// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { Run } from '@sapd/lumastra-plugin-sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const tracking = vi.hoisted(() => ({ settled: null as ((run: Run) => void) | null }));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/stores/run-sse-bus.js', () => ({ runSSEBus: { onAnyChange: () => () => {} } }));
vi.mock('$lib/stores/subject-runs.js', () => ({
    createSubjectRunsTracker: () => ({
        isActive: () => false,
        runsFor: () => [],
        progressFor: () => undefined,
        onSettled: (cb: (run: Run) => void) => {
            tracking.settled = cb;
            return () => {};
        },
        destroy: () => {},
    }),
}));
const api = vi.hoisted(() => ({
    getMediaImages: vi.fn(),
    syncMediaImages: vi.fn(),
    extractPosterFromVideo: vi.fn(),
    uploadMediaImage: vi.fn(),
    uploadMediaImageByUrl: vi.fn(),
    deleteMediaImage: vi.fn(),
}));
vi.mock('$lib/api/admin', () => api);
vi.mock('$lib/api/image-candidates.js', () => ({
    getImageCandidates: vi.fn(async () => ({ data: { candidates: [] } })),
    curateImageCandidates: vi.fn(),
}));
import ImagesTab from './ImagesTab.svelte';
beforeEach(() => {
    vi.clearAllMocks();
    api.getMediaImages.mockResolvedValue({ data: [] });
    api.syncMediaImages.mockResolvedValue({ data: { runId: 'accepted-run' } });
    api.extractPosterFromVideo.mockResolvedValue({ data: { extracted: true } });
});
afterEach(cleanup);
it.each(['track', 'audiobook', 'artist'])(
    '%s keeps audio artwork controls without video actions',
    async (mediaType) => {
        render(ImagesTab, { mediaId: 'fictional-audio', mediaType });
        await waitFor(() => expect(api.getMediaImages).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: /extract from video/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /^refresh artwork$/i })).toBeNull();
        expect(screen.getByLabelText('Upload Poster image')).toBeTruthy();
        expect(screen.getAllByRole('button', { name: 'File' }).length).toBeGreaterThan(0);
        expect(screen.getAllByRole('button', { name: 'URL' }).length).toBeGreaterThan(0);
        expect(api.extractPosterFromVideo).not.toHaveBeenCalled();
        expect(api.syncMediaImages).not.toHaveBeenCalled();
    },
);
it('movie retains working video extraction and image sync', async () => {
    render(ImagesTab, { mediaId: 'fictional-movie', mediaType: 'movie' });
    await fireEvent.click(screen.getAllByRole('button', { name: /extract from video/i })[0]);
    await waitFor(() =>
        expect(api.extractPosterFromVideo).toHaveBeenCalledWith('fictional-movie', {
            artworkType: 'poster',
            force: true,
        }),
    );
    await fireEvent.click(screen.getByRole('button', { name: /^refresh artwork$/i }));
    await waitFor(() =>
        expect(api.syncMediaImages).toHaveBeenCalledWith(
            'fictional-movie',
            expect.objectContaining({ scope: 'movie' }),
        ),
    );
});

it('shows the selected provider thumbnail in the episode image slot without a local candidate', async () => {
    const selectedThumb = '/api/media/fictional-episode/images/thumb?size=full&fallback=none';
    render(ImagesTab, {
        mediaId: 'fictional-episode',
        mediaType: 'episode',
        currentThumbUrl: selectedThumb,
    });
    await waitFor(() => expect(api.getMediaImages).toHaveBeenCalledWith('fictional-episode'));
    expect((screen.getByAltText('thumb') as HTMLImageElement).getAttribute('src')).toBe(
        selectedThumb,
    );
    expect(screen.queryByRole('button', { name: /^remove$/i })).toBeNull();
});

it('updates artwork when the accepted run finishes and keeps planning controls out of the form', async () => {
    const saved = vi.fn();
    render(ImagesTab, { mediaId: 'fictional-movie', mediaType: 'movie', onsaved: saved });
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh artwork' }));
    expect(screen.queryByRole('combobox')).toBeNull();
    expect((await screen.findByRole('status')).textContent).toContain(
        'This page updates when it finishes',
    );
    tracking.settled?.({
        id: 'accepted-run',
        taskId: 'image-sync',
        state: 'completed',
        result: { success: true },
    } as Run);
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toContain('Artwork refresh finished');
    expect(api.syncMediaImages).toHaveBeenCalledExactlyOnceWith('fictional-movie', {
        mode: 'execute',
        scope: 'movie',
        extractVideo: false,
    });
});
