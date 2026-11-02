// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for catalog/series/seasons.ts and catalog/series/episodes.ts.
 *
 * These tests cover the def-layer structure invariants and the "pin the current
 * page contract" behaviour documented in the gap audit:
 *
 *   - seasons.ts returns all seasons; episodes.ts uses real limit/offset paging.
 *   - Episode previews expose context, descriptors, availability and progress.
 *   - watch-status.ts mirrors the same shape.
 *   - next-episode.ts returns a single Episode node (not a collection).
 *
 * All heavy dependencies (db, queries, access) are mocked so tests run without
 * a real database.
 */

import { describe, it, expect, vi } from 'vitest';

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
            ) =>
                new Map(items.map((item) => [item.id, imageSet(surface, item.id, item.mediaType)])),
        ),
    };
});

// ---------------------------------------------------------------------------
// Import the defs directly — only auth + handler keys are inspected here.
// Handler bodies for the contract-pin tests are exercised below via mocks.
// ---------------------------------------------------------------------------

import { def as seasonsDef } from './seasons.js';
import { def as episodesDef } from './episodes.js';
import { def as nextEpisodeDef } from './next-episode.js';
import { def as watchStatusDef } from './watch-status.js';

// ---------------------------------------------------------------------------
// Shared type helpers
// ---------------------------------------------------------------------------

type AuthSpec = { kind: string };

function authKind(def: { auth: AuthSpec | Record<string, AuthSpec> }): string {
    if (typeof def.auth === 'object' && 'kind' in def.auth) {
        return (def.auth as AuthSpec).kind;
    }
    return '';
}

// ---------------------------------------------------------------------------
// Def structure tests
// ---------------------------------------------------------------------------

describe('seasonsDef structure', () => {
    it('declares auth kind = user', () => {
        expect(authKind(seasonsDef)).toBe('user');
    });

    it('has a GET handler', () => {
        expect(typeof seasonsDef.handlers.GET).toBe('function');
    });

    it('does NOT have a POST handler', () => {
        expect(seasonsDef.handlers.POST).toBeUndefined();
    });
});

describe('episodesDef structure', () => {
    it('declares auth kind = user', () => {
        expect(authKind(episodesDef)).toBe('user');
    });

    it('has a GET handler', () => {
        expect(typeof episodesDef.handlers.GET).toBe('function');
    });

    it('does NOT have a POST handler', () => {
        expect(episodesDef.handlers.POST).toBeUndefined();
    });
});

describe('nextEpisodeDef structure', () => {
    it('declares auth kind = user', () => {
        expect(authKind(nextEpisodeDef)).toBe('user');
    });

    it('has a GET handler', () => {
        expect(typeof nextEpisodeDef.handlers.GET).toBe('function');
    });
});

describe('watchStatusDef structure', () => {
    it('declares auth kind = user', () => {
        expect(authKind(watchStatusDef)).toBe('user');
    });

    it('has a GET handler', () => {
        expect(typeof watchStatusDef.handlers.GET).toBe('function');
    });
});

// ---------------------------------------------------------------------------
// Contract-pin tests: page shape emitted by seasons.ts and episodes.ts
//
// Both defs currently return ALL rows in one call and emit a synthetic page
// block: { limit: items.length, offset: 0, hasMore: false, total: items.length }.
// The tests below pin this behaviour so a regression (e.g. dropping offset:0
// or accidentally setting hasMore:true) is caught by CI without a DB.
//
// All DB-touching imports are mocked so these tests remain unit-level.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}), // non-null sentinel — handlers check `if (!sql)`
    getTaskDb: () => ({}),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    // Grant access unconditionally for unit tests.
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));

