// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Unit tests for GET /j/Items/{itemId} covering the per-user metadata-
// language overlay (multilingual-media-metadata parity with /api/v1): a
// stored `metadata_language` pref, the ambient Accept-Language header
// fallback for users with no stored pref, and the primary-language no-op
// regression case.

import type { RequestHandler } from '@sveltejs/kit';
import type { RequestEvent } from './$types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
    mockConfig,
    mockGetPlaybackPreferencesOne,
    mockGetTranslationMapForItems,
    mockGetOwnerItemForFile,
    mockCheckMediaAccess,
    mockGetItemDetail,
    mockGetFilesForMediaItem,
    mockGetChaptersForItem,
    mockGetTrickplayForItem,
    mockEnrichItemsWithProviderIds,
} = vi.hoisted(() => ({
    mockConfig: {
        TMDB_LANGUAGE: 'en-US',
        METADATA_ADDITIONAL_LANGUAGES: ['de-DE'] as string[],
    },
    mockGetPlaybackPreferencesOne: vi.fn(),
    mockGetTranslationMapForItems: vi.fn(),
    mockGetOwnerItemForFile: vi.fn(),
    mockCheckMediaAccess: vi.fn(),
    mockGetItemDetail: vi.fn(),
    mockGetFilesForMediaItem: vi.fn(),
    mockGetChaptersForItem: vi.fn(),
    mockGetTrickplayForItem: vi.fn(),
    mockEnrichItemsWithProviderIds: vi.fn(),
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

vi.mock('$lib/server/config.js', () => ({ config: mockConfig, LUMASTRA_MASTER_KEY: 'test-key' }));
vi.mock('$lib/server/config', () => ({ config: mockConfig, LUMASTRA_MASTER_KEY: 'test-key' }));

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: { one: mockGetPlaybackPreferencesOne },
}));

vi.mock('$lib/server/database/queries/media-translations.queries.js', () => ({
    getTranslationMapForItems: mockGetTranslationMapForItems,
}));

vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: mockGetOwnerItemForFile,
    getFilesForMediaItem: mockGetFilesForMediaItem,
}));

vi.mock('$lib/server/database/queries/media-streams.queries', () => ({
    getStreamsForFile: vi.fn().mockResolvedValue([]),
    getStreamsForMediaItem: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/jellyfin-item-detail.queries', () => ({
    getItemDetail: mockGetItemDetail,
    getChaptersForItem: mockGetChaptersForItem,
    getTrickplayForItem: mockGetTrickplayForItem,
    getLibraryGroupInfo: vi.fn().mockResolvedValue(null),
}));

// C7 fix (2026-09-18 fix plan 4 task 6) added a getDeniedLibraryGroups call
// ahead of every getLibraryGroupInfo lookup in the route. Without this mock
// it hits the real function against the fake `{}` sql from the
// `$lib/server/database` mock below and throws — turning the Live TV
// fallback tests' expected 404 into a 500.
vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: vi.fn().mockResolvedValue(null),
    toLibraryAccessUser: (user: unknown) => user,
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/folder-user-data', () => ({
    applyFolderUserData: vi.fn(async () => {}),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/access-context', () => ({
    buildJellyfinAccessContext: vi.fn(async () => ({
        boundary: { library: { kind: 'all' }, age: { kind: 'any' } },
        deniedGroupIds: null,
        ageRating: null,
    })),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment', () => ({
    enrichItemsWithProviderIds: mockEnrichItemsWithProviderIds,
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/people-studios', () => ({
    ALL_CREDIT_FIELDS: { people: true, studios: true, tags: true },
    enrichItemsWithCredits: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/people-studios-handlers', () => ({
    resolveNameItem: vi.fn(async () => null),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/related-media', () => ({
    enrichItemsWithRelatedMediaCounts: vi.fn(),
}));

vi.mock('$lib/server/database/queries/playlists.queries', () => ({
    getPlaylistById: vi.fn(),
    getPlaylistWatchProgress: vi.fn(),
}));

vi.mock('$lib/server/utils/playlist-utils', () => ({
    getUserRole: vi.fn(),
}));

vi.mock('$lib/server/services/livetv/index', () => ({
    getLiveTvProvider: vi.fn(),
}));

vi.mock('$lib/server/database/queries/livetv-programs.queries', () => ({
    getProgramById: vi.fn(),
}));

