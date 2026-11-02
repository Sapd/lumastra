// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '$lib/schemas/run.schema.js';
import * as m from '$lib/paraglide/messages.js';

const sseState = vi.hoisted(() => ({
    runs: new Map<string, unknown>(),
    callbacks: new Set<() => void>(),
}));

vi.mock('$lib/api/client.js', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('$lib/stores/run-sse-bus.js', () => ({
    runSSEBus: {
        runs: sseState.runs,
        onAnyChange: (callback: () => void) => {
            sseState.callbacks.add(callback);
            return () => sseState.callbacks.delete(callback);
        },
    },
}));
vi.mock('$app/stores', () => ({
    page: writable({
        url: new URL('http://localhost/admin/runs'),
        data: { devToolsEnabled: false },
    }),
    navigating: writable(null),
}));

import { apiGet } from '$lib/api/client.js';
import RunDetailPanel from './RunDetailPanel.svelte';

const previewRun: Run = {
    id: 'run-preview-1',
    taskId: 'trickplay-generation',
    label: 'Preview generation',
    state: 'completed',
    input: {},
    trigger: { kind: 'scheduled' },
    startedAt: '2026-10-24T10:00:00.000Z',
    completedAt: '2026-10-24T10:01:00.000Z',
    stages: [{ id: 'main', label: 'Source versions', state: 'completed', processed: 1, total: 2 }],
    result: {
        success: false,
        itemsProcessed: 663,
        stopReason: 'budget',
        result: { generated: 663, countUnit: 'frames', sourcesRemaining: 1 },
    },
    countSummary: {
        count: 663,
        unit: 'frames',
        continuation: { kind: 'source-check', remainingSources: 1 },
    },
    actor: { type: 'system' },
};

describe('RunDetailPanel preview count presentation', () => {
    beforeEach(() => {
        vi.mocked(apiGet).mockReset();
        sseState.runs.clear();
        sseState.callbacks.clear();
        vi.mocked(apiGet).mockImplementation(
            async (url: string) =>
                (url.endsWith('/diagnostics')
                    ? { data: null, error: 'forbidden', status: 403 }
                    : { data: previewRun, error: null, status: 200 }) as never,
        );
    });

    it('shows the same frame count and validated later source check as the run card', async () => {
        render(RunDetailPanel, { runId: previewRun.id, onclose: vi.fn() });

        expect(await screen.findByText(/663 frames/)).toBeTruthy();
        expect(screen.getByText(/1\s*\/\s*2/)).toBeTruthy();
        expect(screen.getByText(/Source checks still to come in a later pass: 1/)).toBeTruthy();

        sseState.runs.set(previewRun.id, {
            id: previewRun.id,
            taskId: previewRun.taskId,
            label: previewRun.label,
            state: 'completed',
            trigger: previewRun.trigger,
            startedAt: previewRun.startedAt,
            completedAt: '2026-10-24T10:02:00.000Z',
            stages: [],
            actor: previewRun.actor,
            countSummary: { count: 664, unit: 'frames' },
        } satisfies Partial<Run>);
        for (const callback of sseState.callbacks) callback();

        expect(await screen.findByText(/664 frames/)).toBeTruthy();
        expect(screen.queryByText(/663 frames/)).toBeNull();
    });

    it('uses the redacted SSE count summary when REST has no result envelope', async () => {
        const restRun = { ...previewRun, result: undefined, countSummary: undefined };
        vi.mocked(apiGet).mockImplementation(
            async (url: string) =>
                (url.endsWith('/diagnostics')
                    ? { data: null, error: 'forbidden', status: 403 }
                    : { data: restRun, error: null, status: 200 }) as never,
        );
        render(RunDetailPanel, { runId: previewRun.id, onclose: vi.fn() });
        expect((await screen.findAllByText(/Preview generation/)).length).toBeGreaterThan(0);
        expect(screen.queryByText(/frames/)).toBeNull();

        sseState.runs.set(previewRun.id, {
            id: previewRun.id,
            taskId: previewRun.taskId,
            label: previewRun.label,
            state: 'completed',
            trigger: previewRun.trigger,
            startedAt: previewRun.startedAt,
            completedAt: '2026-10-24T10:02:00.000Z',
            stages: [],
            actor: previewRun.actor,
            countSummary: {
                count: 664,
                unit: 'frames',
                continuation: { kind: 'source-check', remainingSources: 2 },
            },
        } satisfies Partial<Run>);
        for (const callback of sseState.callbacks) callback();

        expect(await screen.findByText(/664 frames/)).toBeTruthy();
        expect(
            await screen.findByText(/Source checks still to come in a later pass: 2/),
        ).toBeTruthy();
    });

    it('fetches the terminal REST result after an active run completes over SSE', async () => {
        const fileId = '740fee5d-dd69-4c69-9b4c-d0b02a6a5ed0';
        const active: Run = {
            ...previewRun,
            id: 'active-to-terminal-result',
            taskId: 'media-probe',
            state: 'active',
            completedAt: undefined,
            result: undefined,
            countSummary: undefined,
            input: { fileId },
        };
        const completed: Run = {
            ...active,
            state: 'completed',
            completedAt: '2026-10-26T12:01:00.000Z',
            result: { recheck: { fileId, outcome: 'healthy', issues: [] } },
        };
        let runFetches = 0;
        vi.mocked(apiGet).mockImplementation(async (url: string) => {
            if (url.endsWith('/diagnostics'))
                return { data: null, error: 'forbidden', status: 403 } as never;
            runFetches++;
            return {
                data: runFetches === 1 ? active : completed,
                error: null,
                status: 200,
            } as never;
        });
        render(RunDetailPanel, { runId: active.id, onclose: vi.fn() });
        expect((await screen.findAllByText(/Preview generation/)).length).toBeGreaterThan(0);

        sseState.runs.set(active.id, {
            id: active.id,
            taskId: active.taskId,
            label: active.label,
            state: 'completed',
            trigger: active.trigger,
            startedAt: active.startedAt,
            completedAt: completed.completedAt,
            stages: [],
            actor: active.actor,
        } satisfies Partial<Run>);
        for (const callback of sseState.callbacks) callback();

        expect(await screen.findByText(m.admin_run_selected_file_result())).toBeTruthy();
        expect(await screen.findByText(m.admin_health_recheck_healthy())).toBeTruthy();
        expect(runFetches).toBeGreaterThanOrEqual(2);
    });

    it('recovers a redacted cached terminal probe after its initial REST fetch fails', async () => {
        vi.useFakeTimers();
        const fileId = '740fee5d-dd69-4c69-9b4c-d0b02a6a5ed0';
        const runId = 'cached-terminal-probe-recovery';
        const completed: Run = {
            ...previewRun,
            id: runId,
            taskId: 'media-probe',
            state: 'completed',
            completedAt: '2026-10-26T12:01:00.000Z',
            input: { fileId },
            result: { recheck: { fileId, outcome: 'healthy', issues: [] } },
        };
        sseState.runs.set(runId, {
            id: runId,
            taskId: 'media-probe',
            label: completed.label,
            state: 'completed',
            trigger: completed.trigger,
            startedAt: completed.startedAt,
            completedAt: completed.completedAt,
            stages: [],
            actor: completed.actor,
        } satisfies Partial<Run>);
        let runFetches = 0;
        vi.mocked(apiGet).mockImplementation(async (url: string) => {
            if (url.endsWith('/diagnostics'))
                return { data: null, error: 'forbidden', status: 403 } as never;
            runFetches++;
            if (runFetches === 1) throw new Error('initial REST unavailable');
            return { data: completed, error: null, status: 200 } as never;
        });

        const { unmount } = render(RunDetailPanel, { runId, onclose: vi.fn() });
        await vi.waitFor(() => expect(runFetches).toBe(1));
        await vi.advanceTimersByTimeAsync(0);
        expect(await screen.findByText(m.admin_health_recheck_healthy())).toBeTruthy();
        expect(runFetches).toBe(2);
        unmount();
        vi.useRealTimers();
    });

    it('uses REST to identify broad completed probes without reporting a missing selected result', async () => {
        vi.useFakeTimers();
        const broadProbe: Run = {
            ...previewRun,
            id: 'completed-broad-probe',
            taskId: 'media-probe',
            state: 'completed',
            input: undefined,
            result: undefined,
        };
        sseState.runs.set(broadProbe.id, {
            id: broadProbe.id,
            taskId: broadProbe.taskId,
            label: broadProbe.label,
            state: 'completed',
            trigger: broadProbe.trigger,
            startedAt: broadProbe.startedAt,
            completedAt: broadProbe.completedAt,
            stages: [],
            actor: broadProbe.actor,
        } satisfies Partial<Run>);
        let runFetches = 0;
        vi.mocked(apiGet).mockImplementation(async (url: string) => {
            if (url.endsWith('/diagnostics'))
                return { data: null, error: 'forbidden', status: 403 } as never;
            runFetches++;
            return { data: broadProbe, error: null, status: 200 } as never;
        });

        const { unmount } = render(RunDetailPanel, { runId: broadProbe.id, onclose: vi.fn() });
        await vi.waitFor(() => expect(runFetches).toBe(1));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(runFetches).toBe(1);
        expect(screen.queryByRole('alert')).toBeNull();
        unmount();
        vi.useRealTimers();
    });

    it('catches rejected terminal fetches, exhausts bounded retries, and offers a retry', async () => {
        vi.useFakeTimers();
        const active: Run = {
            ...previewRun,
            id: 'terminal-result-retry',
            taskId: 'media-probe',
            state: 'active',
            completedAt: undefined,
            result: undefined,
            countSummary: undefined,
            input: { fileId: '740fee5d-dd69-4c69-9b4c-d0b02a6a5ed0' },
        };
        let runFetches = 0;
        vi.mocked(apiGet).mockImplementation(async (url: string) => {
            if (url.endsWith('/diagnostics'))
                return { data: null, error: 'forbidden', status: 403 } as never;
            runFetches++;
            if (runFetches === 1) return { data: active, error: null, status: 200 } as never;
            if (runFetches < 5) throw new Error('temporary REST failure');
            return {
                data: {
                    ...active,
                    state: 'completed',
                    completedAt: '2026-10-26T12:05:00.000Z',
                    result: {
                        recheck: {
                            fileId: '740fee5d-dd69-4c69-9b4c-d0b02a6a5ed0',
                            outcome: 'healthy',
                            issues: [],
                        },
                    },
                },
                error: null,
                status: 200,
            } as never;
        });
        const { unmount } = render(RunDetailPanel, { runId: active.id, onclose: vi.fn() });
        await vi.waitFor(() => expect(runFetches).toBe(1));
        sseState.runs.set(active.id, {
            id: active.id,
            taskId: active.taskId,
            label: active.label,
            state: 'completed',
            trigger: active.trigger,
            startedAt: active.startedAt,
            completedAt: '2026-10-26T12:05:00.000Z',
            stages: [],
            actor: active.actor,
        } satisfies Partial<Run>);
        for (const callback of sseState.callbacks) callback();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(runFetches).toBe(4);
        expect(screen.getByRole('alert').textContent).toContain('Could not refresh');

        await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await vi.advanceTimersByTimeAsync(0);
        expect(runFetches).toBe(5);
        expect(screen.getByText(m.admin_health_recheck_healthy())).toBeTruthy();
        unmount();
        vi.useRealTimers();
    });

    it('ignores a terminal response from the previous run after switching runId', async () => {
        vi.useFakeTimers();
        const fileId = '740fee5d-dd69-4c69-9b4c-d0b02a6a5ed0';
        const oldRun: Run = {
            ...previewRun,
            id: 'old-run-result',
            taskId: 'media-probe',
            input: { fileId },
            state: 'active',
            result: undefined,
            completedAt: undefined,
        };
        const newRun: Run = {
            ...previewRun,
            id: 'new-run-result',
            label: 'New run',
            taskId: 'media-probe',
            input: { fileId },
            state: 'active',
            result: undefined,
            completedAt: undefined,
        };
        let releaseOld!: (value: unknown) => void;
        const oldResponse = new Promise<unknown>((resolve) => {
            releaseOld = resolve;
        });
        let oldFetches = 0;
        vi.mocked(apiGet).mockImplementation(async (url: string) => {
            if (url.endsWith('/diagnostics'))
                return { data: null, error: 'forbidden', status: 403 } as never;
            if (url.includes(oldRun.id)) {
                oldFetches++;
                return oldFetches === 1
                    ? ({ data: oldRun, error: null, status: 200 } as never)
                    : (oldResponse as never);
            }
            return { data: newRun, error: null, status: 200 } as never;
        });
        const view = render(RunDetailPanel, { runId: oldRun.id, onclose: vi.fn() });
        await vi.waitFor(() => expect(oldFetches).toBe(1));
        sseState.runs.set(oldRun.id, {
            id: oldRun.id,
            taskId: oldRun.taskId,
            label: oldRun.label,
            state: 'completed',
            trigger: oldRun.trigger,
            startedAt: oldRun.startedAt,
            completedAt: '2026-10-26T12:06:00.000Z',
            stages: [],
            actor: oldRun.actor,
        } satisfies Partial<Run>);
        for (const callback of sseState.callbacks) callback();
        await vi.advanceTimersByTimeAsync(0);
        await view.rerender({ runId: newRun.id, onclose: vi.fn() });
        releaseOld({
            data: {
                ...oldRun,
                state: 'completed',
                result: { recheck: { fileId, outcome: 'healthy', issues: [] } },
                completedAt: '2026-10-26T12:06:00.000Z',
            },
            error: null,
            status: 200,
        });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(oldFetches).toBe(2);
        await Promise.resolve();
        await Promise.resolve();
        expect(screen.getAllByText('New run').length).toBeGreaterThan(0);
        expect(screen.queryByText(m.admin_run_selected_file_result())).toBeNull();
        view.unmount();
        vi.useRealTimers();
    });

    it('does not start result retries for unrelated completed or cancelled runs', async () => {
        vi.useFakeTimers();
        const active: Run = {
            ...previewRun,
            id: 'ordinary-run-without-result',
            state: 'active',
            completedAt: undefined,
            result: undefined,
        };
        let runFetches = 0;
        vi.mocked(apiGet).mockImplementation(async (url: string) => {
            if (url.endsWith('/diagnostics'))
                return { data: null, error: 'forbidden', status: 403 } as never;
            runFetches++;
            return { data: active, error: null, status: 200 } as never;
        });
        const { unmount } = render(RunDetailPanel, { runId: active.id, onclose: vi.fn() });
        await vi.waitFor(() => expect(runFetches).toBe(1));
        sseState.runs.set(active.id, {
            id: active.id,
            taskId: active.taskId,
            label: active.label,
            state: 'cancelled',
            trigger: active.trigger,
            startedAt: active.startedAt,
            completedAt: '2026-10-26T12:07:00.000Z',
            stages: [],
            actor: active.actor,
        } satisfies Partial<Run>);
        for (const callback of sseState.callbacks) callback();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(runFetches).toBe(1);
        expect(screen.queryByRole('alert')).toBeNull();
        unmount();
        vi.useRealTimers();
    });

    it.each([
        { observation: undefined, label: () => m.admin_run_recorded_unconfirmed() },
        { observation: 'waiting' as const, label: () => m.admin_run_confirmed_waiting() },
        { observation: 'playback-deferred' as const, label: () => m.admin_run_playback_deferred() },
    ])(
        'shows admission evidence for pending runs: $observation',
        async ({ observation, label }) => {
            const pending: Run = {
                ...previewRun,
                state: 'pending',
                completedAt: undefined,
                result: undefined,
                countSummary: undefined,
                admissionObservation: observation,
            };
            vi.mocked(apiGet).mockImplementation(
                async (url: string) =>
                    (url.endsWith('/diagnostics')
                        ? { data: null, error: 'forbidden', status: 403 }
                        : { data: pending, error: null, status: 200 }) as never,
            );
            render(RunDetailPanel, { runId: pending.id, onclose: vi.fn() });
            expect(await screen.findByText(label())).toBeTruthy();
            expect(screen.getByText(m.admin_run_field_enqueued())).toBeTruthy();
            expect(screen.queryByText(m.admin_run_field_execution_started())).toBeNull();
        },
    );

    it('uses actual admission time for execution and leaves legacy terminal duration unknown', async () => {
        const active: Run = {
            ...previewRun,
            state: 'active',
            completedAt: undefined,
            executionStartedAt: new Date(Date.now() - 65_000).toISOString(),
            admissionObservation: 'active',
        };
        vi.mocked(apiGet).mockImplementation(
            async (url: string) =>
                (url.endsWith('/diagnostics')
                    ? { data: null, error: 'forbidden', status: 403 }
                    : { data: active, error: null, status: 200 }) as never,
        );
        render(RunDetailPanel, { runId: active.id, onclose: vi.fn() });
        expect(await screen.findByText(m.admin_run_field_execution_started())).toBeTruthy();
        expect(screen.getByText(/Execution 1m/)).toBeTruthy();

        // A historical terminal row has only enqueue time, which cannot be
        // retroactively used as worker execution duration.
        sseState.runs.set(active.id, { ...previewRun, executionStartedAt: undefined });
        for (const callback of sseState.callbacks) callback();
        expect(await screen.findByText(m.admin_run_execution_unknown())).toBeTruthy();
    });

    it('shows a validated selected-file health result for the matching media-probe run', async () => {
        const fileId = '740fee5d-dd69-4c69-9b4c-d0b02a6a5ed0';
        const selected: Run = {
            ...previewRun,
            id: 'selected-health-run',
            taskId: 'media-probe',
            label: 'Media file probe',
            input: { fileId },
            result: {
                recheck: { fileId, outcome: 'healthy', issues: [] },
            },
        };
        vi.mocked(apiGet).mockImplementation(
            async (url: string) =>
                (url.endsWith('/diagnostics')
                    ? { data: null, error: 'forbidden', status: 403 }
                    : { data: selected, error: null, status: 200 }) as never,
        );

        render(RunDetailPanel, { runId: selected.id, onclose: vi.fn() });

        expect(await screen.findByText(m.admin_run_selected_file_result())).toBeTruthy();
        expect(screen.getByText(m.admin_health_recheck_healthy())).toBeTruthy();
    });

    it.each([
        {
            name: 'a different file id',
            result: () => ({
                recheck: {
                    fileId: '840fee5d-dd69-4c69-9b4c-d0b02a6a5ed0',
                    outcome: 'healthy',
                    issues: [],
                },
            }),
        },
        { name: 'a malformed result', result: () => ({ recheck: { outcome: 'healthy' } }) },
    ])('fails closed for $name', async ({ result }) => {
        const fileId = '740fee5d-dd69-4c69-9b4c-d0b02a6a5ed0';
        const selected: Run = {
            ...previewRun,
            id: 'selected-health-invalid',
            taskId: 'media-probe',
            input: { fileId },
            result: result(),
        };
        vi.mocked(apiGet).mockImplementation(
            async (url: string) =>
                (url.endsWith('/diagnostics')
                    ? { data: null, error: 'forbidden', status: 403 }
                    : { data: selected, error: null, status: 200 }) as never,
        );

        render(RunDetailPanel, { runId: selected.id, onclose: vi.fn() });
        expect(await screen.findByText(m.admin_run_input_heading())).toBeTruthy();
        expect(screen.queryByText(m.admin_run_selected_file_result())).toBeNull();
    });
});