// C8 fix (task 4): the handler now derives a MediaAccessBoundary to pass to
// getSeasonsByInternalId (mocked below, so the boundary's contents don't
// affect FAKE_SEASON_ROWS). Real buildSearchAccessContext queries
// library_group_permissions via a real sql tag, which the `{}` sentinel from
// the connection mock above cannot satisfy — mock it out like every other
// DB-touching dependency in this unit-level test file.
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn().mockResolvedValue({
        username: 'test-user',
        deniedGroupIds: null,
        ageRating: null,
        liveTvAllowed: false,
        showUnavailableMedia: false,
    }),
    searchAccessBoundary: vi
        .fn()
        .mockReturnValue({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));

vi.mock('./resolve-series-id.js', () => ({
    resolveSeriesId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
    isUuid: vi.fn().mockReturnValue(true),
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn().mockResolvedValue('test-user-uuid'),
}));

// FAKE_SEASON_ROWS referenced inside vi.mock factory — must be inline (factories
// are hoisted before const initialisers, so top-level consts cannot be referenced).
// Keep the array here for assertion use after the mock is set up.
const FAKE_SEASON_ROWS = [
    {
        id: 'season-1-uuid',
        season_number: 1,
        name: 'Season 1',
        overview: null,
        premiere_date: null,
        episode_count: 3,
        watched_count: 0,
    },
    {
        id: 'season-2-uuid',
        season_number: 2,
        name: 'Season 2',
        overview: null,
        premiere_date: null,
        episode_count: 5,
        watched_count: 2,
    },
];

vi.mock('$lib/server/database/queries/season-detail.queries.js', () => ({
    getSeriesOrdering: vi.fn().mockResolvedValue('standard'),
    hasNonStandardOrdering: vi.fn().mockResolvedValue(false),
    getOrderingSeasons: vi.fn().mockResolvedValue([]),
    getUnmappedPhysicalSeasons: vi.fn().mockResolvedValue([]),
    // Inline the two rows to avoid the hoisting TDZ issue.
    getSeasonsByInternalId: vi.fn().mockResolvedValue([
        {
            id: 'season-1-uuid',
            season_number: 1,
            name: 'Season 1',
            overview: null,
            premiere_date: null,
            episode_count: 3,
            watched_count: 0,
        },
        {
            id: 'season-2-uuid',
            season_number: 2,
            name: 'Season 2',
            overview: null,
            premiere_date: null,
            episode_count: 5,
            watched_count: 2,
        },
    ]),
}));

vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSets: vi.fn(
        async (_sql: unknown, surface: 'v1' | 'internal', items: { id: string }[]) => {
            const { buildImageSet } = await import('$lib/shared/image-descriptor.js');
            return new Map(
                items.map(({ id }) => [
                    id,
                    buildImageSet(surface, {
                        poster: { ownerId: id, urlRole: 'poster', source: 'self', revision: '1' },
                        thumb: { ownerId: id, urlRole: 'thumb', source: 'self', revision: '1' },
                    }),
                ]),
            );
        },
    ),
}));

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaNavContext: vi.fn(),
    getExternalIdsByMediaId: vi.fn().mockResolvedValue([]),
    buildExternalIdsObject: vi.fn().mockReturnValue({}),
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    mergeExternalIds: vi.fn().mockImplementation((_a: unknown, b: unknown) => b),
    createExternalIds: vi.fn().mockImplementation((ids: Record<string, string>) => ids),
}));

const FAKE_EPISODE_ROWS = [
    {
        id: 'ep-1-uuid',
        jellyfin_id: null,
        primary_ext_id: null,
        imdb_id: null,
        title: 'Pilot',
        overview: null,
        season_number: 1,
        episode_number: 1,
        episode_number_end: null,
        premiere_date: null,
        runtime_seconds: 2700,
        runtime_ms: null,
        is_watched: false,
        resume_position_ms: null,
        last_watched_at: null,
        has_file: true,
        audio_languages: [],
        subtitle_languages: [],
        segments: null,
    },
    {
        id: 'ep-2-uuid',
        jellyfin_id: null,
        primary_ext_id: null,
        imdb_id: null,
        title: 'Episode 2',
        overview: null,
        season_number: 1,
        episode_number: 2,
        episode_number_end: null,
        premiere_date: null,
        runtime_seconds: 2700,
        runtime_ms: null,
        is_watched: true,
        resume_position_ms: null,
        last_watched_at: null,
        has_file: true,
        audio_languages: [],
        subtitle_languages: [],
        segments: null,
    },
];

