// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Per-task circuit breaker — DB-backed (no Valkey mirror).
//
// Opens after 5 consecutive failures (primary) or 10 failures in 30 min
// (secondary / pragmatic simplification of the 80% rate rule). Exponential
// backoff: 1 min → 5 min → 30 min → 2 h, keyed on how many times the task
// has tripped (consecutive_failures ÷ THRESHOLD, saturating at 4).
//
// Half-open probe: a single Valkey SETNX gate (`task:probe:<id> 1 NX EX 300`)
// allows one caller through when the cooldown expires. If the probe succeeds
// the circuit closes; if it fails the cooldown extends with the next backoff.
//
// Force-enable: writes manual_override='force_enabled' + override_at. Expires
// after LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS — checked at query time, not via
// a separate TTL column.

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import {
    LUMASTRA_CIRCUIT_FAILURE_THRESHOLD,
    LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS,
    LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS,
} from '$lib/server/config.js';
import { type ValkeyLike, errMessage } from './valkey-types.js';
import { appendAuditEvent } from './observability/audit-log.js';

const log = Logger.for('CircuitBreaker');

// ── Types ─────────────────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half_open';
export type ForceOverride = 'force_enabled' | null;

export interface CircuitDecision {
    allowed: boolean;
    state: CircuitState;
    reason?: 'force_enabled' | 'half_open_probe_taken' | 'open_with_cooldown' | 'circuit_open';
    nextProbeAt?: Date;
}

// Row shape from task_circuit_state.
interface CircuitRow {
    task_id: string;
    state: CircuitState;
    consecutive_failures: number;
    failure_rate_window_count: number;
    failure_rate_window_started_at: Date | null;
    opened_at: Date | null;
    opened_reason: string | null;
    next_probe_at: Date | null;
    manual_override: string | null;
    override_by: string | null;
    override_at: Date | null;
}

// Backoff steps keyed on trip index (saturates at step 3).
const BACKOFF_MS = [
    60_000, // 1 min
    300_000, // 5 min
    1_800_000, // 30 min
    7_200_000, // 2 h
];

// Failure rate window: open after this many failures within the window.
// Pragmatic cap — equivalent to "most of 30 min of activity is failures".
const RATE_WINDOW_FAILURE_CAP = 10;

// ── CircuitBreaker ────────────────────────────────────────────────────────────

export class CircuitBreaker {
    constructor(
        private readonly sql: postgres.Sql,
        private readonly getClient: () => ValkeyLike | null,
    ) {}

    // -- Public API -----------------------------------------------------------

    /**
     * Check whether a task is allowed to run. Called by the orchestrator before
     * enqueue. Creates the circuit row on first call (closed state).
     */
    async check(taskId: string): Promise<CircuitDecision> {
        const row = await this.getOrCreate(taskId);

        // Force-enable bypass.
        if (row.manual_override === 'force_enabled' && row.override_at) {
            const expiresAt = row.override_at.getTime() + LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS;
            if (Date.now() < expiresAt) {
                return {
                    allowed: true,
                    state: row.state,
                    reason: 'force_enabled',
                };
            }
        }

        if (row.state === 'closed') {
            return { allowed: true, state: 'closed' };
        }

        if (row.state === 'half_open') {
            // The probe holder was admitted at the open→half_open transition and
            // holds the SETNX probe lock (`task:probe:<id>`, 300s TTL). If that
            // lock is now FREE, the in-flight probe is gone: a probe that merely
            // FINISHED would have flipped this row out of half_open via
            // reportSuccess/reportFailure, so a still-half_open row with no lock
            // means the probe RUN was orphaned (worker died before reporting).
            // Without re-probing here the circuit stays half_open forever, denying
            // every caller until a manual force-enable — the self-heal gap. So try
            // to (re)acquire the probe: success ⇒ the lock was free (dead/absent
            // probe) and THIS caller becomes the new prober; failure ⇒ a probe is
            // genuinely in flight, deny as before. This converges a stuck half_open
            // on the next enqueue (also covering a quiesced task whose probe died).
            const reprobe = await this.tryAcquireProbeLock(taskId);
            if (reprobe) {
                return {
                    allowed: true,
                    state: 'half_open',
                    reason: 'half_open_probe_taken',
                };
            }
            return {
                allowed: false,
                state: 'half_open',
                reason: 'circuit_open',
            };
        }

        // state === 'open'
        const now = Date.now();
        const probeAt = row.next_probe_at?.getTime() ?? 0;

        if (now < probeAt) {
            return {
                allowed: false,
                state: 'open',
                reason: 'open_with_cooldown',
                nextProbeAt: row.next_probe_at ?? undefined,
            };
        }

        // Cooldown has elapsed — try to acquire the half-open probe lock.
        const acquired = await this.tryAcquireProbeLock(taskId);
        if (!acquired) {
            // Another replica already holds the probe, OR Valkey is
            // unreachable. Either way fail closed so a degraded cache
            // layer can't accidentally let every replica probe at once
            // and flatten a recovering downstream.
            return {
                allowed: false,
                state: 'open',
                reason: 'open_with_cooldown',
                nextProbeAt: row.next_probe_at ?? undefined,
            };
        }

        // Transition DB row to half_open so peers know a probe is in-flight.
        // The `state = 'open'` guard prevents racing transitions from
        // overwriting a forceEnable or a closed state that landed between
        // the SELECT above and this UPDATE.
        await this.sql`
            UPDATE task_circuit_state
            SET state = 'half_open'
            WHERE task_id = ${taskId}
              AND state = 'open'
        `;

        return {
            allowed: true,
            state: 'half_open',
            reason: 'half_open_probe_taken',
        };
    }

