// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { musicTrackFromCard } from '$lib/utils/music-track';
import SimilarTracksModal from './SimilarTracksModal.svelte';

const mocks = vi.hoisted(() => ({
    getTrack: vi.fn(),
    getSimilarTracks: vi.fn(),
}));
vi.mock('$lib/api/music', () => ({
    getTrack: mocks.getTrack,
    getSimilarTracks: mocks.getSimilarTracks,
    setTrackFeedback: vi.fn(),
    clearTrackFeedback: vi.fn(),
}));
vi.mock('$lib/stores/modal.store', () => ({
    modals: { close: vi.fn(), open: vi.fn() },
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: {
        ...writable({ currentTrack: null }),
        play: vi.fn(),
        playNext: vi.fn(),
        addToQueue: vi.fn(),
        enqueue: vi.fn(),
    },
}));

function track(id: string, similarityScore?: number) {
    return {
        ...musicTrackFromCard({
            id,
            title: `Title ${id}`,
            artists: [{ id: null, title: 'Artist' }],
            durationMs: 200_000,
        }),
        ...(similarityScore === undefined ? {} : { similarityScore }),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTrack.mockResolvedValue({ data: { track: track('seed') }, error: null });
});
afterEach(cleanup);

describe('SimilarTracksModal', () => {
    it('asks for basis=auto when sonic is enabled and shows match chips for sonic results', async () => {
        mocks.getSimilarTracks.mockResolvedValue({
            data: {
                items: [track('a', 0.91)],
                source: 'sonic',
                page: { limit: 20, truncated: false },
            },
            error: null,
        });
        render(SimilarTracksModal, { modalId: 'm', trackId: 'seed', sonicEnabled: true });
        await waitFor(() => expect(screen.getByText('91% match')).toBeTruthy());
        expect(mocks.getSimilarTracks).toHaveBeenCalledWith('seed', { basis: 'auto', limit: 20 });
    });

    it('asks for basis=metadata when sonic is disabled and shows no match chips', async () => {
        mocks.getSimilarTracks.mockResolvedValue({
            data: {
                items: [track('a', 0.5)],
                source: 'metadata',
                page: { limit: 20, truncated: false },
            },
            error: null,
        });
        render(SimilarTracksModal, { modalId: 'm', trackId: 'seed', sonicEnabled: false });
        await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
        expect(mocks.getSimilarTracks).toHaveBeenCalledWith('seed', {
            basis: 'metadata',
            limit: 20,
        });
        expect(screen.queryByText(/% match/)).toBeNull();
    });

    it('shows no match chips when auto fell back to metadata', async () => {
        mocks.getSimilarTracks.mockResolvedValue({
            data: {
                items: [track('a', 0.8)],
                source: 'metadata',
                page: { limit: 20, truncated: false },
            },
            error: null,
        });
        render(SimilarTracksModal, { modalId: 'm', trackId: 'seed', sonicEnabled: true });
        await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
        expect(screen.queryByText(/% match/)).toBeNull();
    });
});
