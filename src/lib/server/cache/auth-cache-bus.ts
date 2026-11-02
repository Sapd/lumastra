// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-replica auth-cache invalidation bus.
 *
 * When an admin revokes a user's capabilities, group membership, admin status,
 * or disabled state on ONE replica, the other replicas hold a stale in-process
 * cache (user-access-cache / user-admin-cache) until the TTL expires.
 * This module closes that window by publishing invalidation events to a shared
 * Valkey pub/sub channel and subscribing to clear local entries on receipt.
 *
 * Security goal: prompt REVOKE across replicas.  Capability-ADD lag is harmless
 * (worst case: user waits up to TTL before the new capability is visible), so we
 * only need to invalidate, not broadcast the new value.
 *
 * Channel layout:
 *   auth:cache:invalidate  — JSON payloads, see AuthCacheInvalidation below.
 *
 * The channel uses the CACHE Valkey instance (not coordination), because pub/sub
 * messages are transient — a restart misses nothing important (the local cache is
 * already cold after a restart), and we don't need the noeviction guarantee.
 *
 * valkey-glide requires a DEDICATED client for subscriptions (immutable at
 * creation time).  subscribeToChannel() in valkey.ts manages that pool.
 *
 * Startup: call startAuthCacheInvalidationSubscriber() once at boot, whether or
 * not Valkey is up; it retries until subscribed (see the supervisor below).
 * Before it subscribes, publish calls still work — other replicas receive them.
 */

import { isMainThread } from 'node:worker_threads';
import { Logger } from '../utils/logger.js';
import {
    probeChannelSubscription,
    publishMessage,
    resubscribeChannel,
    subscribeToChannel,
} from './valkey.js';

const logger = Logger.for('AuthCacheBus');

/** The Valkey pub/sub channel for auth cache invalidation. */
export const AUTH_CACHE_INVALIDATION_CHANNEL = 'auth:cache:invalidate';

/** Payload shape published when an auth cache entry should be dropped. */
export type AuthCacheInvalidation =
    | { kind: 'user-access'; userId: string }
    | { kind: 'user-access-many'; userIds: string[] }
    | { kind: 'user-admin'; username: string }
    | { kind: 'user-max-age'; username: string }
    | { kind: 'user-live-tv'; username: string }
    | { kind: 'token-narrowed'; tokenHash: string }
    | { kind: 'device-session-revoked'; deviceSessionIds: string[] };

// Process-local ID so replicas can ignore their own publishes (they already
// applied the local invalidation before publishing).
const LOCAL_INSTANCE_ID = `${process.pid}-${Date.now()}`;

// Registered local-clear callbacks — set independently by each cache module.
const clearUserAccessCallbacks = new Set<(userId: string) => void>();
const clearUserAccessManyCallbacks = new Set<(userIds: readonly string[]) => void>();
const clearUserAdminCallbacks = new Set<(username: string) => void>();
const clearUserLiveTvCallbacks = new Set<(username: string) => void>();
const clearUserMaxAgeCallbacks = new Set<(username: string) => void>();
const clearTokenNarrowedCallbacks = new Set<(tokenHash: string) => void>();
const deviceSessionRevokedCallbacks = new Set<(deviceSessionIds: readonly string[]) => void>();

/**
 * Register a local-clear callback for user-access entries (user-access-cache.ts).
 * Each cache module calls this once at module init.
 */
export function onRemoteUserAccessInvalidate(fn: (userId: string) => void): void {
    clearUserAccessCallbacks.add(fn);
}

/**
 * Register a local-clear callback for user-access-many entries (user-access-cache.ts).
 */
export function onRemoteUserAccessManyInvalidate(fn: (userIds: readonly string[]) => void): void {
    clearUserAccessManyCallbacks.add(fn);
}

/**
 * Register a local-clear callback for user-admin entries (user-admin-cache.ts).
 */
export function onRemoteUserAdminInvalidate(fn: (username: string) => void): void {
    clearUserAdminCallbacks.add(fn);
}

/**
 * Register a local-clear callback for user-max-age entries (user-max-age-cache.ts).
 *
 * FIX ROUND 1 (Important 2, security review 2026-09-16): before this existed,
 * invalidateUserMaxAgeCache() only cleared the LOCAL replica's entry — a
 * sibling replica kept the stale max_age_rating for the full 10-minute TTL
 * after an admin lowered a user's age cap, so resolveTokenUserAccess()'s
 * cache-first fast path (which requires ALL FIVE user-admin-cache entries
 * warm, none of which the age-rating PATCH touches) would keep serving the
 * old, looser cap on that replica.
 */
export function onRemoteUserMaxAgeInvalidate(fn: (username: string) => void): void {
    clearUserMaxAgeCallbacks.add(fn);
}