    /**
     * Read-only view of what `check()` would decide, for status screens and
     * APIs. `check()` is the orchestrator's admission gate: past the cooldown it
     * takes the probe lock and flips the row to half_open, so calling it from a
     * read path would spend the probe slot without starting a run and block the
     * real probe for the lock's 300 s TTL. This never writes and never locks.
     *
     * An open circuit whose cooldown has elapsed reports `allowed: true` with
     * state 'open' — the next enqueue will probe. A half_open circuit reports
     * `allowed: false`: a probe is in flight, or the next enqueue reclaims an
     * orphaned one.
     */
    async peek(taskId: string): Promise<CircuitDecision> {
        const rows = await this.sql<CircuitRow[]>`
            SELECT task_id, state, consecutive_failures,
                   failure_rate_window_count, failure_rate_window_started_at,
                   opened_at, opened_reason, next_probe_at,
                   manual_override, override_by, override_at
            FROM task_circuit_state
            WHERE task_id = ${taskId}
        `;
        const row = rows[0];
        if (!row) return { allowed: true, state: 'closed' };

        if (row.manual_override === 'force_enabled' && row.override_at) {
            const expiresAt = row.override_at.getTime() + LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS;
            if (Date.now() < expiresAt) {
                return { allowed: true, state: row.state, reason: 'force_enabled' };
            }
        }
        if (row.state === 'closed') return { allowed: true, state: 'closed' };
        if (row.state === 'half_open') {
            return { allowed: false, state: 'half_open', reason: 'circuit_open' };
        }
        const probeAt = row.next_probe_at?.getTime() ?? 0;
        if (Date.now() < probeAt) {
            return {
                allowed: false,
                state: 'open',
                reason: 'open_with_cooldown',
                nextProbeAt: row.next_probe_at ?? undefined,
            };
        }
        return { allowed: true, state: 'open', nextProbeAt: row.next_probe_at ?? undefined };
    }

    /**
     * Report a successful run. Closes the circuit if it was half_open; resets
     * consecutive_failures in all cases.
     */
    async reportSuccess(taskId: string): Promise<void> {
        try {
            // Read the pre-update state to detect the half_open → closed recovery
            // transition for the audit log. Two statements rather than a CTE so
            // the simple UPDATE stays parseable by the in-memory test SQL stub;
            // reportSuccess is once-per-run-success, not a hot loop. The state
            // transition itself remains atomic in the UPDATE's CASE — only the
            // (best-effort, informational) audit flag is read-then-write, so a
            // rare concurrent transition can at worst mis-log one audit row.
            const before = await this.sql<{ state: string }[]>`
                SELECT state FROM task_circuit_state WHERE task_id = ${taskId}
            `;
            const wasHalfOpen = before[0]?.state === 'half_open';
            await this.sql`
                UPDATE task_circuit_state
                SET consecutive_failures = 0,
                    state = CASE WHEN state = 'half_open' THEN 'closed' ELSE state END,
                    next_probe_at = CASE WHEN state = 'half_open' THEN NULL ELSE next_probe_at END,
                    opened_at     = CASE WHEN state = 'half_open' THEN NULL ELSE opened_at END,
                    opened_reason = CASE WHEN state = 'half_open' THEN NULL ELSE opened_reason END
                WHERE task_id = ${taskId}
            `;
            if (wasHalfOpen) {
                // Recovery: a half_open probe succeeded and the circuit closed.
                void appendAuditEvent({
                    category: 'circuit-breaker',
                    action: 'circuit-closed',
                    severity: 'info',
                    summary: `Circuit closed for ${taskId} (probe succeeded).`,
                    detail: { taskId },
                });
            }
        } catch (err) {
            log.warn('CircuitBreaker.reportSuccess DB write failed', {
                taskId,
                err: errMessage(err),
            });
        }
    }