const { mockCanStreamChannel } = vi.hoisted(() => ({ mockCanStreamChannel: vi.fn() }));
vi.mock('$lib/server/services/livetv/channel-access', () => ({
    canStreamLiveTvChannel: mockCanStreamChannel,
}));

vi.mock('$lib/server/database/queries/livetv-channels.queries', () => ({
    getFavoriteChannelIds: vi.fn().mockResolvedValue([]),
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
};

const ITEM_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

function buildEvent(
    headers: Record<string, string> = {},
    user: Record<string, unknown> = USER,
): RequestEvent {
    return {
        url: new URL(`http://localhost/j/Items/${ITEM_ID}`),
        request: {
            method: 'GET',
            headers: { get: (name: string) => headers[name] ?? null },
        },
        locals: { user },
        params: { itemId: ITEM_ID },
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

const ITEM_ROW = {
    id: ITEM_ID,
    title: 'Original Title',
    media_type: 'movie',
    mi_overview: 'Original overview',
    year: 2020,
};

describe('GET /j/Items/{itemId} — content-language overlay', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.TMDB_LANGUAGE = 'en-US';
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de-DE'];
        mockGetOwnerItemForFile.mockResolvedValue(null);
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetItemDetail.mockResolvedValue(ITEM_ROW);
        mockGetFilesForMediaItem.mockResolvedValue([]);
        mockGetChaptersForItem.mockResolvedValue([]);
        mockGetTrickplayForItem.mockResolvedValue([]);
        mockEnrichItemsWithProviderIds.mockResolvedValue(undefined);
    });

    it('serves the German overview/title for a user with an explicit metadata_language=de pref', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: 'de-DE',
            metadata_title_language: 'de-DE',
        });
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([
                [
                    ITEM_ID,
                    { title: 'Deutscher Titel', overview: 'Deutsche Übersicht', tagline: null },
                ],
            ]),
        );

        const { GET } = await import('./+server');
        const res = await GET(buildEvent());
        const body = (await res.json()) as { Name: string; Overview: string };

        expect(body.Name).toBe('Deutscher Titel');
        expect(body.Overview).toBe('Deutsche Übersicht');
    });

    it('serves the German overview via the ambient Accept-Language header when the user has no stored pref', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: null,
            metadata_title_language: null,
        });
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([
                [
                    ITEM_ID,
                    { title: 'Deutscher Titel', overview: 'Deutsche Übersicht', tagline: null },
                ],
            ]),
        );

        const { GET } = await import('./+server');
        const { runWithRequestLanguage } =
            await import('$lib/server/utils/request-language-context.js');
        const res = await runWithRequestLanguage(
            { cookieLocale: null, acceptLanguage: 'de-DE,de;q=0.9,en;q=0.5' },
            () => GET(buildEvent({ 'accept-language': 'de-DE,de;q=0.9,en;q=0.5' })),
        );
        const body = (await res.json()) as { Name: string; Overview: string };

        expect(body.Name).toBe('Deutscher Titel');
        expect(body.Overview).toBe('Deutsche Übersicht');
    });

    it('falls back to the primary-language row when there is no pref, no header, and no translation', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: null,
            metadata_title_language: null,
        });

        const { GET } = await import('./+server');
        const res = await GET(buildEvent());
        const body = (await res.json()) as { Name: string; Overview: string };

        expect(body.Name).toBe('Original Title');
        expect(body.Overview).toBe('Original overview');
        expect(mockGetTranslationMapForItems).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// C6 — Live TV permission on all three channel/program branches
//
// checkMediaAccess (mocked above to resolve `true` by default) is vacuous for
// a `tvchannel` row — it structurally never carries a `library_group_id`
// (Shape B) — so `hasLiveTvPermission` is the only control over these three
// branches. A user without it must get 404 (not 403) from every branch: this
// route already denies library access with 404 a few lines above
// (`ApiResponses.notFound`), and its sibling
// `j/LiveTv/Channels/[channelId]/+server.ts:23-25` denies the identical
// payload with 404 too — 403 here would let a Live-TV-denied user distinguish
// "this id is a channel/program" from "unknown id", the existence-leak this
// project's 404-not-403 convention exists to prevent
// (`src/lib/server/middleware/media-access.ts`). `PlaybackInfo/+server.ts`
// keeps its pre-existing 403 — that surface is unchanged by this fix.
// ---------------------------------------------------------------------------

