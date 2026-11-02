// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure unit tests for `diagnoseStuckStage` (Slice 2). No DB, no Valkey — the
 * function is fed a pre-probed context. Covers every `StuckReason` branch under
 * its precondition AND the priority order the spec §7 mandates.
 */

import { describe, it, expect } from 'vitest';
import {
    diagnoseStuckStage,
    estimateWaitMs,
    stageOperatorState,
    type DiagnosisContext,
    type DiagnosisStageInput,
} from './pipeline-diagnosis.js';
import type { TimelineRunRef } from '$lib/schemas/pipeline-timeline.schema.js';

const NOW = new Date('2026-06-03T12:00:00Z');

function stage(overrides: Partial<DiagnosisStageInput> = {}): DiagnosisStageInput {
    return {
        stageId: 'media-probe',
        taskId: 'media-probe',
        status: 'pending',
        skippedReason: null,
        nextEligibleAt: null,
        ...overrides,
    };
}

function ctx(overrides: Partial<DiagnosisContext> = {}): DiagnosisContext {
    return {
        now: NOW,
        circuit: null,
        paused: null,
        identityTtlMs: null,
        depth: null,
        probeUnavailable: false,
        ...overrides,
    };
}

function runRef(overrides: Partial<TimelineRunRef> = {}): TimelineRunRef {
    return {
        runId: 'run_abc',
        state: 'active',
        ownerInstanceId: 'web-1',
        heartbeatAt: NOW.toISOString(),
        startedAt: NOW.toISOString(),
        alive: true,
        ...overrides,
    };
}

describe('diagnoseStuckStage — branches', () => {
    it('running-healthy: running + alive run', () => {
        const d = diagnoseStuckStage(stage({ status: 'running' }), runRef({ alive: true }), ctx());
        expect(d.reason).toBe('running-healthy');
        expect(d.remediable).toBe(false);
    });

    it('orphaned-stage: no owning task', () => {
        const d = diagnoseStuckStage(stage({ taskId: null }), null, ctx());
        expect(d.reason).toBe('orphaned-stage');
    });

    it('worker-dead: running but run not alive', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'running' }),
            runRef({ alive: false, state: 'active' }),
            ctx(),
        );
        expect(d.reason).toBe('worker-dead');
    });

    it('circuit-open: owning task breaker open', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'failed_transient' }),
            null,
            ctx({
                circuit: {
                    state: 'open',
                    openedReason: 'consecutive_failures',
                    nextProbeAt: new Date(NOW.getTime() + 60_000),
                },
            }),
        );
        expect(d.reason).toBe('circuit-open');
        expect(d.summary).toContain('Circuit breaker open');
    });

    it('identity-locked: lock present, no live run', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'pending' }),
            null,
            ctx({ identityTtlMs: 3_600_000 }),
        );
        expect(d.reason).toBe('identity-locked');
        expect(d.detail.ttlMs).toBe(3_600_000);
        expect(d.remediable).toBe(true);
    });

    it('backpressure: class depth at cap', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'pending' }),
            null,
            ctx({ depth: { classDepth: 500, cap: 500 } }),
        );
        expect(d.reason).toBe('backpressure');
    });

    it('predicate-blocked: predicate-false skip reason', () => {
        const d = diagnoseStuckStage(
            stage({
                status: 'skipped_permanent',
                skippedReason: 'predicate-false',
            }),
            null,
            ctx(),
        );
        expect(d.reason).toBe('predicate-blocked');
        expect(d.remediable).toBe(true);
    });

    it('predicate-blocked: predicate-false-on-invalidation', () => {
        const d = diagnoseStuckStage(
            stage({
                status: 'skipped_permanent',
                skippedReason: 'predicate-false-on-invalidation',
            }),
            null,
            ctx(),
        );
        expect(d.reason).toBe('predicate-blocked');
    });

    // C3 fix-round-3 (2026-09-25 security review): the `metadata-locked`
    // terminalDisposition rule (metadata-sync.ts / mdblist-sync.ts) writes
    // this exact skipped_reason. Before this reason was added to
    // PREDICATE_BLOCKED_REASONS, a locked item's row fell through to
    // scheduled-wait/none — reading as an ordinary queue wait instead of
    // "skipped, does not apply right now".
    it('predicate-blocked: metadata-locked skip reason', () => {
        const d = diagnoseStuckStage(
            stage({
                status: 'skipped_transient',
                skippedReason: 'metadata-locked',
                nextEligibleAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
            }),
            null,
            ctx(),
        );
        expect(d.reason).toBe('predicate-blocked');
        expect(d.remediable).toBe(true);
    });

    it('scheduled-wait: next_eligible_at in the future', () => {
        const d = diagnoseStuckStage(
            stage({
                status: 'failed_transient',
                nextEligibleAt: new Date(NOW.getTime() + 60_000),
            }),
            null,
            ctx(),
        );
        expect(d.reason).toBe('scheduled-wait');
    });

    it('none: pending, eligible, nothing blocking', () => {
        const d = diagnoseStuckStage(stage({ status: 'pending' }), null, ctx());
        expect(d.reason).toBe('none');
    });
});

