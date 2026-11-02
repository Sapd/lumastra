// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Run } from '@sapd/lumastra-plugin-sdk';

const mocks = vi.hoisted(() => ({
    start: vi.fn(),
    destroy: vi.fn(),
    settled: null as null | ((run: Run) => void),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    change: null as null | (() => void),
    runs: [] as Run[],
}));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api/admin.js', () => ({
    regenerateEpisodeThumbnails: mocks.start,
    cancelRun: vi.fn(),
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: {
        success: mocks.success,
        error: mocks.error,
        info: mocks.info,
        warning: mocks.warning,
    },
}));
vi.mock('$lib/stores/run-sse-bus.js', () => ({
    runSSEBus: {
        onAnyChange: (cb: () => void) => {
            mocks.change = cb;
            return () => {};
        },
    },
}));
vi.mock('$lib/stores/subject-runs.js', () => ({
    createSubjectRunsTracker: () => ({
        runsFor: () => mocks.runs,
        isActive: () => mocks.runs.length > 0,
        progressFor: () => (mocks.runs.length ? { processed: 3, total: 27 } : undefined),
        onSettled: (cb: (run: Run) => void) => {
            mocks.settled = cb;
            return () => {};
        },
        destroy: mocks.destroy,
    }),
}));
import SeasonThumbnailAction from './SeasonThumbnailAction.svelte';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.runs = [];
    mocks.settled = null;
    mocks.change = null;
    mocks.start.mockResolvedValue({ data: { runId: 'run-1', message: 'Queued' } });
});
afterEach(cleanup);

describe('season thumbnail action', () => {
    it('queues forced season extraction, displays progress, and refreshes artwork on completion', async () => {
        const saved = vi.fn();
        render(SeasonThumbnailAction, { seasonId: 'season-1', onsaved: saved });
        const button = await screen.findByRole('button', {
            name: 'Repair missing episode pictures',
        });
        await fireEvent.click(button);
        expect(mocks.start).toHaveBeenCalledWith('season-1', { scope: 'season' });
        mocks.runs = [{ id: 'run-1', taskId: 'episode-thumbnail-extract', state: 'active' } as Run];
        mocks.change?.();
        await screen.findByText('3 / 27');
        expect((button as HTMLButtonElement).disabled).toBe(true);
        mocks.settled?.({
            id: 'run-1',
            taskId: 'episode-thumbnail-extract',
            state: 'completed',
            result: { success: true },
        } as Run);
        await waitFor(() => expect(saved).toHaveBeenCalledOnce());
        expect(mocks.success).toHaveBeenCalledWith(
            'Episode picture maintenance finished. Current pictures have been refreshed.',
        );
    });
    it('reports a failed season run as failure', async () => {
        render(SeasonThumbnailAction, { seasonId: 'season-1' });
        await screen.findByRole('button');
        mocks.settled?.({ taskId: 'episode-thumbnail-extract', state: 'failed' } as Run);
        expect(mocks.error).toHaveBeenCalledWith(
            'Season thumbnail extraction failed; see task details',
        );
    });
});
