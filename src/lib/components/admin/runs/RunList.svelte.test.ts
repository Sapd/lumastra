// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Admin IA redesign, spec §5/§9: "live updates patch, never replace" — an
 * SSE-triggered reload of the runs list must keep existing rows' DOM
 * identity so a click never races a live refresh (the Runs-History
 * mid-click re-render bug the spec calls out by name). `run.id` is the
 * `{#each}` key in both `RunList` and `RunGroupedList`; this test proves
 * that in practice by asserting the SAME DOM node survives a reload that
 * changes an unrelated field on an existing run.
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Run, RunWithMediaItem } from '$lib/schemas/run.schema.js';

vi.mock('$lib/api/client', () => ({
    apiGet: vi.fn(),
}));

const sseCallbacks = new Set<() => void>();
const sseRunsMap = new Map<string, Run>();

vi.mock('$lib/stores/run-sse-bus', () => ({
    runSSEBus: {
        get runs() {
            return sseRunsMap;
        },
        activeRuns: [],
        connected: true,
        onAnyChange: (cb: () => void) => {
            sseCallbacks.add(cb);
            return () => sseCallbacks.delete(cb);
        },
        onTransitionChange: () => () => {},
        connect: vi.fn(),
        disconnect: vi.fn(),
        upsertRun: vi.fn(),
    },
}));

import { apiGet } from '$lib/api/client';
import RunList from './RunList.svelte';

function makeRun(overrides: Partial<RunWithMediaItem> = {}): RunWithMediaItem {
    return {
        id: 'run-1',
        taskId: 'trickplay-generation',
        label: 'Trickplay Generation',
        state: 'active',
        input: undefined,
        trigger: { kind: 'scheduled' },
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        stages: [],
        actor: { type: 'system' },
        ...overrides,
    };
}

function resolveRuns(runs: RunWithMediaItem[]): void {
    vi.mocked(apiGet).mockResolvedValue({
        data: { items: runs, page: { limit: 50, hasMore: false } },
        error: null,
        status: 200,
    });
}

describe('RunList — patch-in-place under SSE reload', () => {
    beforeEach(() => {
        vi.mocked(apiGet).mockReset();
        sseCallbacks.clear();
        sseRunsMap.clear();
    });

    it('keeps the time-window selector available in a task-scoped runs page', async () => {
        resolveRuns([]);
        const onSinceWindowChange = vi.fn();
        render(RunList, {
            taskId: 'trickplay-generation',
            sinceWindow: '24h',
            onSinceWindowChange,
        });
        await fireEvent.click(screen.getByRole('button', { name: '7d' }));
        expect(onSinceWindowChange).toHaveBeenCalledWith('7d');
        expect(screen.queryByRole('button', { name: 'By task' })).toBeNull();
    });

    it('keeps the same row DOM node across an SSE-triggered reload of the same run id', async () => {
        resolveRuns([makeRun({ ownerInstanceId: 'web-1' })]);

        // taskId scope → flat mode (grouped mode has its own component under
        // test separately; the merge/keying logic under test here is
        // identical either way).
        render(RunList, { taskId: 'trickplay-generation' });

        await waitFor(() => expect(screen.getByText('Trickplay Generation')).toBeTruthy());
        const rowBefore = screen.getByRole('button', { name: /Trickplay Generation/ });

        // Simulate a fresher snapshot of the SAME run arriving over SSE
        // (e.g. its owner instance changed) — reflected both in the bus map
        // AND in the next REST response, matching how the real bus + API
        // response reconcile.
        const updated = makeRun({ ownerInstanceId: 'web-2' });
        sseRunsMap.set(updated.id, updated);
        resolveRuns([updated]);
        for (const cb of sseCallbacks) cb();

        // RunList debounces SSE-triggered reloads by 500ms.
        await new Promise((r) => setTimeout(r, 600));
        await waitFor(() => expect(screen.getByText('web-2')).toBeTruthy());

        const rowAfter = screen.getByRole('button', { name: /Trickplay Generation/ });
        expect(rowAfter).toBe(rowBefore); // same DOM node — patched, not remounted
    });

    it('renders a validated preview frame summary on the mounted run card', async () => {
        resolveRuns([
            makeRun({
                state: 'completed',
                completedAt: new Date().toISOString(),
                stages: [{ id: 'sources', label: 'Sources', state: 'completed', processed: 4 }],
                countSummary: {
                    count: 663,
                    unit: 'frames',
                    continuation: { kind: 'source-check', remainingSources: 1 },
                },
            }),
        ]);

        render(RunList, { taskId: 'trickplay-generation' });

        expect(await screen.findByText(/663 frames/)).toBeTruthy();
    });

    it('keeps the REST frame summary when a legacy terminal SSE row has no summary', async () => {
        const summary = { count: 663, unit: 'frames' as const };
        resolveRuns([
            makeRun({
                state: 'completed',
                completedAt: '2026-10-25T10:01:00.000Z',
                countSummary: summary,
                result: { itemsProcessed: 4 },
            }),
        ]);
        sseRunsMap.set(
            'run-1',
            makeRun({
                state: 'completed',
                completedAt: '2026-10-25T10:02:00.000Z',
                countSummary: undefined,
                result: undefined,
            }),
        );

        render(RunList, { taskId: 'trickplay-generation' });

        expect(await screen.findByText(/663 frames/)).toBeTruthy();
        expect(screen.queryByText(/4 items/)).toBeNull();
    });

    it('retains newer SSE stage progress when a later REST heartbeat arrives', async () => {
        const startedAt = new Date(Date.now() - 60_000).toISOString();
        const stage = {
            id: 'scan',
            label: 'Scanning files',
            state: 'active' as const,
            total: 20,
        };
        resolveRuns([
            makeRun({
                startedAt,
                heartbeatAt: '2026-08-10T13:00:00.000Z',
                stages: [{ ...stage, processed: 5 }],
            }),
        ]);
        render(RunList, { taskId: 'trickplay-generation' });
        await waitFor(() => expect(screen.getByText(/5\/20/)).toBeTruthy());

        // Progress events keep the previous heartbeat by design. The following
        // API snapshot therefore wins as the run envelope, but must not erase
        // the newer item count carried by SSE.
        sseRunsMap.set(
            'run-1',
            makeRun({
                startedAt,
                heartbeatAt: '2026-08-10T13:00:00.000Z',
                stages: [{ ...stage, processed: 12 }],
            }),
        );
        resolveRuns([
            makeRun({
                startedAt,
                heartbeatAt: '2026-08-10T13:00:30.000Z',
                stages: [{ ...stage, processed: 6 }],
            }),
        ]);
        for (const cb of sseCallbacks) cb();

        await waitFor(() => expect(screen.getByText(/12\/20/)).toBeTruthy(), { timeout: 1_000 });
    });

    it('shows the resolved media title for a queued per-item run', async () => {
        resolveRuns([
            makeRun({
                state: 'pending',
                input: { mediaItemId: '5554cd46-b813-4b2c-9c8b-555555555555' },
                mediaItem: {
                    id: '5554cd46-b813-4b2c-9c8b-555555555555',
                    title: 'Lanterns Out',
                },
            }),
        ]);

        render(RunList, { taskId: 'trickplay-generation' });

        await waitFor(() => expect(screen.getByText('Lanterns Out')).toBeTruthy());
    });
});

