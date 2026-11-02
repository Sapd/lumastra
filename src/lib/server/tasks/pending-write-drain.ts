// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// pending-write-drain.ts — Valkey LIST → Postgres drain for offline writes.
//
// Plan §10.4: when Postgres is unreachable during an orchestrator write, the
// caller enqueues the write to `task:pending-writes` (bounded to 10 000 entries).
// A 5s background timer drains the list, replaying writes to Postgres.
//
// Alert thresholds:
//   - LLEN > 1000 → warn
//   - oldest entry enqueuedAt > 5 min → warn
//
// On drain failure: the write is re-pushed to the head of the list (LPUSH)
// rather than dropped, and the drain pass breaks immediately. A separate retry
// list (`task:pending-writes:retry`) is NOT used; re-pushing to the head and
// breaking gives Postgres at least one full drain interval of breathing room
// before the next retry, instead of cycling within a single pass.
//
// Crash-safe claim (durability fix): a claimed entry is never destructively
// popped. The drain loop uses `LMOVE LIST_KEY PROCESSING_KEY RIGHT LEFT` to
// atomically move the oldest entry onto a processing list, and only issues
// `LREM PROCESSING_KEY 1 <raw>` (ack) once the entry has been replayed,
// dropped (malformed), or routed to poison. If the process is killed
// (SIGKILL/OOM/redeploy) between the claim and the ack, the entry survives on
// PROCESSING_KEY instead of vanishing — this list is the fallback path for
// when the initial task_history INSERT failed, so a lost entry here can be
// the ONLY record of a run. Every drain tick opens with a recovery sweep
// (`recoverProcessing`) that moves any such leftovers back onto LIST_KEY
// before computing depth, so a crash-orphaned backlog can't hide from
// alerting and gets redrained on the very next tick. See `PROCESSING_KEY`.
//
// Integration note: the orchestrator's catch blocks for Postgres failures call
// `pendingWriteDrain.enqueue(...)` for transient errors (connection lost,
// deadlock, serialization failure, resource exhaustion). Non-transient errors
// — constraint violations, invalid input, syntax errors — are re-thrown so
// the caller sees them (e.g. idempotency-key dedup catches unique-violation).
// The `isTransientPgError` helper is re-exported below from the shared util.

import type postgres from 'postgres';
import {
    terminalQueueAttemptCurrent,
    terminalResultConfirmed,
    TerminalAttemptJobMissingError,
    TerminalAttemptUnknownError,
    TERMINAL_JOB_MISSING_ACCEPT_AFTER,
    type TerminalQueueAttempt,
} from './terminal-attempt.js';
import { ZodError } from 'zod';
import {
    AuthorityError,
    AuthorityStore,
    type AuthorityToken,
} from '../../../task-runtime/authority/store.js';
import { withExistingTaskWrite } from '../../../task-runtime/authority/existing-write.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isTransientPgError } from '$lib/server/utils/transient-pg.js';
import { taskPendingWritePoisonedTotal, taskPendingWriteDroppedTotal } from './metrics.js';
import { config } from '$lib/server/config.js';
import { type ValkeyLike } from './valkey-types.js';
import { beatAlive, writeHeartbeat } from './observability/heartbeat.js';
import { captureValkeyAuthority, invokeFencedValkey } from './lua/fenced.js';
import { awaitInFlightTick, LOOP_STOP_TIMEOUT_MS } from './loop-stop.js';

// Re-export so existing call sites (`import { isTransientPgError } from
// './pending-write-drain.js'`) keep working without touching every import.
export { isTransientPgError };

const log = Logger.for('PendingWriteDrain');

const LIST_KEY = 'task:pending-writes';
/**
 * Crash-safe "in-flight" holding list. The drain loop claims an entry via
 * `LMOVE LIST_KEY PROCESSING_KEY RIGHT LEFT` (atomic move, not a destructive
 * pop) and only removes it (`LREM PROCESSING_KEY 1 <raw>`) once the entry has
 * been durably handled (replayed, deliberately dropped, or poisoned). Entries
 * only linger here across a crash — normal flow acks synchronously in the
 * same tick. Deliberately TTL-less, same as LIST_KEY: this is a durability
 * key on the `noeviction` coordination instance, not a cache entry.
 */
const PROCESSING_KEY = 'task:pending-writes:processing';
const POISON_KEY = 'task:pending-writes:poison';
const LIST_CAP = 10_000;
const ALERT_DEPTH = 1_000;
const ALERT_AGE_MS = 5 * 60 * 1_000; // 5 minutes
const DRAIN_BATCH = 50; // entries popped per drain tick
/**
 * Maximum replay attempts before a pending write is treated as poison
 * and moved to the DLQ list. 10 attempts at the default 5s interval
 * gives the consumer ~50s to recover transient outages before we give
 * up on a single message.
 */
const MAX_REPLAY_ATTEMPTS = 10;
/**
 * Maximum TRANSIENT replay attempts before an entry is poisoned anyway. Far
 * higher than MAX_REPLAY_ATTEMPTS so a normal multi-minute Postgres outage never
 * poisons a valid write, but still a hard ceiling so an entry that always raises
 * a transient-classified error (deterministic statement-timeout / serialization
 * on a hot row, or an isTransientPgError heuristic false-positive) is eventually
 * evicted to the DLQ instead of wedging the head of the list and starving every
 * write behind it forever. 360 attempts at the default 5s interval ≈ 30 minutes
 * of continuous transient failure on a single entry.
 */
