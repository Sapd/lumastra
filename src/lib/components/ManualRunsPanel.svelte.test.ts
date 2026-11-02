// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';

vi.mock('$lib/api/manual-runs', () => ({ getMyManualRuns: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import ManualRunsPanel from './ManualRunsPanel.svelte';
import { manualRuns } from '$lib/stores/manual-runs.svelte';

const base = {
    taskId: 'file-library-scan',
    title: 'File Library Scan',
    startedAt: '2026-09-23T12:00:00.000Z',
};

describe('ManualRunsPanel', () => {
    afterEach(() => {
        cleanup();
        manualRuns.runs = [];
        localStorage.clear();
    });

    it('renders nothing while no manual run is live', () => {
        render(ManualRunsPanel);
        expect(screen.queryByRole('complementary')).toBeNull();
    });

    it('lists each live run with its own name and percent, and a waiting one as waiting', () => {
        manualRuns.runs = [
            { ...base, id: 'a', detail: 'Kids', state: 'active', processed: 25, total: 100 },
            { ...base, id: 'b', detail: 'Anime', state: 'pending' },
        ];
        render(ManualRunsPanel);

        expect(screen.getByText('File Library Scan · Kids')).toBeTruthy();
        expect(screen.getByText('25%')).toBeTruthy();
        expect(screen.getByText('File Library Scan · Anime')).toBeTruthy();
        expect(screen.getByText('Waiting…')).toBeTruthy();
        expect(
            screen
                .getByRole('progressbar', { name: 'File Library Scan · Kids' })
                .getAttribute('aria-valuenow'),
        ).toBe('25');
    });

    it('collapses to its header', async () => {
        manualRuns.runs = [{ ...base, id: 'a', state: 'active', processed: 1, total: 4 }];
        render(ManualRunsPanel);
        await fireEvent.click(screen.getByRole('button', { name: 'Hide running actions' }));
        flushSync();
        expect(screen.queryByRole('progressbar')).toBeNull();
        expect(screen.getByText(/Running · 1/)).toBeTruthy();
    });
});