describe('GET /j/Items/{itemId} — C6 Live TV permission gate', () => {
    const NO_LIVETV_USER = { ...USER, isAdmin: false, hasLiveTvPermission: false };

    const CHANNEL = {
        id: ITEM_ID,
        name: 'Channel One',
        images: {},
        sortOrder: 1,
        currentProgram: undefined,
        category: undefined,
    };

    const PROGRAM_ROW = {
        id: 'bbbbbbbb-0000-0000-0000-000000000002',
        channel_id: ITEM_ID,
        title: 'Program Title',
        description: null,
        start_time: new Date('2026-01-01T00:00:00Z'),
        end_time: new Date('2026-01-01T01:00:00Z'),
        epg_id: null,
        genres: null,
        official_rating: null,
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        mockConfig.TMDB_LANGUAGE = 'en-US';
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de-DE'];
        mockGetOwnerItemForFile.mockResolvedValue(null);
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetFilesForMediaItem.mockResolvedValue([]);
        mockGetChaptersForItem.mockResolvedValue([]);
        mockGetTrickplayForItem.mockResolvedValue([]);
        mockEnrichItemsWithProviderIds.mockResolvedValue(undefined);
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: null,
            metadata_title_language: null,
        });

        const { getLiveTvProvider } = await import('$lib/server/services/livetv/index');
        vi.mocked(getLiveTvProvider).mockResolvedValue({
            getChannel: vi.fn().mockResolvedValue(CHANNEL),
            getCurrentProgram: vi.fn().mockResolvedValue(undefined),
        } as never);

        const { getProgramById } =
            await import('$lib/server/database/queries/livetv-programs.queries');
        vi.mocked(getProgramById).mockResolvedValue(undefined as never);
        mockCanStreamChannel.mockResolvedValue(true);
    });

    it('branch 1 (tvchannel row from getItemDetail): 404 for a user without hasLiveTvPermission', async () => {
        mockGetItemDetail.mockResolvedValue({ ...ITEM_ROW, media_type: 'tvchannel' });

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(undefined, NO_LIVETV_USER));

        expect(res.status).toBe(404);
    });

    it('branch 2 (channel fallback, no media_items row): 404 for a user without hasLiveTvPermission', async () => {
        mockGetItemDetail.mockResolvedValue(null);

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(undefined, NO_LIVETV_USER));

        expect(res.status).toBe(404);
    });

    it('branch 3 (program fallback, no channel and no media_items row): 404 for a user without hasLiveTvPermission', async () => {
        mockGetItemDetail.mockResolvedValue(null);

        const { getLiveTvProvider } = await import('$lib/server/services/livetv/index');
        vi.mocked(getLiveTvProvider).mockResolvedValue({
            getChannel: vi.fn().mockResolvedValue(null),
            getCurrentProgram: vi.fn().mockResolvedValue(undefined),
        } as never);

        const { getProgramById } =
            await import('$lib/server/database/queries/livetv-programs.queries');
        vi.mocked(getProgramById).mockResolvedValue(PROGRAM_ROW as never);

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(undefined, NO_LIVETV_USER));

        expect(res.status).toBe(404);
    });

    it.each([
        ['branch 1 (tvchannel row)', { ...ITEM_ROW, media_type: 'tvchannel' }],
        ['branch 2 (channel fallback)', null],
    ])(
        '%s: 404 for a channel the viewer may not stream (lineup gate)',
        async (_label, detailRow) => {
            mockGetItemDetail.mockResolvedValue(detailRow);
            mockCanStreamChannel.mockResolvedValue(false);

            const { GET } = await import('./+server');
            const res = await GET(buildEvent(undefined, { ...USER, hasLiveTvPermission: true }));

            expect(res.status).toBe(404);
            expect(mockCanStreamChannel).toHaveBeenCalledWith(expect.anything(), ITEM_ID);
        },
    );

    it('branch 3: 404 for a programme of a channel the viewer may not stream', async () => {
        mockGetItemDetail.mockResolvedValue(null);
        const { getLiveTvProvider } = await import('$lib/server/services/livetv/index');
        vi.mocked(getLiveTvProvider).mockResolvedValue({
            getChannel: vi.fn().mockResolvedValue(null),
            getCurrentProgram: vi.fn().mockResolvedValue(undefined),
        } as never);
        const { getProgramById } =
            await import('$lib/server/database/queries/livetv-programs.queries');
        vi.mocked(getProgramById).mockResolvedValue(PROGRAM_ROW as never);
        mockCanStreamChannel.mockResolvedValue(false);

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(undefined, { ...USER, hasLiveTvPermission: true }));

        expect(res.status).toBe(404);
        expect(mockCanStreamChannel).toHaveBeenCalledWith(expect.anything(), ITEM_ID);
    });

    it.each([
        ['the tvchannel row', { ...ITEM_ROW, media_type: 'tvchannel' }],
        ['the channel fallback', null],
    ])('returns metadata for an allowed viewer via %s', async (_name, row) => {
        mockGetItemDetail.mockResolvedValue(row);

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(undefined, { ...USER, hasLiveTvPermission: true }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.MediaSources).toHaveLength(1);
        expect(body.MediaSources[0]).toMatchObject({ Id: ITEM_ID, MediaStreams: [] });
        expect(body.MediaSources[0]).not.toHaveProperty('TranscodingUrl');
        expect(body.MediaSources[0]).not.toHaveProperty('LiveStreamId');
    });
});

