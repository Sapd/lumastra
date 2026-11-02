// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// progress.ts — throttled progress reporter for TaskContext.reportProgress().
//
// Plugin calls ctx.reportProgress(processed, total?, currentItem?).
// Writes are throttled: minimum 250ms between Valkey flushes (coalesced).
// Heartbeat: forced flush every 30s even if values unchanged.
// High-watermark: total only ever increases (refuses decreases unless total === 0).

import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { type ValkeyLike, errMessage } from './valkey-types.js';
import { captureValkeyAuthority, invokeFencedValkey } from './lua/fenced.js';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';

const log = Logger.for('ProgressTracker');

// `transition-run.lua` moves a terminal run's active hash to
// `task:run:terminal:*` and deletes the active key. A normal HSET after that
// point would silently recreate an unbounded, state-less active hash. Keep the
// check and write in one script: a separate HEXISTS followed by HSET leaves
// the same race open. The terminal target also preserves the last coalesced
// progress update for completed runs without extending its existing TTL.
const WRITE_PROGRESS_LUA = "redis.call('HSET', KEYS[1], unpack(ARGV)); return 1";
const WRITE_FINAL_PROGRESS_LUA = `
if redis.call('HEXISTS', KEYS[1], 'state') == 0 then
    if redis.call('HEXISTS', KEYS[2], 'state') == 0 then
        return 0
    end
    redis.call('HSET', KEYS[2], unpack(ARGV))
    return 2
end
redis.call('HSET', KEYS[1], unpack(ARGV))
return 1
`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface RunProgressState {
    authority: Readonly<AuthorityToken> | undefined;
    stageId: string;
    lastReportedAt: number;
    lastValues: { processed: number; total: number; currentItem?: string };
    pendingTimer: ReturnType<typeof setTimeout> | null;
    heartbeatTimer: ReturnType<typeof setInterval> | null;
}

// ── ProgressTracker ───────────────────────────────────────────────────────────

export class ProgressTracker {
    private readonly trackers = new Map<string, RunProgressState>();

    private readonly throttleMs: number;
    private readonly heartbeatMs: number;

    constructor(
        private readonly getClient: () => ValkeyLike | null = defaultGetClient,
        throttleMs: number = 250,
        heartbeatMs: number = 30_000,
        private readonly getPublishClient: () => ValkeyLike | null = defaultGetPublishClient,
    ) {
        // Clamp to >=1ms — a throttleMs of 0 would degrade the coalescing
        // window into a fire-on-every-call loop that floods Valkey.
        this.throttleMs = Math.max(1, throttleMs);
        // Heartbeat must be at least 100ms — anything below is functionally
        // the same as "fire every event" and provides no actual heartbeat.
        this.heartbeatMs = Math.max(100, heartbeatMs);
    }

    /**
     * Create a tracker for a run. Returns the `reportProgress` function to
     * inject into TaskContext.
     */
    create(
        runId: string,
        stageId: string = 'main',
        authority?: AuthorityToken,
    ): (processed: number, total?: number, currentItem?: string) => void {
        const original = captureValkeyAuthority(authority);
        this.finalize(runId, this.trackers.get(runId)?.authority);
        const state: RunProgressState = {
            authority: original,
            stageId,
            lastReportedAt: 0,
            lastValues: { processed: 0, total: 0 },
            pendingTimer: null,
            heartbeatTimer: null,
        };
        this.trackers.set(runId, state);

        // Start heartbeat — forced flush every heartbeatMs.
        state.heartbeatTimer = setInterval(() => {
            void this.flush(runId, true, false, state);
        }, this.heartbeatMs);
        if (typeof state.heartbeatTimer.unref === 'function') {
            state.heartbeatTimer.unref();
        }

        return (processed: number, total?: number, currentItem?: string): void => {
            const s = this.trackers.get(runId);
            if (!s || s !== state) return;

            // High-watermark: total only increases (reset allowed when total === 0).
            let newTotal: number;
            if (total === undefined) {
                newTotal = s.lastValues.total;
            } else if (total === 0) {
                newTotal = 0;
            } else {
                newTotal = Math.max(total, s.lastValues.total);
            }

            s.lastValues = { processed, total: newTotal, currentItem };

            const now = Date.now();
            const sinceLast = now - s.lastReportedAt;
            if (sinceLast >= this.throttleMs) {
                void this.flush(runId, false, false, state);
            } else if (!s.pendingTimer) {
                const delay = this.throttleMs - sinceLast;
                s.pendingTimer = setTimeout(() => {
                    void this.flush(runId, false, false, state);
                }, delay);
                if (typeof s.pendingTimer.unref === 'function') {
                    s.pendingTimer.unref();
                }
            }
        };
    }

