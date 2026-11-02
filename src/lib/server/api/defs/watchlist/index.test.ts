// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for defs/watchlist/index.ts GET (list watchlist items).
 *
 * This handler previously had NO test coverage, which is how three contract
 * bugs survived in it simultaneously:
 *   1. `genres` was emitted as integer TMDB ids against a `z.array(z.string())`
 *      declaration (the query extracts `(elem->>'id')::integer`);
 *   2. `rating` could be sourced from `tmdb_rating`, which the query aliases
 *      from `metadata->>'popularity'` — an unbounded number, not a 0-10 rating;
 *   3. `savedAt` could be a `Date` against a `z.string()` declaration.
 *
 * Each of those fails the response contract, and because mount() `.parse()`s
 * the body a failure drops or mangles the whole response. The tests below pin
 * the fixed behaviour: display metadata comes from the batched rail hydration,
 * never from those query columns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

/**
 * Shape the tests read off each response item. `media` (and its nested `ids`/
 * `ratings` maps) are typed as records so deep property access resolves to
 * `unknown` leaves the assertions can consume, instead of `item.media` being
 * `unknown` outright.
 */
type WatchlistTestItem = {
    ids: Record<string, unknown>;
    ratings: Record<string, unknown>;
    availability: { isAvailable: boolean; canRequest: boolean };
    [key: string]: unknown;
};

vi.mock('$lib/server/services/image-descriptor/resolver.js', async () => {
    const { buildImageSet } = await import('$lib/shared/image-descriptor.js');
    return {
        resolveImageSets: vi.fn(
            async (
                _sql: unknown,
                surface: import('$lib/shared/api-urls.js').ApiSurface,
                items: Array<{ id: string }>,
            ) =>
                new Map(
                    items.map(({ id }) => [
                        id,
                        buildImageSet(surface, {
                            poster: { ownerId: id, source: 'self' },
                            backdrop: { ownerId: id, source: 'self' },
                        }),
                    ]),
                ),
        ),
    };
});

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

const mockGetUserWatchlistMedia = vi.fn();
vi.mock('$lib/server/database/queries/watchlist-media.queries.js', () => ({
    getUserWatchlistMedia: (...args: unknown[]) => mockGetUserWatchlistMedia(...args),
}));

const mockGetMediaRailMetadataBatch = vi.fn();
vi.mock('$lib/server/database/queries/media-rail-metadata.queries.js', () => ({
    getMediaRailMetadataBatch: (...args: unknown[]) => mockGetMediaRailMetadataBatch(...args),
}));

const mockBatchGetWatchedState = vi.fn();
const mockPlaybackStates = vi.fn().mockResolvedValue([]);
vi.mock('$lib/server/database/queries/watch-state.queries.js', () => ({
    batchGetUserWatchStates: { all: (...args: unknown[]) => mockPlaybackStates(...args) },
    batchGetWatchedState: (...args: unknown[]) => mockBatchGetWatchedState(...args),
}));

const mockBuildSearchAccessContext = vi.fn();
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
}));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

const mockConfig: Record<string, unknown> = {
    METADATA_ADDITIONAL_LANGUAGES: [] as string[],
};
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

const { def } = await import('./index.js');
const { WatchlistItemSchema } = await import('$lib/schemas/api-watchlist-responses.js');

const UUID = '11111111-2222-4333-a444-555555555555';

/** A watchlist row as the query actually returns it — note the hostile fields. */
function makeRow(overrides: Record<string, unknown> = {}) {
    return {
        media_id: UUID,
        primary_ext_id: '603',
        media_type: 'movie',
        title: 'The Lantern',
        overview: 'A hacker discovers reality is a simulation.',
        year: 1999,
        saved_at: '2026-07-01T00:00:00.000Z',
        is_available: true,
        can_request: false,
        jellyfin_id: 'jf-abc',
        imdb_id: 'tt0133093',
        // The query extracts genres as integer TMDB ids, NOT names.
        genres: [28, 878],
        // Aliased from metadata->>'popularity' — must never become `rating`.
        tmdb_rating: 842.19,
        imdb_rating: null,
        rt_rating: 88,
        rt_audience_score: 85,
        letterboxd_rating: 4.3,
        letterboxd_votes: 12345,
        mdblist_score: 90,
        trakt_score: 91,
        mal_score: null,
        runtime_minutes: null,
        certification: null,
        popularity: 842.19,
        actors: ['Keiran Vale'],
        directors: ['Lana Wachowski'],
        release_date: '1999-01-01',
        ...overrides,
    };
}