describe('RunList — flat list lifecycle', () => {
    beforeEach(() => {
        vi.mocked(apiGet).mockReset();
        sseCallbacks.clear();
        sseRunsMap.clear();
    });

    it('a flat "All runs" mount without a task scope fetches (the ?view=all deep link)', async () => {
        resolveRuns([makeRun({ label: 'Deep-linked run' })]);

        render(RunList, { groupedOverride: false });

        await waitFor(() => expect(screen.getByText('Deep-linked run')).toBeTruthy());
        expect(vi.mocked(apiGet).mock.calls[0][0]).toMatch(/^\/api\/runs\?/);
    });

    it('rows from "Load more" survive the next page-1 refresh', async () => {
        const now = Date.now();
        const newer = makeRun({
            id: 'run-new',
            label: 'Newest run',
            startedAt: new Date(now - 1_000).toISOString(),
        });
        const older = makeRun({
            id: 'run-old',
            label: 'Older run',
            startedAt: new Date(now - 60_000).toISOString(),
        });
        vi.mocked(apiGet).mockImplementation(async (url: string) =>
            url.includes('cursor=')
                ? {
                      data: { items: [older], page: { limit: 50, hasMore: false } },
                      error: null,
                      status: 200,
                  }
                : {
                      data: {
                          items: [newer],
                          page: { limit: 50, hasMore: true, nextCursor: 'c1' },
                      },
                      error: null,
                      status: 200,
                  },
        );
        render(RunList, { taskId: 'trickplay-generation', limit: 1 });

        await waitFor(() => expect(screen.getByText('Newest run')).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: /load more/i }));
        await waitFor(() => expect(screen.getByText('Older run')).toBeTruthy());

        for (const cb of sseCallbacks) cb();
        await new Promise((r) => setTimeout(r, 600));

        expect(screen.getByText('Newest run')).toBeTruthy();
        expect(screen.getByText('Older run')).toBeTruthy();
    });

    it('a failed background refresh keeps the rows and flags them as possibly stale', async () => {
        resolveRuns([makeRun({ label: 'Visible run' })]);
        render(RunList, { taskId: 'trickplay-generation' });
        await waitFor(() => expect(screen.getByText('Visible run')).toBeTruthy());

        vi.mocked(apiGet).mockResolvedValue({ data: null, error: 'Bad gateway', status: 502 });
        for (const cb of sseCallbacks) cb();
        await new Promise((r) => setTimeout(r, 600));

        await waitFor(() => expect(screen.getByText(/Could not refresh/)).toBeTruthy());
        expect(screen.getByText('Visible run')).toBeTruthy();
    });
});

describe('RunList — Running tab', () => {
    beforeEach(() => {
        vi.mocked(apiGet).mockReset();
        sseCallbacks.clear();
        sseRunsMap.clear();
    });

    it('sends no started_at window and hides the window selector for live-only states', async () => {
        resolveRuns([makeRun({ label: 'Started two days ago' })]);
        render(RunList, {
            groupedOverride: false,
            stateFilter: ['pending', 'active', 'cancelling'],
            sinceWindow: '24h',
            onSinceWindowChange: vi.fn(),
        });

        await waitFor(() => expect(screen.getByText('Started two days ago')).toBeTruthy());
        expect(vi.mocked(apiGet).mock.calls[0][0]).not.toContain('since=');
        expect(screen.queryByRole('button', { name: '24h' })).toBeNull();
    });
});
