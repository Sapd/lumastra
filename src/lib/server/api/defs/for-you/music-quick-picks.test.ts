// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetSql = vi.fn();
const mockGetUserIdByUsername = vi.fn();
const mockHasPlayableMusic = vi.fn();
const mockHasRecentMusicListening = vi.fn();
const mockGetMediaBrowserStats = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: (...args: unknown[]) => mockGetUserIdByUsername(...args),
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    hasPlayableMusic: (...args: unknown[]) => mockHasPlayableMusic(...args),
    hasRecentMusicListening: (...args: unknown[]) => mockHasRecentMusicListening(...args),
}));

// The gate used to call this full-scan admin stats query on every For You load.
vi.mock('$lib/server/database/queries/admin-media.queries.js', () => ({
    getMediaBrowserStats: (...args: unknown[]) => mockGetMediaBrowserStats(...args),
}));

const mockGetRadio = vi.fn();
const mockGetQuickPicks = vi.fn();
const mockGetDisliked = vi.fn();
const cacheStore = new Map<string, unknown>();

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({ deniedGroupIds: null, ageRating: null })),
    scopedCacheKey: (prefix: string) => `${prefix}|all`,
}));
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getRecentlyListenedRadioMediaItems: (...args: unknown[]) => mockGetRadio(...args),
}));
vi.mock('$lib/server/services/music/quick-picks.service.js', () => ({
    getQuickPicks: (...args: unknown[]) => mockGetQuickPicks(...args),
}));
vi.mock('$lib/server/database/queries/music-quick-picks.queries.js', () => ({
    getDislikedTrackIds: (...args: unknown[]) => mockGetDisliked(...args),
}));
vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { musicQuickPicksRow: { name: 'music-quick-picks-row-v1' } },
    cacheManager: {
        for: () => ({
            get: async (k: string) => cacheStore.get(k) ?? null,
            set: async (k: string, v: unknown) => void cacheStore.set(k, v),
        }),
    },
}));

const { def } = await import('./music-quick-picks.js');

function makeEvent(): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/for-you/music-quick-picks'),
        params: {},
        request: new Request('http://localhost/api/for-you/music-quick-picks'),
    } as unknown as RequestEvent;
}

describe('music-quick-picks library gate', () => {
    const sql = {};

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue(sql);
        mockGetUserIdByUsername.mockResolvedValue('u1');
        mockHasRecentMusicListening.mockResolvedValue(false);
    });

    it('returns a null section without checking listening when no music is playable', async () => {
        mockHasPlayableMusic.mockResolvedValue(false);

        const res = await def.handlers.GET!(makeEvent(), { surface: 'internal' } as never);

        expect(await res.json()).toEqual({ section: null });
        expect(mockHasPlayableMusic).toHaveBeenCalledWith(sql);
        expect(mockHasRecentMusicListening).not.toHaveBeenCalled();
        expect(mockGetMediaBrowserStats).not.toHaveBeenCalled();
    });

    it('continues to the listening check when music is playable', async () => {
        mockHasPlayableMusic.mockResolvedValue(true);

        const res = await def.handlers.GET!(makeEvent(), { surface: 'internal' } as never);

        expect(await res.json()).toEqual({ section: null });
        expect(mockHasRecentMusicListening).toHaveBeenCalledWith(sql, 'u1', 14);
        expect(mockGetMediaBrowserStats).not.toHaveBeenCalled();
    });
});

describe('music-quick-picks row cache', () => {
    const sql = {};
    const track = (id: string) => ({ id, title: `T ${id}`, bucket: 'heavy-rotation' });

    beforeEach(() => {
        vi.clearAllMocks();
        cacheStore.clear();
        mockGetSql.mockResolvedValue(sql);
        mockGetUserIdByUsername.mockResolvedValue('u1');
        mockHasPlayableMusic.mockResolvedValue(true);
        mockHasRecentMusicListening.mockResolvedValue(true);
        mockGetRadio.mockResolvedValue([]);
        mockGetQuickPicks.mockResolvedValue([track('a'), track('b')]);
        mockGetDisliked.mockResolvedValue([]);
    });

    async function ids(): Promise<string[]> {
        const res = await def.handlers.GET!(makeEvent(), { surface: 'internal' } as never);
        const body = (await res.json()) as { section: { items: { id: string }[] } | null };
        return body.section?.items.map((i) => i.id) ?? [];
    }

    it('builds the picks once and serves the next load from the cache', async () => {
        expect(await ids()).toEqual(['a', 'b']);
        expect(await ids()).toEqual(['a', 'b']);
        expect(mockGetQuickPicks).toHaveBeenCalledTimes(1);
    });

    it('drops a pick the user disliked after it was cached', async () => {
        await ids();
        mockGetDisliked.mockResolvedValue(['a']);
        expect(await ids()).toEqual(['b']);
        expect(mockGetQuickPicks).toHaveBeenCalledTimes(1);
    });
});
