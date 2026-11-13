// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /j/Items/Latest and the legacy /j/Users/{userId}/Items/Latest (audit gap
 * 4): IncludeItemTypes / IsPlayed / GroupItems reach the query, grouped series
 * come back as the episode, season or series Jellyfin would show, and every row
 * is re-read with the user's data. SQL semantics live in
 * jellyfin-browse-g2.queries.integration.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    chooseLatestRepresentative,
    parseLatestQuery,
} from '$lib/server/proprietary/jellyfin-compat/latest-handler';

vi.setConfig({ testTimeout: 30_000 });

const {
    mockGetLatestItems,
    mockGetLatestSeriesGroups,
    mockGetFolderEpisodeCounts,
    mockBrowseMediaItems,
    mockApplyFolderUserData,
} = vi.hoisted(() => ({
    mockGetLatestItems: vi.fn(),
    mockGetLatestSeriesGroups: vi.fn(),
    mockGetFolderEpisodeCounts: vi.fn(),
    mockBrowseMediaItems: vi.fn(),
    mockApplyFolderUserData: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (h: unknown) => h,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) as never }));
vi.mock('$lib/server/config.js', () => ({ config: {}, LUMASTRA_MASTER_KEY: 'k' }));
vi.mock('$lib/server/config', () => ({ config: {}, LUMASTRA_MASTER_KEY: 'k' }));
vi.mock('$lib/server/database/queries/jellyfin-browse.queries', () => ({
    getLatestItems: mockGetLatestItems,
    browseMediaItems: mockBrowseMediaItems,
    mapJellyfinTypes: (s: string) =>
        s
            .split(',')
            .map(
                (t) =>
                    ({ Movie: 'movie', Series: 'tv', Episode: 'episode', Season: 'season' })[
                        t.trim()
                    ] ?? t.trim().toLowerCase(),
            ),
}));
vi.mock('$lib/server/database/queries/jellyfin-latest-groups.queries', () => ({
    getLatestSeriesGroups: mockGetLatestSeriesGroups,
    RECENT_ADDITION_WINDOW_HOURS: 24,
}));
vi.mock('$lib/server/database/queries/jellyfin-folder-counts.queries', () => ({
    getFolderEpisodeCounts: mockGetFolderEpisodeCounts,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/folder-user-data', () => ({
    applyFolderUserData: mockApplyFolderUserData,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/access-context', () => ({
    buildJellyfinAccessContext: vi.fn(async () => ({
        boundary: { library: { kind: 'all' }, age: { kind: 'any' } },
        deniedGroupIds: [],
        ageRating: null,
    })),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/content-language', () => ({
    applyJellyfinContentLanguage: vi.fn(async () => {}),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/media-source-enrichment', () => ({
    enrichItemsWithMediaSources: vi.fn(async () => {}),
    dropFilelessPlayables: (items: unknown[]) => items,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment', () => ({
    enrichItemsWithProviderIds: vi.fn(async () => {}),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/music-artists-enrichment', () => ({
    enrichItemsWithMusicArtists: vi.fn(async () => {}),
}));
vi.mock('$lib/paraglide/messages', async () => {
    const { messagesStub } = await import('$lib/server/__testkit__/paraglide-messages-stub');
    return messagesStub;
});
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const USER = { username: 'denis', userId: '00000000-0000-0000-0000-0000000000de' };
const MOVIE = 'aaaaaaaa-0000-0000-0000-000000000001';
const SERIES_ONE_EP = 'bbbbbbbb-0000-0000-0000-000000000001';
const SERIES_SEASON = 'bbbbbbbb-0000-0000-0000-000000000002';
const EP = 'cccccccc-0000-0000-0000-000000000001';
const SEASON = 'dddddddd-0000-0000-0000-000000000001';

const T = (hoursAgo: number): Date => new Date(Date.UTC(2026, 9, 7, 12) - hoursAgo * 3_600_000);

function row(
    id: string,
    media_type: string,
    title = id,
    latest_added: Date = T(0),
): Record<string, unknown> {
    return { id, media_type, title, runtime_seconds: 1500, latest_added };
}

