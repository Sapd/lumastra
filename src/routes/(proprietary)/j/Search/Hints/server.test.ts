// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Unit tests for GET /j/Search/Hints — the endpoint jellyfin-androidtv-family
// clients (e.g. Moonfin) call for their native search screen. Sources and the
// browse query are mocked; scoping against real rows lives in
// filters-search.integration.test.ts.

import type { RequestHandler } from '@sveltejs/kit';
// The route-specific RequestEvent (not the generic @sveltejs/kit one) — avoids
// forcing TypeScript to materialize the app-wide ~1500-member RouteId union
// when checking GET(buildEvent(...)) against this route's narrow handler type.
import type { RequestEvent } from './$types';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
    mockSearchMedia,
    mockSearchMusic,
    mockBrowseMediaItems,
    mockBuildAccessContext,
    mockConfig,
    mockGetPlaybackPreferencesOne,
    mockGetTranslationMapForItems,
    mockVideoGenres,
    mockMusicGenres,
    mockPeople,
    mockGetChannels,
    mockHiddenEpisodes,
} = vi.hoisted(() => ({
    mockSearchMedia: vi.fn(),
    mockSearchMusic: vi.fn(),
    mockBrowseMediaItems: vi.fn(),
    mockBuildAccessContext: vi.fn(),
    mockConfig: {
        TMDB_LANGUAGE: 'en-US',
        METADATA_ADDITIONAL_LANGUAGES: ['de-DE'] as string[],
    },
    mockGetPlaybackPreferencesOne: vi.fn(),
    mockGetTranslationMapForItems: vi.fn(),
    mockVideoGenres: vi.fn(),
    mockMusicGenres: vi.fn(),
    mockPeople: vi.fn(),
    mockGetChannels: vi.fn(),
    mockHiddenEpisodes: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({ config: mockConfig, LUMASTRA_MASTER_KEY: 'test-key' }));
vi.mock('$lib/server/config', () => ({ config: mockConfig, LUMASTRA_MASTER_KEY: 'test-key' }));

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: { one: mockGetPlaybackPreferencesOne },
}));

vi.mock('$lib/server/database/queries/media-translations.queries.js', () => ({
    getTranslationMapForItems: mockGetTranslationMapForItems,
}));

// The real message barrel costs ~35 s to load cold and blew the 30 s timeout —
// see the stub's header.
vi.mock('$lib/paraglide/messages', async () => {
    const { messagesStub } = await import('$lib/server/__testkit__/paraglide-messages-stub');
    return messagesStub;
});

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', () => ({
    getDb: () => ({}) as never,
}));

vi.mock('$lib/server/database/queries/search.queries', () => ({
    searchMedia: mockSearchMedia,
    searchMusic: mockSearchMusic,
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/music-artists-enrichment', () => ({
    enrichItemsWithMusicArtists: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/database/queries/jellyfin-browse.queries', () => ({
    browseMediaItems: mockBrowseMediaItems,
}));

vi.mock('$lib/server/database/queries/jellyfin-filters.queries', () => ({
    getJellyfinGenres: vi.fn(),
    getEpisodesOfAgeHiddenSeries: mockHiddenEpisodes,
}));