const MAX_TRANSIENT_REPLAY_ATTEMPTS = 360;
/**
 * Maximum replays whose original queue attempt stays UNKNOWN (queue lookup
 * timeout, provenance mismatch, a conflicting terminal result) before the entry
 * is moved to the poison DLQ. 60 attempts at the default 5s interval ≈ 5 minutes.
 * A reaped BullMQ job is not counted toward this: after
 * TERMINAL_JOB_MISSING_ACCEPT_AFTER consecutive observations the write is applied.
 */
const MAX_UNKNOWN_REPLAY_ATTEMPTS = 60;
/**
 * Retained UNKNOWN entries per drain tick. Each one is moved behind the rest of
 * the list so later entries still drain; this bounds the queue lookups (up to
 * 2.5 s each) one tick may spend on them.
 */
const MAX_RETAINED_UNKNOWN_PER_TICK = 5;
/**
 * Hard cap on the poison DLQ list. After each poison LPUSH the list is trimmed
 * to the newest POISON_CAP entries (LTRIM 0 POISON_CAP-1). Without this a
 * permanently-invalid write pattern would grow the DLQ without bound under
 * Valkey `noeviction`.
 */
const POISON_CAP = 1000;
/**
 * TTL applied to the poison key after every poison push. Valkey `noeviction`
 * honors explicit key TTLs, so even an abandoned DLQ self-expires after this
 * window (7 days).
 */
const POISON_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

/**
 * Fallback `kind` label for the dropped-write metric when the evicted entry
 * can't be JSON-decoded (its real kind is unknown). Kept inside the bounded
 * cardinality set the metric already declares.
 */
const UNKNOWN_KIND_LABEL = 'unknown';

/**
 * Result of a single replay attempt. On failure, `transient` distinguishes a
 * connection/PG-unreachable error (give Postgres breathing room, don't count
 * toward poison) from a malformed-payload / constraint error (count toward the
 * poison threshold).
 */
type ReplayResult =
    | { ok: true }
    | {
          ok: false;
          transient: boolean;
          authorityError?: string;
          attemptUnknown?: boolean;
          /** The original BullMQ job is gone and PostgreSQL does not confirm the outcome. */
          jobMissing?: boolean;
      };

/**
 * Queue-attempt observation taken before the PostgreSQL transaction opens.
 * `settled`: PostgreSQL already confirms the outcome or a successor attempt owns
 * the run. `missing-accepted`: the job stayed reaped long enough that PostgreSQL
 * decides the outcome.
 */
type QueueAttemptObservation = 'current' | 'settled' | 'missing' | 'missing-accepted';

// ── Transient error classification ────────────────────────────────────────────
// Lives in `$lib/server/utils/transient-pg.ts` so audit-listener.ts can share
// the same SQLSTATE set. Re-exported above for backwards-compatible imports.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingWrite {
    kind: 'insert' | 'update';
    /** Optional provenance for new runner terminal writes; legacy entries retain their behavior. */
    queueAttempt?: TerminalQueueAttempt;
    runId: string;
    payload: Record<string, unknown>;
    enqueuedAt: number; // ms epoch
    /** Original writer authority. Replay must never borrow the drain worker's token. */
    authority?: AuthorityToken;
    /**
     * NON-transient replay attempt counter (malformed payload / constraint
     * error). Optional on the wire so older entries that predate this field
     * still drain cleanly — code below treats `undefined` as 0. Incremented on
     * every non-transient failed replay; once it hits MAX_REPLAY_ATTEMPTS the
     * entry is moved to the poison list.
     */
    attempts?: number;
    /**
     * TRANSIENT replay attempt counter (PG unreachable / connection drop). Kept
     * separate from `attempts` so a multi-minute outage doesn't poison valid
     * writes — but bounded by MAX_TRANSIENT_REPLAY_ATTEMPTS so an entry that
     * DETERMINISTICALLY raises a transient-classified error (e.g. statement
     * timeout / serialization failure on a hot row, or a heuristic
     * false-positive) is eventually poisoned instead of wedging the head of the
     * list forever. Treated as 0 when undefined.
     */
    transientAttempts?: number;
    /**
     * Replays whose original queue attempt stayed UNKNOWN. Bounded by
     * MAX_UNKNOWN_REPLAY_ATTEMPTS; treated as 0 when undefined.
     */
    unknownAttempts?: number;
    /**
     * Consecutive replays that found the original BullMQ job reaped. Reset by any
     * other observation; treated as 0 when undefined.
     */
    jobMissingObservations?: number;
    /**
     * Runner instance whose attempt produced this terminal write. A write whose
     * job was reaped is applied only over a row that instance still owns, never
     * over a successor attempt's row; without it such a write is not applied.
     */
    ownerInstanceId?: string;
}

// ── PendingWriteDrain ─────────────────────────────────────────────────────────

export class PendingWriteDrain {
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private tickIntervalMs = 5_000;
    /** The timer tick currently running, if any. stop() waits for it. */
    private inFlightTick: Promise<void> | null = null;
    /** Set by stop(); a tick that fires after it does not claim or drain. */
    private stopped = false;
    private readonly authority: Readonly<AuthorityToken> | undefined;

    constructor(
        private readonly sql: postgres.Sql,
        private readonly getClient: () => Promise<ValkeyLike>,
        authority?: AuthorityToken,
    ) {
        this.authority = captureValkeyAuthority(authority);
    }

    // -- enqueue ---------------------------------------------------------------