// The episode list resolves durations through the batch query; the fake sql above
// cannot run it, and these tests do not assert durations.
vi.mock('$lib/server/database/queries/media-items.queries.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        findPlaybackDurationsMs: vi.fn(async () => new Map<string, number>()),
    };
});

vi.mock('$lib/server/database/queries/episode-detail.queries.js', () => ({
    // Inline rows to avoid the hoisting TDZ issue with FAKE_EPISODE_ROWS.
    getSeriesEpisodesWithWatchState: vi.fn().mockResolvedValue([
        {
            ordering: 'standard',
            series_id: '11111111-1111-4111-8111-111111111111',
            series_name: 'Example',
            season_id: 'season-1-uuid',
            id: 'ep-1-uuid',
            jellyfin_id: null,
            primary_ext_id: null,
            imdb_id: null,
            title: 'Pilot',
            overview: null,
            season_number: 1,
            episode_number: 1,
            episode_number_end: null,
            premiere_date: null,
            runtime_seconds: 2700,
            runtime_ms: null,
            is_watched: false,
            resume_position_ms: null,
            last_watched_at: null,
            has_file: true,
            audio_languages: [],
            subtitle_languages: [],
            segments: null,
        },
        {
            ordering: 'standard',
            series_id: '11111111-1111-4111-8111-111111111111',
            series_name: 'Example',
            season_id: 'season-1-uuid',
            id: 'ep-2-uuid',
            jellyfin_id: null,
            primary_ext_id: null,
            imdb_id: null,
            title: 'Episode 2',
            overview: null,
            season_number: 1,
            episode_number: 2,
            episode_number_end: null,
            premiere_date: null,
            runtime_seconds: 2700,
            runtime_ms: null,
            is_watched: true,
            resume_position_ms: null,
            last_watched_at: null,
            has_file: true,
            audio_languages: [],
            subtitle_languages: [],
            segments: null,
        },
    ]),
}));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: vi.fn().mockReturnValue('tmdb'),
}));

vi.mock('$lib/server/utils/watch-constants.js', () => ({
    isEffectivelyWatched: vi
        .fn()
        .mockImplementation((ep: { is_watched?: boolean }) => Boolean(ep.is_watched)),
}));

// ---------------------------------------------------------------------------
// Minimal fake RequestEvent factory
// ---------------------------------------------------------------------------

function fakeEvent(opts: {
    params?: Record<string, string>;
    searchParams?: Record<string, string>;
    userId?: string;
}): import('@sveltejs/kit').RequestEvent {
    const url = new URL(
        'http://localhost/api/v1/series/11111111-1111-4111-8111-111111111111/seasons',
    );
    for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
        url.searchParams.set(k, v);
    }
    return {
        url,
        request: new Request(url, { method: 'GET' }),
        params: opts.params ?? {},
        locals: {
            user: {
                userId: opts.userId ?? 'test-user-uuid',
                username: 'alice',
                ownerIsAdmin: false,
                isAgeRestricted: false,
            },
            resolvedIds: undefined,
        },
        route: { id: null },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: (fn: () => unknown) => fn(),
    } as unknown as import('@sveltejs/kit').RequestEvent;
}

const FAKE_CTX = { surface: 'v1' as const };

// ---------------------------------------------------------------------------
// seasons.ts — page contract pin
// ---------------------------------------------------------------------------