vi.mock('$lib/server/database/queries/jellyfin-people.queries', () => ({
    CREDIT_ROLES: ['actor', 'director', 'writer', 'producer'],
    listVisiblePersons: mockPeople,
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/genres', async (importOriginal) => {
    const mod =
        await importOriginal<typeof import('$lib/server/proprietary/jellyfin-compat/genres')>();
    return { ...mod, listVisibleVideoGenres: mockVideoGenres };
});

vi.mock('$lib/server/proprietary/jellyfin-compat/music-genres', () => ({
    listVisibleMusicGenres: mockMusicGenres,
    musicGenreId: (name: string) => `music-${name.toLowerCase()}`,
}));

vi.mock('$lib/server/services/livetv/index', () => ({
    getLiveTvProvider: async () => ({ getChannels: mockGetChannels }),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/access-context', () => ({
    buildJellyfinAccessContext: mockBuildAccessContext,
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER = {
    username: 'denis',
    userId: '00000000-0000-0000-0000-0000000000de',
    isAdmin: true,
    hasLiveTvPermission: false,
};

function buildEvent(query: string, user: Record<string, unknown> = USER): RequestEvent {
    return {
        url: new URL(`http://localhost/j/Search/Hints${query}`),
        request: { method: 'GET', headers: { get: () => null } },
        locals: { user },
        params: {},
        route: { id: null },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
    } as unknown as RequestEvent;
}

interface HintBody {
    SearchHints: Array<Record<string, unknown> & { Id: string; Name: string; Type: string }>;
    TotalRecordCount: number;
}

async function hints(query: string, user?: Record<string, unknown>): Promise<HintBody> {
    const { GET } = await import('./+server');
    const res = await GET(buildEvent(query, user));
    expect(res.status).toBe(200);
    return (await res.json()) as HintBody;
}

const TRACK_ROW = {
    id: 'bbbbbbbb-0000-0000-0000-000000000001',
    title: 'Star Lanterns Theme',
    media_type: 'track',
    runtime_seconds: 300,
};

const ALBUM_ROW = {
    id: 'bbbbbbbb-0000-0000-0000-000000000002',
    title: 'Star Lanterns',
    media_type: 'album',
};

const STAR_WARS_ROW = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    title: 'Star Lanterns: A New Hope',
    media_type: 'movie',
    year: 1977,
    runtime_seconds: 7200,
};

const EPISODE_ROW = {
    id: 'aaaaaaaa-0000-0000-0000-000000000002',
    title: 'Star Crossed',
    media_type: 'episode',
    series_name: 'Space Show',
    series_id: 'aaaaaaaa-0000-0000-0000-0000000000aa',
    season_number: 2,
    episode_number: 7,
};

const ALL_ROWS = [STAR_WARS_ROW, EPISODE_ROW, TRACK_ROW, ALBUM_ROW];

/** browseMediaItems as the real one behaves for orderByIdList: id order, LIMIT, full count. */
function browseInIdOrder(rows: Array<{ id: string }> = ALL_ROWS) {
    return async (_sql: unknown, opts: { idList: string[]; limit: number }) => {
        const matched = opts.idList
            .map((id) => rows.find((r) => r.id === id))
            .filter((r): r is NonNullable<typeof r> => r != null);
        return { rows: matched.slice(0, opts.limit), totalCount: matched.length };
    };
}

describe('GET /j/Search/Hints', () => {
    beforeEach(() => {
        mockSearchMedia.mockReset();
        mockSearchMedia.mockResolvedValue([]);
        mockSearchMusic.mockReset();
        mockSearchMusic.mockResolvedValue([]);
        mockBrowseMediaItems.mockReset();
        mockBrowseMediaItems.mockImplementation(browseInIdOrder());
        mockBuildAccessContext.mockReset();
        mockBuildAccessContext.mockResolvedValue({
            boundary: {},
            deniedGroupIds: [],
            ageRating: null,
        });
        mockVideoGenres.mockReset();
        mockVideoGenres.mockResolvedValue([]);
        mockMusicGenres.mockReset();
        mockMusicGenres.mockResolvedValue([]);
        mockPeople.mockReset();
        mockPeople.mockResolvedValue({ rows: [], totalCount: 0 });
        mockGetChannels.mockReset();
        mockGetChannels.mockResolvedValue([]);
        mockHiddenEpisodes.mockReset();
        mockHiddenEpisodes.mockResolvedValue([]);
        mockConfig.TMDB_LANGUAGE = 'en-US';
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de-DE'];
        mockGetPlaybackPreferencesOne.mockReset();
        mockGetTranslationMapForItems.mockReset();
    });

    it('returns matching hints for a search term', async () => {
        mockSearchMedia.mockResolvedValue([
            { internal_id: STAR_WARS_ROW.id, title: STAR_WARS_ROW.title, rank: 1 },
        ]);
        const body = await hints('?SearchTerm=star+lanterns');

        expect(body.TotalRecordCount).toBe(1);
        expect(body.SearchHints).toHaveLength(1);
        expect(body.SearchHints[0]).toMatchObject({
            Id: STAR_WARS_ROW.id,
            Name: 'Star Lanterns: A New Hope',
            Type: 'Movie',
            IsFolder: false,
            MediaType: 'Video',
            Artists: [],
        });
    });

    it('returns an empty result when SearchTerm is missing or blank', async () => {
        for (const q of ['', '?SearchTerm=%20%20']) {
            const body = await hints(q);
            expect(body).toEqual({ SearchHints: [], TotalRecordCount: 0 });
        }
        expect(mockSearchMedia).not.toHaveBeenCalled();
        expect(mockVideoGenres).not.toHaveBeenCalled();
    });

    it('overlays the German title for a user with an explicit metadata_language=de pref', async () => {
        mockSearchMedia.mockResolvedValue([
            { internal_id: STAR_WARS_ROW.id, title: STAR_WARS_ROW.title, rank: 1 },
        ]);
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: 'de-DE',
            metadata_title_language: 'de-DE',
        });
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([
                [STAR_WARS_ROW.id, { title: 'Krieg der Sterne', overview: null, tagline: null }],
            ]),
        );
        const body = await hints('?SearchTerm=star+lanterns');
        expect(body.SearchHints[0].Name).toBe('Krieg der Sterne');
    });

    it('searches movies, series and episodes by default and returns episodes with series and numbers', async () => {
        mockSearchMedia.mockResolvedValue([
            { internal_id: EPISODE_ROW.id, title: EPISODE_ROW.title, rank: 1 },
        ]);
        const body = await hints('?SearchTerm=crossed');

        expect(mockSearchMedia).toHaveBeenCalledWith(
            expect.anything(),
            'crossed',
            expect.anything(),
            expect.objectContaining({ mediaTypes: ['movie', 'tv', 'episode'], offset: 0 }),
        );
        expect(body.SearchHints).toEqual([
            expect.objectContaining({
                Id: EPISODE_ROW.id,
                Type: 'Episode',
                Series: 'Space Show',
                ParentIndexNumber: 2,
                IndexNumber: 7,
            }),
        ]);
    });

    it("drops episodes whose series the user's age rating hides", async () => {
        mockSearchMedia.mockResolvedValue([
            {
                internal_id: EPISODE_ROW.id,
                title: EPISODE_ROW.title,
                media_type: 'episode',
                rank: 2,
            },
            {
                internal_id: STAR_WARS_ROW.id,
                title: STAR_WARS_ROW.title,
                media_type: 'movie',
                rank: 1,
            },
        ]);
        mockHiddenEpisodes.mockResolvedValue([EPISODE_ROW.id]);
        const body = await hints('?SearchTerm=star');

        expect(mockHiddenEpisodes).toHaveBeenCalledWith(expect.anything(), [EPISODE_ROW.id], {});
        expect(body.SearchHints.map((h) => h.Id)).toEqual([STAR_WARS_ROW.id]);
        expect(body.TotalRecordCount).toBe(1);
    });

    it('searches music via searchMusic for an Audio-only request', async () => {
        mockSearchMusic.mockResolvedValue([{ id: TRACK_ROW.id, title: TRACK_ROW.title }]);
        const body = await hints('?SearchTerm=star&IncludeItemTypes=Audio');

        expect(mockSearchMedia).not.toHaveBeenCalled();
        expect(mockSearchMusic).toHaveBeenCalledWith(
            expect.anything(),
            'star',
            200,
            expect.anything(),
            expect.objectContaining({
                offset: 0,
                mediaTypes: ['track'],
                excludeVariousArtists: true,
                playableOnly: true,
            }),
        );
        expect(mockBrowseMediaItems).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ mediaTypes: ['track'], orderByIdList: true }),
        );
        expect(body.SearchHints).toEqual([
            expect.objectContaining({ Id: TRACK_ROW.id, Type: 'Audio' }),
        ]);
    });

    it('keeps video-only requests off searchMusic and the by-name sources', async () => {
        await hints('?SearchTerm=star&IncludeItemTypes=Movie,Series');

        expect(mockSearchMusic).not.toHaveBeenCalled();
        expect(mockVideoGenres).not.toHaveBeenCalled();
        expect(mockSearchMedia).toHaveBeenCalledWith(
            expect.anything(),
            'star',
            expect.anything(),
            expect.objectContaining({ mediaTypes: ['movie', 'tv'], offset: 0 }),
        );
    });

    it('honours ExcludeItemTypes and IncludeArtists=false', async () => {
        await hints(
            '?SearchTerm=star&ExcludeItemTypes=Episode,Genre,MusicGenre&IncludeArtists=false',
        );

        expect(mockSearchMedia).toHaveBeenCalledWith(
            expect.anything(),
            'star',
            expect.anything(),
            expect.objectContaining({ mediaTypes: ['movie', 'tv'] }),
        );
        expect(mockSearchMusic).toHaveBeenCalledWith(
            expect.anything(),
            'star',
            200,
            expect.anything(),
            expect.objectContaining({ mediaTypes: ['album', 'track'] }),
        );
        expect(mockVideoGenres).not.toHaveBeenCalled();
        expect(mockMusicGenres).not.toHaveBeenCalled();
    });

    it('MediaTypes=Video keeps only movies and episodes', async () => {
        await hints('?SearchTerm=star&MediaTypes=Video');

        expect(mockSearchMedia).toHaveBeenCalledWith(
            expect.anything(),
            'star',
            expect.anything(),
            expect.objectContaining({ mediaTypes: ['movie', 'episode'] }),
        );
        expect(mockSearchMusic).not.toHaveBeenCalled();
        expect(mockVideoGenres).not.toHaveBeenCalled();
    });

    it('returns empty without searching for types Lumastra has none of', async () => {
        const body = await hints('?SearchTerm=star&IncludeItemTypes=Playlist,BoxSet');
        expect(body).toEqual({ SearchHints: [], TotalRecordCount: 0 });
        expect(mockSearchMedia).not.toHaveBeenCalled();
        expect(mockSearchMusic).not.toHaveBeenCalled();
    });

    it('merges library hits exact title first, pages them and reports the full total', async () => {
        mockSearchMedia.mockResolvedValue([
            { internal_id: STAR_WARS_ROW.id, title: STAR_WARS_ROW.title, rank: 1 },
        ]);
        mockSearchMusic.mockResolvedValue([
            { id: TRACK_ROW.id, title: TRACK_ROW.title },
            { id: ALBUM_ROW.id, title: ALBUM_ROW.title },
        ]);

        const page1 = await hints('?SearchTerm=Star+Lanterns&Limit=2');
        // Album "Star Lanterns" is the exact match; the rest keep source order (video first).
        expect(page1.SearchHints.map((h) => h.Id)).toEqual([ALBUM_ROW.id, STAR_WARS_ROW.id]);
        expect(page1.TotalRecordCount).toBe(3);
        expect(mockBrowseMediaItems).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({
                idList: [ALBUM_ROW.id, STAR_WARS_ROW.id, TRACK_ROW.id],
                limit: 2,
                startIndex: 0,
            }),
        );

        const page2 = await hints('?SearchTerm=Star+Lanterns&Limit=2&StartIndex=2');
        expect(page2.SearchHints.map((h) => h.Id)).toEqual([TRACK_ROW.id]);
        expect(page2.TotalRecordCount).toBe(3);
    });

    it('a ParentId scopes library hits recursively and drops by-name kinds', async () => {
        const parentId = 'cccccccc-0000-0000-0000-000000000001';
        mockSearchMedia.mockResolvedValue([
            { internal_id: STAR_WARS_ROW.id, title: STAR_WARS_ROW.title, rank: 1 },
        ]);
        await hints(`?SearchTerm=star&ParentId=${parentId}`);

        expect(mockBrowseMediaItems).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ parentId, recursive: true }),
        );
        expect(mockVideoGenres).not.toHaveBeenCalled();
        expect(mockMusicGenres).not.toHaveBeenCalled();
    });

    it('the user root folder ParentId means no parent', async () => {
        await hints('?SearchTerm=star&ParentId=f27caa37e5142225cceded48f6553502');
        expect(mockVideoGenres).toHaveBeenCalled();
    });

    it('returns genre and music genre hints, exact match first; IncludeGenres=false drops them', async () => {
        mockVideoGenres.mockResolvedValue([
            { name: 'Melodrama', counts: {}, total: 1 },
            { name: 'Action', counts: {}, total: 1 },
            { name: 'Drama', counts: {}, total: 4 },
        ]);
        mockMusicGenres.mockResolvedValue([{ genre: 'Drama Pop', track_count: 3, album_count: 1 }]);

        const body = await hints('?SearchTerm=drama');
        // Exact, then prefix, then substring matches.
        expect(body.SearchHints.map((h) => [h.Type, h.Name])).toEqual([
            ['Genre', 'Drama'],
            ['MusicGenre', 'Drama Pop'],
            ['Genre', 'Melodrama'],
        ]);
        expect(body.SearchHints[0]).toMatchObject({
            // md5("drama"), dashed: the hex items carry in GenreItems[].Id.
            Id: createHash('md5')
                .update('drama')
                .digest('hex')
                .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
            ItemId: body.SearchHints[0].Id,
            MediaType: 'Unknown',
            IsFolder: true,
            Artists: [],
        });
        expect(body.SearchHints[1].Id).toBe('music-drama pop');
        expect(body.TotalRecordCount).toBe(3);

        mockVideoGenres.mockClear();
        const off = await hints('?SearchTerm=drama&IncludeGenres=false');
        expect(off.SearchHints).toEqual([]);
        expect(mockVideoGenres).not.toHaveBeenCalled();
    });

    it('IncludeMedia=false searches only the by-name kinds', async () => {
        mockVideoGenres.mockResolvedValue([{ name: 'Star Harbor', counts: {}, total: 1 }]);
        const body = await hints('?SearchTerm=star&IncludeMedia=false');

        expect(mockSearchMedia).not.toHaveBeenCalled();
        expect(mockSearchMusic).not.toHaveBeenCalled();
        expect(body.SearchHints.map((h) => h.Type)).toEqual(['Genre']);
    });

    it('program flags that no library item has empty the result', async () => {
        for (const q of [
            'IsSeries=true',
            'IsKids=true',
            'IsAiring=false',
            'IsMovie=true&IncludeItemTypes=Series',
        ]) {
            const body = await hints(`?SearchTerm=star&${q}`);
            expect(body).toEqual({ SearchHints: [], TotalRecordCount: 0 });
        }
        expect(mockSearchMedia).not.toHaveBeenCalled();

        await hints('?SearchTerm=star&IsMovie=true&IsSeries=false&IncludeItemTypes=Movie');
        expect(mockSearchMedia).toHaveBeenCalled();
    });

    it('returns Live TV channels only for users with Live TV permission', async () => {
        mockGetChannels.mockResolvedValue([
            {
                id: 'dddddddd-0000-0000-0000-000000000001',
                name: 'Star Channel',
                images: { primary: { href: 'x', revision: '0', source: 'self' } },
            },
            { id: 'dddddddd-0000-0000-0000-000000000002', name: 'News 24', images: {} },
        ]);
        const without = await hints('?SearchTerm=star');
        expect(without.SearchHints).toEqual([]);
        expect(mockGetChannels).not.toHaveBeenCalled();

        const withPermission = await hints('?SearchTerm=star', {
            ...USER,
            hasLiveTvPermission: true,
        });
        expect(withPermission.SearchHints).toEqual([
            expect.objectContaining({
                Id: 'dddddddd-0000-0000-0000-000000000001',
                Type: 'TvChannel',
                MediaType: 'Video',
                PrimaryImageTag: '0',
            }),
        ]);
    });

    it('returns Person hints with the id /Persons issues, scoped to the caller', async () => {
        const PID = '11111111-1111-4111-8111-111111111111';
        mockPeople.mockResolvedValue({
            rows: [{ id: PID, name: 'Mark Hamill' }],
            totalCount: 1,
        });
        const body = await hints('?SearchTerm=hamill&IncludeItemTypes=Person');
        expect(body.SearchHints).toEqual([
            expect.objectContaining({ Id: PID, ItemId: PID, Type: 'Person', Name: 'Mark Hamill' }),
        ]);
        // The access boundary of the caller and the term reach the people query.
        expect(mockPeople).toHaveBeenCalledWith(
            expect.anything(),
            {},
            expect.objectContaining({ searchTerm: 'hamill' }),
        );
        expect(mockSearchMedia).not.toHaveBeenCalled();
    });

    it('issues no Person hint when the caller sees no credit of that person', async () => {
        mockPeople.mockResolvedValue({ rows: [], totalCount: 0 });
        const body = await hints('?SearchTerm=hidden&IncludeItemTypes=Person');
        expect(body).toEqual({ SearchHints: [], TotalRecordCount: 0 });
    });

    it('does not query people when Person is excluded', async () => {
        await hints('?SearchTerm=star&IncludePeople=false&IncludeMedia=false');
        expect(mockPeople).not.toHaveBeenCalled();
    });

    it('answers 500 when the search fails', async () => {
        mockSearchMedia.mockRejectedValue(new Error('boom'));
        const { GET } = await import('./+server');
        const res = await GET(buildEvent('?SearchTerm=star&IncludeItemTypes=Movie'));
        expect(res.status).toBe(500);
    });
});
