// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    review: vi.fn(),
    regenerate: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
}));
vi.mock('$lib/api/admin.js', () => ({
    getSharedEpisodeThumbReview: mocks.review,
    regenerateEpisodeThumbnails: mocks.regenerate,
    cancelRun: mocks.cancel,
}));
vi.mock('$lib/api/client.js', () => ({ apiGet: mocks.run }));
import SharedEpisodeThumbnailReview from './SharedEpisodeThumbnailReview.svelte';

const episodeId = 'a5577691-ea6d-4086-b5a8-b03ad43e8ea8';
const reviewToken = 'a'.repeat(64);
const row = {
    episodeId,
    episodeTitle: 'Fictional episode',
    seasonNumber: 1,
    episodeNumber: 2,
    selectedCandidateId: 'bfaf9048-c913-4989-96fd-1a92efb65455',
    artworkPath: '/images/shared-thumb.jpg',
    sharedCount: 2,
    candidateCount: 3,
    chosenBy: 'admin',
    locked: true,
    provider: 'tmdb',
    suppressed: false,
    sourceFileId: '9ba36388-122c-40f7-aafb-4793953323d7',
    sourcePath: '/library/Fictional S01E01E02.mkv',
    sourceMissing: false,
    sourceDurationSeconds: 1200,
    sourceSharedCount: 2,
    startOffsetMs: '600000',
    endOffsetMs: '1200000',
    reviewToken,
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.review.mockResolvedValue({ data: { total: 2, limit: 12, offset: 0, rows: [row] } });
    mocks.regenerate.mockResolvedValue({ data: { runId: 'run-1', deduped: false } });
    mocks.run.mockResolvedValue({
        data: {
            state: 'completed',
            result: { result: { extracted: 1, skipped: 0, errors: 0 } },
        },
    });
});
afterEach(cleanup);

it('shows bounded shared-image context and protected entries without choosing an owner', async () => {
    render(SharedEpisodeThumbnailReview, { mediaId: 'series-1' });
    expect(
        screen.getByText('Choose separate episode pictures (optional)').closest('details')?.open,
    ).toBe(false);
    await fireEvent.click(screen.getByText('Choose separate episode pictures (optional)'));
    await waitFor(() => expect(screen.getByText(/Fictional episode/)).toBeTruthy());
    expect(screen.getByText(/2 episodes shown/)).toBeTruthy();
    expect(screen.getByText(/Fictional S01E01E02.mkv/)).toBeTruthy();
    expect(screen.getByText(/shared-thumb.jpg/)).toBeTruthy();
    expect(screen.getByText(/Locked/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose a separate picture' })).toBeTruthy();
    expect(mocks.regenerate).not.toHaveBeenCalled();
});

it('queues only the reviewed episode and refreshes on a truthful completed result', async () => {
    const onsaved = vi.fn();
    render(SharedEpisodeThumbnailReview, { mediaId: 'series-1', onsaved });
    await fireEvent.click(screen.getByText('Choose separate episode pictures (optional)'));
    await fireEvent.click(await screen.findByRole('button', { name: 'Choose a separate picture' }));
    await waitFor(() =>
        expect(mocks.regenerate).toHaveBeenCalledWith(episodeId, {
            scope: 'episode',
            reviewToken,
        }),
    );
    await waitFor(() => expect(onsaved).toHaveBeenCalledOnce());
    expect(screen.getByRole('status').textContent).toContain(
        'Created: 1. Unchanged: 0. Failed: 0.',
    );
    expect(mocks.review.mock.calls.length).toBeGreaterThan(1);
});
