// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicTrack } from '$lib/schemas/music';
import type { PageSection } from '$lib/types/server-driven-ui';

const playback = vi.hoisted(() => ({
    startPlayback: vi.fn<(track: MusicTrack) => Promise<void>>(),
}));
const modals = vi.hoisted(() => ({ openAlbumForTrack: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { data: {} } }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$lib/stores/music-player.store', () => ({ musicPlayerStore: playback }));
vi.mock('$lib/utils/modal-utils', () => ({
    ...modals,
    openAlbumModal: vi.fn(),
    openArtistModal: vi.fn(),
    openSimilarTracksModal: vi.fn(),
}));
vi.mock('$lib/api/playlists', () => ({ getPlaylist: vi.fn() }));
vi.mock('$lib/api/music', () => ({ getAlbum: vi.fn() }));
vi.mock('$lib/utils/image-utils', () => ({ getCatalogPosterUrl: () => '/fixture.jpg' }));

import { createMusicItemHandlers } from './music-item-handlers.svelte';
import { mapMusicTrackToItem } from './mapMusicTrackToItem';
import { musicTrackFromCard } from './music-track';

const section: PageSection = {
    id: 'music-recommendations',
    type: 'carousel',
    title: 'Music',
    items: [],
};
const performer = { id: 'performer-id', title: 'DJ Manian' };
const remixer = { id: 'remixer-id', title: 'Cascada' };

describe('music cards preserve artist roles when starting playback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        playback.startPlayback.mockResolvedValue(undefined);
    });

    it.each(['play button', 'album fallback'] as const)(
        'keeps performer and title-remixer identities separate through %s',
        async (entry) => {
            const track = musicTrackFromCard({
                id: 'track-id',
                title: 'Like a Prayer (Cascada radio edit)',
                artists: [performer],
                remixerArtists: [remixer],
            });
            const item = mapMusicTrackToItem(track);
            const handlers = createMusicItemHandlers();
            if (entry === 'play button') {
                await handlers.handleItemPlay({ section, item });
            } else {
                modals.openAlbumForTrack.mockImplementation((_id, options) => options.fallback());
                handlers.handleItemClick({ section, item });
            }
            expect(playback.startPlayback).toHaveBeenCalledOnce();
            expect(playback.startPlayback.mock.calls[0][0]).toMatchObject({
                id: track.id,
                title: track.title,
                artists: [performer],
                remixerArtists: [remixer],
            });
        },
    );

    it('does not promote a remixer into an explicitly empty performer list', async () => {
        const item = mapMusicTrackToItem(
            musicTrackFromCard({
                id: 'track-id',
                title: 'Instrumental (Cascada remix)',
                artists: [],
                remixerArtists: [remixer],
            }),
        );
        await createMusicItemHandlers().handleItemPlay({ section, item });
        expect(playback.startPlayback.mock.calls[0][0]).toMatchObject({
            artists: [],
            remixerArtists: [remixer],
        });
    });
});