function makeMeta(overrides: Record<string, unknown> = {}) {
    return {
        mediaId: UUID,
        overview: 'Hydrated overview.',
        imdbRating: 8.7,
        tmdbRating: 8.2,
        voteCount: 4200,
        rtRating: 88,
        runtimeMinutes: 136,
        genres: ['Action', 'Science Fiction'],
        certification: 'R',
        resolutionTier: '4K',
        hdrTier: 'dolby_vision',
        hdrType: null,
        hasAtmos: true,
        hasCc: true,
        hasSdh: false,
        hasAd: false,
        ...overrides,
    };
}

async function callGet(rows: Array<Record<string, unknown>>, metas?: Map<string, unknown>) {
    mockGetUserWatchlistMedia.mockResolvedValue(rows);
    mockGetMediaRailMetadataBatch.mockResolvedValue(
        metas ?? new Map(rows.map((r) => [String(r.media_id), makeMeta({ mediaId: r.media_id })])),
    );

    const event = {
        locals: { user: { userId: 'user-1', username: 'denis' } },
        url: new URL('http://localhost/api/v1/watchlist'),
    } as unknown as RequestEvent;

    const response = await def.handlers.GET!(event, {} as ApiContext);
    return (await response.json()) as { items: Array<Record<string, unknown>>; page: unknown };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockPlaybackStates.mockResolvedValue([]);
    mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: [], ageRating: null });
    // Default: nothing watched. Individual tests override to assert the flag.
    mockBatchGetWatchedState.mockResolvedValue(new Map());
    mockPlaybackStates.mockResolvedValue([]);
    mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
});