async function call(path: string, query = ''): Promise<{ status: number; body: unknown }> {
    const mod =
        path === 'items'
            ? await import('./+server')
            : await import('../../Users/[userId]/Items/Latest/+server');
    const res = await (mod.GET as (e: never) => Promise<Response>)({
        url: new URL(`http://localhost/j/Items/Latest${query}`),
        request: { method: 'GET', headers: { get: () => null } },
        locals: { user: USER },
        params: path === 'items' ? {} : { userId: USER.userId },
        route: { id: null },
    } as never);
    return { status: res.status, body: await res.json() };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestItems.mockResolvedValue([
        row(MOVIE, 'movie', MOVIE, T(1)),
        row(SERIES_ONE_EP, 'tv', SERIES_ONE_EP, T(2)),
        row(SERIES_SEASON, 'tv', SERIES_SEASON, T(3)),
    ]);
    mockGetLatestSeriesGroups.mockResolvedValue(
        new Map([
            [
                SERIES_ONE_EP,
                {
                    seriesId: SERIES_ONE_EP,
                    recentCount: 1,
                    seasonIds: ['s-x'],
                    newestEpisodeId: EP,
                    newestAdded: T(2),
                },
            ],
            [
                SERIES_SEASON,
                {
                    seriesId: SERIES_SEASON,
                    recentCount: 3,
                    seasonIds: [SEASON],
                    newestEpisodeId: 'ep-newest',
                    newestAdded: T(3),
                },
            ],
        ]),
    );
    mockGetFolderEpisodeCounts.mockResolvedValue(
        new Map([
            [SERIES_ONE_EP, { childCount: 1, totalCount: 10, playedCount: 0 }],
            ['s-x', { childCount: 10, totalCount: 10, playedCount: 0 }],
            [SERIES_SEASON, { childCount: 3, totalCount: 30, playedCount: 0 }],
            [SEASON, { childCount: 10, totalCount: 10, playedCount: 0 }],
        ]),
    );
    mockBrowseMediaItems.mockImplementation(async (_sql: unknown, o: { idList: string[] }) => ({
        rows: o.idList
            .filter((id) => id !== SERIES_ONE_EP && id !== SERIES_SEASON)
            .map((id) =>
                row(id, id === EP ? 'episode' : id === SEASON ? 'season' : 'movie', `T-${id}`),
            ),
        totalCount: o.idList.length,
    }));
});

describe('parseLatestQuery', () => {
    const q = (s: string) => parseLatestQuery(new URL(`http://x/Items/Latest${s}`));

    it('defaults: grouped movies + series, played items hidden (HidePlayedInLatest)', () => {
        expect(q('')).toMatchObject({
            limit: 20,
            groupItems: true,
            mediaTypes: ['movie', 'tv'],
            expandSeries: true,
            isPlayed: false,
        });
    });

    it('IncludeItemTypes=Episode&GroupItems=false lists episodes only', () => {
        expect(q('?IncludeItemTypes=Episode&GroupItems=false')).toMatchObject({
            mediaTypes: ['episode'],
            expandSeries: false,
        });
    });

    it('IncludeItemTypes=Movie never ranks series', () => {
        expect(q('?IncludeItemTypes=Movie').mediaTypes).toEqual(['movie']);
    });

    it('IncludeItemTypes=Series lists series without expanding them', () => {
        expect(q('?IncludeItemTypes=Series')).toMatchObject({
            mediaTypes: ['tv'],
            expandSeries: false,
        });
    });

    it('types Latest has none of yield nothing', () => {
        expect(q('?IncludeItemTypes=MusicAlbum,Audio').mediaTypes).toEqual([]);
    });

    it('IsPlayed=true overrides the default; the user root folder is no parent', () => {
        expect(q('?isPlayed=true&ParentId=f27caa37e5142225cceded48f6553502')).toMatchObject({
            isPlayed: true,
            parentId: null,
        });
    });

    it('caps Limit', () => {
        expect(q('?Limit=5000').limit).toBe(100);
    });
});

