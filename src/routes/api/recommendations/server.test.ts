// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Smoke tests for GET /api/recommendations (the internal BFF surface mounted
 * from this route's +server.ts).
 *
 * These exercise the route's dispatch + response shaping — NOT the suggestion
 * engine internals (which live in suggestion-engine.service.ts and have their
 * own unit tests). All external I/O (database, access context, caches, watch
 * manager, rate limiter) is mocked at the module boundary, mirroring
 * api/defs/recommendations/feed.test.ts.
 *
 * Covered:
 *   - type=movies happy path returns the mapped library shape.
 *   - unknown type → validation problem (422), never a 500.
 *
 * (The legacy type=ai branch — and its suggestion-engine/embeddings mocks —
 * was removed with the route branch itself; see AI recs redesign Plan 3
 * Task 5. The taste rail's equivalent coverage lives in
 * src/lib/server/api/defs/for-you/taste.integration.test.ts.)
 *
 * NOTE: named server.test.ts (NOT +server.test.ts) — the `+` prefix is reserved
 * by SvelteKit for route files and breaks the vite build if used on tests.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ---------------------------------------------------------------------------
// Shared mutable mock state (hoisted so vi.mock factories can close over it)
// ---------------------------------------------------------------------------

const mockGetDb = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockGetQualityLibraryMedia = vi.fn();

// ---------------------------------------------------------------------------
// Module mocks — declared before importing the route module
// ---------------------------------------------------------------------------

// Rate-limit wrapper → identity passthrough so we test mount + handler only
// (no Valkey dependency).
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    withAISuggestionRateLimit: (handler: unknown) => handler,
}));

// getEffectiveUser → always the authenticated username so effectiveUserId
// resolves to locals.user.userId (no getUserIdByUsername round-trip).
vi.mock('$lib/server/dev-user.js', () => ({
    getEffectiveUser: () => 'alice',
}));

// Preserve real config named exports (mount's auth chain reads feature flags at
// load); only DEFAULT_USER is consulted by the route.
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual };
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

// Cache namespaces + a stub cache for every .for() call at module load.
vi.mock('$lib/server/cache', () => {
    const makeCacheStub = () => ({
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        deleteUserCache: vi.fn().mockResolvedValue(undefined),
    });
    return {
        cacheManager: { for: () => makeCacheStub() },
        CACHE_NAMESPACES: {
            heroNextUp: 'hero-nextup',
        },
    };
});

vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        getNextUp: vi.fn().mockResolvedValue([]),
        getContinueWatching: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    searchAccessBoundary: () => ({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));

vi.mock('$lib/server/database/queries/hero-fallback.queries.js', () => ({
    getQualityLibraryMedia: (...args: unknown[]) => mockGetQualityLibraryMedia(...args),
}));

