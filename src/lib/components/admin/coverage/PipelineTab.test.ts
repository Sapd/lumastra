// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import PipelineTab from './PipelineTab.svelte';
import type {
    PipelineTimelineResponse,
    TimelineStage,
} from '$lib/schemas/pipeline-timeline.schema.js';

// ── MockEventSource ────────────────────────────────────────────────────────────

class MockEventSource {
    listeners: Record<string, ((ev: { data: string }) => void)[]> = {};
    constructor(public url: string) {}
    addEventListener(type: string, listener: (ev: { data: string }) => void): void {
        (this.listeners[type] ??= []).push(listener);
    }
    fire(type: string, data: unknown): void {
        for (const l of this.listeners[type] ?? []) l({ data: JSON.stringify(data) });
    }
    close(): void {}
}

let mockEs: MockEventSource | null = null;

const ITEM = 'item-uuid-1';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * `operatorState` is computed SERVER-side (`stageOperatorState`); the coarse
 * mapping here mirrors it for the statuses these tests use, and any test that
 * cares about a specific bucket passes it explicitly via `extra`.
 */
function defaultOperatorState(status: TimelineStage['status']): TimelineStage['operatorState'] {
    if (status === 'completed') return 'done';
    if (status === 'failed_transient' || status === 'failed_permanent') return 'failed';
    if (status === 'skipped_permanent' || status === 'obsolete') return 'skipped';
    return 'waiting';
}

function makeStage(
    stageId: string,
    status: TimelineStage['status'] = 'completed',
    extra: Partial<TimelineStage> = {},
): TimelineStage {
    return {
        stageId,
        taskId: `task-${stageId}`,
        taskName: `Task ${stageId}`,
        status,
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
        operatorState: defaultOperatorState(status),
        updatedAt: '2026-06-03T10:00:00.000Z',
        ...extra,
    };
}

function makeTimeline(stages: TimelineStage[]): PipelineTimelineResponse {
    const count = (pred: (s: TimelineStage) => boolean): number => stages.filter(pred).length;
    return {
        mediaItemId: ITEM,
        stages,
        events: [],
        summary: {
            total: stages.length,
            completed: count((s) => s.status === 'completed'),
            in_progress: count((s) => s.status === 'running'),
            failed: count(
                (s) => s.status === 'failed_transient' || s.status === 'failed_permanent',
            ),
            pending: count((s) => s.status === 'pending'),
            skipped: count(
                (s) => s.status === 'skipped_transient' || s.status === 'skipped_permanent',
            ),
            obsolete: count((s) => s.status === 'obsolete'),
        },
    };
}

