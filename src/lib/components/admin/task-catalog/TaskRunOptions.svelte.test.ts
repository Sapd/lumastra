// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The task page offers the extra run modes the server supports: a full run
 * (force rebuild only where the task can wipe) and the intro analyzer's
 * scoped segment refresh.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

const modals = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('$lib/stores/modal.store', () => ({ modals }));
vi.mock('$lib/stores/toast.store.js', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const apiPost = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({ apiPost }));

import TaskRunOptions from './TaskRunOptions.svelte';
import RunScopeModal from './RunScopeModal.svelte';
import SegmentRefreshModal from './SegmentRefreshModal.svelte';

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

const base = {
    id: 'tmdb-metadata-sync',
    name: 'TMDB metadata',
    version: '1.0.0',
    processingVersion: 1,
    resourceClass: 'io',
    capabilities: {},
    visibility: 'user' as const,
    supportsPerItemRetry: false,
};

describe('TaskRunOptions', () => {
    it('renders nothing for a task without extra modes', () => {
        const { container } = render(TaskRunOptions, { props: { task: base, running: false } });
        expect(container.textContent?.trim()).toBe('');
    });

    it('full run opens the scope modal; force only where the task can wipe', async () => {
        render(TaskRunOptions, {
            props: { task: { ...base, supportsFullRun: true }, running: false },
        });
        await fireEvent.click(screen.getByRole('button', { name: m.admin_task_full_run() }));
        expect(modals.open).toHaveBeenCalledWith(
            RunScopeModal,
            expect.objectContaining({ allowForce: false }),
        );

        apiPost.mockResolvedValue({ data: { runId: 'r1' }, error: null });
        const { onConfirm } = modals.open.mock.calls[0][1] as {
            onConfirm: (s: string) => Promise<void>;
        };
        await onConfirm('manual');
        expect(apiPost).toHaveBeenCalledWith(
            '/api/tasks/tmdb-metadata-sync/run',
            expect.anything(),
            { input: { mode: 'manual' } },
            expect.objectContaining({ headers: expect.any(Object) }),
        );
    });

    it('is disabled while a run is in progress', () => {
        render(TaskRunOptions, {
            props: {
                task: { ...base, supportsFullRun: true, supportsForceRun: true },
                running: true,
            },
        });
        expect(
            (screen.getByRole('button', { name: m.admin_task_full_run() }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });

    it('disables both full and scoped runs for a recorded in-flight run', async () => {
        render(TaskRunOptions, {
            props: {
                task: { ...base, id: 'lumastra-intro-analyzer', supportsFullRun: true },
                running: true,
            },
        });
        const full = screen.getByRole('button', { name: m.admin_task_full_run() });
        const segment = screen.getByRole('button', { name: m.admin_task_segment_refresh() });
        expect((full as HTMLButtonElement).disabled).toBe(true);
        expect((segment as HTMLButtonElement).disabled).toBe(true);
        await fireEvent.click(full);
        await fireEvent.click(segment);
        expect(modals.open).not.toHaveBeenCalled();
        expect(apiPost).not.toHaveBeenCalled();
    });

    it('the intro analyzer offers a scoped segment refresh', async () => {
        render(TaskRunOptions, {
            props: {
                task: { ...base, id: 'lumastra-intro-analyzer', name: 'Intros' },
                running: false,
            },
        });
        await fireEvent.click(screen.getByRole('button', { name: m.admin_task_segment_refresh() }));
        expect(modals.open).toHaveBeenCalledWith(SegmentRefreshModal, expect.anything());

        apiPost.mockResolvedValue({ data: { runId: 'r2' }, error: null });
        const { onConfirm } = modals.open.mock.calls[0][1] as {
            onConfirm: (s: string) => Promise<void>;
        };
        await onConfirm('outro');
        expect(apiPost).toHaveBeenCalledWith(
            '/api/tasks/lumastra-intro-analyzer/run',
            expect.anything(),
            { input: { segmentTypes: ['Outro'] } },
        );
    });
});
