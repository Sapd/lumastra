// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for defs/catalog/media-id.ts (GET media/{id}).
 *
 * Covers two independently-reported tvOS contract bugs:
 *   1. buildMediaDetail() emits a lightweight traversal-node shape (id/type/
 *      ids/title/images/isAvailable/canRequest + per-kind seriesId/season/
 *      episode/seasons/user fields) that the OLD registered OpenAPI schema
 *      (MediaDetailSchema — a rich actors/genres/ratings contract meant for
 *      GET /api/media-details) never matched. MediaNodeSchema (media-detail.ts)
 *      is the accurate replacement — these tests prove buildMediaDetail()'s
 *      real output validates against it for every media kind.
 *   2. The GET handler's ID-resolution fallback (when locals.resolvedIds is
 *      absent) only accepted bare UUIDs and unconditionally 422'd any
 *      composite/external id — even via the documented ?externalId= query
 *      param — instead of calling mediaIdResolver.resolveAnyMediaId() like
 *      the withIdResolution middleware does. These tests prove composite ids
 *      now resolve, and that resolver errors map to the same HTTP statuses
 *      id-resolution.ts's own middleware uses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Sql } from 'postgres';
import { MediaNodeSchema } from '$lib/schemas/media-detail.js';

vi.mock('$lib/server/services/image-descriptor/index.js', async () => {
    const { buildImageSet } = await import('$lib/shared/image-descriptor.js');
    const imageSet = (surface: 'internal' | 'v1', id: string, mediaType?: string) =>
        buildImageSet(
            surface,
            mediaType === 'episode'
                ? { thumb: { ownerId: id } }
                : { poster: { ownerId: id }, backdrop: { ownerId: id } },
        );
    return {
        resolveImageSet: vi.fn(
            async (_sql: unknown, surface: 'internal' | 'v1', id: string, mediaType?: string) =>
                imageSet(surface, id, mediaType),
        ),
        resolveImageSets: vi.fn(
            async (
                _sql: unknown,
                surface: 'internal' | 'v1',
                items: { id: string; mediaType?: string }[],
            ) => new Map(items.map((item) => [item.id, imageSet(surface, item.id, item.mediaType)])),
        ),
    };
});

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

const mockGetDb = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockGetMediaDetailsById = vi.fn();
const mockGetExternalIdsByMediaId = vi.fn();
const mockBuildExternalIdsObject = vi.fn();
const mockGetMediaNavContext = vi.fn();
const mockResolveAnyMediaId = vi.fn();
const mockGetMediaDetailByUuid = vi.fn();
const mockGetAudiobookNodeDetail = vi.fn();
vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSet: vi.fn().mockResolvedValue({}),
}));
const mockLibraryNames = vi.fn().mockResolvedValue([]);

vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getMediaItemLibraryNames: (...args: unknown[]) => mockLibraryNames(...args),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn().mockResolvedValue({ deniedGroupIds: null, ageRating: null }),
    searchAccessBoundary: vi
        .fn()
        .mockReturnValue({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaDetailsById: (...args: unknown[]) => mockGetMediaDetailsById(...args),
    getExternalIdsByMediaId: (...args: unknown[]) => mockGetExternalIdsByMediaId(...args),
    buildExternalIdsObject: (...args: unknown[]) => mockBuildExternalIdsObject(...args),
    getMediaNavContext: (...args: unknown[]) => mockGetMediaNavContext(...args),
}));

// buildMediaDetail enriches ?include=details with audio/subtitle language
// facts. It is a query module like the ones above, so stub it rather than
// making the fake `sql` object callable — the tests here assert response
// SHAPE, not stream aggregation (that has its own unit + integration tests).
vi.mock('$lib/server/database/queries/media-stream-summary.queries.js', () => ({
    getMediaStreamSummary: vi.fn().mockResolvedValue({
        audioLanguages: [],
        subtitleLanguages: [],
        hasClosedCaptions: false,
        hasSDH: false,
        hasAudioDescription: false,
        bestAudio: null,
    }),
}));

vi.mock('$lib/server/services/image-descriptor/resolver.js', async () => {
    const { buildImageSet } = await import('$lib/shared/image-descriptor.js');
    return {
        resolveImageSet: vi.fn(
            async (
                _sql: Sql,
                surface: import('$lib/shared/api-urls.js').ApiSurface,
                ownerId: string,
            ) =>
                buildImageSet(surface, {
                    poster: { ownerId, urlRole: 'poster', source: 'self' },
                }),
        ),
    };
});