/** Register the per-user Live TV cache's cross-replica invalidator. */
export function onRemoteUserLiveTvInvalidate(fn: (username: string) => void): void {
    clearUserLiveTvCallbacks.add(fn);
}

/**
 * Register a local-clear callback for a narrowed (or un-narrowed) token's LRU
 * entry — `pat.service.ts` / `service-token.service.ts` each register one.
 *
 * Security review 2026-09-16 (C4 fix round 1 review): `PatService
 * .markAdminScopedForceNonAdminForUser()` / `ServiceTokenService
 * .markAdminScopedForceNonAdminImpersonating()` (and their promotion-side
 * `clear…` counterparts) used to evict only the LOCAL replica's token cache
 * — a sibling replica kept serving the stale, still-admin-scoped `Principal`
 * for up to that replica's own token-cache TTL (30 min for PATs, 5 min for
 * service tokens) after a demotion. This mirrors `onRemoteUserAdminInvalidate`
 * / `onRemoteUserMaxAgeInvalidate` exactly: the demotion path already
 * broadcasts the IDENTITY half (`invalidateUserAdminCache` → `{kind:
 * 'user-admin'}`) on this very channel, so the CREDENTIAL half — which
 * exists specifically as defence in depth if the identity half regresses —
 * must not be the one part of the picture that stays replica-local.
 *
 * Keyed by token hash rather than user/username because a single user can
 * hold several tokens and only SOME of them are admin-class; the writer
 * publishes one event per affected hash. Both `pat.service.ts`'s and
 * `service-token.service.ts`'s callbacks receive every event and no-op if
 * the hash isn't theirs (a `Map.delete` on an absent key), so one shared
 * `kind` serves both credential classes without a service-specific channel.
 */
export function onRemoteTokenNarrowedInvalidate(fn: (tokenHash: string) => void): void {
    clearTokenNarrowedCallbacks.add(fn);
}

/**
 * Register a callback for device sessions revoked on another replica
 * (`oauth/device-session-liveness.ts`), so that replica's cached "live"
 * verdict for the session's access JWTs is dropped at once instead of after
 * its TTL.
 */
export function onRemoteDeviceSessionRevoked(
    fn: (deviceSessionIds: readonly string[]) => void,
): void {
    deviceSessionRevokedCallbacks.add(fn);
}

/** Publish a cross-replica cache invalidation event (fire-and-forget). */
export function publishAuthCacheInvalidation(event: AuthCacheInvalidation): void {
    const payload = JSON.stringify({ ...event, _from: LOCAL_INSTANCE_ID });
    // Best-effort: a publish failure only means other replicas keep stale entries
    // until TTL — not a hard security failure (TTLs are short: 1–10 min).
    publishMessage(AUTH_CACHE_INVALIDATION_CHANNEL, payload).catch((err: unknown) => {
        logger.debug('auth cache invalidation publish failed (non-critical)', {
            error: err instanceof Error ? err.message : String(err),
        });
    });
}

/** Handle an incoming raw pub/sub message from the invalidation channel. */
function handleInvalidationMessage(raw: string): void {
    let event: AuthCacheInvalidation & { _from?: string };
    try {
        event = JSON.parse(raw) as typeof event;
    } catch {
        logger.warn('auth cache invalidation: malformed message ignored', { raw });
        return;
    }

    // Skip messages this process published (we already invalidated locally).
    if (event._from === LOCAL_INSTANCE_ID) return;

    switch (event.kind) {
        case 'user-access':
            for (const fn of clearUserAccessCallbacks) fn(event.userId);
            break;
        case 'user-access-many':
            for (const fn of clearUserAccessManyCallbacks) fn(event.userIds);
            break;
        case 'user-admin':
            for (const fn of clearUserAdminCallbacks) fn(event.username);
            break;
        case 'user-live-tv':
            for (const fn of clearUserLiveTvCallbacks) fn(event.username);
            break;
        case 'user-max-age':
            for (const fn of clearUserMaxAgeCallbacks) fn(event.username);
            break;
        case 'token-narrowed':
            for (const fn of clearTokenNarrowedCallbacks) fn(event.tokenHash);
            break;
        case 'device-session-revoked':
            if (Array.isArray(event.deviceSessionIds)) {
                for (const fn of deviceSessionRevokedCallbacks) fn(event.deviceSessionIds);
            }
            break;
        default:
            logger.debug('auth cache invalidation: unknown kind, ignoring', { raw });
    }
}

