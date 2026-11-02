// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));
import TaskActionButton from './TaskActionButton.svelte';
import type { Run } from '@sapd/lumastra-plugin-sdk';

function tracker(runs: Run[]) {
    return {
        runsFor: () => runs,
        isActive: () => runs.some((r) => !['completed', 'failed', 'cancelled'].includes(r.state)),
        progressFor: () =>
            runs[0]?.stages?.[0]?.total
                ? { processed: runs[0].stages[0].processed ?? 0, total: runs[0].stages[0].total! }
                : undefined,
        onSettled: () => () => {},
        destroy: () => {},
    };
}

const activeRun = {
    id: 'r1',
    taskId: 'trickplay-generation',
    label: 'Trickplay',
    state: 'active',
    stages: [{ id: 's', processed: 3, total: 10 }],
    startedAt: '2026-08-18T10:00:00.000Z',
    trigger: { kind: 'manual' },
    actor: { type: 'user' },
    input: {},
} as unknown as Run;

describe('TaskActionButton', () => {
    it('is enabled and shows its label when nothing is running', () => {
        const { getByRole } = render(TaskActionButton, {
            props: {
                taskId: 'trickplay-generation',
                label: 'Generate',
                tracker: tracker([]),
                onstart: vi.fn(),
            },
        });
        expect((getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(
            false,
        );
    });

    it('is disabled and shows progress while a run is active', () => {
        const { getByText, getByRole } = render(TaskActionButton, {
            props: {
                taskId: 'trickplay-generation',
                label: 'Generate',
                tracker: tracker([activeRun]),
                onstart: vi.fn(),
            },
        });
        expect(getByText('3 / 10')).toBeTruthy();
        expect((getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(
            true,
        );
    });

    it('shows a cancel affordance while a run is in flight', () => {
        const { getByRole } = render(TaskActionButton, {
            props: {
                taskId: 'trickplay-generation',
                label: 'Generate',
                tracker: tracker([activeRun]),
                onstart: vi.fn(),
            },
        });
        expect(getByRole('button', { name: /cancel/i })).toBeTruthy();
    });

    it('says so when starting the task fails, instead of just re-enabling', async () => {
        const { getByRole } = render(TaskActionButton, {
            props: {
                taskId: 'trickplay-generation',
                label: 'Generate',
                tracker: tracker([]),
                onstart: vi.fn().mockRejectedValue(new Error('network down')),
            },
        });
        await fireEvent.click(getByRole('button', { name: 'Generate' }));
        await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not start the task'));
    });
});

it('adopts the accepted run ID even when it completed before the event stream saw it', async () => {
    const observeRun = vi.fn();
    const current = { ...tracker([]), observeRun };
    const view = render(TaskActionButton, {
        taskId: 'trickplay-generation',
        label: 'Rebuild',
        tracker: current,
        onstart: vi.fn().mockResolvedValue({ runId: 'finished-run' }),
    });
    await fireEvent.click(view.getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(observeRun).toHaveBeenCalledExactlyOnceWith('finished-run'));
});

it('does not attach a previous subject’s late acceptance to the new subject', async () => {
    let accept!: (value: { runId: string; deduped: boolean }) => void;
    const onstart = vi.fn(
        () =>
            new Promise<{ runId: string; deduped: boolean }>((resolve) => {
                accept = resolve;
            }),
    );
    const old = { ...tracker([]), observeRun: vi.fn() };
    const next = { ...tracker([]), observeRun: vi.fn() };
    const view = render(TaskActionButton, {
        taskId: 'trickplay-generation',
        label: 'Rebuild',
        tracker: old,
        onstart,
    });
    await fireEvent.click(view.getByRole('button', { name: 'Rebuild' }));
    await view.rerender({
        taskId: 'trickplay-generation',
        label: 'Rebuild',
        tracker: next,
        onstart,
    });
    accept({ runId: 'previous-subject-run', deduped: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(next.observeRun).not.toHaveBeenCalled();
    expect(old.observeRun).not.toHaveBeenCalled();
    expect((view.getByRole('button', { name: 'Rebuild' }) as HTMLButtonElement).disabled).toBe(
        false,
    );
});