vi.mock('$lib/server/database/queries/media-details.queries.js', () => ({
    getMediaDetailByUuid: (...args: unknown[]) => mockGetMediaDetailByUuid(...args),
}));

// No probed file in these fixtures: durationMs falls back to runtime_minutes * 60000.
vi.mock('$lib/server/database/queries/media-items.queries.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/database/queries/media-items.queries.js')>()),
    findPlaybackDurationMs: vi.fn(async () => null),
}));

vi.mock('$lib/server/database/queries/audiobooks.queries.js', () => ({
    getAudiobookNodeDetail: (...args: unknown[]) => mockGetAudiobookNodeDetail(...args),
}));

vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: {
        resolveAnyMediaId: (...args: unknown[]) => mockResolveAnyMediaId(...args),
    },
}));

// ── Lazy-fill hook mocks (metadata-translations-sync enqueue) ───────────────

const mockGetPlaybackPreferencesOne = vi.fn();
const mockHasTranslation = vi.fn();
const mockStartRun = vi.fn();
const mockGetTranslationMapForItems = vi.fn().mockResolvedValue(new Map());

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: {
        one: (...args: unknown[]) => mockGetPlaybackPreferencesOne(...args),
    },
}));

vi.mock('$lib/server/database/queries/media-translations.queries.js', () => ({
    hasTranslation: (...args: unknown[]) => mockHasTranslation(...args),
    getTranslationMapForItems: (...args: unknown[]) => mockGetTranslationMapForItems(...args),
}));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: (...args: unknown[]) => mockStartRun(...args),
    },
}));

const { config } = await import('$lib/server/config.js');