describe('GET /watchlist — canonical envelope', () => {
    it('emits the catalog UUID as id and catalogId with external-only ids', async () => {
        const body = await callGet([makeRow()]);
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.id).toBe(UUID);
        expect(item.catalogId).toBe(UUID);
        expect(item.ids.internal).toBeUndefined();
        expect(item).not.toHaveProperty('media');
        expect(item.ids.tmdb).toBe('603');
        expect(item.ids.imdb).toBe('tt0133093');
        // A row's Jellyfin id is never emitted.
        expect(item.ids).not.toHaveProperty('jellyfin');
    });

    it('produces items that satisfy the declared response contract', async () => {
        // mount() .parse()s the body — anything failing here would be dropped
        // or mangled on the wire.
        const body = await callGet([makeRow(), makeRow({ media_type: 'tv' })]);

        for (const item of body.items) {
            const parsed = WatchlistItemSchema.safeParse(item);
            expect(parsed.success).toBe(true);
        }
    });

    it("maps media_type 'tv' to the canonical 'series' discriminator", async () => {
        const body = await callGet([makeRow({ media_type: 'tv' })]);
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.type).toBe('series');
    });

    it("preserves media_type 'audiobook' rather than collapsing it to 'movie'", async () => {
        // Regression guard: toMovieOrSeries(...) ?? 'movie' silently mislabelled
        // every non-movie/tv row as a movie. toPublicMediaType(...) ?? 'movie'
        // must report 'audiobook' for an audiobook row.
        const body = await callGet([makeRow({ media_type: 'audiobook' })]);
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.type).toBe('audiobook');
        expect(WatchlistItemSchema.safeParse(item).success).toBe(true);
    });

    it('takes genres as NAMES from hydration, never the query integer ids', async () => {
        const body = await callGet([makeRow()]);
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.genres).toEqual(['Action', 'Science Fiction']);
        expect(item.genres).not.toContain(28);
    });

    it('never sources rating from the popularity-aliased tmdb_rating column', async () => {
        // Row popularity is 842.19; hydration says imdbRating 8.7.
        const body = await callGet([makeRow()]);
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.rating).toBe(8.7);
        expect(item.rating).toBeLessThanOrEqual(10);
    });

    it('omits rating entirely when hydration has none, rather than falling back to popularity', async () => {
        const body = await callGet(
            [makeRow()],
            new Map([[UUID, makeMeta({ imdbRating: null, tmdbRating: null })]]),
        );
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.rating).toBeUndefined();
    });

    it('falls back to the TMDB score when IMDb is absent and the vote count qualifies', async () => {
        const body = await callGet(
            [makeRow()],
            new Map([[UUID, makeMeta({ imdbRating: null, tmdbRating: 7.4, voteCount: 900 })]]),
        );
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.rating).toBe(7.4);
    });

    it('suppresses a TMDB score backed by too few votes rather than showing it raw', async () => {
        const body = await callGet(
            [makeRow()],
            new Map([[UUID, makeMeta({ imdbRating: null, tmdbRating: 10, voteCount: 3 })]]),
        );
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.rating).toBeUndefined();
    });

    it('normalises a Date savedAt to an ISO string', async () => {
        const body = await callGet([makeRow({ saved_at: new Date('2026-07-01T00:00:00.000Z') })]);
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.savedAt).toBe('2026-07-01T00:00:00.000Z');
        expect(WatchlistItemSchema.safeParse(item).success).toBe(true);
    });

    it('carries the aggregate ratings block', async () => {
        const body = await callGet([makeRow()]);
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.ratings).toEqual({
            letterboxd: 4.3,
            letterboxdVotes: 12345,
            rtAudience: 85,
            mdblist: 90,
            trakt: 91,
            mal: null,
        });
    });

    it('preserves a zero score rather than nulling it', async () => {
        const body = await callGet([makeRow({ trakt_score: 0 })]);
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.ratings.trakt).toBe(0);
    });

    it('an available item needs no Jellyfin id', async () => {
        // Availability is has_files, decoupled from Jellyfin presence.
        const body = await callGet([makeRow({ jellyfin_id: null, is_available: true })]);
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.ids.jellyfin).toBeUndefined();
        expect(item.availability.isAvailable).toBe(true);
        expect(WatchlistItemSchema.safeParse(item).success).toBe(true);
    });

    it('sets canRequest only when the item is unavailable', async () => {
        const unavailable = await callGet([makeRow({ is_available: false, can_request: true })]);
        expect((unavailable.items[0] as WatchlistTestItem).availability.canRequest).toBe(true);

        const available = await callGet([makeRow({ is_available: true, can_request: true })]);
        expect((available.items[0] as WatchlistTestItem).availability.canRequest).toBe(false);
    });

    it('still renders an item when hydration returns nothing for it', async () => {
        const body = await callGet([makeRow()], new Map());
        const [item] = body.items as Array<WatchlistTestItem>;

        expect(item.id).toBe(UUID);
        expect(item.title).toBe('The Lantern');
        expect(WatchlistItemSchema.safeParse(item).success).toBe(true);
    });

    it('hydrates in ONE batched call, not per item', async () => {
        await callGet([makeRow(), makeRow({ media_id: '99999999-2222-4333-a444-555555555555' })]);

        expect(mockGetMediaRailMetadataBatch).toHaveBeenCalledTimes(1);
    });

    it('resolves watched state in ONE batched call, not per item', async () => {
        await callGet([makeRow(), makeRow({ media_id: '99999999-2222-4333-a444-555555555555' })]);

        expect(mockBatchGetWatchedState).toHaveBeenCalledTimes(1);
        // Scoped to the caller, over exactly the rows being returned.
        const [, userId, mediaIds] = mockBatchGetWatchedState.mock.calls[0];
        expect(userId).toBe('user-1');
        expect(mediaIds).toEqual([UUID, '99999999-2222-4333-a444-555555555555']);
    });

    it('emits watched=false and unknown playback progress without stored state', async () => {
        const { items } = await callGet([makeRow()]);

        // Never undefined — the client must not have to distinguish "unwatched"
        // from "the server said nothing".
        expect(items[0].watched).toBe(false);
        expect(items[0].progress).toMatchObject({
            positionMs: null,
            fraction: null,
            finished: false,
            updatedAt: null,
        });
        expect(items[0].episodeProgress).toBeUndefined();
    });

    it('emits watched=true and finished progress for a watched movie', async () => {
        mockBatchGetWatchedState.mockResolvedValue(
            new Map([
                [
                    UUID,
                    { mediaId: UUID, watched: true, totalEpisodes: null, watchedEpisodes: null },
                ],
            ]),
        );

        const { items } = await callGet([makeRow()]);

        expect(items[0].watched).toBe(true);
        expect(items[0].progress).toMatchObject({ finished: true, fraction: 1 });
        expect(items[0].episodeProgress).toBeUndefined();
    });

    it('emits episode progress for a series alongside the watched flag', async () => {
        mockBatchGetWatchedState.mockResolvedValue(
            new Map([
                [UUID, { mediaId: UUID, watched: false, totalEpisodes: 10, watchedEpisodes: 4 }],
            ]),
        );

        const { items } = await callGet([makeRow({ media_type: 'tv' })]);

        expect(items[0].watched).toBe(false);
        expect(items[0].episodeProgress).toEqual({ watched: 4, total: 10 });
        expect(items[0].progress).toBeUndefined();
    });

    it('keeps a 0-of-N progress block rather than omitting it as falsy', async () => {
        mockBatchGetWatchedState.mockResolvedValue(
            new Map([
                [UUID, { mediaId: UUID, watched: false, totalEpisodes: 8, watchedEpisodes: 0 }],
            ]),
        );

        const { items } = await callGet([makeRow({ media_type: 'tv' })]);

        expect(items[0].episodeProgress).toEqual({ watched: 0, total: 8 });
    });

    it('satisfies the response contract with watched and progress present', async () => {
        mockBatchGetWatchedState.mockResolvedValue(
            new Map([
                [UUID, { mediaId: UUID, watched: true, totalEpisodes: 10, watchedEpisodes: 10 }],
            ]),
        );

        const { items } = await callGet([makeRow({ media_type: 'tv' })]);

        expect(() => WatchlistItemSchema.parse(items[0])).not.toThrow();
    });
});