    /**
     * Clean up timers for a run after it reaches terminal state.
     * Call this from the runner's finally block.
     */
    finalize(runId: string, authority?: AuthorityToken): void {
        const state = this.trackers.get(runId);
        if (!state) return;
        if (
            state.authority?.partition !== authority?.partition ||
            state.authority?.generation !== authority?.generation ||
            state.authority?.ownerId !== authority?.ownerId
        )
            return;
        if (state.pendingTimer) {
            clearTimeout(state.pendingTimer);
            state.pendingTimer = null;
        }
        if (state.heartbeatTimer) {
            clearInterval(state.heartbeatTimer);
            state.heartbeatTimer = null;
        }
        // A plugin can report progress right up until it returns — e.g.
        // 999/1000 then 1000/1000 inside the 250ms throttle window — which
        // leaves the final value sitting in `lastValues` behind the
        // pendingTimer we just cancelled above. Without an explicit flush
        // here, that update is lost forever once the tracker is deleted
        // below (admin progress reads stuck below 100% on a run that
        // actually finished). Fire one last unthrottled flush before
        // deleting state.
        //
        // `finalize()` is synchronous and callers do not await it (runner.ts
        // calls it bare inside cleanup/finally blocks), so this has to be
        // fire-and-forget. `flush()` internally captures `state.lastValues`
        // synchronously (before its first `await`), i.e. before the
        // `trackers.delete()` below runs, so the buffered value is not lost
        // to the deletion race. `flush()` already logs-and-swallows its own
        // HSET/PUBLISH failures, but attach a `.catch()` anyway so any other
        // rejection can't surface as an unhandled rejection.
        void this.flush(runId, true, true, state).catch((err) => {
            log.warn('ProgressTracker: finalize flush failed', {
                runId,
                err: errMessage(err),
            });
        });
        this.trackers.delete(runId);
    }

    private async flush(
        runId: string,
        _force: boolean,
        onlyWriteToExistingRunState: boolean = false,
        expectedState?: RunProgressState,
    ): Promise<void> {
        const state = this.trackers.get(runId);
        if (!state || (expectedState && state !== expectedState)) return;

        // Clear pending timer regardless (heartbeat or throttle-triggered).
        if (state.pendingTimer) {
            clearTimeout(state.pendingTimer);
            state.pendingTimer = null;
        }

        state.lastReportedAt = Date.now();
        const { processed, total, currentItem } = state.lastValues;
        const stageId = state.stageId;

        const client = this.getClient();
        if (!client) return;

        const key = `task:run:active:${runId}`;
        const fields = [
            `stage:${stageId}:processed`,
            String(processed),
            `stage:${stageId}:total`,
            String(total),
            `stage:${stageId}:currentItem`,
            currentItem ?? '',
            'progressLastReported',
            String(state.lastReportedAt),
        ];

        let wrote: boolean;
        try {
            const raw = await invokeFencedValkey(
                onlyWriteToExistingRunState ? WRITE_FINAL_PROGRESS_LUA : WRITE_PROGRESS_LUA,
                onlyWriteToExistingRunState ? [key, `task:run:terminal:${runId}`] : [key],
                fields,
                client,
                state.authority,
            );
            wrote = Number(raw) > 0;
        } catch (err) {
            log.warn('ProgressTracker: HSET failed', {
                runId,
                err: errMessage(err),
            });
            return;
        }

        // Terminal transition won the race. Do not emit a progress event for a
        // run whose active record no longer exists.
        if (!wrote) return;

        // Pubsub for SSE consumers — best-effort. Single global channel
        // `task:events:progress` (not per-runId) so the SSE relay can use the
        // existing exact-match subscribe helper instead of pattern-subscribe.
        // Payload carries runId so consumers filter client-side.
        try {
            const payload = JSON.stringify({
                runId,
                stageId,
                processed,
                total,
                currentItem,
                ts: state.lastReportedAt,
                authority: state.authority,
            });
            // All pub/sub rides the coordination instance (the SSE relay
            // subscribes there, and it is up whenever the task system is), so
            // the publish goes to the same client as the keyed HSET above.
            const publishClient = this.getPublishClient();
            if (!publishClient) throw new Error('Valkey progress publisher is not connected');
            // HSET acknowledgment can arrive after handoff or first management.
            // Fence publication itself, including when the original writer was
            // unmanaged.
            await invokeFencedValkey(
                'return redis.call("PUBLISH", ARGV[1], ARGV[2])',
                [],
                ['task:events:progress', payload],
                publishClient,
                state.authority,
            );
        } catch (err) {
            log.warn('ProgressTracker: PUBLISH failed', {
                runId,
                err: errMessage(err),
            });
        }
    }
}

// ── Module-level singleton ────────────────────────────────────────────────────

function defaultGetClient(): ValkeyLike | null {
    return getCoordinationClient() as unknown as ValkeyLike | null;
}

function defaultGetPublishClient(): ValkeyLike | null {
    return getCoordinationClient() as unknown as ValkeyLike | null;
}

export const progressTracker = new ProgressTracker();