const { def, buildMediaDetail } = await import('./media-id.js');
const { buildImageRefs } = await import('$lib/shared/api-urls.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(opts: {
    id: string;
    resolvedInternalId?: string;
    externalId?: string;
}): RequestEvent {
    const url = new URL(
        `http://localhost/api/v1/media/${opts.id}${opts.externalId ? `?externalId=${opts.externalId}` : ''}`,
    );
    return {
        url,
        params: { id: opts.id },
        route: { id: '/api/v1/media/[id]' as const },
        request: new Request(url.toString()),
        locals: {
            resolvedIds: opts.resolvedInternalId
                ? { internalId: opts.resolvedInternalId, source: 'uuid' }
                : undefined,
            user: {
                userId: 'usr_00000000-0000-0000-0000-000000000001',
                username: 'alice',
                userGroups: [],
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const CTX = { surface: 'internal' as const };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue(vi.fn(async () => []));
    mockCheckMediaAccess.mockResolvedValue(true);
    mockGetExternalIdsByMediaId.mockResolvedValue([]);
    mockBuildExternalIdsObject.mockReturnValue({});
    mockGetMediaNavContext.mockResolvedValue(null);
    mockGetMediaDetailByUuid.mockResolvedValue(null);
    mockGetAudiobookNodeDetail.mockResolvedValue(null);
    mockLibraryNames.mockResolvedValue([]);
});

// ── buildMediaDetail() → MediaNodeSchema conformance ───────────────────────

describe('buildMediaDetail() response shape — validates against MediaNodeSchema', () => {
    const sql = vi.fn(async () => []) as unknown as Sql;

    it('serializes a stored tagline and only requests accessible library labels', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            media_type: 'movie',
            title: 'Awakening',
            tagline: '  Why are they here?  ',
        });
        mockLibraryNames.mockResolvedValue(['Cinema']);
        const body = await buildMediaDetail(
            sql,
            'movie-uuid',
            'internal',
            '',
            undefined,
            async () => ({
                library: { kind: 'denyGroups', ids: ['private-library'] },
                age: { kind: 'any' },
            }),
        );
        const parsed = MediaNodeSchema.parse(body);
        expect(parsed.tagline).toBe('Why are they here?');
        expect(parsed.libraryNames).toEqual(['Cinema']);
        expect(mockLibraryNames).toHaveBeenCalledWith(sql, 'movie-uuid', ['private-library']);
    });

    it('omits library context when no access boundary was provided', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            media_type: 'movie',
            title: 'Awakening',
            tagline: ' ',
        });
        const body = await buildMediaDetail(sql, 'movie-uuid', 'internal', '', undefined);
        expect(body?.libraryNames).toBeUndefined();
        expect(body?.tagline).toBeUndefined();
        expect(mockLibraryNames).not.toHaveBeenCalled();
    });

    it('produces a movie node with required id/ids/title/images/isAvailable/canRequest', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: 'A team travels through a wormhole.',
            premiere_date: '2014-11-07',
            is_available: true,
            can_request: false,
        });

        const body = await buildMediaDetail(sql, 'movie-uuid', 'v1', '', undefined);
        expect(body).not.toBeNull();
        expect(body?.type).toBe('movie');

        const parsed = MediaNodeSchema.parse(body);
        expect(parsed.type).toBe('movie');
        expect(parsed.id).toBe('movie-uuid');
        expect(parsed.images.poster?.href).toContain('/movie-uuid/images/poster');
        if (parsed.type === 'movie') {
            expect(parsed.isAvailable).toBe(true);
            expect(parsed.canRequest).toBe(false);
        }
    });

    it('derives the year from premiere_date when the row has one', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            year: 1999,
            premiere_date: '2014-11-07',
            is_available: true,
            can_request: false,
        });

        const body = await buildMediaDetail(sql, 'movie-uuid', 'v1', '', undefined);
        expect(body?.year).toBe(2014);
    });

    it('falls back to media_items.year when premiere_date is absent', async () => {
        // Regression: `premiere_date` was read off a row the detail query never
        // selected, so `year` was absent from EVERY movie/series/episode node
        // even when media_items.year was populated.
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'movie-uuid',
            media_type: 'movie',
            title: 'Full Metal Jacket',
            year: 1987,
            premiere_date: null,
            is_available: true,
            can_request: false,
        });

        const body = await buildMediaDetail(sql, 'movie-uuid', 'v1', '', undefined);
        expect(body?.year).toBe(1987);
    });

    it('omits the year when neither premiere_date nor media_items.year is set', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'movie-uuid',
            media_type: 'movie',
            title: 'Untitled',
            year: null,
            premiere_date: null,
            is_available: true,
            can_request: false,
        });

        const body = await buildMediaDetail(sql, 'movie-uuid', 'v1', '', undefined);
        expect(body?.year).toBeUndefined();
        expect(MediaNodeSchema.parse(body)).toBeTruthy();
    });

    it('produces an episode node with seriesId/seasonNumber/episodeNumber (type union previously rejected this)', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'ep-uuid',
            media_type: 'episode',
            title: 'Pilot',
            overview: null,
            premiere_date: '2020-01-01',
            is_available: true,
            can_request: false,
            season_number: 1,
            episode_number: 1,
        });
        mockGetMediaNavContext.mockResolvedValue({
            series_id: 'series-uuid',
            season_number: 1,
            episode_number: 1,
        });

        const body = await buildMediaDetail(sql, 'ep-uuid', 'v1', '', undefined);
        expect(body?.type).toBe('episode');

        // Before MediaNodeSchema existed, the registered schema only unioned
        // movie|series (or the rich MediaDetailSchema, which never modeled
        // seriesId/seasonNumber/episodeNumber at all) and would reject this.
        const parsed = MediaNodeSchema.parse(body);
        if (parsed.type === 'episode') {
            expect(parsed.seriesId).toBe('series-uuid');
            expect(parsed.seasonNumber).toBe(1);
            expect(parsed.episodeNumber).toBe(1);
        } else {
            throw new Error(`expected type 'episode', got '${parsed.type}'`);
        }
    });

    it('preserves seasons{href} for a series node and user{} when ?include=user', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'series-uuid',
            media_type: 'tv',
            title: 'Starhaven',
            overview: 'A team at Lumon.',
            premiere_date: '2022-02-18',
            is_available: true,
            can_request: false,
        });

        // buildMediaDetail runs a raw tagged-template query on `sql` directly
        // (not through a query module) when ?include=user — fake the tag as a
        // callable returning a resolved Promise (native .catch() works as-is).
        const fakeSql = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
            Promise.resolve([{ user_rating: 7, in_watchlist: true }])) as unknown as Sql;

        const body = await buildMediaDetail(fakeSql, 'series-uuid', 'v1', 'user', 'usr_1');
        expect(body?.type).toBe('series');

        // Before MediaNodeSeriesSchema existed, `seasons` and `user` were
        // undeclared and z.object() silently strips unknown keys on parse.
        const parsed = MediaNodeSchema.parse(body);
        if (parsed.type === 'series') {
            expect(parsed.seasons?.href).toBe('/api/v1/series/series-uuid/seasons');
            expect(parsed.user?.rating).toBe(7);
            expect(parsed.user?.inWatchlist).toBe(true);
        } else {
            throw new Error(`expected type 'series', got '${parsed.type}'`);
        }
    });

    it('normalizes a PostgreSQL numeric user rating before returning the node', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'series-uuid',
            media_type: 'tv',
            title: 'Starhaven',
            overview: null,
            premiere_date: null,
            is_available: true,
            can_request: false,
        });

        // postgres exposes NUMERIC values as strings unless the type parser is
        // overridden. Swift's generated decoder rejects that string and drops
        // the complete audiobook/detail response.
        const fakeSql = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
            Promise.resolve([{ user_rating: '7.5', in_watchlist: false }])) as unknown as Sql;

        const body = await buildMediaDetail(fakeSql, 'series-uuid', 'v1', 'user', 'usr_1');
        const parsed = MediaNodeSchema.parse(body);
        if (parsed.type !== 'series') throw new Error(`expected 'series', got '${parsed.type}'`);
        expect(parsed.user?.rating).toBe(7.5);
        expect(parsed.user?.inWatchlist).toBe(false);
    });

    it('returns rich metadata by default for a movie', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: 'A team travels through a wormhole.',
            premiere_date: '2014-11-07',
            runtime_minutes: 169,
            is_available: true,
            can_request: false,
        });
        mockGetMediaDetailByUuid.mockResolvedValue({
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: 'A team travels through a wormhole.',
            release_date: '2014-11-07',
            runtime_minutes: 169,
            genres: ['Sci-Fi', 'Drama'],
            imdb_rating: 8.7,
            tmdb_rating: 8.4,
            is_available: true,
            can_request: false,
            actors: ['Matthew McConaughey'],
        });

        const body = await buildMediaDetail(sql, 'movie-uuid', 'v1', '', undefined);
        expect(mockGetMediaDetailByUuid).toHaveBeenCalledWith(sql, 'movie-uuid');

        const parsed = MediaNodeSchema.parse(body);
        if (parsed.type !== 'movie') throw new Error(`expected 'movie', got '${parsed.type}'`);
        expect(parsed.details?.genres).toEqual(['Sci-Fi', 'Drama']);
        // The runtime lives on the node as durationMs (ms), not as details.runtime.
        // (MediaNodeSchema's base arms omit durationMs; the route's response schema
        // extends it in, so assert on the builder output.)
        expect(body).toMatchObject({ durationMs: 169 * 60_000 });
        expect(parsed.details).not.toHaveProperty('runtime');
        expect(body).not.toHaveProperty('runtimeMinutes');
        expect(parsed.details?.rating).toBeGreaterThan(0);
        // Identity fields must NOT be duplicated inside `details` — they already
        // live on the node itself (toNodeDetailsExtra strips them).
        expect(parsed.details).not.toHaveProperty('id');
        expect(parsed.details).not.toHaveProperty('title');
        expect(parsed.details).not.toHaveProperty('images');
    });

    it('returns structured credits by default, including unknown identities', async () => {
        mockGetMediaDetailsById.mockResolvedValue({ media_type: 'movie', title: 'Intertidal' });
        const sql = vi.fn(async () => [
            {
                metadata: {
                    cast: [
                        {
                            id: 123,
                            name: 'Alex Example',
                            character: 'Pilot',
                            order: 2,
                            profile_path: '/alex.jpg',
                        },
                        { name: 'Unknown Actor' },
                    ],
                    crew: [
                        {
                            id: 456,
                            name: 'Jamie Example',
                            job: 'Director',
                            department: 'Directing',
                        },
                    ],
                },
            },
        ]) as unknown as Sql;
        const parsed = MediaNodeSchema.parse(
            await buildMediaDetail(sql, 'movie-uuid', 'v1', '', undefined),
        );
        if (parsed.type !== 'movie') throw new Error('Expected movie');
        expect(parsed.credits?.cast[0]).toMatchObject({
            person: { id: 'tmdb:123', name: 'Alex Example' },
            character: 'Pilot',
            order: 2,
        });
        expect(parsed.credits?.cast[0].person.images?.primary?.variants).toBeDefined();
        expect(parsed.credits?.cast[1].person).toEqual({ id: null, name: 'Unknown Actor' });
        expect(parsed.credits?.crew[0]).toMatchObject({
            person: { id: 'tmdb:456' },
            job: 'Director',
        });
        expect(parsed).not.toHaveProperty('actors');
    });

    it('reads default rich metadata even when include is absent', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: null,
            premiere_date: null,
            is_available: true,
            can_request: false,
        });

        const body = await buildMediaDetail(sql, 'movie-uuid', 'v1', '', undefined);
        expect(mockGetMediaDetailByUuid).toHaveBeenCalledWith(sql, 'movie-uuid');
        expect(body).not.toHaveProperty('details'); // Missing provider metadata is still absent.
    });

    it('never populates `details` for an episode, by default (rich schema is movie/series only)', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'ep-uuid',
            media_type: 'episode',
            title: 'Pilot',
            overview: null,
            premiere_date: null,
            is_available: true,
            can_request: false,
        });
        mockGetMediaNavContext.mockResolvedValue({
            series_id: 'series-uuid',
            season_number: 1,
            episode_number: 1,
        });

        const body = await buildMediaDetail(sql, 'ep-uuid', 'v1', '', undefined);
        expect(mockGetMediaDetailByUuid).not.toHaveBeenCalled();
        expect(body).not.toHaveProperty('details');
    });
});

