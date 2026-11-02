// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Task detail tabs: a per-item retry the server refused is not shown as
 * queued, and "Load more" on the Runs tab actually loads more.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('$lib/stores/toast.store.js', () => ({ toasts }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({ apiGet, apiPost }));

import TaskFailuresList from './TaskFailuresList.svelte';
import TaskRecentRuns from './TaskRecentRuns.svelte';
import { runSSEBus } from '$lib/stores/run-sse-bus.js';

afterEach(() => {
    cleanup();
    runSSEBus.runs.clear();
    apiGet.mockReset();
    apiPost.mockReset();
    vi.clearAllMocks();
});

describe('TaskFailuresList retry', () => {
    function renderOne() {
        apiGet.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 'f1',
                        itemId: 'item-key-1',
                        title: 'Some Film',
                        reason: 'boom',
                        occurredAt: '2026-10-06T10:00:00.000Z',
                    },
                ],
                page: { limit: 50, hasMore: false, total: 1 },
            },
            error: null,
        });
        render(TaskFailuresList, { taskId: 'media-probe', supportsRetry: true } as never);
    }

    it('a 200 with retried:false keeps the row and reports the failure', async () => {
        renderOne();
        apiPost.mockResolvedValue({
            data: {
                retried: false,
                reason: 'item-retry-failed',
                message: "Per-item retry failed for 'item-key-1'",
                itemId: 'item-key-1',
                itemReason: 'still broken',
            },
            error: null,
        });

        await fireEvent.click(
            await screen.findByRole('button', { name: m.admin_task_failures_retry() }),
        );

        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith('Retry failed: still broken'),
        );
        expect(toasts.success).not.toHaveBeenCalled();
        expect(screen.getByText('Some Film')).toBeTruthy();
    });

    it('a real retry removes the row', async () => {
        renderOne();
        apiPost.mockResolvedValue({
            data: { retried: true, reason: 'item-retry', message: 'ok', itemId: 'item-key-1' },
            error: null,
        });

        await fireEvent.click(
            await screen.findByRole('button', { name: m.admin_task_failures_retry() }),
        );

        await waitFor(() => expect(screen.queryByText('Some Film')).toBeNull());
        expect(toasts.success).toHaveBeenCalled();
    });
});

describe('TaskRecentRuns load more', () => {
    function run(i: number) {
        return {
            id: `run-${i}`,
            taskId: 'media-probe',
            label: `Run ${i}`,
            state: 'completed',
            trigger: { kind: 'scheduled' },
            startedAt: new Date(Date.now() - i * 60_000).toISOString(),
            completedAt: new Date(Date.now() - i * 60_000 + 1000).toISOString(),
            stages: [],
            actor: { type: 'system' },
        };
    }

    it('asks for a larger page and keeps it (the effect used to reset to page 1)', async () => {
        apiGet.mockImplementation(async (url: string) => {
            const limit = Number(new URL(url, 'http://x').searchParams.get('limit'));
            return {
                data: {
                    items: Array.from({ length: limit }, (_, i) => run(i)),
                    page: { limit, hasMore: false },
                },
                error: null,
            };
        });
        render(TaskRecentRuns, { taskId: 'media-probe', limit: 2 } as never);

        await fireEvent.click(await screen.findByRole('button', { name: m.section_load_more() }));

        await waitFor(() => expect(apiGet.mock.calls.at(-1)?.[0]).toContain('limit=22'));
        await new Promise((r) => setTimeout(r, 20));
        const limits = apiGet.mock.calls.map((c) =>
            new URL(c[0] as string, 'http://x').searchParams.get('limit'),
        );
        expect(limits).toEqual(['2', '22']);
    });

    it('retains REST frame summary when a legacy terminal SSE row omits it', async () => {
        const restRun = {
            ...run(1),
            taskId: 'trickplay-generation',
            countSummary: { count: 663, unit: 'frames' as const },
            result: { itemsProcessed: 4 },
        };
        runSSEBus.runs.set(restRun.id, {
            ...restRun,
            state: 'completed',
            completedAt: new Date(Date.now() + 1_000).toISOString(),
            countSummary: undefined,
            result: undefined,
        } as never);
        apiGet.mockResolvedValue({
            data: { items: [restRun], page: { limit: 2, hasMore: false } },
            error: null,
        });

        render(TaskRecentRuns, { taskId: 'trickplay-generation', limit: 2 } as never);

        expect(await screen.findByText(/663 frames/)).toBeTruthy();
        expect(screen.queryByText(/4 items/)).toBeNull();
        runSSEBus.runs.delete(restRun.id);
    });
});
