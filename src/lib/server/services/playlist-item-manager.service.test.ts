// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/playlist-item-manager.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type {
    SeriesEpisodeRow,
    AlbumTrackRow,
} from '$lib/server/database/queries/playlist-items.queries.js';
import type { InsertedItemRow } from '$lib/server/database/queries/playlists.queries.js';
import type { PlaylistEntry } from '$lib/types/api-playlists.js';

vi.mock('$lib/server/database/queries/playlists.queries.js', () => ({
    resolvePreferredToMediaId: vi.fn(),
    resolveEpisodeContext: vi.fn().mockResolvedValue(null),
    getNextPosition: vi.fn().mockResolvedValue(0),
    insertPlaylistItem: vi.fn(),
    touchPlaylist: vi.fn().mockResolvedValue(undefined),
    getPlaylistSummary: vi.fn(async () => ({
        itemCount: 0,
        revision: 1,
        updatedAt: '2026-10-17T00:00:00Z',
    })),
    getPlaylistItems: vi.fn(async () => []),
    getItemPosition: vi.fn(),
    deletePlaylistItem: vi.fn(),
    reorderItemsAfterDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/database/queries/playlist-items.queries.js', () => ({
    getSeriesEpisodesForPlaylist: vi.fn(),
    getAlbumTracks: vi.fn(),
}));

vi.mock('$lib/utils/external-ids.js', async (importOriginal) => ({
    // The legacy-Jellyfin-id helpers stay real (none of these fixtures carry one).
    ...(await importOriginal<typeof import('$lib/utils/external-ids.js')>()),
    // Real lookup semantics: the episode branch reads 'internal' through this.
    getExternalIdFor: vi.fn(
        (ids: Record<string, string> | undefined, provider: string) => ids?.[provider],
    ),
    getPreferredExternalId: vi.fn().mockReturnValue('tmdb:550'),
}));