describe('seasonsDef GET — page contract (hasMore=false, offset=0, no real pagination)', () => {
    it('returns { items, page } envelope for a collection of seasons', async () => {
        const event = fakeEvent({ params: { id: '11111111-1111-4111-8111-111111111111' } });
        const res = await seasonsDef.handlers.GET!(event, FAKE_CTX);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            items: Array<Record<string, unknown>>;
            page: Record<string, unknown>;
        };
        expect(Array.isArray(body.items)).toBe(true);
        // Season 2 has no available episodes in the fixture, so the list leaves it out.
        expect(body.items.map((s) => s.id)).toEqual([FAKE_SEASON_ROWS[0].id]);
        expect(body.page).toMatchObject({
            limit: 1,
            offset: 0,
            hasMore: false,
            total: 1,
        });
    });

    it('each Season item has the canonical Season node shape', async () => {
        const event = fakeEvent({ params: { id: '11111111-1111-4111-8111-111111111111' } });
        const res = await seasonsDef.handlers.GET!(event, FAKE_CTX);
        const body = (await res.json()) as { items: Array<Record<string, unknown>> };
        const first = body.items[0];
        expect(first.type).toBe('season');
        expect(typeof first.id).toBe('string');
        expect(typeof first.seasonNumber).toBe('number');
        expect(typeof first.title).toBe('string');
        expect(typeof first.episodeCount).toBe('number');
        // ids{} map
        expect(first).toHaveProperty('ids');
        expect(typeof first.ids).toBe('object');
        // images{} node
        expect(first).toHaveProperty('images');
        const images = first.images as Record<string, Record<string, unknown>>;
        expect(images.poster).toBeDefined();
        expect(typeof images.poster.href).toBe('string');
        expect(typeof (images.poster.variants as Record<string, unknown>).thumb).toBe('string');
        // series.href deep-link
        expect(first).toHaveProperty('series');
        const series = first.series as Record<string, unknown>;
        expect(typeof series.href).toBe('string');
        // episodes.href deep-link
        expect(first).toHaveProperty('episodes');
        const episodes = first.episodes as Record<string, unknown>;
        expect(typeof episodes.href).toBe('string');
    });

    it('returns a single Season node (not a collection) for a single-season-by-number call', async () => {
        // seasonParam = '1' → handler finds the matching node and returns it bare
        const event = fakeEvent({
            params: { id: '11111111-1111-4111-8111-111111111111', n: '1' },
            searchParams: {},
        });
        const res = await seasonsDef.handlers.GET!(event, FAKE_CTX);
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        // Bare node — NOT { items, page }
        expect(body).not.toHaveProperty('items');
        expect(body).not.toHaveProperty('page');
        expect(body.type).toBe('season');
        expect(body.seasonNumber).toBe(1);
    });

    it('returns 404 for a missing season number', async () => {
        const event = fakeEvent({
            params: { id: '11111111-1111-4111-8111-111111111111', n: '99' },
        });
        const res = await seasonsDef.handlers.GET!(event, FAKE_CTX);
        expect(res.status).toBe(404);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.code).toBe('not_found');
        expect(res.headers.get('content-type')).toContain('application/problem+json');
    });

    it('returns 422 for a non-integer season number', async () => {
        const event = fakeEvent({
            params: { id: '11111111-1111-4111-8111-111111111111', n: 'abc' },
        });
        const res = await seasonsDef.handlers.GET!(event, FAKE_CTX);
        expect(res.status).toBe(422);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.code).toBe('validation_failed');
        expect(res.headers.get('content-type')).toContain('application/problem+json');
    });
});

// ---------------------------------------------------------------------------
// episodes.ts — page contract pin
// ---------------------------------------------------------------------------