    /**
     * Enqueue a pending write. If the list is at capacity (10 000 entries) the
     * oldest entry (tail of the LPUSH list, i.e. `LINDEX -1`) is dropped and a
     * warning is logged. Dropping the oldest — rather than the new write — avoids
     * losing recent state updates that callers depend on for run lifecycle.
     *
     * Note: LPUSH prepends (newest at index 0). We pop with RPOP during drain
     * (oldest first). At capacity a single fenced Lua script moves the tail to the
     * bounded poison list and then pushes the incoming entry.
     */
    async enqueue(write: PendingWrite, options: { strict?: boolean } = {}): Promise<void> {
        try {
            // Snapshot before awaiting Valkey so a caller cannot change the
            // authority or payload while this write waits to be enqueued. Keep
            // serialization inside the catch boundary: plugin results may not
            // be JSON-safe, and callers can enqueue without awaiting the result.
            const encoded = JSON.stringify(write);
            if (typeof encoded !== 'string') throw new Error('Pending write is not serializable');
            const original = captureValkeyAuthority(write.authority);
            const client = await this.getClient();
            // Capacity transfer, bounded poison retention, and the incoming
            // push share ONE ownership fence. LMOVE preserves the evicted raw
            // payload even if a later command fails; there is no naked RPOP.
            const droppedRaw = await invokeFencedValkey(
                `-- task-pending-enqueue-v1
                local dropped = false
                if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[2]) then
                    dropped = redis.call('LMOVE', KEYS[1], KEYS[2], 'RIGHT', 'LEFT')
                    if dropped then
                        redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[3]) - 1)
                        redis.call('PEXPIRE', KEYS[2], ARGV[4])
                    end
                end
                redis.call('LPUSH', KEYS[1], ARGV[1])
                return dropped`,
                [LIST_KEY, POISON_KEY],
                [encoded, LIST_CAP, POISON_CAP, POISON_TTL_MS],
                client,
                original,
            );
            if (
                options.strict &&
                droppedRaw !== null &&
                droppedRaw !== false &&
                typeof droppedRaw !== 'string' &&
                !(droppedRaw instanceof Uint8Array)
            )
                throw new Error('Invalid pending-write acknowledgement');
            if (droppedRaw !== null && droppedRaw !== undefined && droppedRaw !== false) {
                let droppedRunId = 'unknown';
                let droppedKind: string = UNKNOWN_KIND_LABEL;
                try {
                    const decoded = JSON.parse(String(droppedRaw)) as Partial<PendingWrite>;
                    if (typeof decoded.runId === 'string') droppedRunId = decoded.runId;
                    if (decoded.kind === 'insert' || decoded.kind === 'update')
                        droppedKind = decoded.kind;
                } catch {
                    /* Preserve undecodable entries as raw poison payloads. */
                }
                taskPendingWriteDroppedTotal.inc({ kind: droppedKind });
                log.warn('PendingWriteDrain: list at capacity, dropped oldest entry', {
                    cap: LIST_CAP,
                    runId: droppedRunId,
                });
            }
        } catch (err) {
            log.error(
                'PendingWriteDrain.enqueue failed',
                err instanceof Error ? err : new Error(String(err)),
                {
                    runId: write.runId,
                },
            );
            if (options.strict)
                throw new Error('UNKNOWN: pending-write enqueue is unconfirmed', { cause: err });
        }
    }

    // -- start / stop ----------------------------------------------------------

