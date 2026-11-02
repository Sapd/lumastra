// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-process L1 invalidation for cache namespaces.
 *
 * `UnifiedCache.clear()` empties the in-memory L1 of the calling process and
 * the shared L2 (Valkey). The background worker and the web server are separate
 * processes, so a clear run by the worker (new content ingested) never reached
 * the web process's L1, which kept serving the old entry for the rest of its
 * TTL (2 min for "Recently added"). The clearing process publishes the names it
 * cleared; every other process drops its own L1 copy of those namespaces. L2 is
 * already clear by then, so the next read recomputes and re-fills it.
 *
 * Channel layout:
 *   cache:namespace-clear  - JSON `{ namespaces: string[], _from: string }`.
 *
 * Uses the CACHE Valkey instance through publishMessage / subscribeToChannel,
 * like auth-cache-bus. Messages are transient: a process that misses one still
 * converges when the L1 TTL expires.
 */

import { isMainThread } from 'node:worker_threads';
import { Logger } from '../utils/logger.js';
import { CacheManager } from './unified-cache.js';
import { publishMessage, subscribeToChannel } from './valkey.js';

const logger = Logger.for('NamespaceClearBus');

/** The Valkey pub/sub channel for namespace L1 clears. */
export const NAMESPACE_CLEAR_CHANNEL = 'cache:namespace-clear';

// Process-local ID so a process ignores its own publishes (it cleared locally).
const LOCAL_INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/** Publish that `namespaces` were cleared here (fire-and-forget). */
export function publishNamespaceClear(namespaces: string[]): void {
    if (namespaces.length === 0) return;
    const payload = JSON.stringify({ namespaces, _from: LOCAL_INSTANCE_ID });
    // Best-effort: a failed publish degrades to the L1 TTL, never fails the caller.
    publishMessage(NAMESPACE_CLEAR_CHANNEL, payload).catch((err: unknown) => {
        logger.debug('namespace clear publish failed (non-critical)', {
            error: err instanceof Error ? err.message : String(err),
        });
    });
}

function handleMessage(raw: string): void {
    let event: { namespaces?: unknown; _from?: unknown };
    try {
        event = JSON.parse(raw) as typeof event;
    } catch {
        logger.warn('namespace clear: malformed message ignored');
        return;
    }
    if (event._from === LOCAL_INSTANCE_ID) return;
    if (!Array.isArray(event.namespaces)) return;

    const manager = CacheManager.getInstance();
    for (const name of event.namespaces) {
        if (typeof name === 'string') manager.clearL1(name);
    }
}

let subscribed = false;
let startup: Promise<boolean> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Subscribe this process to namespace clears. Idempotent. Retries with backoff
 * (unref'd) while Valkey is unreachable; a no-op without TASK_CACHE_URL
 * (pub/sub runs on the task Valkey) and in worker threads, where
 * subscribeToChannel is unavailable.
 */
export function startNamespaceClearSubscriber(delayMs = RETRY_BASE_MS): Promise<boolean> {
    if (subscribed) return Promise.resolve(true);
    if (!isMainThread || !process.env.TASK_CACHE_URL) return Promise.resolve(false);
    if (startup) return startup;
    const attempt = (async (): Promise<boolean> => {
        let unsubscribe: Awaited<ReturnType<typeof subscribeToChannel>> = null;
        try {
            unsubscribe = await subscribeToChannel(NAMESPACE_CLEAR_CHANNEL, handleMessage);
        } catch (err) {
            logger.debug('namespace clear subscribe threw', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        if (unsubscribe) {
            subscribed = true;
            logger.info('namespace clear subscriber started', { channel: NAMESPACE_CLEAR_CHANNEL });
            return true;
        }
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            startup = undefined;
            void startNamespaceClearSubscriber(Math.min(delayMs * 2, RETRY_MAX_MS));
        }, delayMs);
        retryTimer.unref?.();
        return false;
    })();
    startup = attempt;
    return attempt;
}

/** Test seam: reset module state. */
export function _resetNamespaceClearBusForTests(): void {
    subscribed = false;
    startup = undefined;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
}

/** Test seam: deliver a raw message as if it came from another process. */
export function _handleNamespaceClearForTests(raw: string): void {
    handleMessage(raw);
}