// ── Audiobook node ─────────────────────────────────────────────────────────
//
// Regression: an AudiobookShelf book has NO provider_metadata row, so
// getMediaDetailsById (which sources overview from
// provider_metadata.metadata->>'overview') reported `overview: null` for a book
// whose description sits in media_items.overview — and nothing at all knew about
// its authors, narrators or chapters. The detail modal therefore rendered a cover,
// a title and a year and nothing else, even though every one of those facts was
// already in the database.
//
// Note the type union: before MediaNodeAudiobookSchema existed, `type:
// 'audiobook'` could not be parsed at all. That failed SILENTLY — mount()'s
// conformance strip logs and passes the original through on a hard parse failure,
// so the missing variant never surfaced as an error.

describe('buildMediaDetail() audiobook node', () => {
    const sql = vi.fn(async () => []) as unknown as Sql;

    const ABS_DETAIL = {
        overview: 'Felix Vale liest Band 1 von Milo Farrow.',
        year: 2016,
        runtimeSeconds: 30_000,
        authors: [{ id: '11111111-1111-4111-8111-111111111111', name: 'M.K. Fenwick' }],
        narrators: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Felix Vale' }],
        publisher: 'Der Hörverlag',
        series: { id: '33333333-3333-4333-8333-333333333333', name: 'Milo Farrow', position: 1 },
        ids: { isbn: '9780000000001' },
        abridged: false,
        durationMs: 30_600_000,
        chapters: [
            { index: 0, startMs: 0, endMs: 120000, name: 'Der Junge, der überlebte' },
            {
                index: 1,
                startMs: 120000,
                endMs: 400000,
                name: 'Das verschwundene Glas',
            },
        ],
    };

    function mockAudiobookRow(overrides: Record<string, unknown> = {}): void {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'book-uuid',
            media_type: 'audiobook',
            title: 'Milo Farrow und der Stein der Weisen - Gesprochen von Felix Vale',
            // NULL because it comes from provider_metadata, which ABS books lack.
            overview: null,
            premiere_date: null,
            is_available: true,
            can_request: false,
            ...overrides,
        });
    }

    it('validates against MediaNodeSchema and carries authors/narrators/chapters', async () => {
        mockAudiobookRow();
        mockGetAudiobookNodeDetail.mockResolvedValue(ABS_DETAIL);

        const body = await buildMediaDetail(sql, 'book-uuid', 'v1', '', undefined);
        expect(body).not.toBeNull();

        const parsed = MediaNodeSchema.parse(body);
        expect(parsed.type).toBe('audiobook');
        if (parsed.type !== 'audiobook') throw new Error('expected an audiobook node');
        // The detail carries the same cover ImageSet the list items do.
        expect(Object.keys(parsed.images).length).toBeGreaterThan(0);

        expect(parsed.authors).toEqual(ABS_DETAIL.authors);
        expect(parsed.narrators).toEqual(ABS_DETAIL.narrators);
        expect(parsed.publisher).toBe('Der Hörverlag');
        expect(parsed.series).toEqual(ABS_DETAIL.series);
        expect(parsed.abridged).toBe(false);
        expect(parsed.chapters).toHaveLength(2);
        expect(parsed.chapters).toEqual(ABS_DETAIL.chapters);
        for (const field of [
            'seriesName',
            'seriesSequence',
            'seriesBooks',
            'durationSeconds',
            'resumePositionMs',
            'isFinished',
        ])
            expect(body).not.toHaveProperty(field);
    });

    it('falls back to media_items.overview when provider_metadata has none', async () => {
        mockAudiobookRow();
        mockGetAudiobookNodeDetail.mockResolvedValue(ABS_DETAIL);

        const body = await buildMediaDetail(sql, 'book-uuid', 'v1', '', undefined);
        expect(body?.overview).toBe('Felix Vale liest Band 1 von Milo Farrow.');
    });

    it('derives the year from the book row when there is no premiere_date', async () => {
        mockAudiobookRow();
        mockGetAudiobookNodeDetail.mockResolvedValue(ABS_DETAIL);

        const body = await buildMediaDetail(sql, 'book-uuid', 'v1', '', undefined);
        expect(body?.year).toBe(2016);
    });

    it("prefers AudiobookShelf's own duration over the local runtime mirror", async () => {
        mockAudiobookRow();
        mockGetAudiobookNodeDetail.mockResolvedValue(ABS_DETAIL);

        const body = await buildMediaDetail(sql, 'book-uuid', 'v1', '', undefined);
        expect(body?.durationMs).toBe(30_600_000);
    });

    it('still produces a valid node when the audiobook read finds nothing', async () => {
        mockAudiobookRow();
        mockGetAudiobookNodeDetail.mockResolvedValue(null);

        const body = await buildMediaDetail(sql, 'book-uuid', 'v1', '', undefined);
        const parsed = MediaNodeSchema.parse(body);
        expect(parsed.type).toBe('audiobook');
        if (parsed.type !== 'audiobook') throw new Error('expected an audiobook node');
        // No half-populated book fields — absent, not empty.
        expect(parsed.authors).toEqual([]);
        expect(parsed.chapters).toEqual([]);
        // The cover still comes through when the audiobook read finds nothing.
        expect(Object.keys(parsed.images).length).toBeGreaterThan(0);
    });

    it('costs no extra query for a movie', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: 'A team travels through a wormhole.',
            premiere_date: '2014-11-07',
            is_available: true,
            can_request: false,
        });

        await buildMediaDetail(sql, 'movie-uuid', 'v1', '', undefined);
        expect(mockGetAudiobookNodeDetail).not.toHaveBeenCalled();
    });
});

