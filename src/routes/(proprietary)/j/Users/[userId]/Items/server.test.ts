// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for GET /j/Users/{userId}/Items covering the per-user
// metadata-language overlay: the ambient Accept-Language header fallback
// (no stored pref — the path real Jellyfin clients hit in practice) and the
// primary-language no-op regression case.

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
    mockBrowseMediaItems,
    mockBuildAccessContext,
} = vi.hoisted(() => ({
    mockConfig: {
        TMDB_LANGUAGE: 'en-US',
        METADATA_ADDITIONAL_LANGUAGES: ['de-DE'] as string[],
    },
    mockGetPlaybackPreferencesOne: vi.fn(),
    mockGetTranslationMapForItems: vi.fn(),
    mockBrowseMediaItems: vi.fn(),
    mockBuildAccessContext: vi.fn(),
}));

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

vi.mock('$lib/server/database/queries/jellyfin-browse.queries', () => ({
    browseMediaItems: mockBrowseMediaItems,
    mapJellyfinMediaTypes: () => [],
    mapJellyfinTypes: (types: string) =>
        types
            .split(',')
            .map((t) => t.trim().toLowerCase())
            .map((t) => (t === 'series' ? 'tv' : t)),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/access-context', () => ({
    buildJellyfinAccessContext: mockBuildAccessContext,
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/folder-user-data', () => ({
    applyFolderUserData: vi.fn(async () => {}),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/media-source-enrichment', () => ({
    enrichItemsWithMediaSources: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment', () => ({
    enrichItemsWithProviderIds: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/database/queries/search.queries', () => ({
    searchMedia: vi.fn(),
}));

// The real message barrel costs ~35 s to load cold and blew the 30 s timeout —
// see the stub's header.
vi.mock('$lib/paraglide/messages', async () => {
    const { messagesStub } = await import('$lib/server/__testkit__/paraglide-messages-stub');
    return messagesStub;
});

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

function buildEvent(headers: Record<string, string> = {}, extraQuery = ''): RequestEvent {
    return {
        // A bare /Users/{id}/Items is the root-views request (Jellyfin parity);
        // the overlay under test is on a real item listing.
        url: new URL(
            `http://localhost/j/Users/${USER.userId}/Items?IncludeItemTypes=Movie${extraQuery}`,
        ),
        request: {
            method: 'GET',
            headers: { get: (name: string) => headers[name] ?? null },
        },
        locals: { user: USER },
        params: { userId: USER.userId },
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

const MOVIE_ROW = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    title: 'Original Title',
    media_type: 'movie',
    mi_overview: 'Original overview',
    year: 2020,
};

describe('GET /j/Users/{userId}/Items — content-language overlay', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.TMDB_LANGUAGE = 'en-US';
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de-DE'];
        mockBuildAccessContext.mockResolvedValue({
            boundary: {},
            deniedGroupIds: [],
            ageRating: null,
        });
        mockBrowseMediaItems.mockResolvedValue({ rows: [MOVIE_ROW], totalCount: 1 });
    });

    it('overlays German title/overview via the ambient Accept-Language header when the user has no stored pref', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: null,
            metadata_title_language: null,
        });
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([
                [
                    MOVIE_ROW.id,
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
        const body = (await res.json()) as { Items: Array<{ Name: string; Overview?: string }> };

        expect(body.Items[0].Name).toBe('Deutscher Titel');
        expect(body.Items[0].Overview).toBe('Deutsche Übersicht');
    });

    it('serves the primary-language row when no pref, no header, and no translation resolve', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: null,
            metadata_title_language: null,
        });

        const { GET } = await import('./+server');
        const res = await GET(buildEvent());
        const body = (await res.json()) as { Items: Array<{ Name: string; Overview?: string }> };

        expect(body.Items[0].Name).toBe('Original Title');
        expect(body.Items[0].Overview).toBe('Original overview');
        expect(mockGetTranslationMapForItems).not.toHaveBeenCalled();
    });

    it('EnableTotalRecordCount=false asks the query for no count and reports the page size', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: null,
            metadata_title_language: null,
        });
        const { GET } = await import('./+server');
        const res = await GET(buildEvent({}, '&EnableTotalRecordCount=false'));
        const body = (await res.json()) as { Items: unknown[]; TotalRecordCount: number };
        expect(mockBrowseMediaItems).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ skipCount: true }),
        );
        expect(body.TotalRecordCount).toBe(body.Items.length);

        mockBrowseMediaItems.mockClear();
        await GET(buildEvent());
        expect(mockBrowseMediaItems).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ skipCount: false }),
        );
    });

    it('Fields=PrimaryImageAspectRatio still returns the fields /Items sent before Fields existed', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: null,
            metadata_title_language: null,
        });
        const { enrichItemsWithProviderIds } =
            await import('$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment');
        vi.mocked(enrichItemsWithProviderIds).mockImplementationOnce(async (_sql, items) => {
            items[0].ProviderIds = { Tmdb: '603' };
        });
        mockBrowseMediaItems.mockResolvedValue({
            rows: [
                { ...MOVIE_ROW, created_at: new Date('2026-01-02T03:04:05Z'), path: '/m/x.mkv' },
            ],
            totalCount: 1,
        });
        const { GET } = await import('./+server');
        const res = await GET(buildEvent({}, '&Fields=PrimaryImageAspectRatio'));
        const body = (await res.json()) as { Items: Record<string, unknown>[] };
        const item = body.Items[0];
        expect(item.ProviderIds).toEqual({ Tmdb: '603' });
        expect(item.Overview).toBe('Original overview');
        for (const field of [
            'DateCreated',
            'SortName',
            'Genres',
            'Etag',
            'PrimaryImageAspectRatio',
        ]) {
            expect(item, field).toHaveProperty(field);
        }
        // Only what wave 2 added is gated.
        expect(item).not.toHaveProperty('CanDelete');
    });
});