describe('chooseLatestRepresentative (GetLatestTvShowItems step 5)', () => {
    const counts = new Map([
        ['multi', { childCount: 3, totalCount: 30, playedCount: 0 }],
        ['single', { childCount: 1, totalCount: 8, playedCount: 0 }],
        ['s1', { childCount: 8, totalCount: 8, playedCount: 0 }],
        ['s-one-ep', { childCount: 1, totalCount: 1, playedCount: 0 }],
    ]);
    const g = (seriesId: string, recentCount: number, seasonIds: string[]) => ({
        seriesId,
        recentCount,
        seasonIds,
        newestEpisodeId: 'ep',
        newestAdded: T(0),
    });

    it('one new episode → the episode', () => {
        expect(chooseLatestRepresentative(g('multi', 1, ['s1']), counts)).toBe('ep');
    });
    it('several in one season of a multi-season series → the season', () => {
        expect(chooseLatestRepresentative(g('multi', 4, ['s1']), counts)).toBe('s1');
    });
    it('several in a single-season series → the series', () => {
        expect(chooseLatestRepresentative(g('single', 4, ['s1']), counts)).toBe('single');
    });
    it('the whole (one-episode) season landed → treated as a bulk addition', () => {
        expect(chooseLatestRepresentative(g('multi', 1, ['s-one-ep']), counts)).toBe('s-one-ep');
    });
    it('across seasons → the series', () => {
        expect(chooseLatestRepresentative(g('multi', 2, ['s1', 's2']), counts)).toBe('multi');
    });
    it('no matching episode → nothing', () => {
        expect(chooseLatestRepresentative(undefined, counts)).toBeNull();
        expect(chooseLatestRepresentative(g('multi', 0, []), counts)).toBeNull();
    });
});