function stubFetch(body: PipelineTimelineResponse): void {
    const res: Record<string, unknown> = {
        ok: true,
        status: 200,
        headers: { get: (_name: string) => null },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
        // apiGet clones the response before reading it (typedJson validation);
        // return an equivalent stub so the clone path works too.
        clone: () => res,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    mockEs = null;
    vi.stubGlobal(
        'EventSource',
        class {
            constructor(url: string) {
                mockEs = new MockEventSource(url);
                return mockEs;
            }
        },
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────────
// PipelineTab fetches /pipeline/timeline and renders the single-item timeline.
// PipelineTimeline labels each row with `pipelineStepName(stage.stageId)`, so
// unknown ids surface humanized ('probe' → 'Probe') and the raw id only shows
// in dev mode. Statuses `completed` / `failed_permanent` are asserted because
// they do NOT collide with the summary line's words (complete / failed / …).

describe('PipelineTab', () => {
    test('renders the timeline returned from the API', async () => {
        stubFetch(
            makeTimeline([
                makeStage('probe', 'completed'),
                makeStage('trickplay', 'failed_permanent'),
            ]),
        );

        render(PipelineTab, { mediaItemId: ITEM });

        expect(await screen.findByText('Probe')).toBeTruthy();
        expect(screen.getByText('Trickplay')).toBeTruthy();
        // status pills render the operator-friendly label (taskStatusLabel):
        // 'completed' → 'Done', 'failed_permanent' → 'Failed — gave up'.
        expect(screen.getByText('Done')).toBeTruthy();
        expect(screen.getByText('Failed — gave up')).toBeTruthy();
    });

    test('offers a "?" explaining what a known step does, and hides raw ids outside dev mode', async () => {
        stubFetch(makeTimeline([makeStage('mdblist-sync', 'completed')]));

        render(PipelineTab, { mediaItemId: ITEM });

        expect(await screen.findByText('Fetch MDBList Ratings')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'What does this step do?' })).toBeTruthy();
        // Raw stage/task ids are dev-mode only (admin IA spec §3.3).
        expect(screen.queryByText('mdblist-sync')).toBeNull();
        expect(screen.queryByText('task-mdblist-sync')).toBeNull();
    });

    test('shows the raw stage and task ids in dev mode', async () => {
        stubFetch(makeTimeline([makeStage('mdblist-sync', 'completed')]));

        render(PipelineTab, { mediaItemId: ITEM, devMode: true });

        expect(await screen.findByText('mdblist-sync')).toBeTruthy();
        expect(screen.getByText('task-mdblist-sync')).toBeTruthy();
    });

    test('omits the "?" for a stage nothing knows a description for', async () => {
        stubFetch(makeTimeline([makeStage('some-plugin-stage', 'completed')]));

        render(PipelineTab, { mediaItemId: ITEM });

        await screen.findByText('Some Plugin Stage');
        expect(screen.queryByRole('button', { name: 'What does this step do?' })).toBeNull();
    });

    test('patches a stage status in place on a matching stage-state-changed event', async () => {
        stubFetch(makeTimeline([makeStage('probe', 'failed_permanent')]));

        render(PipelineTab, { mediaItemId: ITEM });
        await screen.findByText('Probe');
        expect(screen.getByText('Failed — gave up')).toBeTruthy();

        mockEs!.fire('stage-state-changed', {
            mediaItemId: ITEM,
            stageId: 'probe',
            newStatus: 'completed',
            processingVersion: 1,
            kind: 'update',
        });

        await waitFor(() => expect(screen.getByText('Done')).toBeTruthy());
        expect(screen.queryByText('Failed — gave up')).toBeNull();
    });

    test('shows a banner when a delete event arrives for this item', async () => {
        stubFetch(makeTimeline([makeStage('probe')]));

        render(PipelineTab, { mediaItemId: ITEM });
        await screen.findByText('Probe');

        mockEs!.fire('stage-state-changed', {
            mediaItemId: ITEM,
            stageId: 'probe',
            newStatus: 'obsolete',
            processingVersion: 1,
            kind: 'delete',
        });

        await waitFor(() => expect(screen.getByText(/dismissed or deleted/i)).toBeTruthy());
    });

    test('ignores stage-state-changed events for other mediaItemIds', async () => {
        stubFetch(makeTimeline([makeStage('probe', 'completed')]));

        render(PipelineTab, { mediaItemId: ITEM });
        await screen.findByText('Probe');

        mockEs!.fire('stage-state-changed', {
            mediaItemId: 'other-item',
            stageId: 'probe',
            newStatus: 'failed_permanent',
            processingVersion: 1,
            kind: 'delete',
        });

        // Give the handler a tick; the delete banner must NOT appear and the
        // timeline must still be intact.
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByText(/dismissed or deleted/i)).toBeNull();
        expect(screen.getByText('Probe')).toBeTruthy();
        expect(screen.getByText('Done')).toBeTruthy();
    });

    // ── The five operator states ──────────────────────────────────────────────
    // Half of "it's broken" reports are a row that is actually waiting, not
    // applicable, or switched off. Each of these must read differently.

    test('a WAITING row shows its queue position and an ETA, not a failure', async () => {
        stubFetch(
            makeTimeline([
                makeStage('probe', 'pending', {
                    diagnosis: {
                        reason: 'none',
                        summary: 'Eligible and waiting.',
                        detail: {},
                        remediable: false,
                    },
                    queueWait: { itemsAhead: 812, atLeast: false, etaMs: 40 * 60_000 },
                }),
            ]),
        );

        render(PipelineTab, { mediaItemId: ITEM });

        expect(await screen.findByText(/812 items ahead/)).toBeTruthy();
        expect(screen.getByText(/about 40 minutes/)).toBeTruthy();
        expect(screen.getByText('Waiting')).toBeTruthy();
    });

    test('a WAITING row with no measurable throughput shows position but refuses to guess a time', async () => {
        stubFetch(
            makeTimeline([
                makeStage('probe', 'pending', {
                    diagnosis: {
                        reason: 'none',
                        summary: 'Eligible and waiting.',
                        detail: {},
                        remediable: false,
                    },
                    queueWait: { itemsAhead: 40, atLeast: false, etaMs: null },
                }),
            ]),
        );

        render(PipelineTab, { mediaItemId: ITEM });

        expect(await screen.findByText(/40 items ahead/)).toBeTruthy();
        expect(screen.getByText(/no time estimate yet/)).toBeTruthy();
    });

    test('a capped position reads as a floor, never as an exact number', async () => {
        stubFetch(
            makeTimeline([
                makeStage('probe', 'pending', {
                    diagnosis: {
                        reason: 'none',
                        summary: 'Eligible and waiting.',
                        detail: {},
                        remediable: false,
                    },
                    queueWait: { itemsAhead: 10_001, atLeast: true, etaMs: null },
                }),
            ]),
        );

        render(PipelineTab, { mediaItemId: ITEM });

        expect(await screen.findByText(/More than 10,?001 items ahead/)).toBeTruthy();
    });

    test('"Do this one first" is offered only when the server says it can honestly run', async () => {
        stubFetch(
            makeTimeline([
                makeStage('probe', 'pending', { prioritizable: true }),
                makeStage('trickplay', 'pending', { prioritizable: false }),
            ]),
        );

        render(PipelineTab, { mediaItemId: ITEM });

        await screen.findByText('Probe');
        // Exactly one button — the un-prioritizable row must not render an
        // affordance that would do nothing.
        expect(screen.getAllByRole('button', { name: 'Do this one first' })).toHaveLength(1);
    });

    test('an OFF row says an admin switched it off and offers to switch it back on', async () => {
        stubFetch(
            makeTimeline([
                makeStage('probe', 'pending', {
                    operatorState: 'off',
                    diagnosis: {
                        reason: 'schedule-paused',
                        summary: 'paused',
                        detail: {},
                        remediable: true,
                    },
                    paused: {
                        taskId: 'task-probe',
                        pausedBy: 'testuser',
                        pausedAt: '2026-06-03T09:00:00.000Z',
                    },
                }),
            ]),
        );

        render(PipelineTab, { mediaItemId: ITEM });

        expect(await screen.findByText('Off')).toBeTruthy();
        expect(screen.getByText(/An admin turned this step off/)).toBeTruthy();
        expect(screen.getByText(/Turned off by testuser/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Turn back on' })).toBeTruthy();
    });

    test('a SKIPPED row explains why it does not apply, without a raw reason code', async () => {
        stubFetch(
            makeTimeline([
                makeStage('probe', 'skipped_permanent', {
                    skippedReason: 'no-match-upstream',
                }),
            ]),
        );

        render(PipelineTab, { mediaItemId: ITEM });

        expect(await screen.findByText('Not applicable')).toBeTruthy();
        expect(screen.getByText(/The metadata provider had nothing for this item/)).toBeTruthy();
        expect(screen.queryByText(/no-match-upstream/)).toBeNull();
    });

    test('a FAILED row names how many OTHER items hit the same error', async () => {
        stubFetch(
            makeTimeline([
                makeStage('probe', 'failed_permanent', {
                    lastError: { message: 'ENOENT: no such file' },
                    blastRadius: {
                        otherItems: 14,
                        atLeast: false,
                        samples: [{ mediaItemId: 'other-1', title: 'Some Other Film' }],
                    },
                }),
            ]),
        );

        render(PipelineTab, { mediaItemId: ITEM });

        expect(await screen.findByText(/14 other items hit the same error/)).toBeTruthy();
    });

    test('a failure nothing else shares says so — that is what rules out the config', async () => {
        stubFetch(
            makeTimeline([
                makeStage('probe', 'failed_permanent', {
                    lastError: { message: 'ENOENT: no such file' },
                    blastRadius: { otherItems: 0, atLeast: false, samples: [] },
                }),
            ]),
        );

        render(PipelineTab, { mediaItemId: ITEM });

        expect(await screen.findByText(/No other item hit this error/)).toBeTruthy();
    });

    test('a DONE row shows when it finished, so staleness is visible', async () => {
        stubFetch(
            makeTimeline([
                makeStage('probe', 'completed', {
                    completedAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
                }),
            ]),
        );

        render(PipelineTab, { mediaItemId: ITEM });

        expect(await screen.findByText(/Finished .*3d ago/)).toBeTruthy();
    });
});

describe('PipelineTab error recovery', () => {
    test('a later successful load clears the error from an earlier failed one', async () => {
        const body = makeTimeline([makeStage('probe', 'completed')]);
        const failed: Record<string, unknown> = {
            ok: false,
            status: 500,
            headers: { get: (_name: string) => null },
            json: () => Promise.resolve({ error: 'boom' }),
            text: () => Promise.resolve('{"error":"boom"}'),
            clone: () => failed,
        };
        const ok: Record<string, unknown> = {
            ok: true,
            status: 200,
            headers: { get: (_name: string) => null },
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(JSON.stringify(body)),
            clone: () => ok,
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(failed).mockResolvedValue(ok));

        render(PipelineTab, { mediaItemId: ITEM });
        await screen.findByText(/^Error:/);

        // A seed event re-fetches the whole timeline.
        mockEs?.fire('stage-state-changed', {
            mediaItemId: ITEM,
            stageId: 'probe',
            newStatus: 'completed',
            processingVersion: 1,
            kind: 'seed',
        });

        expect(await screen.findByText('Probe')).toBeTruthy();
        expect(screen.queryByText(/^Error:/)).toBeNull();
    });
});

test('reconciles missed source state on focus without remounting', async () => {
    stubFetch(makeTimeline([makeStage('probe', 'completed')]));
    render(PipelineTab, { mediaItemId: ITEM });
    await waitFor(() => expect(screen.getByText('Done', { exact: true })).toBeTruthy());
    stubFetch(makeTimeline([makeStage('probe', 'pending')]));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.queryByText('Done', { exact: true })).toBeNull());
});

test('synchronously switches subjects and rejects delayed old timeline responses without remounting', async () => {
    stubFetch(makeTimeline([makeStage('probe', 'completed')]));
    const view = render(PipelineTab, { mediaItemId: ITEM });
    await screen.findByText('Probe');
    stubFetch({ ...makeTimeline([makeStage('trickplay', 'pending')]), mediaItemId: 'next-item' });
    await view.rerender({ mediaItemId: 'next-item' });
    await screen.findByText('Trickplay');
    expect(screen.queryByText('Probe')).toBeNull();
    expect(
        vi
            .mocked(fetch)
            .mock.calls.some(([input]) => String(input).includes('next-item/pipeline/timeline')),
    ).toBe(true);
});