// ── GET handler — ID resolution fallback ───────────────────────────────────

describe('GET /media/{id} — ID resolution fallback (no locals.resolvedIds)', () => {
    it('resolves a composite external id (path segment) via mediaIdResolver instead of 422ing', async () => {
        mockResolveAnyMediaId.mockResolvedValue({
            internalId: 'movie-uuid',
            source: 'composite',
        });
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: null,
            premiere_date: null,
            is_available: true,
            can_request: false,
        });

        const res = await def.handlers.GET!(makeEvent({ id: 'tmdb:157336:movie' }), CTX);

        expect(mockResolveAnyMediaId).toHaveBeenCalledWith('tmdb:157336:movie');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { id: string };
        expect(body.id).toBe('movie-uuid');
    });

    it('falls back to ?externalId= when the path segment is empty', async () => {
        mockResolveAnyMediaId.mockResolvedValue({
            internalId: 'movie-uuid',
            source: 'composite',
        });
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: null,
            premiere_date: null,
            is_available: true,
            can_request: false,
        });

        const event = makeEvent({ id: '' });
        const ctxWithQuery = {
            ...CTX,
            input: {
                body: undefined,
                params: undefined,
                query: {
                    externalId: 'tmdb:157336:movie',
                } as { externalId?: string; include?: string },
            },
        };

        await def.handlers.GET!(event, ctxWithQuery);

        expect(mockResolveAnyMediaId).toHaveBeenCalledWith('tmdb:157336:movie');
    });

    it('maps "Invalid media ID format" resolver errors to 422 validation_failed', async () => {
        mockResolveAnyMediaId.mockRejectedValue(
            new Error('Invalid media ID format: bogus (expected UUID or provider:id:mediaType)'),
        );

        const res = await def.handlers.GET!(makeEvent({ id: 'bogus' }), CTX);
        expect(res.status).toBe(422);
    });

    it('maps "not found" resolver errors to 404', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('Media not found: tmdb:999999:movie'));

        const res = await def.handlers.GET!(makeEvent({ id: 'tmdb:999999:movie' }), CTX);
        expect(res.status).toBe(404);
    });

    it('maps "Database connection not available" resolver errors to 503', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('Database connection not available'));

        const res = await def.handlers.GET!(makeEvent({ id: 'tmdb:1:movie' }), CTX);
        expect(res.status).toBe(503);
    });

    it('still fast-paths a bare UUID via locals.resolvedIds without consulting the resolver', async () => {
        mockGetMediaDetailsById.mockResolvedValue({
            id: '12345678-1234-1234-1234-123456789012',
            media_type: 'movie',
            title: 'Intertidal',
            overview: null,
            premiere_date: null,
            is_available: true,
            can_request: false,
        });

        const res = await def.handlers.GET!(
            makeEvent({
                id: '12345678-1234-1234-1234-123456789012',
                resolvedInternalId: '12345678-1234-1234-1234-123456789012',
            }),
            CTX,
        );

        expect(res.status).toBe(200);
        expect(mockResolveAnyMediaId).not.toHaveBeenCalled();
    });
});