describe('GET /Items/Latest', () => {
    it('passes types, IsPlayed and the user to the ranking query', async () => {
        await call('items', '?IncludeItemTypes=Movie,Episode&Limit=7&ParentId=lib-1');
        expect(mockGetLatestItems).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                // Grouping over-fetches (Jellyfin's Limit * 2), then trims.
                limit: 14,
                parentId: 'lib-1',
                groupItems: true,
                mediaTypes: ['movie', 'tv'],
                isPlayed: false,
                userId: USER.userId,
            }),
        );
    });

    it('groups series into the episode / season Jellyfin shows, in ranking order', async () => {
        const { status, body } = await call('items');
        expect(status).toBe(200);
        expect((body as { Id: string; Type: string }[]).map((i) => [i.Id, i.Type])).toEqual([
            [MOVIE, 'Movie'],
            [EP, 'Episode'],
            [SEASON, 'Season'],
        ]);
        // Re-read with the user's data, in slot order, fallbacks included.
        expect(mockBrowseMediaItems).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                idList: [MOVIE, EP, SERIES_ONE_EP, SEASON, SERIES_SEASON],
                orderByIdList: true,
                enableUserData: true,
                userId: USER.userId,
            }),
        );
        // The counts fetched for grouping are reused, not queried again.
        expect(mockApplyFolderUserData.mock.calls[0][4]).toBeInstanceOf(Map);
    });

    it('a series is placed by its newest episode that passes the filters, not its newest file', async () => {
        // SERIES_ONE_EP's newest file (T 0.5) is a WATCHED episode; its newest
        // unwatched one landed at T 5 — so it ranks after the movie and the season.
        mockGetLatestItems.mockResolvedValue([
            row(SERIES_ONE_EP, 'tv', SERIES_ONE_EP, T(0.5)),
            row(MOVIE, 'movie', MOVIE, T(1)),
            row(SERIES_SEASON, 'tv', SERIES_SEASON, T(3)),
        ]);
        mockGetLatestSeriesGroups.mockResolvedValue(
            new Map([
                [
                    SERIES_ONE_EP,
                    {
                        seriesId: SERIES_ONE_EP,
                        recentCount: 1,
                        seasonIds: ['s-x'],
                        newestEpisodeId: EP,
                        newestAdded: T(5),
                    },
                ],
                [
                    SERIES_SEASON,
                    {
                        seriesId: SERIES_SEASON,
                        recentCount: 3,
                        seasonIds: [SEASON],
                        newestEpisodeId: 'e',
                        newestAdded: T(3),
                    },
                ],
            ]),
        );
        const { body } = await call('items');
        expect((body as { Id: string }[]).map((i) => i.Id)).toEqual([MOVIE, SEASON, EP]);
    });

    it('trims to Limit after dropping series with nothing to show', async () => {
        mockGetLatestItems.mockResolvedValue([
            row('bbbbbbbb-0000-0000-0000-00000000dead', 'tv', 'gone', T(0)),
            row(MOVIE, 'movie', MOVIE, T(1)),
            row(SERIES_ONE_EP, 'tv', SERIES_ONE_EP, T(2)),
            row(SERIES_SEASON, 'tv', SERIES_SEASON, T(3)),
        ]);
        const { body } = await call('items', '?Limit=2');
        expect((body as { Id: string }[]).map((i) => i.Id)).toEqual([MOVIE, EP]);
    });

    it("reads only files newer than the oldest ranked series' newest file minus 24 h", async () => {
        await call('items');
        // Ranked series at T(2) and T(3): cutoff = T(3) - 24 h.
        expect(mockGetLatestSeriesGroups.mock.calls[0][1]).toMatchObject({
            seriesIds: [SERIES_ONE_EP, SERIES_SEASON],
            addedSince: T(27),
        });
    });

    it('reads again without the cutoff only when the row comes out short', async () => {
        // Only SERIES_SEASON groups under the cutoff: 1 movie + 1 group < Limit 3.
        mockGetLatestSeriesGroups.mockImplementation(
            async (_sql: unknown, o: { addedSince: Date | null }) =>
                new Map([
                    [
                        SERIES_SEASON,
                        {
                            seriesId: SERIES_SEASON,
                            recentCount: 3,
                            seasonIds: [SEASON],
                            newestEpisodeId: 'e',
                            newestAdded: T(3),
                        },
                    ],
                    ...(o.addedSince
                        ? []
                        : ([
                              [
                                  SERIES_ONE_EP,
                                  {
                                      seriesId: SERIES_ONE_EP,
                                      recentCount: 1,
                                      seasonIds: ['s-x'],
                                      newestEpisodeId: EP,
                                      newestAdded: T(50),
                                  },
                              ],
                          ] as const)),
                ]),
        );
        const { body } = await call('items', '?Limit=3');
        expect(mockGetLatestSeriesGroups).toHaveBeenCalledTimes(2);
        expect(mockGetLatestSeriesGroups.mock.calls[1][1]).toMatchObject({ addedSince: null });
        expect((body as { Id: string }[]).map((i) => i.Id)).toEqual([MOVIE, SEASON, EP]);
    });

    it('a full row keeps the single cutoff read', async () => {
        await call('items');
        expect(mockGetLatestSeriesGroups).toHaveBeenCalledTimes(1);
    });

    it('falls back to the series when the episode row is not listable', async () => {
        mockBrowseMediaItems.mockImplementation(async (_s: unknown, o: { idList: string[] }) => ({
            rows: o.idList
                .filter((id) => id !== EP)
                .map((id) =>
                    row(
                        id,
                        id.startsWith('bbbb') ? 'tv' : id === SEASON ? 'season' : 'movie',
                        `T-${id}`,
                    ),
                ),
            totalCount: 0,
        }));
        const { body } = await call('items');
        expect((body as { Id: string }[]).map((i) => i.Id)).toEqual([MOVIE, SERIES_ONE_EP, SEASON]);
    });

    it('GroupItems=false never groups', async () => {
        await call('items', '?GroupItems=false');
        expect(mockGetLatestSeriesGroups).not.toHaveBeenCalled();
        expect(mockGetLatestItems.mock.calls[0][1]).toMatchObject({
            groupItems: false,
            mediaTypes: ['movie', 'episode'],
        });
    });

    it('answers [] without querying for types Latest has none of', async () => {
        const { body } = await call('items', '?IncludeItemTypes=MusicAlbum');
        expect(body).toEqual([]);
        expect(mockGetLatestItems).not.toHaveBeenCalled();
    });

    it('the legacy route is the same handler', async () => {
        const a = await call('items', '?IncludeItemTypes=Movie');
        const b = await call('legacy', '?IncludeItemTypes=Movie');
        expect(b).toEqual(a);
    });
});
