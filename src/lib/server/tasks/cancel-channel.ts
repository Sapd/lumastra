// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// cancel-channel.ts — centralized cancel pubsub, multiplexed over ONE shared
// Valkey subscription.
//
// All in-flight runs share a single subscription to CANCEL_CHANNEL; the target
// runId travels in the JSON payload and is demultiplexed to per-run callbacks
// here. This replaces the previous design, which opened a dedicated GLIDE
// pubsub connection per `task:cancel:<runId>` channel and closed it when the
// run ended — one connect/teardown per job. Under the task system's run volume
// that was constant connection churn, and GLIDE's pubsub synchronizer logged
// `Failed to subscribe Exact channels: Internal client has been dropped` on
// every teardown (benign, but noisy — under log rotation it evicts useful
// lines). One persistent connection eliminates both.
//
// The publish payload and `subscribeToCancel` signature are unchanged, so the
// runner's per-run subscribe/cleanup paths need no changes.

import { subscribeToChannel, getCoordinationClient } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { type ValkeyLike, errMessage } from './valkey-types.js';

const log = Logger.for('CancelChannel');
type SubscribeFn = (
    channel: string,
    cb: (msg: string) => void,
) => Promise<(() => Promise<void>) | null>;

// ── Channel ──────────────────────────────────────────────────────────────────

/**
 * The single channel all cancels are published to and subscribed from. The
 * target runId lives in the JSON payload, not the channel name, so one
 * subscription serves every run.
 */
export const CANCEL_CHANNEL = 'task:cancel';

// ── Publish ────────────────────────────────────────────────────────────────────

/**
 * Publish a cancel signal. Runner instances trip the matching run's
 * AbortController via the shared subscription.
 */
export async function publishCancel(
    runId: string,
    reason?: string,
    clientOverride?: ValkeyLike,
): Promise<void> {
    const client: ValkeyLike | null =
        // Same instance subscribeToChannel listens on: the task Valkey. The
        // runner heartbeat also polls task_history.cancel_requested_at, so a
        // lost PUBLISH (pub/sub never buffers) only delays the cancel.
        clientOverride ?? (getCoordinationClient() as unknown as ValkeyLike | null);
    if (!client) {
        log.warn('publishCancel: no Valkey client', { runId });
        return;
    }
    const payload = JSON.stringify({ runId, reason: reason ?? 'user' });
    try {
        await client.customCommand(['PUBLISH', CANCEL_CHANNEL, payload]);
    } catch (err) {
        log.warn('publishCancel failed', { runId, err: errMessage(err) });
    }
}

// ── Shared subscription multiplexer ─────────────────────────────────────────────

const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];

/** runId → cancel callbacks for runs currently active on this process. */
const runCallbacks = new Map<string, Set<(reason: string | null) => void>>();
/** In-flight establishment of the shared subscription; null when idle. */
let sharedSubInit: Promise<void> | null = null;
/** Teardown for the shared subscription; null until established. */
let sharedSubUnsub: (() => Promise<void>) | null = null;

/** Parse a cancel payload and fan it out to the matching run's callbacks. */
function dispatchCancel(raw: string): void {
    let runId: string | null = null;
    let reason: string | null = null;
    try {
        const parsed = JSON.parse(raw) as { runId?: unknown; reason?: unknown };
        runId = typeof parsed.runId === 'string' ? parsed.runId : null;
        reason = typeof parsed.reason === 'string' ? parsed.reason : null;
    } catch {
        // malformed payload — nothing routable
    }
    if (!runId) return;
    const set = runCallbacks.get(runId);
    if (!set) return;
    // Snapshot: a callback may deregister itself (or a sibling) synchronously
    // via its unsub, mutating the set mid-iteration and skipping a sibling.
    for (const cb of [...set]) {
        try {
            cb(reason);
        } catch (err) {
            log.warn('cancel callback threw', { runId, err: errMessage(err) });
        }
    }
}

async function subscribeWithRetry(
    subscribe: SubscribeFn,
    useRetry: boolean,
): Promise<(() => Promise<void>) | null> {
    const maxAttempts = useRetry ? RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const unsub = await subscribe(CANCEL_CHANNEL, dispatchCancel);
            if (unsub) return unsub;
            // null → no Valkey configured / transient — retry if allowed
        } catch (err) {
            log.warn('cancel subscription attempt failed', {
                attempt,
                err: errMessage(err),
            });
        }
        if (!useRetry) return null;
        const delayMs = RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) break;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    return null;
}

/**
 * Establish the one shared subscription if it isn't already up. Concurrent
 * callers share a single in-flight attempt; a failed attempt is NOT cached,
 * so the next run re-attempts (preserves the old per-run resilience to a
 * Valkey blip during subscribe).
 */
function ensureSharedSubscription(subscribe: SubscribeFn, useRetry: boolean): Promise<void> {
    if (sharedSubUnsub) return Promise.resolve();
    if (sharedSubInit) return sharedSubInit;
    sharedSubInit = (async () => {
        try {
            sharedSubUnsub = await subscribeWithRetry(subscribe, useRetry);
            if (!sharedSubUnsub && useRetry) {
                log.warn('cancel subscription not established — a later run will retry');
            }
        } finally {
            sharedSubInit = null;
        }
    })();
    return sharedSubInit;
}

/**
 * Register a cancel callback for `runId`. Returns an unsubscribe function that
 * deregisters the callback; the shared Valkey subscription itself stays up for
 * the process lifetime (closed via valkey `closeAllSubscriptions` on shutdown).
 *
 * The callback receives the reason string (or null when the payload omits it
 * or is unparseable). Signature is unchanged from the per-run design.
 *
 * `subscribeOverride` is a test seam; when omitted the real Valkey
 * `subscribeToChannel` is used and subscribe failures are retried with
 * exponential backoff (250ms → 5s).
 */
export async function subscribeToCancel(
    runId: string,
    onCancel: (reason: string | null) => void,
    subscribeOverride?: SubscribeFn,
): Promise<() => Promise<void>> {
    let set = runCallbacks.get(runId);
    if (!set) {
        set = new Set();
        runCallbacks.set(runId, set);
    }
    set.add(onCancel);

    const subscribe = subscribeOverride ?? ((ch, cb) => subscribeToChannel(ch, cb));
    // A test-injected override that returns null is a deliberate stub, not a
    // transient blip — looping through 8.75s of backoff would block tests.
    const useRetry = subscribeOverride === undefined;
    await ensureSharedSubscription(subscribe, useRetry);

    let removed = false;
    return async () => {
        if (removed) return;
        removed = true;
        const current = runCallbacks.get(runId);
        if (current) {
            current.delete(onCancel);
            if (current.size === 0) runCallbacks.delete(runId);
        }
    };
}

/** Test-only: reset the shared-subscription singleton + callback registry. */
export function __resetCancelChannelForTests(): void {
    runCallbacks.clear();
    sharedSubInit = null;
    sharedSubUnsub = null;
}