// ── Lazy-fill enqueue (metadata-translations-sync) ──────────────────────────

describe('buildMediaDetail() lazy-fill translations enqueue', () => {
    const USER_ID = 'usr_00000000-0000-0000-0000-000000000001';

    /** sql stub that is ALSO callable as a tagged template (the lazy-fill
     * IIFE queries the stage row directly); resolves to no stage row. */
    function makeSql(): Sql {
        const fn = vi.fn().mockResolvedValue([]);
        return fn as unknown as Sql;
    }

    function mockMovieRow(): void {
        mockGetMediaDetailsById.mockResolvedValue({
            id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: null,
            premiere_date: null,
            is_available: true,
            can_request: false,
        });
    }

    it('enqueues with the stage-sweep coverage idempotencyKey (dedup against sweep + repeat views)', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de']);
        try {
            mockMovieRow();
            mockGetPlaybackPreferencesOne.mockResolvedValue({
                metadata_title_language: 'de',
                metadata_language: null,
            });
            mockHasTranslation.mockResolvedValue(false);
            mockStartRun.mockResolvedValue({ deduped: false });

            const body = await buildMediaDetail(makeSql(), 'movie-uuid', 'v1', '', USER_ID);
            expect(body).not.toBeNull();

            // Fire-and-forget IIFE — wait for the enqueue to land.
            await vi.waitFor(() => expect(mockStartRun).toHaveBeenCalledTimes(1));
            expect(mockStartRun).toHaveBeenCalledWith(
                'metadata-translations-sync',
                { mediaItemId: 'movie-uuid' },
                expect.objectContaining({
                    idempotencyKey: 'coverage:metadata-translations-sync:movie-uuid',
                }),
            );
        } finally {
            langSpy.mockRestore();
        }
    });

    it('feature off (no admin languages): zero extra queries — prefs lookup never runs', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue([]);
        try {
            mockMovieRow();

            const body = await buildMediaDetail(makeSql(), 'movie-uuid', 'v1', '', USER_ID);
            expect(body).not.toBeNull();

            // Give any (buggy) stray IIFE a tick to run before asserting.
            await new Promise((resolve) => setImmediate(resolve));
            expect(mockGetPlaybackPreferencesOne).not.toHaveBeenCalled();
            expect(mockStartRun).not.toHaveBeenCalled();
        } finally {
            langSpy.mockRestore();
        }
    });

    it('does not enqueue when the stage row is in a terminal state', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de']);
        try {
            mockMovieRow();
            mockGetPlaybackPreferencesOne.mockResolvedValue({
                metadata_title_language: 'de',
                metadata_language: null,
            });
            mockHasTranslation.mockResolvedValue(false);
            const sql = vi
                .fn()
                .mockResolvedValue([{ status: 'skipped_permanent' }]) as unknown as Sql;

            const body = await buildMediaDetail(sql, 'movie-uuid', 'v1', '', USER_ID);
            expect(body).not.toBeNull();

            await vi.waitFor(() => expect(mockHasTranslation).toHaveBeenCalled());
            await new Promise((resolve) => setImmediate(resolve));
            expect(mockStartRun).not.toHaveBeenCalled();
        } finally {
            langSpy.mockRestore();
        }
    });
});