vi.mock('$lib/server/utils/playlist-transforms.js', () => ({
    transformInsertedItemRow: vi.fn(),
    transformPlaylistItemRow: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

import {
    resolvePreferredToMediaId,
    resolveEpisodeContext,
    getNextPosition,
    insertPlaylistItem,
    touchPlaylist,
    getItemPosition,
    deletePlaylistItem,
    reorderItemsAfterDelete,
} from '$lib/server/database/queries/playlists.queries.js';
import {
    getSeriesEpisodesForPlaylist,
    getAlbumTracks,
} from '$lib/server/database/queries/playlist-items.queries.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { transformInsertedItemRow } from '$lib/server/utils/playlist-transforms.js';
import { playlistItemManager } from './playlist-item-manager.service.js';

// Mock sql with transaction support — begin() calls the callback with a tx handle.
// mockTx must be callable as a tagged-template function so advisory-lock statements
// (`await tx\`SELECT pg_advisory_xact_lock(...)\``) resolve without throwing.
const mockTx = Object.assign(vi.fn().mockResolvedValue([]), {}) as unknown as postgres.Sql;
const mockSql = {
    begin: vi.fn(async (fn: (tx: postgres.Sql) => Promise<unknown>) => fn(mockTx)),
} as unknown as postgres.Sql;

const makeEpisode = (overrides?: Partial<SeriesEpisodeRow>): SeriesEpisodeRow => ({
    id: 'ep-uuid-1',
    title: 'Pilot',
    season_number: 1,
    episode_number: 1,
    poster_path: null,
    overview: null,
    ...overrides,
});

const makeTrack = (overrides?: Partial<AlbumTrackRow>): AlbumTrackRow => ({
    id: 'track-uuid-1',
    title: 'Track 1',
    sort_order: 1,
    episode_number: 1,
    runtime_seconds: 240,
    ...overrides,
});

const makeInsertedRow = (id = 42) =>
    ({
        id,
        position: 0,
        title: 'Test Movie',
        series_name: null,
        season_number: null,
        episode_number: null,
        overview: null,
        poster_path: null,
        added_at: new Date().toISOString(),
    }) as InsertedItemRow;

const makeMockPlaylistItem = (): PlaylistEntry =>
    ({
        id: 42,
        mediaId: 'media-uuid-1',
        externalIds: { tmdb: '550' },
        mediaType: 'movie',
        title: 'Test Movie',
        position: 0,
    }) as unknown as PlaylistEntry;

const baseParams = {
    sql: mockSql,
    playlistId: 1,
    externalIds: { tmdb: '550' },
    mediaType: 'movie',
    title: 'Test Movie',
    username: 'alice',
};

describe('PlaylistItemManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getNextPosition).mockResolvedValue(0);
        vi.mocked(touchPlaylist).mockResolvedValue(undefined);
        vi.mocked(reorderItemsAfterDelete).mockResolvedValue(undefined);
    });

    // =========================================================================
    // addItems
    // =========================================================================

    describe('addItems', () => {
        it('TV series expansion — calls getSeriesEpisodesForPlaylist, inserts each episode, returns expanded result', async () => {
            const episodes = [
                makeEpisode({
                    id: 'ep-1',
                    season_number: 1,
                    episode_number: 1,
                }),
                makeEpisode({ id: 'ep-2', season_number: 1, episode_number: 2 }),
            ];
            vi.mocked(resolvePreferredToMediaId).mockResolvedValue('series-uuid-1');
            vi.mocked(getSeriesEpisodesForPlaylist).mockResolvedValue(episodes);
            vi.mocked(insertPlaylistItem).mockResolvedValue(makeInsertedRow());

            const result = await playlistItemManager.addItems({
                surface: 'internal',
                ...baseParams,
                mediaType: 'tv',
                title: 'Drifting Clouds',
            });

            expect(getSeriesEpisodesForPlaylist).toHaveBeenCalledWith(mockSql, 'series-uuid-1');
            expect(mockSql.begin).toHaveBeenCalled();
            expect(insertPlaylistItem).toHaveBeenCalledTimes(2);
            expect(touchPlaylist).toHaveBeenCalledWith(mockTx, 1);
            expect(result).toMatchObject({
                type: 'expanded',
                expanded: true,
                seriesName: 'Drifting Clouds',
                episodesAdded: 2,
            });
        });

        it('TV series with no episodes — returns expanded=false, episodesAdded=0', async () => {
            vi.mocked(resolvePreferredToMediaId).mockResolvedValue('series-uuid-1');
            vi.mocked(getSeriesEpisodesForPlaylist).mockResolvedValue([]);

            const result = await playlistItemManager.addItems({
                surface: 'internal',
                ...baseParams,
                mediaType: 'tv',
                title: 'Empty Series',
            });

            expect(result).toMatchObject({
                type: 'expanded',
                expanded: false,
                episodesAdded: 0,
            });
            expect(insertPlaylistItem).not.toHaveBeenCalled();
        });

        it('music album expansion — calls getAlbumTracks, inserts each track, returns expanded', async () => {
            const tracks = [
                makeTrack({ id: 'track-1', title: 'Track 1' }),
                makeTrack({ id: 'track-2', title: 'Track 2' }),
            ];
            vi.mocked(getExternalIdFor).mockReturnValue('album-uuid-1');
            vi.mocked(getAlbumTracks).mockResolvedValue(tracks);
            vi.mocked(insertPlaylistItem).mockResolvedValue(makeInsertedRow());

            const result = await playlistItemManager.addItems({
                surface: 'internal',
                ...baseParams,
                mediaType: 'album',
                title: 'Dark Side of the Moon',
                externalIds: { internal: 'album-uuid-1' } as Record<string, string>,
            });

            expect(getAlbumTracks).toHaveBeenCalledWith(mockSql, 'album-uuid-1');
            expect(mockSql.begin).toHaveBeenCalled();
            expect(insertPlaylistItem).toHaveBeenCalledTimes(2);
            expect(touchPlaylist).toHaveBeenCalledWith(mockTx, 1);
            expect(result).toMatchObject({
                type: 'expanded',
                expanded: true,
                episodesAdded: 2,
            });
        });

        it('single track — mediaType=track with no album children, inserts single item', async () => {
            vi.mocked(getExternalIdFor).mockReturnValue('track-uuid-1');
            vi.mocked(getAlbumTracks).mockResolvedValue([]);
            const row = makeInsertedRow();
            vi.mocked(insertPlaylistItem).mockResolvedValue(row);
            const item = makeMockPlaylistItem();
            vi.mocked(transformInsertedItemRow).mockReturnValue(item);

            const result = await playlistItemManager.addItems({
                surface: 'internal',
                ...baseParams,
                mediaType: 'track',
                title: 'My Track',
                externalIds: { internal: 'track-uuid-1' } as Record<string, string>,
            });

            expect(insertPlaylistItem).toHaveBeenCalledTimes(1);
            expect(touchPlaylist).toHaveBeenCalledWith(mockTx, 1);
            expect(result).toMatchObject({ type: 'single', item });
        });

        it('single movie — resolves via resolvePreferredToMediaId, inserts, returns single with item', async () => {
            vi.mocked(resolvePreferredToMediaId).mockResolvedValue('movie-uuid-1');
            const row = makeInsertedRow();
            vi.mocked(insertPlaylistItem).mockResolvedValue(row);
            const item = makeMockPlaylistItem();
            vi.mocked(transformInsertedItemRow).mockReturnValue(item);

            const result = await playlistItemManager.addItems({
                surface: 'internal',
                ...baseParams,
                mediaType: 'movie',
                title: 'The Lantern',
            });

            expect(resolvePreferredToMediaId).toHaveBeenCalled();
            expect(insertPlaylistItem).toHaveBeenCalledTimes(1);
            expect(touchPlaylist).toHaveBeenCalledWith(mockTx, 1);
            expect(result).toMatchObject({ type: 'single', item });
        });

        it('returns null when media not found — resolvePreferredToMediaId returns null', async () => {
            vi.mocked(resolvePreferredToMediaId).mockResolvedValue(null);

            const result = await playlistItemManager.addItems({
                surface: 'internal',
                ...baseParams,
                mediaType: 'movie',
            });

            expect(result).toBeNull();
            expect(insertPlaylistItem).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // removeItem
    // =========================================================================

    // =========================================================================
    // Single-episode adds (search-sourced)
    // =========================================================================

    describe('addItems — single episode', () => {
        beforeEach(() => {
            // The music tests above pin getExternalIdFor to a fixed return via
            // mockReturnValue, which clearAllMocks() does NOT undo. Restore real
            // lookup semantics so the episode branch reads the actual ids.
            vi.mocked(getExternalIdFor).mockImplementation(
                // Types inferred from the mocked fn (ExternalIds|null|undefined,
                // ExternalIdProvider) — matches the real lookup exactly.
                (externalIds, provider) => externalIds?.[provider],
            );
        });

        const episodeParams = {
            surface: 'internal' as const,
            ...baseParams,
            externalIds: { internal: 'ep-uuid-1' },
            mediaType: 'episode',
            title: 'Orionlands',
        };

        it('derives season/episode/seriesName from the hierarchy when the client sends none', async () => {
            vi.mocked(resolvePreferredToMediaId).mockResolvedValue('ep-uuid-1');
            vi.mocked(resolveEpisodeContext).mockResolvedValue({
                seriesMediaId: 'series-uuid-1',
                seriesName: 'Drifting Clouds',
                seasonNumber: 5,
                episodeNumber: 14,
            });
            vi.mocked(insertPlaylistItem).mockResolvedValue(makeInsertedRow());
            vi.mocked(transformInsertedItemRow).mockReturnValue(makeMockPlaylistItem());

            await playlistItemManager.addItems(episodeParams);

            expect(resolveEpisodeContext).toHaveBeenCalledWith(mockSql, 'ep-uuid-1');
            expect(insertPlaylistItem).toHaveBeenCalledWith(
                mockTx,
                expect.objectContaining({
                    // The episode's OWN uuid, matching what series expansion writes.
                    mediaId: 'ep-uuid-1',
                    seasonNumber: 5,
                    episodeNumber: 14,
                    seriesName: 'Drifting Clouds',
                }),
            );
        });

        it('overrides client-supplied season/episode that disagree with the database', async () => {
            vi.mocked(resolvePreferredToMediaId).mockResolvedValue('ep-uuid-1');
            vi.mocked(resolveEpisodeContext).mockResolvedValue({
                seriesMediaId: 'series-uuid-1',
                seriesName: 'Drifting Clouds',
                seasonNumber: 5,
                episodeNumber: 14,
            });
            vi.mocked(insertPlaylistItem).mockResolvedValue(makeInsertedRow());
            vi.mocked(transformInsertedItemRow).mockReturnValue(makeMockPlaylistItem());

            await playlistItemManager.addItems({
                ...episodeParams,
                seasonNumber: 1,
                episodeNumber: 1,
                seriesName: 'Wrong Show',
            });

            expect(insertPlaylistItem).toHaveBeenCalledWith(
                mockTx,
                expect.objectContaining({
                    seasonNumber: 5,
                    episodeNumber: 14,
                    seriesName: 'Drifting Clouds',
                }),
            );
        });

        it('reports the resolved series as seriesExternalIds, not the episode ids the client sent', async () => {
            vi.mocked(resolvePreferredToMediaId).mockResolvedValue('ep-uuid-1');
            vi.mocked(resolveEpisodeContext).mockResolvedValue({
                seriesMediaId: 'series-uuid-1',
                seriesName: 'Drifting Clouds',
                seasonNumber: 5,
                episodeNumber: 14,
            });
            vi.mocked(insertPlaylistItem).mockResolvedValue(makeInsertedRow());
            vi.mocked(transformInsertedItemRow).mockReturnValue(makeMockPlaylistItem());

            await playlistItemManager.addItems({
                ...episodeParams,
                // What Search.svelte sends today: the episode's own ids mislabeled.
                seriesExternalIds: { internal: 'ep-uuid-1' },
            });

            expect(transformInsertedItemRow).toHaveBeenCalledWith(
                expect.anything(),
                { internal: 'ep-uuid-1' },
                'episode',
                'internal',
                { internal: 'series-uuid-1' },
            );
        });

        it('falls through unchanged when the id is not an episode (SeriesEpisodePicker path)', async () => {
            vi.mocked(resolvePreferredToMediaId).mockResolvedValue('series-uuid-1');
            vi.mocked(resolveEpisodeContext).mockResolvedValue(null);
            vi.mocked(insertPlaylistItem).mockResolvedValue(makeInsertedRow());
            vi.mocked(transformInsertedItemRow).mockReturnValue(makeMockPlaylistItem());

            await playlistItemManager.addItems({
                ...episodeParams,
                externalIds: { internal: 'series-uuid-1' },
                seasonNumber: 3,
                episodeNumber: 7,
                seriesName: 'Picker Show',
            });

            // Client-supplied values survive when nothing could be derived.
            expect(insertPlaylistItem).toHaveBeenCalledWith(
                mockTx,
                expect.objectContaining({
                    seasonNumber: 3,
                    episodeNumber: 7,
                    seriesName: 'Picker Show',
                }),
            );
        });

        it('does not attempt derivation when no internal uuid is present', async () => {
            vi.mocked(resolvePreferredToMediaId).mockResolvedValue('series-uuid-1');
            vi.mocked(insertPlaylistItem).mockResolvedValue(makeInsertedRow());
            vi.mocked(transformInsertedItemRow).mockReturnValue(makeMockPlaylistItem());

            await playlistItemManager.addItems({
                ...episodeParams,
                externalIds: { tmdb: '1396' },
                seasonNumber: 2,
                episodeNumber: 4,
            });

            expect(resolveEpisodeContext).not.toHaveBeenCalled();
        });
    });

    describe('removeItem', () => {
        it('successful removal — gets position, deletes, reorders, touches, returns true', async () => {
            vi.mocked(getItemPosition).mockResolvedValue(3);
            vi.mocked(deletePlaylistItem).mockResolvedValue(true);

            const result = await playlistItemManager.removeItem({
                sql: mockSql,
                playlistId: 1,
                itemId: 42,
                username: 'alice',
            });

            expect(mockSql.begin).toHaveBeenCalled();
            expect(getItemPosition).toHaveBeenCalledWith(mockTx, 42, 1);
            expect(deletePlaylistItem).toHaveBeenCalledWith(mockTx, 42, 1);
            expect(reorderItemsAfterDelete).toHaveBeenCalledWith(mockTx, 1, 3);
            expect(touchPlaylist).toHaveBeenCalledWith(mockTx, 1);
            expect(result).toBe(true);
        });

        it('item not found — getItemPosition returns null, returns false without deleting', async () => {
            vi.mocked(getItemPosition).mockResolvedValue(null);

            const result = await playlistItemManager.removeItem({
                sql: mockSql,
                playlistId: 1,
                itemId: 999,
                username: 'alice',
            });

            expect(deletePlaylistItem).not.toHaveBeenCalled();
            expect(result).toBe(false);
        });
    });
});