describe('episodesDef GET — paged MediaPreview contract', () => {
    it('returns { items, page } envelope', async () => {
        const event = fakeEvent({ params: { id: '11111111-1111-4111-8111-111111111111' } });
        const res = await episodesDef.handlers.GET!(event, FAKE_CTX);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            items: Array<Record<string, unknown>>;
            page: Record<string, unknown>;
        };
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.items).toHaveLength(FAKE_EPISODE_ROWS.length);
        expect(body.page).toMatchObject({
            limit: 50,
            offset: 0,
            hasMore: false,
        });
    });

    it('episode items have the canonical Episode node shape (no legacy success/episodes wrapper)', async () => {
        const event = fakeEvent({ params: { id: '11111111-1111-4111-8111-111111111111' } });
        const res = await episodesDef.handlers.GET!(event, FAKE_CTX);
        const body = (await res.json()) as {
            items: Array<Record<string, unknown>>;
            page: Record<string, unknown>;
        };
        // Redesign contract: bare { items, page }, no success:true or episodes[].
        expect(body).not.toHaveProperty('success');
        expect(body).not.toHaveProperty('episodes');
        const ep = body.items[0];
        expect(ep.type).toBe('episode');
        expect(typeof ep.id).toBe('string');
        expect(ep).toHaveProperty('ids');
        expect(typeof ep.ids).toBe('object');
        // images{} node — package 10 thumb descriptor
        expect(ep).toHaveProperty('images');
        const images = ep.images as Record<string, Record<string, unknown>>;
        expect(images.thumb).toBeDefined();
        expect(typeof images.thumb.href).toBe('string');
        expect(ep).toHaveProperty('title');
        expect(ep).toHaveProperty('context.seasonNumber');
        expect(ep).toHaveProperty('context.episodeNumber');
        // series.href deep-link
        expect(ep).toHaveProperty('context.series.id');
        expect(ep).toHaveProperty('progress');
        expect(ep).toHaveProperty('availability.hasFile');
    });
});

// ---------------------------------------------------------------------------
// Cross-surface hrefs — seasons.ts / episodes.ts must emit SAME-SURFACE
// deep-links (a session client on the internal surface must not be handed a
// '/api/v1/...' href, which requires bearer auth and would 401).
// ---------------------------------------------------------------------------

const FAKE_CTX_INTERNAL = { surface: 'internal' as const };

describe('seasonsDef GET — cross-surface hrefs', () => {
    it('emits /api/v1/series/... hrefs when mounted on the v1 surface', async () => {
        const event = fakeEvent({ params: { id: '11111111-1111-4111-8111-111111111111' } });
        const res = await seasonsDef.handlers.GET!(event, FAKE_CTX);
        const body = (await res.json()) as { items: Array<Record<string, unknown>> };
        const first = body.items[0];
        const series = first.series as Record<string, unknown>;
        const episodes = first.episodes as Record<string, unknown>;
        expect(series.href).toBe('/api/v1/series/11111111-1111-4111-8111-111111111111');
        expect(episodes.href).toContain(
            '/api/v1/series/11111111-1111-4111-8111-111111111111/episodes',
        );
    });

    it('emits /api/series/... (no v1 prefix) hrefs when mounted on the internal surface', async () => {
        const event = fakeEvent({ params: { id: '11111111-1111-4111-8111-111111111111' } });
        const res = await seasonsDef.handlers.GET!(event, FAKE_CTX_INTERNAL);
        const body = (await res.json()) as { items: Array<Record<string, unknown>> };
        const first = body.items[0];
        const series = first.series as Record<string, unknown>;
        const episodes = first.episodes as Record<string, unknown>;
        expect(series.href).toBe('/api/series/11111111-1111-4111-8111-111111111111');
        expect(episodes.href).toContain(
            '/api/series/11111111-1111-4111-8111-111111111111/episodes',
        );
    });
});

describe('episodesDef GET — cross-surface hrefs', () => {
    it('emits /api/v1/series/... hrefs when mounted on the v1 surface', async () => {
        const event = fakeEvent({ params: { id: '11111111-1111-4111-8111-111111111111' } });
        const res = await episodesDef.handlers.GET!(event, FAKE_CTX);
        const body = (await res.json()) as { items: Array<Record<string, unknown>> };
        const images = body.items[0].images as { thumb: { href: string } };
        expect(images.thumb.href).toContain('/api/v1/media/');
    });

    it('emits /api/series/... (no v1 prefix) hrefs when mounted on the internal surface', async () => {
        const event = fakeEvent({ params: { id: '11111111-1111-4111-8111-111111111111' } });
        const res = await episodesDef.handlers.GET!(event, FAKE_CTX_INTERNAL);
        const body = (await res.json()) as { items: Array<Record<string, unknown>> };
        const images = body.items[0].images as { thumb: { href: string } };
        expect(images.thumb.href).toContain('/api/media/');
    });
});