describe('diagnoseStuckStage — priority order', () => {
    it('worker-dead beats scheduled-wait when both apply', () => {
        const d = diagnoseStuckStage(
            stage({
                status: 'running',
                nextEligibleAt: new Date(NOW.getTime() + 60_000),
            }),
            runRef({ alive: false }),
            ctx(),
        );
        expect(d.reason).toBe('worker-dead');
    });

    it('circuit-open beats backpressure when both apply', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'failed_transient' }),
            null,
            ctx({
                circuit: {
                    state: 'open',
                    openedReason: 'failure_rate',
                    nextProbeAt: null,
                },
                depth: { classDepth: 999, cap: 500 },
            }),
        );
        expect(d.reason).toBe('circuit-open');
    });

    it('running-healthy checked before everything for a live run', () => {
        // Even with a future next_eligible_at and a held identity lock, a live
        // running stage is healthy, not stuck.
        const d = diagnoseStuckStage(
            stage({
                status: 'running',
                nextEligibleAt: new Date(NOW.getTime() + 60_000),
            }),
            runRef({ alive: true }),
            ctx({ identityTtlMs: 5_000 }),
        );
        expect(d.reason).toBe('running-healthy');
    });

    it('orphaned-stage beats circuit/backpressure (no task to own them)', () => {
        const d = diagnoseStuckStage(
            stage({ taskId: null, status: 'pending' }),
            null,
            ctx({ depth: { classDepth: 999, cap: 1 } }),
        );
        expect(d.reason).toBe('orphaned-stage');
    });
});

describe('diagnoseStuckStage — Valkey probe unavailable', () => {
    it('identity-locked does NOT fire when probe is unavailable', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'pending' }),
            null,
            ctx({ identityTtlMs: 3_600_000, probeUnavailable: true }),
        );
        expect(d.reason).toBe('none');
        expect(d.detail.probe).toBe('unavailable');
    });

    it('backpressure does NOT fire when probe is unavailable', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'pending' }),
            null,
            ctx({ depth: { classDepth: 999, cap: 1 }, probeUnavailable: true }),
        );
        expect(d.reason).toBe('none');
    });

    it('probe-unavailable does NOT change a non-Valkey verdict (circuit-open)', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'failed_transient' }),
            null,
            ctx({
                circuit: {
                    state: 'open',
                    openedReason: 'consecutive_failures',
                    nextProbeAt: null,
                },
                probeUnavailable: true,
            }),
        );
        expect(d.reason).toBe('circuit-open');
    });

    it('probe-unavailable does NOT change a non-Valkey verdict (scheduled-wait)', () => {
        const d = diagnoseStuckStage(
            stage({
                status: 'failed_transient',
                nextEligibleAt: new Date(NOW.getTime() + 60_000),
            }),
            null,
            ctx({ probeUnavailable: true }),
        );
        expect(d.reason).toBe('scheduled-wait');
    });
});

// ── schedule-paused: an admin switched the step off ────────────────────────────