// jellyfin-androidtv's version picker loads the chosen version as an item:
// GET /Items/{MediaSource.Id}, where our MediaSource.Id is a media_files id.
// The route resolved file → owning item for the detail row but then looked the
// FILES up by the raw (file) id, found none, and answered MediaSources: [] —
// the app crashed on the null source (NPE in buildExoPlayerOptions, prod
// 2026-10-02, "2001: A Space Odyssey" 2160p).
describe('GET /j/Items/{fileId} — version picker', () => {
    const FILE_1080 = 'ffffffff-0000-0000-0000-000000001080';
    const FILE_2160 = 'ffffffff-0000-0000-0000-000000002160';

    function versionEvent(id: string): RequestEvent {
        const event = buildEvent();
        return {
            ...event,
            url: new URL(`http://localhost/j/Items/${id}`),
            params: { itemId: id },
        } as unknown as RequestEvent;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: null,
            metadata_title_language: null,
        });
        mockGetTranslationMapForItems.mockResolvedValue(new Map());
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetItemDetail.mockResolvedValue(ITEM_ROW);
        mockGetChaptersForItem.mockResolvedValue([]);
        mockGetTrickplayForItem.mockResolvedValue([]);
        mockEnrichItemsWithProviderIds.mockResolvedValue(undefined);
        mockGetOwnerItemForFile.mockImplementation(async (_sql: unknown, id: string) =>
            id === FILE_1080 || id === FILE_2160 ? ITEM_ID : null,
        );
        // Files belong to the movie, never to a file id.
        mockGetFilesForMediaItem.mockImplementation(async (_sql: unknown, id: string) =>
            id === ITEM_ID
                ? [
                      { id: FILE_1080, file_path: '/m/2001 - Bluray-1080p.mkv' },
                      { id: FILE_2160, file_path: '/m/2001 - Bluray-2160p.mkv' },
                  ]
                : [],
        );
    });

    it('returns the movie with every version, the picked one first, under the picked id', async () => {
        const { GET } = await import('./+server');
        const res = await GET(versionEvent(FILE_2160));
        const body = (await res.json()) as {
            Id: string;
            MediaSources: Array<{ Id: string; TranscodingUrl: string }>;
        };

        expect(res.status).toBe(200);
        expect(body.Id).toBe(FILE_2160);
        expect(body.MediaSources.map((s) => s.Id)).toEqual([FILE_2160, FILE_1080]);
        // The stream URLs name the movie: /Videos/{fileId}/master.m3u8 404s.
        expect(body.MediaSources[0].TranscodingUrl).toContain(`/Videos/${ITEM_ID}/master.m3u8`);
        expect(mockGetChaptersForItem).toHaveBeenCalledWith(expect.anything(), ITEM_ID);
        expect(mockGetTrickplayForItem).toHaveBeenCalledWith(expect.anything(), ITEM_ID);
    });

    it('a plain item request is unchanged: its own id, files in stored order', async () => {
        const { GET } = await import('./+server');
        const body = (await (await GET(versionEvent(ITEM_ID))).json()) as {
            Id: string;
            MediaSources: Array<{ Id: string }>;
        };
        expect(body.Id).toBe(ITEM_ID);
        expect(body.MediaSources.map((s) => s.Id)).toEqual([FILE_1080, FILE_2160]);
    });
});