    /**
     * Start the background drain timer. Idempotent — calling start() twice has
     * no effect.
     */
    start(intervalMs: number = 5_000): void {
        if (this.timer) return;
        this.stopped = false;
        this.tickIntervalMs = intervalMs;
        this.timer = setInterval(() => {
            if (this.stopped || this.inFlightTick) return;
            this.inFlightTick = this.tickIfLeader()
                .catch((err: unknown) => {
                    log.warn('PendingWriteDrain tick failed', {
                        err: err instanceof Error ? err.message : String(err),
                    });
                })
                .finally(() => {
                    this.inFlightTick = null;
                });
        }, intervalMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        log.info('PendingWriteDrain started', { intervalMs });
    }

    /**
     * Acquire a per-window leadership bucket and drain if won.
     *
     * Why leader-gate: the underlying drain is already cross-replica safe
     * (atomic RPOP serializes consumers), but every replica running its
     * own 5s timer means N round-trips to Valkey per tick just to find
     * out the list is empty 99% of the time. Per-window SETNX on
     * `lock:pending-write-drain:<bucket>` reduces that to exactly one
     * round-trip per tick across the fleet, matching the scheduler /
     * sessions-cache leader-election pattern.
     *
     * Ownership or reachability errors skip this tick. Atomic list operations
     * do not authorize a stale owner to claim or acknowledge durable entries.
     */
    private async tickIfLeader(): Promise<void> {
        let claimed: boolean;
        try {
            const client = await this.getClient();
            const intervalMs = this.tickIntervalMs;
            const bucket = Math.floor(Date.now() / intervalMs);
            // TTL ≈ tick interval; floored at 2s for sub-2s configs.
            const ttlMs = Math.max(2_000, intervalMs - 1_000);
            const result = await this.mutate(client, [
                'SET',
                `lock:pending-write-drain:${bucket}`,
                config.INSTANCE_ID,
                'NX',
                'PX',
                String(Math.round(ttlMs)),
            ]);
            claimed = result === 'OK';
        } catch {
            log.warn('PendingWriteDrain lock claim failed, skipping tick');
            claimed = false;
        }
        if (!claimed) return;
        // Leader confirmed above — liveness beat before the (possibly slow) drain.
        await beatAlive('pending-write-drain');
        await this.drain().catch((err: unknown) => {
            log.error(
                'PendingWriteDrain.drain threw',
                err instanceof Error ? err : new Error(String(err)),
            );
        });
    }

    /**
     * Stop the timer and wait (bounded) for the tick in flight, so a successor
     * cannot start a drain that overlaps ours. Resolves true once no tick is
     * running, false if the wait timed out.
     */
    stop(timeoutMs: number = LOOP_STOP_TIMEOUT_MS): Promise<boolean> {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        return awaitInFlightTick('pending-write-drain', this.inFlightTick, timeoutMs);
    }

    // -- drain -----------------------------------------------------------------

    /**
     * One drain pass. Claims up to DRAIN_BATCH entries from the list tail
     * (oldest first) via crash-safe `LMOVE` onto PROCESSING_KEY and replays
     * them to Postgres, acking (LREM) each one off PROCESSING_KEY once it's
     * durably handled. A failed write is re-enqueued at the head (LPUSH) and
     * the drain pass breaks immediately — that gives Postgres at least one
     * full drain interval of breathing room before the next retry instead of
     * cycling the same entry within one pass.
     */
    async drain(): Promise<{ drained: number; remaining: number }> {
        if (this.running) return { drained: 0, remaining: -1 };
        this.running = true;
        let drained = 0;
        try {
            const client = await this.getClient();

            // Crash-recovery sweep FIRST: anything still sitting on
            // PROCESSING_KEY is a leftover from a claim that never got acked
            // (process killed mid-replay). Move it back onto LIST_KEY before
            // computing depth so a post-crash backlog shows up in the alert
            // metrics immediately instead of hiding on the processing list
            // (this is also why `len` below doesn't need a separate LLEN on
            // PROCESSING_KEY added in — the sweep already merged it in).
            await this.recoverProcessing(client);

            const len = await this.llen(client);

            // Alert on high depth.
            if (len > ALERT_DEPTH) {
                log.warn('PendingWriteDrain: list depth exceeds alert threshold', {
                    depth: len,
                    threshold: ALERT_DEPTH,
                });
            }

            // Claim up to DRAIN_BATCH oldest entries (tail → same side RPOP
            // used to read) via crash-safe LMOVE onto PROCESSING_KEY. Every
            // exit from this loop body below must ack (LREM) the raw string
            // off PROCESSING_KEY once its fate (replayed / dropped / poisoned
            // / re-enqueued) is durably decided — never before.
            const toPop = Math.min(len, DRAIN_BATCH);
            let retainedUnknown = 0;
            for (let i = 0; i < toPop; i++) {
                if (this.stopped) break;
                const raw = await this.mutate(client, [
                    'LMOVE',
                    LIST_KEY,
                    PROCESSING_KEY,
                    'RIGHT',
                    'LEFT',
                ]);
                if (raw === null || raw === undefined) break;
                const rawStr = String(raw);

                let write: PendingWrite;
                try {
                    write = JSON.parse(rawStr) as PendingWrite;
                } catch {
                    log.warn('PendingWriteDrain: malformed entry dropped', {
                        raw: rawStr,
                    });
                    await this.ackProcessing(client, rawStr);
                    drained++;
                    continue;
                }

                // Alert on stale entry.
                const ageMs = Date.now() - write.enqueuedAt;
                if (ageMs > ALERT_AGE_MS) {
                    log.warn('PendingWriteDrain: stale entry', {
                        runId: write.runId,
                        ageMs,
                        threshold: ALERT_AGE_MS,
                    });
                }

                const replayed = await this.replayWrite(write);
                if (replayed.ok) {
                    await this.ackProcessing(client, rawStr);
                    drained++;
                } else if (replayed.attemptUnknown) {
                    // No guessed attempt receipt and no lost outcome: retain the
                    // payload until its queue/SQL proof returns. A reaped job is
                    // applied after a few observations (replayWrite) and does not
                    // count; any other UNKNOWN is dead-lettered at the bound.
                    const unknownAttempts =
                        (write.unknownAttempts ?? 0) + (replayed.jobMissing ? 0 : 1);
                    const bumped: PendingWrite = {
                        ...write,
                        unknownAttempts,
                        jobMissingObservations: replayed.jobMissing
                            ? (write.jobMissingObservations ?? 0) + 1
                            : 0,
                    };
                    if (!replayed.jobMissing && unknownAttempts >= MAX_UNKNOWN_REPLAY_ATTEMPTS) {
                        log.error(
                            'PendingWriteDrain: queue attempt stayed UNKNOWN, moving to DLQ',
                            new Error('pending-write-poison'),
                            {
                                runId: write.runId,
                                kind: write.kind,
                                jobId: write.queueAttempt?.id,
                                unknownAttempts,
                                reason: 'attempt-unknown-exhausted',
                                ageMs: Date.now() - write.enqueuedAt,
                            },
                        );
                        await this.transferProcessing(
                            client,
                            rawStr,
                            JSON.stringify({
                                ...bumped,
                                rejectionReason: 'attempt-unknown-exhausted',
                            }),
                            true,
                        );
                        taskPendingWritePoisonedTotal.inc({ kind: write.kind });
                        drained++;
                    } else {
                        // LPUSH lands behind every waiting entry (claims take the
                        // other end), so one UNKNOWN entry cannot block the list.
                        await this.transferProcessing(
                            client,
                            rawStr,
                            JSON.stringify(bumped),
                            false,
                        );
                        if (++retainedUnknown >= MAX_RETAINED_UNKNOWN_PER_TICK) break;
                    }
                } else if (replayed.authorityError) {
                    // An obsolete (or invalid) generation cannot become valid on
                    // retry. Keep its original token and payload as evidence for
                    // reconciliation; acknowledge only after the DLQ write lands.
                    await this.transferProcessing(
                        client,
                        rawStr,
                        JSON.stringify({
                            ...write,
                            rejectionReason: `authority:${replayed.authorityError}`,
                        }),
                        true,
                    );
                    taskPendingWritePoisonedTotal.inc({ kind: write.kind });
                    drained++;
                } else if (
                    replayed.transient &&
                    (write.transientAttempts ?? 0) + 1 < MAX_TRANSIENT_REPLAY_ATTEMPTS
                ) {
                    // Transient failure (PG unreachable / connection drop). Don't
                    // count it toward the NON-transient poison threshold — a
                    // multi-minute outage would otherwise poison perfectly valid
                    // writes after ~10 ticks. Bump only the transient counter and
                    // re-enqueue to the head, then break to give Postgres a full
                    // drain interval of breathing room before the next retry.
                    // The bounded transientAttempts (checked above) guarantees an
                    // entry that ALWAYS fails transiently is eventually poisoned
                    // (next branch) rather than wedging the head forever.
                    //
                    // The bumped copy is a NEW string re-pushed to LIST_KEY, not
                    // the original claimed entry — ack the ORIGINAL raw string
                    // off PROCESSING_KEY or it would double (one copy re-queued
                    // on LIST_KEY, the stale original still parked on
                    // PROCESSING_KEY forever).
                    const bumped: PendingWrite = {
                        ...write,
                        transientAttempts: (write.transientAttempts ?? 0) + 1,
                    };
                    await this.transferProcessing(client, rawStr, JSON.stringify(bumped), false);
                    break;
                } else {
                    // Either a non-transient failure, OR a transient failure that
                    // has exhausted MAX_TRANSIENT_REPLAY_ATTEMPTS (a deterministic
                    // transient error wedging the head). Count toward poison.
                    const transientExhausted = replayed.transient;
                    const attempts = (write.attempts ?? 0) + 1;
                    if (transientExhausted || attempts >= MAX_REPLAY_ATTEMPTS) {
                        // Poison message — move to DLQ list and stop
                        // retrying so the main list keeps draining.
                        log.error(
                            'PendingWriteDrain: poison message, moving to DLQ',
                            new Error('pending-write-poison'),
                            {
                                runId: write.runId,
                                kind: write.kind,
                                attempts,
                                transientAttempts: write.transientAttempts ?? 0,
                                reason: transientExhausted ? 'transient-exhausted' : 'max-attempts',
                                maxAttempts: MAX_REPLAY_ATTEMPTS,
                                ageMs: Date.now() - write.enqueuedAt,
                            },
                        );
                        // Keep the processing claim until poison publication,
                        // bounds and removal complete under the same fence. A
                        // failed poison write must never acknowledge the source.
                        await this.transferProcessing(
                            client,
                            rawStr,
                            JSON.stringify({
                                ...write,
                                attempts,
                                transientAttempts:
                                    (write.transientAttempts ?? 0) + (transientExhausted ? 1 : 0),
                            }),
                            true,
                        );
                        taskPendingWritePoisonedTotal.inc({ kind: write.kind });
                        // Count poisoned entries as "drained" so the loop's
                        // remaining-count math stays consistent.
                        drained++;
                    } else {
                        // Re-enqueue with bumped attempt counter. Use LPUSH so the
                        // entry lands at the head of the list — combined with the
                        // break below, the entry waits a full drain interval before
                        // the next retry instead of being popped again in this same
                        // pass. The RPOP/LPUSH would otherwise still cycle within
                        // one pass without the break.
                        const bumped: PendingWrite = { ...write, attempts };
                        await this.transferProcessing(
                            client,
                            rawStr,
                            JSON.stringify(bumped),
                            false,
                        );
                        // Break after the first re-enqueue so the entry is not
                        // immediately re-popped in this same drain pass.
                        break;
                    }
                }
            }

            const remaining = await this.llen(client);

            // Observability heartbeat (Slice 0). `depth` = the pre-drain list
            // length; status degrades when the backlog is over the alert
            // threshold (Postgres has likely been unreachable). Best-effort.
            await writeHeartbeat('pending-write-drain', {
                status: remaining > ALERT_DEPTH ? 'degraded' : 'ok',
                detail: { drained, remaining, depth: len },
            });

            return { drained, remaining };
        } finally {
            this.running = false;
        }
    }

    // -- private ---------------------------------------------------------------

    /** Fence each queue-list mutation at the actual coordination boundary.
     * Enqueue supplies its entry's origin; drain reconciliation uses the
     * drainer's immutable origin, never replacing the replay entry's token. */
    private async mutate(
        client: ValkeyLike,
        command: string[],
        options?: { authority?: AuthorityToken },
    ): Promise<unknown> {
        const authority = options ? options.authority : this.authority;
        const [operation, firstKey, ...args] = command;
        if (operation === 'LMOVE') {
            return invokeFencedValkey(
                "return redis.call('LMOVE', KEYS[1], KEYS[2], ARGV[1], ARGV[2])",
                [firstKey, args[0]],
                args.slice(1),
                client,
                authority,
            );
        }
        return invokeFencedValkey(
            'return redis.call(ARGV[1], KEYS[1], unpack(ARGV, 2))',
            [firstKey],
            [operation, ...args],
            client,
            authority,
        );
    }

    private async llen(client: ValkeyLike): Promise<number> {
        const result = await client.customCommand(['LLEN', LIST_KEY]);
        return typeof result === 'number' ? result : parseInt(String(result ?? '0'), 10);
    }

    /**
     * Ack a claimed entry: remove the exact raw string that `LMOVE` moved
     * onto PROCESSING_KEY. Must only be called once the entry's fate
     * (replayed / dropped / poisoned / re-enqueued elsewhere) is durably
     * decided — calling it any earlier reopens the crash-loss window this
     * fix closes. `LREM key 1 value` removes a single matching occurrence
     * (head→tail), which is sufficient here: PROCESSING_KEY should contain
     * at most one copy of a given raw string during normal (single-leader)
     * operation.
     */
    private async ackProcessing(client: ValkeyLike, raw: string): Promise<void> {
        await this.mutate(client, ['LREM', PROCESSING_KEY, '1', raw]);
    }

    /**
     * Crash-recovery sweep. Moves every entry still sitting on
     * PROCESSING_KEY back onto LIST_KEY (`LMOVE PROCESSING_KEY LIST_KEY LEFT
     * RIGHT`, repeated until empty) so a claim that was never acked — because
     * the process was killed between the LMOVE claim and the replay/ack —
     * gets redrained instead of vanishing.
     *
     * Entries only accumulate here across a crash: normal flow acks
     * synchronously in the same tick that claims an entry, and the drain
     * loop is leader-gated (concurrent drainers across replicas are rare,
     * limited to the moment leadership changes hands). Popping from the LEFT
     * of PROCESSING_KEY (the most recently claimed entry) and pushing to the
     * RIGHT of LIST_KEY (the next position `LMOVE ... RIGHT LEFT` will claim)
     * means recovered entries — which have already been silently stuck since
     * the crash — are redrained on the very next claim rather than waiting
     * behind the rest of the backlog.
     *
     * Bounded defensively at LIST_CAP iterations; PROCESSING_KEY can't
     * realistically hold more than DRAIN_BATCH entries even after a crash,
     * since only one drain tick's worth of claims are ever in flight at once.
     */
    private async recoverProcessing(client: ValkeyLike): Promise<number> {
        let recovered = 0;
        for (let i = 0; i < LIST_CAP; i++) {
            const moved = await this.mutate(client, [
                'LMOVE',
                PROCESSING_KEY,
                LIST_KEY,
                'LEFT',
                'RIGHT',
            ]);
            if (moved === null || moved === undefined) break;
            recovered++;
        }
        if (recovered > 0) {
            log.warn('PendingWriteDrain: recovered crash-orphaned entries from processing list', {
                recovered,
            });
        }
        return recovered;
    }

    /** Publish a replacement and acknowledge its exact processing claim under
     * one fence. Destination errors leave the original claim recoverable. */
    private async transferProcessing(
        client: ValkeyLike,
        raw: string,
        encoded: string,
        poison: boolean,
    ): Promise<void> {
        await invokeFencedValkey(
            `-- task-pending-transfer-v1
            redis.call('LPUSH', KEYS[2], ARGV[2])
            if ARGV[3] == '1' then
                redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[4]) - 1)
                redis.call('PEXPIRE', KEYS[2], ARGV[5])
            end
            return redis.call('LREM', KEYS[1], 1, ARGV[1])`,
            [PROCESSING_KEY, poison ? POISON_KEY : LIST_KEY],
            [raw, encoded, poison ? '1' : '0', POISON_CAP, POISON_TTL_MS],
            client,
            this.authority,
        );
    }

    private async replayWrite(write: PendingWrite): Promise<ReplayResult> {
        try {
            // Valkey/BullMQ lookups run before the authority transaction opens:
            // a slow or unreachable queue must never hold a PostgreSQL connection
            // (or the shared management lock) while it waits.
            let observation: QueueAttemptObservation = 'current';
            if (write.kind === 'update' && write.queueAttempt) {
                observation = await this.observeQueueAttempt(write, write.queueAttempt);
                if (observation === 'settled') return { ok: true };
                if (observation === 'missing') {
                    if ((write.jobMissingObservations ?? 0) + 1 < TERMINAL_JOB_MISSING_ACCEPT_AFTER)
                        return {
                            ok: false,
                            transient: true,
                            attemptUnknown: true,
                            jobMissing: true,
                        };
                    // Without the original owner the attempt cannot be told
                    // apart from a successor's: leave it UNKNOWN (bounded).
                    if (!write.ownerInstanceId)
                        return { ok: false, transient: true, attemptUnknown: true };
                    observation = 'missing-accepted';
                }
            }
            await withExistingTaskWrite(this.sql, write.authority, async (sql) => {
                if (write.kind === 'insert') {
                    await this.replayInsert(sql, write);
                } else {
                    await this.replayUpdate(sql, write, observation);
                }
            });
            return { ok: true };
        } catch (err) {
            if (err instanceof TerminalAttemptUnknownError)
                return { ok: false, transient: true, attemptUnknown: true };
            if (
                err instanceof AuthorityError &&
                err.code === 'stale_authority' &&
                (await this.authorityUnchanged(write.authority))
            ) {
                // A lease that lapsed during a PostgreSQL outage is not a lost
                // generation. Keep retrying while owner and generation stand.
                log.warn('PendingWriteDrain: stale authority with unchanged owner, will retry', {
                    runId: write.runId,
                    kind: write.kind,
                });
                return { ok: false, transient: true };
            }
            if (err instanceof AuthorityError || err instanceof ZodError) {
                return {
                    ok: false,
                    transient: false,
                    authorityError: err instanceof AuthorityError ? err.code : 'invalid',
                };
            }
            const transient = isTransientPgError(err);
            log.warn('PendingWriteDrain: replay failed, will retry', {
                runId: write.runId,
                kind: write.kind,
                transient,
                err: err instanceof Error ? err.message : String(err),
            });
            return { ok: false, transient };
        }
    }

    /**
     * Observe the original queue attempt with the drain's own SQL handle, outside
     * any write transaction. Throws TerminalAttemptUnknownError/AuthorityError for
     * observations that cannot be classified.
     */
    private async observeQueueAttempt(
        write: PendingWrite,
        attempt: TerminalQueueAttempt,
    ): Promise<QueueAttemptObservation> {
        try {
            const current = await terminalQueueAttemptCurrent(
                attempt,
                write.runId,
                write.authority,
                () => this.terminalStateConfirmed(this.sql, write),
            );
            return current ? 'current' : 'settled';
        } catch (err) {
            if (err instanceof TerminalAttemptJobMissingError) return 'missing';
            throw err;
        }
    }

    /** PostgreSQL already holds this write's outcome (or a superseding terminal one). */
    private async terminalStateConfirmed(
        sql: postgres.Sql | postgres.TransactionSql,
        write: PendingWrite,
    ): Promise<boolean> {
        const p = write.payload;
        if (Object.prototype.hasOwnProperty.call(p, 'result'))
            return terminalResultConfirmed(sql, write.runId, String(p.state), p.result);
        const rows = await sql<
            { state: string }[]
        >`SELECT state FROM task_history WHERE id = ${write.runId}`;
        return (
            rows[0]?.state === p.state ||
            rows[0]?.state === 'completed' ||
            rows[0]?.state === 'cancelled'
        );
    }

    /**
     * Apply a terminal write whose BullMQ job was reaped. Inside the write
     * transaction: re-confirm in SQL, then update only a row the original
     * attempt's runner instance still owns in a running state. A successor's
     * pending/active row (re-dispatch under a new job id) is left untouched and
     * PostgreSQL's outcome is accepted.
     */
    private async replayReapedAttempt(
        sql: postgres.Sql | postgres.TransactionSql,
        write: PendingWrite,
    ): Promise<void> {
        if (await this.terminalStateConfirmed(sql, write)) return;
        const p = write.payload;
        const state = String(p.state ?? 'failed');
        const completedAt = p.completedAt != null ? String(p.completedAt) : null;
        const errorValue =
            p.error != null ? sql.json(p.error as unknown as postgres.JSONValue) : null;
        const owner = String(write.ownerInstanceId);
        const rows = Object.prototype.hasOwnProperty.call(p, 'result')
            ? await sql`
                UPDATE task_history
                SET state        = ${state},
                    completed_at = ${completedAt},
                    result       = ${p.result != null ? sql.json(p.result as postgres.JSONValue) : null},
                    error        = ${errorValue}
                WHERE id = ${write.runId}
                  AND owner_instance_id = ${owner}
                  AND (state IN ('active', 'cancelling')
                       OR (state = 'failed' AND ${state}::text = 'completed'))
                  AND (state <> 'cancelling' OR error->>'code' IS DISTINCT FROM 'HARD_KILL_QUEUE_PENDING')
                RETURNING id`
            : await sql`
                UPDATE task_history
                SET state        = ${state},
                    completed_at = ${completedAt},
                    error        = ${errorValue}
                WHERE id = ${write.runId}
                  AND owner_instance_id = ${owner}
                  AND (state IN ('active', 'cancelling')
                       OR (state = 'failed' AND ${state}::text = 'completed'))
                  AND (state <> 'cancelling' OR error->>'code' IS DISTINCT FROM 'HARD_KILL_QUEUE_PENDING')
                RETURNING id`;
        if (rows.length === 0)
            log.warn('PendingWriteDrain: terminal job reaped, accepting PostgreSQL outcome', {
                runId: write.runId,
                state,
                jobId: write.queueAttempt?.id,
            });
    }

    /**
     * True when a managed entry's `stale_authority` rejection does not mean the
     * writer lost its generation: the partition still names the same owner and
     * generation (only the lease lapsed). Undecidable checks (PostgreSQL
     * unreachable) also retry. Unmanaged (tokenless) entries are never retried:
     * `withUnmanagedWrite` rejects them only once a task authority row exists,
     * and a tokenless write can never succeed in that state (tokenless queue
     * writes refuse it too, via `withTaskQueueWrite`'s cached 30 s check).
     */
    private async authorityUnchanged(authority: AuthorityToken | undefined): Promise<boolean> {
        if (authority === undefined) return false;
        try {
            await new AuthorityStore(this.sql).getSnapshot(authority);
            return true;
        } catch (err) {
            return !(err instanceof AuthorityError || err instanceof ZodError);
        }
    }

    /**
     * Idempotency (verified — required by the crash-safe claim above: a
     * process can be killed AFTER a replay lands in Postgres but BEFORE the
     * `LREM` ack, so the recovery sweep can hand this same entry back for a
     * second replay): `ON CONFLICT (id) DO NOTHING` makes a repeat INSERT for
     * the same `runId` a silent no-op — no error, `{ ok: true }` both times.
     */
    private async replayInsert(
        sql: postgres.Sql | postgres.TransactionSql,
        write: PendingWrite,
    ): Promise<void> {
        const p = write.payload;
        await sql`
            INSERT INTO task_history (
                id, task_id, parent_run_id, label, state,
                input, scope, trigger, actor,
                started_at, heartbeat_at,
                processing_version, owner_instance_id,
                retention_policy, stages
            ) VALUES (
                ${write.runId},
                ${String(p.taskId ?? '')},
                ${p.parentRunId != null ? String(p.parentRunId) : null},
                ${String(p.label ?? '')},
                ${String(p.state ?? 'pending')},
                ${sql.json((p.input ?? {}) as Record<string, never>)},
                ${p.scope != null ? sql.json(p.scope as Record<string, never>) : null},
                ${sql.json((p.trigger ?? { kind: 'in-process' }) as Record<string, never>)},
                ${sql.json((p.actor ?? { type: 'system' }) as Record<string, never>)},
                ${String(p.startedAt ?? new Date().toISOString())},
                ${String(p.startedAt ?? new Date().toISOString())},
                ${String(p.processingVersion ?? '1')},
                ${p.ownerInstanceId != null ? String(p.ownerInstanceId) : null},
                ${String(p.retentionPolicy ?? 'standard')},
                ${sql.json((p.stages ?? []) as never[])}
            )
            ON CONFLICT (id) DO NOTHING
        `;
    }

    /**
     * Idempotency (verified — same crash/recovery-sweep double-replay concern
     * as `replayInsert`): every UPDATE below is guarded by
     * `WHERE id = ... AND (state NOT IN ('completed','failed','cancelled') OR
     * (state = 'failed' AND allowOverwrite))`. After a first replay lands, the
     * row's `state` is already terminal, so a repeat UPDATE for the same
     * write matches zero rows and postgres.js resolves normally (no error,
     * no rows affected) rather than throwing — `replayWrite` still reports
     * `{ ok: true }` on the harmless repeat. New attempt-bearing runner
     * results additionally enrich a NULL same-state terminal mirror exactly
     * once after queue validation; existing results and terminal metadata stay.
     */
    private async replayUpdate(
        sql: postgres.Sql | postgres.TransactionSql,
        write: PendingWrite,
        observation: QueueAttemptObservation,
    ): Promise<void> {
        if (observation === 'missing-accepted') {
            await this.replayReapedAttempt(sql, write);
            return;
        }
        const p = write.payload;
        // Do not acknowledge an unapplied deferred result as successful while
        // queue cleanup is uncertain. Quarantine the original payload instead.
        if (write.authority) {
            const blocked = await sql`SELECT id FROM task_history WHERE id = ${write.runId}
                AND state = 'cancelling' AND error->>'code' = 'HARD_KILL_QUEUE_PENDING'`;
            if (blocked.length !== 0) throw new AuthorityError('conflict');
        }
        const state = String(p.state ?? 'failed');
        const completedAt = p.completedAt != null ? String(p.completedAt) : null;
        const errorValue =
            p.error != null ? sql.json(p.error as unknown as postgres.JSONValue) : null;
        // Allow `failed → completed` overwrite for the retry-success path,
        // mirroring runner.writeTerminalToPostgres / the orchestrator's terminal
        // write. The clause is a no-op for any non-completed target state, so it
        // doesn't change behaviour for the orchestrator's intermediate-state
        // (e.g. 'cancelling') enqueues.
        const allowOverwrite = state === 'completed';

        // `cancel_requested_at` is carried only on the orchestrator's
        // cancelling-mirror enqueue (the DB-down fallback for cancelRun). Without
        // replaying it, a cancel deferred through the drain leaves the column NULL
        // and the run becomes permanently invisible to the reconciler's
        // cancel-grace sweep — re-opening the very wedge this fix closes. Include
        // the column only when the payload carries the key so other replays can't
        // clobber an existing timestamp with null.
        if (Object.prototype.hasOwnProperty.call(p, 'cancelRequestedAt')) {
            const cancelRequestedAt =
                p.cancelRequestedAt != null ? String(p.cancelRequestedAt) : null;
            await sql`
                UPDATE task_history
                SET state               = ${state},
                    completed_at        = ${completedAt},
                    cancel_requested_at = ${cancelRequestedAt},
                    error               = ${errorValue}
                WHERE id = ${write.runId}
                  AND (state NOT IN ('completed', 'failed', 'cancelled')
                       OR (state = 'failed' AND ${allowOverwrite}))
                  AND (state <> 'cancelling' OR error->>'code' IS DISTINCT FROM 'HARD_KILL_QUEUE_PENDING')
            `;
            return;
        }

        // `result` is only carried on terminal completed/failed writes from the
        // runner (the orchestrator's update enqueues omit it). Include the
        // column in the SET only when the payload actually carries the key, so
        // an intermediate-state replay can't clobber an existing result with
        // null.
        if (Object.prototype.hasOwnProperty.call(p, 'result')) {
            const resultValue = p.result != null ? sql.json(p.result as postgres.JSONValue) : null;
            // Only a new entry whose original queue attempt was freshly verified
            // may enrich a state-only terminal mirror. Preserve its terminal
            // state, error and completion time; never replace an existing result.
            if (write.queueAttempt && p.result != null) {
                await sql`UPDATE task_history SET result = ${resultValue}
                    WHERE id = ${write.runId} AND state = ${state}
                      AND state IN ('completed', 'failed') AND result IS NULL`;
            }
            await sql`
                UPDATE task_history
                SET state        = ${state},
                    completed_at = ${completedAt},
                    result       = ${resultValue},
                    error        = ${errorValue}
                WHERE id = ${write.runId}
                  AND (state NOT IN ('completed', 'failed', 'cancelled')
                       OR (state = 'failed' AND ${allowOverwrite}))
                  AND (state <> 'cancelling' OR error->>'code' IS DISTINCT FROM 'HARD_KILL_QUEUE_PENDING')
            `;
            if (
                write.queueAttempt &&
                !(await terminalResultConfirmed(sql, write.runId, state, p.result))
            )
                throw new TerminalAttemptUnknownError(
                    'UNKNOWN: original terminal result is unconfirmed',
                );
            return;
        }

        await sql`
            UPDATE task_history
            SET state        = ${state},
                completed_at = ${completedAt},
                error        = ${errorValue}
            WHERE id = ${write.runId}
              AND (state NOT IN ('completed', 'failed', 'cancelled')
                   OR (state = 'failed' AND ${allowOverwrite}))
                  AND (state <> 'cancelling' OR error->>'code' IS DISTINCT FROM 'HARD_KILL_QUEUE_PENDING')
        `;
    }
}
