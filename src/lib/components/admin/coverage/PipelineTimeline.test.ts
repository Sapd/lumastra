// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Un-ignore: the way back from an operator's own "give up".
 *
 * The load-bearing rule is that the button must appear on EXACTLY the rows the
 * server will act on. `unskipItemStage` restores only `skipped_permanent` rows
 * whose `skipped_reason LIKE 'operator-%'`; the disposition runner writes the
 * same status for stages that genuinely don't apply, and un-skipping one of
 * those sets it pending, stage-sweep re-skips it, and the operator watches
 * their own action silently undo itself. So a button on a system skip is worse
 * than no button — these tests pin both sides of that gate.
 */

import { render, screen, fireEvent, within } from '@testing-library/svelte';
import { describe, expect, test, vi } from 'vitest';
import PipelineTimeline from './PipelineTimeline.svelte';
import type { TimelineStage } from '$lib/schemas/pipeline-timeline.schema.js';

function makeStage(over: Partial<TimelineStage> = {}): TimelineStage {
    return {
        stageId: 'season-poster',
        taskId: 'provider-artwork-season-poster',
        taskName: 'Provider Artwork: Season posters',
        status: 'completed',
        processingVersion: 1,
        attempt: 0,
        skippedReason: null,
        lastError: null,
        startedAt: null,
        completedAt: null,
        nextEligibleAt: null,
        timeInStageMs: null,
        run: null,
        diagnosis: null,
        operatorState: 'done',
        updatedAt: new Date().toISOString(),
        ...over,
    } as TimelineStage;
}

/** A row an operator ignored by hand — the only reversible kind. */
function operatorSkipped(reason = 'operator-gave-up'): TimelineStage {
    return makeStage({
        status: 'skipped_permanent',
        operatorState: 'skipped',
        skippedReason: reason,
    });
}

function renderTimeline(stages: TimelineStage[]) {
    return render(PipelineTimeline, { mediaItemId: 'item-1', stages });
}

describe('PipelineTimeline — owning task hint', () => {
    test('names the owning task when the step name would not lead you to it', () => {
        // The audit's case was "Quick scan failed" under a task called "Media
        // File Probe". Builtin steps now carry their task's name (one
        // vocabulary), so this still matters for a plugin step whose
        // humanized id shares nothing with its task's name.
        renderTimeline([
            makeStage({
                stageId: 'frame-sampler',
                taskId: 'acme-vision',
                taskName: 'Acme Vision',
            }),
        ]);
        expect(screen.getByText(/part of Acme Vision/)).toBeTruthy();
    });

    test('a builtin step named after its task needs no hint', () => {
        renderTimeline([
            makeStage({
                stageId: 'media-probe-a',
                taskId: 'media-probe',
                taskName: 'Read Media File Details',
            }),
        ]);
        expect(screen.queryByText(/part of/)).toBeNull();
    });

    test('stays quiet when the names already share a word', () => {
        // "Poster art" under "Provider Artwork: Posters" leads there on its own;
        // repeating the task on every row would be noise. poster/posters and
        // art/artwork must count as shared, or this fires on good copy.
        renderTimeline([
            makeStage({
                stageId: 'provider-artwork-poster',
                taskId: 'provider-artwork-poster',
                taskName: 'Provider Artwork: Posters',
            }),
        ]);
        expect(screen.queryByText(/part of/)).toBeNull();
    });

    test('stays quiet when no task owns the stage', () => {
        renderTimeline([makeStage({ taskName: null })]);
        expect(screen.queryByText(/part of/)).toBeNull();
    });
});