    /**
     * Report a failed run. May open the circuit.
     *
     * Callers MUST NOT pass `kind: 'permanent'` here — permanent failures
     * (bad data, schema mismatch, invalid IDs) are excluded at the call site
     * in runner.ts because waiting will never fix them and a backlog of them
     * would open the circuit as noise. Only transient / fatal failures drive
     * the consecutive-failure count.
     */
    async reportFailure(
        taskId: string,
        error: { kind: 'transient' | 'permanent' | 'fatal' },
    ): Promise<void> {
        try {
            const row = await this.getOrCreate(taskId);

            const newConsecutive = row.consecutive_failures + 1;
            const now = new Date();

            // Sliding window accounting.
            let windowCount = row.failure_rate_window_count;
            let windowStarted = row.failure_rate_window_started_at;

            const windowAgeMs = windowStarted ? now.getTime() - windowStarted.getTime() : Infinity;

            if (windowAgeMs > LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS || !windowStarted) {
                windowCount = 1;
                windowStarted = now;
            } else {
                windowCount += 1;
            }

            const shouldOpen =
                newConsecutive >= LUMASTRA_CIRCUIT_FAILURE_THRESHOLD ||
                windowCount >= RATE_WINDOW_FAILURE_CAP;

            if (shouldOpen && row.state === 'closed') {
                // tripIndex 0 = 1 min (first trip), 1 = 5 min, 2 = 30 min, 3 = 2 h.
                // newConsecutive == THRESHOLD on the very first trip; with the
                // naive floor() formula that yields tripIndex=1 (5 min) which
                // is one step too aggressive. Subtract 1 and clamp at 0.
                const tripIndex = Math.min(
                    Math.max(
                        0,
                        Math.floor(newConsecutive / LUMASTRA_CIRCUIT_FAILURE_THRESHOLD) - 1,
                    ),
                    BACKOFF_MS.length - 1,
                );
                const backoffMs = BACKOFF_MS[tripIndex];
                const nextProbeAt = new Date(now.getTime() + backoffMs);
                const openedReason =
                    newConsecutive >= LUMASTRA_CIRCUIT_FAILURE_THRESHOLD
                        ? 'consecutive_failures'
                        : 'failure_rate';

                log.warn('CircuitBreaker opening', {
                    taskId,
                    reason: openedReason,
                    consecutiveFailures: newConsecutive,
                    windowCount,
                    backoffMs,
                    error: error.kind,
                });

                await this.sql`
                    UPDATE task_circuit_state
                    SET state                          = 'open',
                        consecutive_failures           = ${newConsecutive},
                        failure_rate_window_count      = ${windowCount},
                        failure_rate_window_started_at = ${windowStarted},
                        opened_at                      = ${now},
                        opened_reason                  = ${openedReason},
                        next_probe_at                  = ${nextProbeAt}
                    WHERE task_id = ${taskId}
                `;
                // Observability (Slice 0): circuit opened (closed → open). Best-effort.
                void appendAuditEvent({
                    category: 'circuit-breaker',
                    action: 'circuit-opened',
                    severity: 'error',
                    summary: `Circuit opened for ${taskId} (${openedReason}).`,
                    detail: {
                        taskId,
                        reason: openedReason,
                        consecutiveFailures: newConsecutive,
                        windowCount,
                        backoffMs,
                    },
                });
            } else if (row.state === 'half_open') {
                // Probe failed — re-open with a longer backoff.
                const tripIndex = Math.min(
                    Math.floor(newConsecutive / LUMASTRA_CIRCUIT_FAILURE_THRESHOLD) + 1,
                    BACKOFF_MS.length - 1,
                );
                const backoffMs = BACKOFF_MS[tripIndex];
                const nextProbeAt = new Date(now.getTime() + backoffMs);

                log.warn('CircuitBreaker probe failed, re-opening', {
                    taskId,
                    backoffMs,
                    error: error.kind,
                });

                await this.sql`
                    UPDATE task_circuit_state
                    SET state                          = 'open',
                        consecutive_failures           = ${newConsecutive},
                        failure_rate_window_count      = ${windowCount},
                        failure_rate_window_started_at = ${windowStarted},
                        opened_at                      = ${now},
                        opened_reason                  = 'probe_failure',
                        next_probe_at                  = ${nextProbeAt}
                    WHERE task_id = ${taskId}
                `;
                // Observability (Slice 0): circuit re-opened after a failed
                // half_open probe. Best-effort.
                void appendAuditEvent({
                    category: 'circuit-breaker',
                    action: 'circuit-opened',
                    severity: 'error',
                    summary: `Circuit re-opened for ${taskId} (probe_failure).`,
                    detail: { taskId, reason: 'probe_failure', backoffMs },
                });
            } else if (row.state === 'open') {
                // Continued failures while the circuit is already open should
                // extend the cooldown window, not just bump counters. Otherwise
                // a downstream that's been failing for hours still re-opens
                // its probe gate on the original short timer.
                const tripIndex = Math.min(
                    Math.max(
                        0,
                        Math.floor(newConsecutive / LUMASTRA_CIRCUIT_FAILURE_THRESHOLD) - 1,
                    ),
                    BACKOFF_MS.length - 1,
                );
                const backoffMs = BACKOFF_MS[tripIndex];
                const nextProbeAt = new Date(now.getTime() + backoffMs);

                await this.sql`
                    UPDATE task_circuit_state
                    SET consecutive_failures           = ${newConsecutive},
                        failure_rate_window_count      = ${windowCount},
                        failure_rate_window_started_at = ${windowStarted},
                        next_probe_at                  = ${nextProbeAt}
                    WHERE task_id = ${taskId}
                `;
            } else {
                // Counts haven't tripped yet — just update counters.
                await this.sql`
                    UPDATE task_circuit_state
                    SET consecutive_failures           = ${newConsecutive},
                        failure_rate_window_count      = ${windowCount},
                        failure_rate_window_started_at = ${windowStarted}
                    WHERE task_id = ${taskId}
                `;
            }
        } catch (err) {
            log.warn('CircuitBreaker.reportFailure DB write failed', {
                taskId,
                err: errMessage(err),
            });
        }
    }