// ---------------------------------------------------------------------------
// Subscription supervisor
// ---------------------------------------------------------------------------
//
// A message published while this replica is not subscribed is lost for good
// (pub/sub has no backlog). Two ways that used to happen silently:
//
//  - Boot with Valkey unreachable: the single subscribe attempt failed and
//    nothing retried, so the replica used its caches for its whole lifetime
//    without ever hearing another replica's revocations.
//  - A dropped connection: GLIDE reconnects and re-subscribes on its own, but
//    emits no event, and everything published in between is gone.
//
// The supervisor retries the subscription with backoff until it holds, then
// probes it every SUBSCRIPTION_PROBE_INTERVAL_MS (one CLIENT ID + a local
// GLIDE state read). A failed probe or a missing channel = unsubscribed; a
// changed connection id = a reconnect happened between two probes. In both
// cases {@link onAuthCacheBusResync} listeners run once the subscription is
// confirmed again, so caches can drop entries an unseen event may have
// invalidated. Consumers that must not miss an event ask
// {@link isAuthCacheBusSubscribed} and fall back to their source of truth
// while it is false (`oauth/device-session-liveness.ts` reads the DB).

/** First retry delay after a failed subscribe; doubles up to the max. */
export const SUBSCRIBE_RETRY_BASE_MS = 1_000;
export const SUBSCRIBE_RETRY_MAX_MS = 30_000;
/** How often a held subscription is re-verified. */
export const SUBSCRIPTION_PROBE_INTERVAL_MS = 5_000;

/**
 * - `idle`: not started (scripts, tests, a process that never called start).
 * - `disabled`: no TASK_CACHE_URL or a worker thread — no pub/sub by configuration,
 *   and with no Valkey there are no peer replicas to hear from.
 * - `subscribed` / `unsubscribed`: the supervisor's last verdict.
 */
export type AuthCacheBusState = 'idle' | 'disabled' | 'subscribed' | 'unsubscribed';

let busState: AuthCacheBusState = 'idle';
let busStateSince = Date.now();
let lastConnectionId: number | null = null;
let retryAttempt = 0;
let supervisorTimer: ReturnType<typeof setTimeout> | null = null;
let supervisorGeneration = 0;
let supervisorStarted = false;
let startPromise: Promise<void> | null = null;
let downLogged = false;
let lastDownReason: string | null = null;
const resyncCallbacks = new Set<() => void>();

/** Idle/disabled processes may cache; only a lost subscription makes entries untrusted. */
export function isAuthCacheBusDown(): boolean {
    return busState === 'unsubscribed';
}

/**
 * Whether this replica is known to receive every invalidation published from
 * now on. `disabled` counts as subscribed: without Valkey there is no bus and
 * no other replica to miss events from.
 */
export function isAuthCacheBusSubscribed(): boolean {
    return busState === 'subscribed' || busState === 'disabled';
}

/** State for the component-health view. */
export function getAuthCacheBusStatus(): {
    state: AuthCacheBusState;
    since: number;
    reason: string | null;
} {
    return {
        state: busState,
        since: busStateSince,
        reason: busState === 'unsubscribed' ? lastDownReason : null,
    };
}

/**
 * Register a callback run when the subscription is (re-)established after a
 * period in which events may have been lost: recovery from `unsubscribed`
 * (including a first subscribe that only succeeded after failed attempts at
 * boot), or a reconnect noticed via a changed connection id. Not run when the
 * very first attempt succeeds. Callbacks should drop cached entries that an
 * unseen invalidation could have covered.
 */
export function onAuthCacheBusResync(fn: () => void): void {
    resyncCallbacks.add(fn);
}

function setBusState(next: AuthCacheBusState): void {
    if (busState === next) return;
    busState = next;
    busStateSince = Date.now();
}

function runResync(): void {
    for (const fn of resyncCallbacks) {
        try {
            fn();
        } catch (err) {
            logger.warn('auth cache bus resync listener failed', { error: String(err) });
        }
    }
}

function markDown(reason: string): void {
    lastDownReason = reason;
    setBusState('unsubscribed');
    if (!downLogged) {
        downLogged = true;
        logger.warn(
            'auth cache invalidation bus not subscribed; retrying. Until it recovers, revocations from other replicas reach this one only via their DB re-check',
            { channel: AUTH_CACHE_INVALIDATION_CHANNEL, reason },
        );
    }
}

function markUp(connectionId: number): void {
    const wasDown = busState === 'unsubscribed';
    const reconnected = lastConnectionId !== null && lastConnectionId !== connectionId;
    const firstSubscribe = busState === 'idle';
    lastConnectionId = connectionId;
    retryAttempt = 0;
    setBusState('subscribed');
    if (firstSubscribe) {
        logger.info('auth cache invalidation subscriber started', {
            channel: AUTH_CACHE_INVALIDATION_CHANNEL,
        });
        return;
    }
    if (wasDown) {
        downLogged = false;
        lastDownReason = null;
        logger.info('auth cache invalidation bus subscribed again', {
            channel: AUTH_CACHE_INVALIDATION_CHANNEL,
        });
    } else if (reconnected) {
        logger.info('auth cache invalidation bus reconnected; dropping cached auth entries', {
            channel: AUTH_CACHE_INVALIDATION_CHANNEL,
        });
    }
    if (wasDown || reconnected) runResync();
}

