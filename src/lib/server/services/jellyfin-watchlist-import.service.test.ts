// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    },
}));

vi.mock('./jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserIdByUserId: vi.fn(),
}));

vi.mock('$lib/server/jellyfin/media.service.js', () => ({
    jellyfinMediaService: { getFavoriteItems: vi.fn() },
}));

vi.mock('./watchlist-manager.service.js', () => ({
    watchlistManager: { addItem: vi.fn() },
}));

import { resolveJellyfinUserIdByUserId } from './jellyfin-user-id-resolver.js';
import { jellyfinMediaService } from '$lib/server/jellyfin/media.service.js';
import { watchlistManager } from './watchlist-manager.service.js';
import { importJellyfinFavoritesToWatchlist } from './jellyfin-watchlist-import.service.js';

const mockSql = {} as postgres.Sql;
const TEST_USER = {
    userId: toUserId('00000000-0000-0000-0000-000000000001'),
    username: 'basti',
    groups: '',
    userGroups: [],
    hasWatchPermission: true,
    hasLiveTvPermission: false,
    hasRequestPermission: false,
    ownerIsAdmin: false,
    maxAgeRating: null,
    isAgeRestricted: false,
    isModerator: false,
    liveTvPriority: 'low' as const,
};

describe('importJellyfinFavoritesToWatchlist', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns unavailable when the Jellyfin user cannot be resolved', async () => {
        vi.mocked(resolveJellyfinUserIdByUserId).mockResolvedValue(undefined);

        const result = await importJellyfinFavoritesToWatchlist(mockSql, TEST_USER);

        expect(result).toEqual({ ok: false, reason: 'unavailable' });
        expect(jellyfinMediaService.getFavoriteItems).not.toHaveBeenCalled();
    });

    it('returns unavailable when fetching favorites throws', async () => {
        vi.mocked(resolveJellyfinUserIdByUserId).mockResolvedValue('jf-user-1');
        vi.mocked(jellyfinMediaService.getFavoriteItems).mockRejectedValue(
            new Error('Jellyfin unreachable'),
        );

        const result = await importJellyfinFavoritesToWatchlist(mockSql, TEST_USER);

        expect(result).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('imports items with a TMDB id, skips items without one', async () => {
        vi.mocked(resolveJellyfinUserIdByUserId).mockResolvedValue('jf-user-1');
        vi.mocked(jellyfinMediaService.getFavoriteItems).mockResolvedValue([
            { Id: '1', Name: 'Quiet Orbit', Type: 'Movie', ProviderIds: { Tmdb: '550' } },
            { Id: '2', Name: 'No Metadata Match', Type: 'Movie', ProviderIds: {} },
            { Id: '3', Name: 'Drifting Clouds', Type: 'Series', ProviderIds: { Tmdb: '1396' } },
        ] as never);
        vi.mocked(watchlistManager.addItem).mockResolvedValue({ saved: true, mediaId: 'uuid-x' });

        const result = await importJellyfinFavoritesToWatchlist(mockSql, TEST_USER);

        expect(result).toEqual({ ok: true, imported: 2, skipped: 1, total: 3 });
        expect(watchlistManager.addItem).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: { tmdb: '550' },
                mediaType: 'movie',
                title: 'Quiet Orbit',
                user: TEST_USER,
                skipActivityFeed: true,
            }),
        );
        expect(watchlistManager.addItem).toHaveBeenCalledWith(
            expect.objectContaining({ externalIds: { tmdb: '1396' }, mediaType: 'tv' }),
        );
    });

    it('folds a per-item addItem failure into skipped without aborting the batch', async () => {
        vi.mocked(resolveJellyfinUserIdByUserId).mockResolvedValue('jf-user-1');
        vi.mocked(jellyfinMediaService.getFavoriteItems).mockResolvedValue([
            { Id: '1', Name: 'Quiet Orbit', Type: 'Movie', ProviderIds: { Tmdb: '550' } },
            { Id: '2', Name: 'Access Denied Movie', Type: 'Movie', ProviderIds: { Tmdb: '999' } },
        ] as never);
        vi.mocked(watchlistManager.addItem)
            .mockResolvedValueOnce({ saved: true, mediaId: 'uuid-1' })
            .mockRejectedValueOnce(new Error('access denied'));

        const result = await importJellyfinFavoritesToWatchlist(mockSql, TEST_USER);

        expect(result).toEqual({ ok: true, imported: 1, skipped: 1, total: 2 });
    });

    it('counts items with unresolvable IDs (saved: false) as skipped, not imported', async () => {
        vi.mocked(resolveJellyfinUserIdByUserId).mockResolvedValue('jf-user-1');
        vi.mocked(jellyfinMediaService.getFavoriteItems).mockResolvedValue([
            { Id: '1', Name: 'Quiet Orbit', Type: 'Movie', ProviderIds: { Tmdb: '550' } },
            { Id: '2', Name: 'Unresolvable Movie', Type: 'Movie', ProviderIds: { Tmdb: '99999' } },
        ] as never);
        vi.mocked(watchlistManager.addItem)
            .mockResolvedValueOnce({ saved: true, mediaId: 'uuid-1' })
            .mockResolvedValueOnce({ saved: false, mediaId: null });

        const result = await importJellyfinFavoritesToWatchlist(mockSql, TEST_USER);

        expect(result).toEqual({ ok: true, imported: 1, skipped: 1, total: 2 });
    });

    it('returns zero counts for an empty favorites list', async () => {
        vi.mocked(resolveJellyfinUserIdByUserId).mockResolvedValue('jf-user-1');
        vi.mocked(jellyfinMediaService.getFavoriteItems).mockResolvedValue([]);

        const result = await importJellyfinFavoritesToWatchlist(mockSql, TEST_USER);

        expect(result).toEqual({ ok: true, imported: 0, skipped: 0, total: 0 });
    });
});