    /**
     * Admin force-enable: bypass the circuit for up to LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS.
     * Does not change `state` — the force-enable is a time-limited override checked in check().
     */
    async forceEnable(taskId: string, by: string): Promise<void> {
        await this.getOrCreate(taskId);
        await this.sql`
            UPDATE task_circuit_state
            SET manual_override = 'force_enabled',
                override_by     = ${by},
                override_at     = NOW()
            WHERE task_id = ${taskId}
        `;
        log.info('CircuitBreaker force-enable set', { taskId, by });
    }

    // -- Private helpers ------------------------------------------------------

    private async getOrCreate(taskId: string): Promise<CircuitRow> {
        const rows = await this.sql<CircuitRow[]>`
            SELECT task_id, state, consecutive_failures,
                   failure_rate_window_count, failure_rate_window_started_at,
                   opened_at, opened_reason, next_probe_at,
                   manual_override, override_by, override_at
            FROM task_circuit_state
            WHERE task_id = ${taskId}
        `;
        if (rows.length > 0) return rows[0];

        // First-time insert — closed state.
        await this.sql`
            INSERT INTO task_circuit_state (task_id, state)
            VALUES (${taskId}, 'closed')
            ON CONFLICT (task_id) DO NOTHING
        `;

        const inserted = await this.sql<CircuitRow[]>`
            SELECT task_id, state, consecutive_failures,
                   failure_rate_window_count, failure_rate_window_started_at,
                   opened_at, opened_reason, next_probe_at,
                   manual_override, override_by, override_at
            FROM task_circuit_state
            WHERE task_id = ${taskId}
        `;
        return inserted[0];
    }

    /**
     * Attempt to acquire the half-open probe lock for `taskId`. Returns true
     * only when this caller is the sole permitted probe for the cooldown
     * window.
     *
     * Failure modes — both fail CLOSED (deny the probe):
     *   - No Valkey client wired up: without the lock we have no way to
     *     stop every replica from probing simultaneously, which would
     *     defeat the breaker's "one canary at a time" guarantee.
     *   - Probe-lock command threw: same reasoning. We'd rather extend
     *     the cooldown by another tick than stampede a recovering
     *     downstream while the cache layer is degraded.
     */
    private async tryAcquireProbeLock(taskId: string): Promise<boolean> {
        try {
            const client = this.getClient();
            if (!client) return false; // No Valkey — fail closed.
            const result = await client.customCommand([
                'SET',
                `task:probe:${taskId}`,
                '1',
                'NX',
                'EX',
                '300',
            ]);
            return result === 'OK';
        } catch (err) {
            log.warn('CircuitBreaker probe lock acquire failed — failing closed', {
                taskId,
                err: errMessage(err),
            });
            return false;
        }
    }
}