// ── Title/overview overlay (multilingual-media-metadata spec §5) ───────────

describe('buildMediaDetail() metadata-language overlay', () => {
    const USER_ID = 'usr_00000000-0000-0000-0000-000000000001';
    const sql = vi.fn(async () => []) as unknown as Sql;

    it('swaps the localized title/overview when prefs + a translation resolve', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de']);
        try {
            mockGetMediaDetailsById.mockResolvedValue({
                id: 'movie-uuid',
                media_type: 'movie',
                title: 'Intertidal',
                overview: 'A team travels through a wormhole.',
                premiere_date: '2014-11-07',
                is_available: true,
                can_request: false,
            });
            mockGetPlaybackPreferencesOne.mockResolvedValue({
                metadata_title_language: 'de',
                metadata_language: 'de',
            });
            mockGetTranslationMapForItems.mockResolvedValue(
                new Map([
                    [
                        'movie-uuid',
                        {
                            title: 'Intertidal (DE)',
                            overview: 'Ein Team durchquert ein Wurmloch.',
                            tagline: 'Die Antwort liegt jenseits der Sterne.',
                        },
                    ],
                ]),
            );
            mockHasTranslation.mockResolvedValue(true); // skip lazy-fill enqueue

            const body = await buildMediaDetail(sql, 'movie-uuid', 'v1', '', USER_ID);

            expect(body?.title).toBe('Intertidal (DE)');
            expect(body?.overview).toBe('Ein Team durchquert ein Wurmloch.');
            expect(body?.tagline).toBe('Die Antwort liegt jenseits der Sterne.');
        } finally {
            langSpy.mockRestore();
        }
    });

    it('leaves title/overview untouched when no admin-additional language is configured', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue([]);
        try {
            mockGetMediaDetailsById.mockResolvedValue({
                id: 'movie-uuid',
                media_type: 'movie',
                title: 'Intertidal',
                overview: 'A team travels through a wormhole.',
                premiere_date: '2014-11-07',
                is_available: true,
                can_request: false,
            });

            const body = await buildMediaDetail(sql, 'movie-uuid', 'v1', '', USER_ID);

            expect(body?.title).toBe('Intertidal');
            expect(body?.overview).toBe('A team travels through a wormhole.');
            expect(mockGetPlaybackPreferencesOne).not.toHaveBeenCalled();
        } finally {
            langSpy.mockRestore();
        }
    });
});