// ---------------------------------------------------------------------------
// Season ids are internal UUIDs (no Jellyfin ids)
// ---------------------------------------------------------------------------

describe('seasonsDef GET — virtual seasons (non-standard ordering)', () => {
    it('uses virtual handles for every logical season', async () => {
        const queries = await import('$lib/server/database/queries/season-detail.queries.js');
        const physical = '7b1f2a3c-4d5e-4f60-8a71-92b3c4d5e6f7';
        vi.mocked(queries.getSeriesOrdering).mockResolvedValueOnce('dvd');
        const { getSeriesEpisodesWithWatchState } =
            await import('$lib/server/database/queries/episode-detail.queries.js');
        vi.mocked(getSeriesEpisodesWithWatchState).mockResolvedValueOnce([
            { ...FAKE_EPISODE_ROWS[0], ordering: 'dvd', season_number: 1 },
            { ...FAKE_EPISODE_ROWS[1], ordering: 'dvd', season_number: 2 },
        ] as never);
        vi.mocked(queries.getOrderingSeasons).mockResolvedValueOnce([
            {
                season_number: 1,
                episode_count: 2,
                watched_count: 0,
                physical_season_id: physical,
                image_tag: null,
            },
            {
                season_number: 2,
                episode_count: 1,
                watched_count: 0,
                physical_season_id: null,
                image_tag: null,
            },
        ]);
        vi.mocked(queries.getUnmappedPhysicalSeasons).mockResolvedValueOnce([]);

        const event = fakeEvent({ params: { id: '11111111-1111-4111-8111-111111111111' } });
        const res = await seasonsDef.handlers.GET!(event, FAKE_CTX);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ id: string; ids: object }> };

        expect(body.items.map((s) => s.id)).toEqual([
            'vseason:11111111-1111-4111-8111-111111111111:dvd:1',
            'vseason:11111111-1111-4111-8111-111111111111:dvd:2',
        ]);
        for (const s of body.items) expect(s.ids).not.toHaveProperty('jellyfin');
    });

    it('keeps virtual seasons unique when they share a physical season', async () => {
        const queries = await import('$lib/server/database/queries/season-detail.queries.js');
        const physical = '7b1f2a3c-4d5e-4f60-8a71-92b3c4d5e6f7';
        vi.mocked(queries.getSeriesOrdering).mockResolvedValueOnce('dvd');
        const { getSeriesEpisodesWithWatchState } =
            await import('$lib/server/database/queries/episode-detail.queries.js');
        vi.mocked(getSeriesEpisodesWithWatchState).mockResolvedValueOnce([
            { ...FAKE_EPISODE_ROWS[0], ordering: 'dvd', season_number: 1 },
            { ...FAKE_EPISODE_ROWS[1], ordering: 'dvd', season_number: 2 },
        ] as never);
        vi.mocked(queries.getOrderingSeasons).mockResolvedValueOnce([
            {
                season_number: 1,
                episode_count: 1,
                watched_count: 0,
                physical_season_id: physical,
                image_tag: null,
            },
            {
                season_number: 2,
                episode_count: 1,
                watched_count: 0,
                physical_season_id: physical,
                image_tag: null,
            },
        ]);
        vi.mocked(queries.getUnmappedPhysicalSeasons).mockResolvedValueOnce([]);

        const event = fakeEvent({ params: { id: '11111111-1111-4111-8111-111111111111' } });
        const res = await seasonsDef.handlers.GET!(event, FAKE_CTX);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ id: string }> };

        expect(body.items.map((s) => s.id)).toEqual([
            'vseason:11111111-1111-4111-8111-111111111111:dvd:1',
            'vseason:11111111-1111-4111-8111-111111111111:dvd:2',
        ]);
    });
});

