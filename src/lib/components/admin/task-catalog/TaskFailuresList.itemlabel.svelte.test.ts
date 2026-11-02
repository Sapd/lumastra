// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * A failure row never shows a bare UUID where a title goes.
 *
 * Observed on preprod: two of four rows on media-probe's Failures tab read
 * `3d7aa735-c0e5-4b93-88df-1650bd68e0cc`. `getFailureItemTitles` resolves
 * `item_id` to a real title and its docstring says ids it cannot resolve are
 * absent, with "callers fall back to the raw id" — so a deleted media row put
 * a UUID on screen where a film name belongs.
 *
 * Unresolvable AND uuid-shaped means exactly one thing: the row is gone. That
 * is worth saying, because it tells the operator the failure can be dismissed.
 * A NON-uuid id is a plugin's own key and may be meaningful, so it survives.
 */

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock('$lib/api/client.js', () => ({ apiGet: mockGet, apiPost: mockPost }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

const modal = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('$lib/stores/modal.store', () => ({ modals: modal }));
import { toasts } from '$lib/stores/toast.store';
import TaskFailuresList from './TaskFailuresList.svelte';

const UUID = '3d7aa735-c0e5-4b93-88df-1650bd68e0cc';

function failure(over: Record<string, unknown> = {}) {
    return {
        id: 'f1',
        itemId: UUID,
        reason: 'truncated_video',
        occurredAt: '2026-07-18T03:42:00.000Z',
        ...over,
    };
}

function renderList(failures: unknown[]) {
    // The component fetches its own page; the label logic is what is under test.
    mockGet.mockResolvedValue({
        data: { items: failures, page: { limit: 50, hasMore: false, total: failures.length } },
        error: null,
    });
    return render(TaskFailuresList, { taskId: 'media-probe' } as never);
}

describe('TaskFailuresList item label', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(cleanup);

    it('says the item is gone instead of printing its UUID', async () => {
        renderList([failure()]);
        await waitFor(() => expect(screen.getByText('No longer in your library')).toBeTruthy());
        expect(screen.queryByText(UUID)).toBeNull();
    });

    it('prefers a real title whenever one resolved', async () => {
        renderList([failure({ title: 'Cinderella trailer' })]);
        await waitFor(() => expect(screen.getByText('Cinderella trailer')).toBeTruthy());
    });

    it('KEEPS a non-uuid id — that is a plugin key and may be meaningful', async () => {
        // e.g. a path or a provider-scoped key; blanking it would lose real
        // information, so the "gone" wording is uuid-shaped only.
        renderList([failure({ itemId: '/movies/Some Film (2021)/film.mkv' })]);
        await waitFor(() =>
            expect(screen.getByText('/movies/Some Film (2021)/film.mkv')).toBeTruthy(),
        );
    });

    it('handles the composite mediaItemId|fileId key', async () => {
        // trickplay-params keys on `${mediaItemId}|${fileId}`; the part before
        // the pipe is what gets looked up, so an unresolved one is still gone.
        renderList([failure({ itemId: `${UUID}|9f0f1a2b-1111-2222-3333-444455556666` })]);
        await waitFor(() => expect(screen.getByText('No longer in your library')).toBeTruthy());
    });
});

it('Retry all reports actual restored count and a repeated zero leaves queued work unchanged', async () => {
    mockGet.mockResolvedValue({
        data: {
            items: [failure({ title: 'Intro timeout' })],
            page: { limit: 50, hasMore: false, total: 1 },
        },
    });
    mockPost
        .mockResolvedValueOnce({ data: { count: 3 } })
        .mockResolvedValueOnce({ data: { count: 0 } });
    render(TaskFailuresList, {
        taskId: 'lumastra-intro-analyzer',
        coveredStageIds: ['intro-visual'],
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry all failed items' }));
    await modal.open.mock.calls[0][1].onConfirm();
    expect(toasts.success).toHaveBeenCalledWith(expect.stringContaining('3'));
    await fireEvent.click(screen.getByRole('button', { name: 'Retry all failed items' }));
    await modal.open.mock.calls[1][1].onConfirm();
    expect(toasts.info).toHaveBeenCalledWith(
        '0 additional items queued. Already queued, running, completed and intentionally skipped items were unchanged.',
    );
    expect(mockPost.mock.calls.map((c) => c[2])).toEqual([
        { stageId: 'intro-visual' },
        { stageId: 'intro-visual' },
    ]);
});