vi.mock('$lib/server/database/queries/watch-history.queries.js', () => ({
    hasUserWatchActivitySince: { check: vi.fn().mockResolvedValue(false) },
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import the route module AFTER mocks are declared
// ---------------------------------------------------------------------------

const { GET } = await import('./+server.js');
const { watchManager } = await import('$lib/server/services/watch-manager.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'usr_00000000-0000-0000-0000-000000000001';

function makeEvent(searchParams: Record<string, string> = {}): RequestEvent {
    const url = new URL('http://localhost/api/recommendations');
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
    return {
        url,
        params: {},
        route: { id: '/api/recommendations' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: USER_ID,
                username: 'alice',
                groups: '',
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

async function callGet(searchParams: Record<string, string> = {}) {
    const res = await GET!(makeEvent(searchParams));
    const body = await res.clone().json();
    return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();

    mockGetDb.mockReturnValue({});
    mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
});

// ---------------------------------------------------------------------------
// type=movies — library happy path
// ---------------------------------------------------------------------------

describe('GET /api/recommendations?type=movies', () => {
    test('returns the mapped library shape', async () => {
        mockGetQualityLibraryMedia.mockResolvedValue([
            {
                tmdb_id: 603,
                jellyfin_id: 'jf-1',
                internal_id: 'uuid-9',
                media_type: 'movie',
                title: 'The Lantern',
                release_year: 1999,
                overview: 'Neo',
                genres: [28, 878],
                imdb_rating: 8.7,
                tmdb_rating: 8.2,
                is_available: true,
                can_request: false,
                trailer_url: null,
            },
        ]);

        const { status, body } = await callGet({ type: 'movies', limit: '5' });

        expect(status).toBe(200);
        expect(body.items).toHaveLength(1);
        expect(body.items[0].title).toBe('The Lantern');
        expect(body.items[0].mediaType).toBe('movie');
        expect(body.items[0].isAvailable).toBe(true);
        expect(body.items[0].externalIds).not.toHaveProperty('jellyfin');
        expect(body.items[0].externalIds.internal).toBe('uuid-9');
        expect(mockGetQualityLibraryMedia).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// unknown type — validation problem, not 500
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// type=continue — audiobook chapter/file list stripping
// ---------------------------------------------------------------------------

describe('GET /api/recommendations?type=continue', () => {
    test('strips chapters/audioFiles from an audiobook row but keeps authors/narrators', async () => {
        // One in-progress audiobook on prod carried 555 chapters + 555
        // audioFiles inside this same blob — the fixture below stands in for
        // that shape.
        const audiobookshelf = {
            chapters: [{ title: 'Chapter 1', start: 0 }],
            audioFiles: [{ ino: '1', filename: 'part1.mp3' }],
            authors: ['A. Author'],
            narrators: ['N. Narrator'],
        };
        vi.mocked(watchManager.getContinueWatching).mockResolvedValue([
            {
                media_id: 'ab1',
                media_type: 'audiobook',
                title: 'An Audiobook',
                overview: null,
                custom_metadata: { audiobookshelf },
                resume_position_ms: 1000,
                runtime_ms: 100_000,
                last_event_at: new Date().toISOString(),
                last_event_source: null,
                parent_id: null,
                series_id: null,
                series_name: null,
                season_number: null,
                episode_number: null,
                jellyfin_id: null,
                tmdb_id: null,
                imdb_id: null,
                series_jellyfin_id: null,
                sort_date: new Date().toISOString(),
            },
        ] as never);

        const { status, body } = await callGet({ type: 'continue' });

        expect(status).toBe(200);
        expect(body.items).toHaveLength(1);
        const shelf = body.items[0].customMetadata?.audiobookshelf;
        expect(shelf).toBeDefined();
        expect(shelf).not.toHaveProperty('chapters');
        expect(shelf).not.toHaveProperty('audioFiles');
        expect(shelf.authors).toEqual(['A. Author']);
        expect(shelf.narrators).toEqual(['N. Narrator']);
    });
});

describe('GET /api/recommendations?type=continue — internal ids', () => {
    test('an episode row carries the internal series id and backdrop, no Jellyfin id', async () => {
        vi.mocked(watchManager.getContinueWatching).mockResolvedValue([
            {
                media_id: 'ep-uuid',
                media_type: 'episode',
                title: 'Pilot',
                overview: null,
                custom_metadata: null,
                resume_position_ms: 1000,
                runtime_ms: 100_000,
                last_event_at: new Date().toISOString(),
                last_event_source: null,
                parent_id: 'season-uuid',
                series_id: 'series-uuid',
                series_name: 'A Show',
                season_number: 1,
                episode_number: 1,
                jellyfin_id: 'abcdef0123456789abcdef0123456789',
                tmdb_id: null,
                imdb_id: null,
                series_jellyfin_id: 'fedcba9876543210fedcba9876543210',
                sort_date: new Date().toISOString(),
            },
        ] as never);

        const { status, body } = await callGet({ type: 'continue' });

        expect(status).toBe(200);
        const item = body.items[0];
        expect(item.seriesId).toBe('series-uuid');
        expect(item.imageBackdropId).toBe('series-uuid');
        expect(item.externalIds).not.toHaveProperty('jellyfin');
    });
});

describe('GET /api/recommendations — unknown type', () => {
    test('an out-of-enum type yields a validation problem (422), not a 500', async () => {
        const { status, body } = await callGet({ type: 'bogus' });

        expect(status).toBe(422);
        expect(body.code).toBe('validation_failed');
        // No case handler must be reached for an invalid request.
        expect(mockGetQualityLibraryMedia).not.toHaveBeenCalled();
    });
});