describe('GET /watchlist — opt-in pagination + keyset cursor', () => {
    const UUID2 = '99999999-2222-4333-a444-555555555555';

    /** Invoke GET with an explicit URL (query params) and the given DB rows. */
    async function callGetUrl(rows: Array<Record<string, unknown>>, urlStr: string) {
        mockGetUserWatchlistMedia.mockResolvedValue(rows);
        mockGetMediaRailMetadataBatch.mockResolvedValue(
            new Map(rows.map((r) => [String(r.media_id), makeMeta({ mediaId: r.media_id })])),
        );
        const event = {
            locals: { user: { userId: 'user-1', username: 'denis' } },
            url: new URL(urlStr),
        } as unknown as RequestEvent;
        return def.handlers.GET!(event, {} as ApiContext);
    }

    it('full-list mode (no paging params) emits offset shape and NO cursor', async () => {
        const res = await callGetUrl([makeRow()], 'http://localhost/api/v1/watchlist');
        const body = (await res.json()) as { page: Record<string, unknown> };

        expect(body.page.offset).toBe(0);
        expect(body.page.hasMore).toBe(false);
        expect(body.page.nextCursor).toBeUndefined();
    });

    it('offset paging emits a J1 bootstrap cursor when more items remain', async () => {
        // limit=2 but the query returns 3 (the +1 look-ahead) → hasMore.
        const res = await callGetUrl(
            [makeRow(), makeRow({ media_id: UUID2, primary_ext_id: '604' }), makeRow()],
            'http://localhost/api/v1/watchlist?limit=2',
        );
        const body = (await res.json()) as {
            items: unknown[];
            page: Record<string, unknown>;
        };

        expect(body.items.length).toBe(2);
        expect(body.page.offset).toBe(0);
        expect(body.page.hasMore).toBe(true);
        // J1: offset response carries a forward cursor, tagged for this feed.
        expect(typeof body.page.nextCursor).toBe('string');
        expect(body.page.nextCursor as string).toMatch(/^wl:/);
    });

    it('cursor mode drops offset (Gate C) and continues the keyset', async () => {
        // Obtain a real, valid cursor from a J1 bootstrap response first.
        const bootstrap = await callGetUrl(
            [makeRow(), makeRow({ media_id: UUID2, primary_ext_id: '604' }), makeRow()],
            'http://localhost/api/v1/watchlist?limit=2',
        );
        const cursor = ((await bootstrap.json()) as { page: { nextCursor: string } }).page
            .nextCursor;

        const res = await callGetUrl(
            [makeRow(), makeRow({ media_id: UUID2, primary_ext_id: '604' }), makeRow()],
            `http://localhost/api/v1/watchlist?limit=2&cursor=${encodeURIComponent(cursor)}`,
        );
        const body = (await res.json()) as { items: unknown[]; page: Record<string, unknown> };

        expect(body.items.length).toBe(2);
        expect(body.page.hasMore).toBe(true);
        // Gate C: no offset in cursor mode.
        expect('offset' in body.page).toBe(false);
        expect(body.page.nextCursor as string).toMatch(/^wl:/);

        // The query was called in cursor mode (pagination carries a cursor, no offset).
        const lastCall = mockGetUserWatchlistMedia.mock.calls.at(-1)!;
        const pagination = lastCall[3] as Record<string, unknown>;
        expect(pagination.cursor).toBeDefined();
        expect(pagination.offset).toBeUndefined();
    });

    it('rejects a malformed cursor with 400 rather than a silently-empty page', async () => {
        const res = await callGetUrl(
            [makeRow()],
            'http://localhost/api/v1/watchlist?cursor=not-a-real-cursor',
        );
        expect(res.status).toBe(422);
    });

    it('rejects a foreign-feed cursor (wrong tag) with 400', async () => {
        // A validly-encoded cursor from another feed (e.g. 'sv:' series) must not
        // decode-and-run here.
        const foreign = 'sv:' + Buffer.from('2026-07-01:x', 'utf-8').toString('base64url');
        const res = await callGetUrl(
            [makeRow()],
            `http://localhost/api/v1/watchlist?cursor=${encodeURIComponent(foreign)}`,
        );
        expect(res.status).toBe(422);
    });
});