describe('diagnoseStuckStage — schedule-paused', () => {
    const paused = { pausedBy: 'denis', pausedAt: new Date('2026-06-03T09:00:00Z') };

    it('reports schedule-paused for a pending row on a paused task', () => {
        const d = diagnoseStuckStage(stage({ status: 'pending' }), null, ctx({ paused }));
        expect(d.reason).toBe('schedule-paused');
        // Resuming is a one-click PUT on the task's state, unlike circuit-open.
        expect(d.remediable).toBe(true);
        expect(d.detail.pausedBy).toBe('denis');
    });

    it('outranks circuit-open — a human "off" is the more actionable of the two', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'pending' }),
            null,
            ctx({
                paused,
                circuit: { state: 'open', openedReason: 'too many failures', nextProbeAt: null },
            }),
        );
        expect(d.reason).toBe('schedule-paused');
    });

    it('does NOT outrank worker-dead — a stale live run is the stronger signal', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'running' }),
            runRef({ alive: false, state: 'active' }),
            ctx({ paused }),
        );
        expect(d.reason).toBe('worker-dead');
    });

    it('says nothing about a settled row: the sweep was never going to claim it', () => {
        for (const status of ['skipped_permanent', 'failed_permanent'] as const) {
            const d = diagnoseStuckStage(stage({ status }), null, ctx({ paused }));
            expect(d.reason).not.toBe('schedule-paused');
        }
    });

    it('never leaks the raw task id into the operator summary', () => {
        const d = diagnoseStuckStage(
            stage({ status: 'pending', taskId: 'media-probe-a' }),
            null,
            ctx({ paused }),
        );
        expect(d.summary).not.toContain('media-probe-a');
    });
});

// ── The five operator buckets ──────────────────────────────────────────────────

describe('stageOperatorState', () => {
    it('maps the settled statuses onto their buckets', () => {
        expect(stageOperatorState('completed', null)).toBe('done');
        expect(stageOperatorState('failed_transient', null)).toBe('failed');
        expect(stageOperatorState('failed_permanent', null)).toBe('failed');
        expect(stageOperatorState('skipped_permanent', null)).toBe('skipped');
        expect(stageOperatorState('obsolete', null)).toBe('skipped');
        expect(stageOperatorState('pending', null)).toBe('waiting');
    });

    it('folds `running` into waiting — same "nothing for you to do yet" bucket', () => {
        expect(stageOperatorState('running', null)).toBe('waiting');
    });

    it('reads a paused pending row as off, not as waiting', () => {
        const d = {
            reason: 'schedule-paused' as const,
            summary: '',
            detail: {},
            remediable: true,
        };
        expect(stageOperatorState('pending', d)).toBe('off');
    });

    it('keeps a FAILED row failed even when the task is also paused', () => {
        // The error is the headline; the pause is an extra note on the row.
        const d = {
            reason: 'schedule-paused' as const,
            summary: '',
            detail: {},
            remediable: true,
        };
        expect(stageOperatorState('failed_transient', d)).toBe('failed');
    });

    it('reads a predicate-blocked row as skipped — it does not apply, it is not late', () => {
        const d = {
            reason: 'predicate-blocked' as const,
            summary: '',
            detail: {},
            remediable: true,
        };
        expect(stageOperatorState('pending', d)).toBe('skipped');
        expect(stageOperatorState('skipped_transient', d)).toBe('skipped');
    });

    it('keeps a skipped_transient row that is NOT predicate-blocked as queued work', () => {
        expect(stageOperatorState('skipped_transient', null)).toBe('waiting');
    });

    // C3 fix-round-3 (2026-09-25 security review): end-to-end through the
    // real diagnosis, not a hand-built StageDiagnosis literal — a locked
    // item's skipped_transient row reads as "skipped" (does not apply right
    // now), not "waiting" with a perpetually re-arming 6h ETA.
    it('reads a metadata-locked skipped_transient row as skipped, not waiting', () => {
        const d = diagnoseStuckStage(
            stage({
                status: 'skipped_transient',
                skippedReason: 'metadata-locked',
                nextEligibleAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
            }),
            null,
            ctx(),
        );
        expect(stageOperatorState('skipped_transient', d)).toBe('skipped');
    });
});

// ── ETA ────────────────────────────────────────────────────────────────────────

describe('estimateWaitMs', () => {
    it('returns zero when nothing is ahead', () => {
        expect(estimateWaitMs(0, 50)).toBe(0);
    });

    it('refuses to guess when nothing has finished recently', () => {
        // Never "now" and never Infinity — the caller renders no time at all.
        expect(estimateWaitMs(500, 0)).toBeNull();
    });

    it('divides the backlog by the observed rate', () => {
        // 50 completions in a 5 minute window = 10/min; 100 ahead = 10 minutes.
        expect(estimateWaitMs(100, 50)).toBe(10 * 60_000);
    });

    it('clamps to the dispatcher ceiling so it cannot promise a time the sweep cannot serve', () => {
        // 5000 completions in the window measures 1000/min, but the stage sweep
        // hands out at most 100/min — so 1000 ahead is 10 minutes, not 1.
        expect(estimateWaitMs(1000, 5000)).toBe(10 * 60_000);
    });
});
