// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The minted relay token, shared through Valkey.
 *
 * `relay-token.store.ts` holds the token in process memory. On its own that
 * meant every process boot fetched a fresh token from lumastra.org: web and
 * worker each, every replica, and every restart — an install in a 30 s crash
 * loop called lumastra.org every 30 s per process. Keeping the minted
 * token here, with a TTL equal to its remaining life, lets a restarted or
 * sibling process adopt the one the install already holds, so the install as a
 * whole renews about once per refresh interval.
 *
 * Every call is best-effort: a Valkey failure falls back to the old
 * per-process behaviour (fetch a token), never to "no push".
 *
 * @module services/push/relay-token-shared
 */

import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { acquireLock, releaseLock } from '$lib/server/cache/valkey';

const KEY = 'v1:relay-token';
/** Do not share a token with less life than this left; fetching a new one is cheaper than a 401. */
const MIN_SHARE_REMAINING_MS = 5 * 60 * 1000;

interface SharedRelayToken {
    token: string;
    expiresAtMs: number;
}

function sharedCache() {
    return cacheManager.for(CACHE_NAMESPACES.pushRelayToken);
}

/** The token another process (or a previous boot) stored, or null. Never throws. */
export async function loadSharedRelayToken(
    now: number = Date.now(),
): Promise<SharedRelayToken | null> {
    try {
        const value = await sharedCache().get<SharedRelayToken>(KEY);
        if (
            !value ||
            typeof value.token !== 'string' ||
            value.token.length === 0 ||
            typeof value.expiresAtMs !== 'number' ||
            value.expiresAtMs - now < MIN_SHARE_REMAINING_MS
        ) {
            return null;
        }
        return value;
    } catch {
        return null;
    }
}

/** Share a freshly minted token for its remaining life. Never throws. */
export async function saveSharedRelayToken(
    token: string,
    expiresAtMs: number,
    now: number = Date.now(),
): Promise<void> {
    const ttlMs = expiresAtMs - now;
    if (ttlMs < MIN_SHARE_REMAINING_MS) return;
    try {
        await sharedCache().set(KEY, { token, expiresAtMs }, ttlMs);
    } catch {
        // Best-effort: without the shared copy each process fetches its own.
    }
}

/** Drop the shared copy (contact switched off). Never throws. */
export async function clearSharedRelayToken(): Promise<void> {
    try {
        await sharedCache().delete(KEY);
    } catch {
        // Best-effort: the TTL removes it at the token's expiry anyway.
    }
}

/**
 * Drop the shared copy only if it is the token the relay rejected. A sibling
 * process may already have stored a newer one; that one must survive. Never throws.
 */
export async function clearSharedRelayTokenIfEquals(rejectedToken: string | null): Promise<void> {
    try {
        const value = await sharedCache().get<SharedRelayToken>(KEY);
        if (!value) return;
        if (rejectedToken !== null && value.token !== rejectedToken) return;
        await sharedCache().delete(KEY);
    } catch {
        // Best-effort: the TTL removes it at the token's expiry anyway.
    }
}

const ENROL_LOCK_KEY = 'lock:push-relay-token-enrol';
/** Longer than the request timeout, so a crashed holder frees the slot soon. */
const ENROL_LOCK_TTL_SECONDS = 45;

/**
 * Take the cross-process lock around the call to lumastra.org, so two processes
 * (web and worker, or two replicas) with an empty shared slot make one request,
 * not two. Returns the lock value, or null when another process holds it.
 */
export async function acquireEnrolLock(): Promise<string | null> {
    try {
        return await acquireLock(ENROL_LOCK_KEY, ENROL_LOCK_TTL_SECONDS);
    } catch {
        // No lock service: fall back to the old per-process behaviour.
        return `local-${process.pid}`;
    }
}

export async function releaseEnrolLock(lockValue: string): Promise<void> {
    try {
        await releaseLock(ENROL_LOCK_KEY, lockValue);
    } catch {
        // The TTL frees it anyway.
    }
}