describe('POST/DELETE /watchlist — mediaType: audiobook', () => {
    // Regression guard for the reported gap: `mediaType: 'audiobook'` used to
    // 422 at the Zod boundary before any handler code ran ("Invalid option:
    // expected one of \"movie\"|\"series\"|\"tv\"").
    const AUDIOBOOK_UUID = '99999999-8888-7777-6666-555555555555';

    it("mount()'s request.body schema accepts mediaType: 'audiobook' without validation error", () => {
        const parsed = def.request!.body!.parse({
            externalIds: { internal: AUDIOBOOK_UUID },
            mediaType: 'audiobook',
            title: 'A Book',
        });
        expect(parsed).toMatchObject({ mediaType: 'audiobook' });
    });

    it("mount()'s request.body schema accepts the snake_case media_type variant too", () => {
        const parsed = def.request!.body!.parse({
            externalIds: { internal: AUDIOBOOK_UUID },
            media_type: 'audiobook',
        });
        expect(parsed).toMatchObject({ mediaType: 'audiobook' });
    });

    // The handler's own 'series' → 'tv' normalization ternary (POST/DELETE) is
    // exercised end-to-end, with mediaType passthrough for 'audiobook' verified,
    // at the WatchlistManager level (watchlist-manager.service.test.ts) — that
    // suite already isolates resolve-and-gate's dependencies, which the real
    // module pulls in transitively (media-access → plugin/task registry) far
    // beyond what this file's lighter GET-focused mocks cover.
});

describe('watchlist playback state', () => {
    it.each(['movie', 'episode', 'audiobook'])(
        'reports milliseconds separately from episode counts for %s',
        async (media_type) => {
            mockPlaybackStates.mockResolvedValue([
                {
                    media_id: UUID,
                    resume_position_ms: '90000',
                    runtime_ms: '180000',
                    is_watched: false,
                    last_event_at: '2026-10-17T10:00:00Z',
                },
            ]);
            const { items } = await callGet([makeRow({ media_type })]);
            expect(items[0].progress).toEqual({
                positionMs: 90000,
                durationMs: 180000,
                fraction: 0.5,
                finished: false,
                updatedAt: '2026-10-17T10:00:00Z',
            });
            expect(items[0].episodeProgress).toBeUndefined();
            expect(WatchlistItemSchema.safeParse(items[0]).success).toBe(true);
        },
    );
});