describe('PipelineTimeline — un-ignore', () => {
    test('offers Un-ignore on an operator-ignored row', () => {
        renderTimeline([operatorSkipped()]);
        expect(screen.getByRole('button', { name: 'Un-ignore' })).toBeTruthy();
    });

    test.each([
        ['predicate-false', 'a stage that does not apply'],
        ['ineligible', 'the disposition runner'],
        ['unsupported-media-type', 'a wrong-media-type skip'],
        ['no-match-upstream', 'a provider miss'],
    ])('does NOT offer Un-ignore on a system skip (%s)', (reason) => {
        // Mirrors the server's `skipped_reason LIKE 'operator-%'` gate. Without
        // this, the button returns restored:0 and appears to do nothing.
        renderTimeline([
            makeStage({
                status: 'skipped_permanent',
                operatorState: 'skipped',
                skippedReason: reason,
            }),
        ]);
        expect(screen.queryByRole('button', { name: 'Un-ignore' })).toBeNull();
    });

    test('does NOT offer Un-ignore on a skipped row with no reason at all', () => {
        renderTimeline([
            makeStage({
                status: 'skipped_permanent',
                operatorState: 'skipped',
                skippedReason: null,
            }),
        ]);
        expect(screen.queryByRole('button', { name: 'Un-ignore' })).toBeNull();
    });

    test.each([
        ['failed_permanent', 'failed'],
        ['failed_transient', 'failed'],
        ['completed', 'done'],
        ['pending', 'waiting'],
    ])('does NOT offer Un-ignore on a %s row', (status, operatorState) => {
        // Un-ignore is not a retry: resurrecting a failed row is
        // resetFailedPermanent's job, and the server refuses these outright.
        renderTimeline([
            makeStage({
                status: status as TimelineStage['status'],
                operatorState: operatorState as TimelineStage['operatorState'],
                // Even with an operator-looking reason, the STATUS disqualifies it.
                skippedReason: 'operator-gave-up',
            }),
        ]);
        expect(screen.queryByRole('button', { name: 'Un-ignore' })).toBeNull();
    });

    test('an operator ignore does not read like a system skip', () => {
        // "Doesn't apply to this item" is actively misleading when the reason it
        // doesn't apply is that the operator said so.
        renderTimeline([operatorSkipped()]);
        expect(screen.getByText(/You ignored this step for this item\./)).toBeTruthy();
        expect(screen.queryByText(/Doesn't apply/)).toBeNull();
    });

    test('surfaces the operator note when one was given', () => {
        renderTimeline([operatorSkipped('operator-gave-up: bad source file, will re-rip')]);
        expect(screen.getByText(/bad source file, will re-rip/)).toBeTruthy();
    });

    test('never renders the raw operator- reason code', () => {
        const { container } = renderTimeline([operatorSkipped()]);
        expect(container.textContent).not.toContain('operator-gave-up');
    });
});

describe('PipelineTimeline — music analysis without an engine (Windows e2e S7)', () => {
    test('explains essentia-unavailable instead of showing the code', () => {
        const { container } = renderTimeline([
            makeStage({
                stageId: 'music-analysis',
                taskId: 'music-analysis',
                taskName: 'Analyze Music Audio',
                status: 'skipped_permanent',
                operatorState: 'skipped',
                skippedReason: 'essentia-unavailable',
            }),
        ]);
        expect(container.textContent).toContain('Audio analysis is unavailable on this host.');
        expect(container.textContent).not.toContain('essentia-unavailable');
    });
});

const oldStart = '2026-08-01T10:00:00.000Z';
function run(
    over: Partial<NonNullable<TimelineStage['run']>> = {},
): NonNullable<TimelineStage['run']> {
    return {
        runId: 'historical-run-id',
        state: 'expired',
        ownerInstanceId: null,
        heartbeatAt: null,
        startedAt: oldStart,
        alive: false,
        ...over,
    };
}
describe('PipelineTimeline truthful attempt timing', () => {
    test.each([
        'pending',
        'failed_transient',
        'failed_permanent',
        'skipped_permanent',
        'obsolete',
    ] as const)('%s never claims a historical elapsed value is a completion', (status) => {
        renderTimeline([
            makeStage({
                status,
                operatorState: status.startsWith('failed')
                    ? 'failed'
                    : status === 'pending'
                      ? 'waiting'
                      : 'skipped',
                startedAt: oldStart,
                completedAt: null,
                timeInStageMs: 5601180000,
                run: run(),
            }),
        ]);
        expect(screen.queryByText(/completed in/i)).toBeNull();
        expect(screen.queryByText(/^Running \d/)).toBeNull();
        expect(screen.getByText(/Historical attempt started/)).toBeTruthy();
        expect(screen.getByText('Historical run reference')).toBeTruthy();
        expect(screen.getByText('Log record expired')).toBeTruthy();
    });
    test('completed timing comes from consistent attempt timestamps, not a retained elapsed field', () => {
        const started = Date.now() - 120000;
        renderTimeline([
            makeStage({
                startedAt: new Date(started).toISOString(),
                completedAt: new Date(started + 30000).toISOString(),
                timeInStageMs: 5601180000,
                run: run({ state: 'completed', startedAt: new Date(started - 1000).toISOString() }),
            }),
        ]);
        expect(screen.getByText('Completed in 30s')).toBeTruthy();
        expect(screen.queryByText(/1555h/)).toBeNull();
    });
    test.each(['expired', 'inverted', 'different-attempt'] as const)(
        'does not claim a completion duration with %s evidence',
        (kind) => {
            const started = Date.now() - 120000;
            renderTimeline([
                makeStage({
                    startedAt: new Date(started).toISOString(),
                    completedAt: new Date(
                        started + (kind === 'inverted' ? -1000 : 30000),
                    ).toISOString(),
                    timeInStageMs: 5601180000,
                    run: run({
                        state: kind === 'expired' ? 'expired' : 'completed',
                        startedAt: new Date(
                            started + (kind === 'different-attempt' ? 10000 : -1000),
                        ).toISOString(),
                    }),
                }),
            ]);
            expect(screen.queryByText(/Completed in/)).toBeNull();
            expect(screen.getByText('Completion timing is unverified.')).toBeTruthy();
        },
    );
    test('shows running time only for the current live attempt', () => {
        const started = Date.now() - 60000;
        renderTimeline([
            makeStage({
                status: 'running',
                operatorState: 'waiting',
                startedAt: new Date(started).toISOString(),
                completedAt: null,
                timeInStageMs: 60000,
                run: run({
                    state: 'active',
                    alive: true,
                    heartbeatAt: new Date().toISOString(),
                    startedAt: new Date(started - 1000).toISOString(),
                }),
            }),
        ]);
        expect(screen.getByText('Running 1m 0s')).toBeTruthy();
        expect(screen.getByText(/Current attempt started/)).toBeTruthy();
        expect(screen.queryByText(/completed in/i)).toBeNull();
    });
    test.each(['expired', 'no-heartbeat', 'different-attempt'] as const)(
        'marks running duration unverified with %s evidence',
        (kind) => {
            const started = Date.now() - 60000;
            renderTimeline([
                makeStage({
                    status: 'running',
                    operatorState: 'waiting',
                    startedAt: new Date(started).toISOString(),
                    completedAt: null,
                    timeInStageMs: 5601180000,
                    run: run({
                        state: kind === 'expired' ? 'expired' : 'active',
                        alive: kind === 'different-attempt',
                        startedAt: new Date(
                            started + (kind === 'different-attempt' ? 1000 : -1000),
                        ).toISOString(),
                    }),
                }),
            ]);
            expect(screen.getByText('Live attempt timing is unverified.')).toBeTruthy();
            expect(screen.queryByText(/^Running \d/)).toBeNull();
        },
    );
    test('reevaluation explains eligibility/state scope without promising processor execution', async () => {
        renderTimeline([
            makeStage({
                status: 'pending',
                operatorState: 'waiting',
                diagnosis: {
                    reason: 'predicate-blocked',
                    summary: 'Waiting on eligibility',
                    detail: {},
                    remediable: true,
                },
            }),
        ]);
        expect(screen.getByText(/Reevaluation checks eligibility/)).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Re-evaluate' }));
        const dialog = screen.getByRole('dialog');
        expect(
            within(dialog).getByText(/this is not proof that the selected processor ran/),
        ).toBeTruthy();
    });
});

test('a frozen heartbeat snapshot loses verified running timing without any stage SSE event', async () => {
    vi.useFakeTimers();
    try {
        const now = Date.now();
        renderTimeline([
            makeStage({
                status: 'running',
                operatorState: 'waiting',
                startedAt: new Date(now - 60000).toISOString(),
                completedAt: null,
                timeInStageMs: 60000,
                run: run({
                    state: 'active',
                    alive: true,
                    heartbeatAt: new Date(now).toISOString(),
                    startedAt: new Date(now - 61000).toISOString(),
                }),
            }),
        ]);
        expect(screen.getByText('Running 1m 0s')).toBeTruthy();
        await vi.advanceTimersByTimeAsync(31000);
        expect(screen.getByText('Live attempt timing is unverified.')).toBeTruthy();
        expect(screen.queryByText('Running 1m 0s')).toBeNull();
    } finally {
        vi.useRealTimers();
    }
});

describe('cooperative season analysis explanation', () => {
    test.each(['pending', 'failed_transient'] as const)(
        'renders restrained season context for %s without a false orphan or per-item ETA',
        (status) => {
            const explanation = 'Audio matching is handled for the whole season.';
            renderTimeline([
                makeStage({
                    stageId: 'lumastra-intro-analyzer:acoustic',
                    taskId: 'lumastra-intro-analyzer',
                    taskName: 'Intro analysis',
                    status,
                    operatorState: status === 'pending' ? 'waiting' : 'failed',
                    prioritizable: false,
                    diagnosis: {
                        reason: 'none',
                        summary: explanation,
                        detail: {
                            coordination: 'season-cohort',
                            taskId: 'lumastra-intro-analyzer',
                        },
                        remediable: false,
                    },
                    lastError:
                        status === 'failed_transient' ? { message: 'Audio matching failed' } : null,
                }),
            ]);
            expect(screen.getByText(explanation)).toBeTruthy();
            expect(
                screen.queryByText(
                    /Lost its worker|will never be picked up|no time estimate|about \d/i,
                ),
            ).toBeNull();
            expect(screen.queryByText('season-cohort')).toBeNull();
            expect(screen.queryByText('lumastra-intro-analyzer')).toBeNull();
            expect(screen.queryByRole('button', { name: 'Do this one first' })).toBeNull();
            if (status === 'failed_transient')
                expect(screen.getByRole('button', { name: /Audio matching failed/ })).toBeTruthy();
        },
    );
});