// ── buildImageRefs() — backdrop preset parity with poster ──────────────────
//
// Regression: the music text-search/lyrics-search response schema
// (MusicSearchResultItemSchema in api-music-responses.ts) requires `thumb`
// on every ImagePresetsSchema-shaped role, including `backdrop`. buildImageRefs
// omitted it, so every semantic-search result item failed client-side
// validation (fail-open masked it — raw data still rendered, but every
// response silently logged a schema-mismatch warning).
describe('buildImageRefs()', () => {
    it('emits the same href/thumb/card/full presets for backdrop as for poster', () => {
        const refs = buildImageRefs('media-uuid', 'v1');

        expect(refs.poster).toMatchObject({
            href: expect.any(String),
            thumb: expect.any(String),
            card: expect.any(String),
            full: expect.any(String),
        });
        expect(refs.backdrop).toMatchObject({
            href: expect.any(String),
            thumb: expect.any(String),
            card: expect.any(String),
            full: expect.any(String),
            wide: expect.any(String),
        });
        expect(refs.backdrop.thumb).toBe('/api/v1/media/media-uuid/images/backdrop?size=thumb');
    });
});

describe('MEDIA_NODE_TYPES', () => {
    it('is exactly the MediaNodeSchema arms and excludes music types', async () => {
        const { MEDIA_NODE_TYPES } = await import('./media-id.js');
        expect([...MEDIA_NODE_TYPES].sort()).toEqual(
            ['audiobook', 'episode', 'movie', 'season', 'series'].sort(),
        );
        for (const t of ['artist', 'album', 'track']) {
            expect(MEDIA_NODE_TYPES.has(t)).toBe(false);
        }
    });
});