function schedule(generation: number, delayMs: number): void {
    if (generation !== supervisorGeneration) return;
    supervisorTimer = setTimeout(() => {
        supervisorTimer = null;
        void superviseOnce(generation);
    }, delayMs);
    // Never hold the process open for the supervisor.
    supervisorTimer.unref?.();
}

function retryDelay(): number {
    const delay = Math.min(SUBSCRIBE_RETRY_BASE_MS * 2 ** retryAttempt, SUBSCRIBE_RETRY_MAX_MS);
    retryAttempt++;
    return delay;
}

async function superviseOnce(generation: number): Promise<void> {
    if (generation !== supervisorGeneration) return;
    let delay: number;
    try {
        if (busState !== 'subscribed') {
            // subscribeToChannel creates the shared client on first use and only
            // sends SUBSCRIBE for a channel it does not know yet; a channel that
            // is registered but lost on the server gets a re-SUBSCRIBE below.
            const unsubscribe = await subscribeToChannel(
                AUTH_CACHE_INVALIDATION_CHANNEL,
                handleInvalidationMessage,
            );
            if (generation !== supervisorGeneration) return;
            if (!unsubscribe) {
                markDown('Valkey unreachable');
                schedule(generation, retryDelay());
                return;
            }
            let probe = await probeChannelSubscription(AUTH_CACHE_INVALIDATION_CHANNEL);
            if (probe && !probe.subscribed) {
                await resubscribeChannel(AUTH_CACHE_INVALIDATION_CHANNEL);
                probe = await probeChannelSubscription(AUTH_CACHE_INVALIDATION_CHANNEL);
            }
            if (generation !== supervisorGeneration) return;
            if (!probe?.subscribed) {
                markDown(probe ? 'subscription not confirmed' : 'pub/sub connection not answering');
                schedule(generation, retryDelay());
                return;
            }
            markUp(probe.connectionId);
            delay = SUBSCRIPTION_PROBE_INTERVAL_MS;
        } else {
            const probe = await probeChannelSubscription(AUTH_CACHE_INVALIDATION_CHANNEL);
            if (generation !== supervisorGeneration) return;
            if (!probe?.subscribed) {
                markDown(probe ? 'subscription lost' : 'pub/sub connection lost');
                delay = retryDelay();
            } else {
                markUp(probe.connectionId);
                delay = SUBSCRIPTION_PROBE_INTERVAL_MS;
            }
        }
    } catch (err) {
        if (generation !== supervisorGeneration) return;
        // A fixed reason: it is shown in the health report, the error is not.
        logger.debug('auth cache bus subscribe attempt failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        markDown('subscribe failed');
        delay = retryDelay();
    }
    schedule(generation, delay);
}

/**
 * Start the cross-replica invalidation subscriber and its supervisor.
 * Idempotent. Call once at server startup whether or not Valkey is reachable
 * yet: the supervisor retries with backoff (1 s doubling to 30 s) until the
 * subscription holds, and re-establishes it after a connection loss.
 *
 * Resolves after the first attempt. Never throws.
 */
export async function startAuthCacheInvalidationSubscriber(): Promise<void> {
    if (supervisorStarted) return startPromise ?? undefined;
    // Same gates as subscribeToChannel (pub/sub runs on TASK_CACHE_URL):
    // no Valkey configured, or a worker thread, is a configuration, not an
    // outage — nothing to retry or log.
    if (!isMainThread || !process.env.TASK_CACHE_URL) {
        setBusState('disabled');
        return;
    }
    supervisorStarted = true;
    const generation = ++supervisorGeneration;
    startPromise = superviseOnce(generation).finally(() => {
        startPromise = null;
    });
    return startPromise;
}

/**
 * Stop the supervisor (graceful shutdown): call before
 * `closeAllSubscriptions()`, or its next retry opens a new pub/sub client.
 */
export function stopAuthCacheInvalidationSubscriber(): void {
    supervisorGeneration++;
    if (supervisorTimer) clearTimeout(supervisorTimer);
    supervisorTimer = null;
}

/** Test hook: stop the supervisor and forget all state. */
export function _resetAuthCacheBusForTests(): void {
    stopAuthCacheInvalidationSubscriber();
    supervisorStarted = false;
    startPromise = null;
    busState = 'idle';
    busStateSince = Date.now();
    lastConnectionId = null;
    retryAttempt = 0;
    downLogged = false;
    lastDownReason = null;
}