describe('episodesDef paging and direct coordinates', () => {
    it('passes validated limit, offset and specials to the query', async () => {
        const queries = await import('$lib/server/database/queries/episode-detail.queries.js');
        const event = fakeEvent({
            params: { id: '11111111-1111-4111-8111-111111111111' },
            searchParams: { limit: '1', offset: '2', specials: 'exclude' },
        });
        const response = await episodesDef.handlers.GET!(event, FAKE_CTX);
        expect(queries.getSeriesEpisodesWithWatchState).toHaveBeenLastCalledWith(
            expect.anything(),
            '11111111-1111-4111-8111-111111111111',
            expect.anything(),
            undefined,
            expect.objectContaining({ limit: 2, offset: 2, specials: 'exclude' }),
        );
        expect((await response.json()).page).toMatchObject({ limit: 1, offset: 2, hasMore: true });
    });
    it('returns one preview for direct lookup, with combined span context', async () => {
        const queries = await import('$lib/server/database/queries/episode-detail.queries.js');
        vi.mocked(queries.getSeriesEpisodesWithWatchState).mockResolvedValueOnce([
            {
                ...FAKE_EPISODE_ROWS[0],
                ordering: 'standard',
                series_id: '11111111-1111-4111-8111-111111111111',
                season_id: 'season-2',
                season_number: 2,
                episode_number: 4,
                episode_number_end: 5,
            },
        ] as never);
        const response = await episodesDef.handlers.GET!(
            fakeEvent({
                params: {
                    id: '11111111-1111-4111-8111-111111111111',
                    n: '2',
                    e: '5',
                },
            }),
            FAKE_CTX,
        );
        const body = await response.json();
        expect(body).not.toHaveProperty('items');
        expect(body.context).toMatchObject({
            seasonNumber: 2,
            episodeNumber: 4,
            endEpisodeNumber: 5,
        });
        expect(queries.getSeriesEpisodesWithWatchState).toHaveBeenLastCalledWith(
            expect.anything(),
            '11111111-1111-4111-8111-111111111111',
            expect.anything(),
            2,
            expect.objectContaining({ episode: 5 }),
        );
    });
    it('returns 404 for a missing direct coordinate', async () => {
        const queries = await import('$lib/server/database/queries/episode-detail.queries.js');
        vi.mocked(queries.getSeriesEpisodesWithWatchState).mockResolvedValueOnce([]);
        const response = await episodesDef.handlers.GET!(
            fakeEvent({
                params: {
                    id: '11111111-1111-4111-8111-111111111111',
                    n: '2',
                    e: '9',
                },
            }),
            FAKE_CTX,
        );
        expect(response.status).toBe(404);
    });
});

describe('episode collection artwork batching', () => {
    it('resolves the whole page once and emits thumb descriptors without still aliases', async () => {
        const { resolveImageSets } = await import('$lib/server/services/image-descriptor/index.js');
        vi.mocked(resolveImageSets).mockClear();
        const response = await episodesDef.handlers.GET!(
            fakeEvent({ params: { id: 'test-series-uuid' } }),
            FAKE_CTX,
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            items: Array<{
                id: string;
                images: import('$lib/schemas/api-image-descriptor.js').ImageSet;
            }>;
        };
        expect(resolveImageSets).toHaveBeenCalledTimes(1);
        expect(vi.mocked(resolveImageSets).mock.calls[0][2]).toEqual(
            body.items.map(({ id }) => ({ id, mediaType: 'episode' })),
        );
        for (const item of body.items) {
            expect(item.images).not.toHaveProperty('still');
            expect(item.images.thumb).toMatchObject({ source: 'self', revision: '1' });
            expect(item.images.thumb?.variants?.card).toContain('?size=card&v=1');
        }
    });
});
