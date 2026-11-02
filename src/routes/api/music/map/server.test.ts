// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

/**
 * Unit tests for GET /api/music/map.
 *
 * NOTE: This file is named server.test.ts (NOT +server.test.ts) — the `+`
 * prefix is reserved by SvelteKit for route files and breaks the vite build
 * if used on test files.
 *
 * All heavy dependencies (db, config, cache, queries) are mocked so tests
 * run fast without a real database.
 */

import { describe, test, expect, vi, beforeEach, beforeAll } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mutable mock state
// ---------------------------------------------------------------------------

const mockFeatures = { musicMap: true };
const mockGetSql = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockScopedCacheKey = vi.fn();
const mockSearchAccessBoundary = vi.fn();
const mockGetMapPoints = vi.fn();
const mockCountMapCoords = vi.fn();
const mockCountSonicEmbeddingCoverage = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('$lib/server/config.js', () => ({
    config: {},
    features: mockFeatures,
    FEATURE_PER_TASK_QUEUES: false,
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: mockBuildSearchAccessContext,
    scopedCacheKey: mockScopedCacheKey,
    searchAccessBoundary: mockSearchAccessBoundary,
}));

vi.mock('$lib/server/database/queries/music-map.queries.js', () => ({
    getMapPoints: mockGetMapPoints,
    countMapCoords: mockCountMapCoords,
    countSonicEmbeddingCoverage: mockCountSonicEmbeddingCoverage,
}));

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({
            get: mockCacheGet,
            set: mockCacheSet,
        }),
    },
    CACHE_NAMESPACES: {
        musicMapPoints: { name: 'music-map-points-v1', l1TTL: 300000, l2TTL: 1800000 },
    },
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: unknown) => handler,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

vi.mock('$lib/server/middleware/feature-flag.js', () => ({
    requireFeature: (_flag: unknown) => (handler: unknown) => handler,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const fakeSql = vi.fn();
const UNRESTRICTED_ACCESS_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
};

/**
 * What `searchAccessBoundary(UNRESTRICTED_ACCESS_CTX)` returns. Mocked rather
 * than imported so this file keeps zero real dependencies.
 */
const UNRESTRICTED_BOUNDARY = {
    library: { kind: 'all' as const },
    age: { kind: 'any' as const },
};

function makeEvent(overrides: Record<string, unknown> = {}): unknown {
    return {
        locals: { user: { userId: 'user-1', username: 'alice', groups: [] } },
        url: new URL('http://localhost/api/music/map'),
        request: new Request('http://localhost/api/music/map'),
        params: {},
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Import the module under test after mocks are set up
// vi.mock() calls are hoisted above imports, so the module resolves with mocks.
// We import once via beforeAll to avoid per-test re-compilation overhead.
// ---------------------------------------------------------------------------

let GET: (event: unknown) => Promise<Response>;
beforeAll(async () => {
    const mod = await import('./+server.js');
    GET = mod.GET as (event: unknown) => Promise<Response>;
}, 60000);

beforeEach(() => {
    vi.resetAllMocks();
    mockGetSql.mockResolvedValue(fakeSql);
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_ACCESS_CTX);
    mockSearchAccessBoundary.mockReturnValue(UNRESTRICTED_BOUNDARY);
    mockScopedCacheKey.mockReturnValue('music-map-v1::');
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    // Default: table has data so the fast-empty-check doesn't short-circuit
    mockCountMapCoords.mockResolvedValue(1);
    mockCountSonicEmbeddingCoverage.mockResolvedValue({ embedded: 0, total: 0 });
    mockGetMapPoints.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/music/map', () => {
    test('returns 401 when no user', async () => {
        const event = makeEvent({ locals: { user: null } });
        const res = await GET(event);
        expect(res.status).toBe(401);
    });

    test('returns 5xx when DB unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await GET(makeEvent());
        expect(res.status).toBeGreaterThanOrEqual(500);
    });

    test('returns cached payload when cache hits', async () => {
        const cached = { points: [], hasCoords: false };
        mockCacheGet.mockResolvedValue(cached);

        const res = await GET(makeEvent());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject(cached);
        // Query should not have been called
        expect(mockGetMapPoints).not.toHaveBeenCalled();
    });

    test('returns empty payload when no coords', async () => {
        // Simulate empty projection table — fast-path short-circuit.
        // countMapCoords returning 0 means the projection hasn't run yet;
        // the route should return immediately without calling getMapPoints.
        mockCacheGet.mockResolvedValue(null); // ensure no stale cache hit
        mockCountMapCoords.mockImplementation(() => Promise.resolve(0));

        const res = await GET(makeEvent());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.points).toEqual([]);
        expect(body.hasCoords).toBe(false);
        // Fast-path: should NOT cache the empty result
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    test('returns points and caches when coords exist', async () => {
        const mapRows = [
            {
                media_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                x: 0.3,
                y: 0.7,
                title: 'Test Track',
                artist_title: 'Test Artist',
                top_mood: '"happy"',
                custom_poster_url: null,
            },
        ];
        mockGetMapPoints.mockResolvedValue(mapRows);

        const res = await GET(makeEvent());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.hasCoords).toBe(true);
        expect(body.points).toHaveLength(1);

        const pt = body.points[0];
        expect(pt.id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect(pt.x).toBeCloseTo(0.3);
        // Mood should have JSON quotes stripped
        expect(pt.topMood).toBe('happy');

        expect(mockCacheSet).toHaveBeenCalledOnce();
    });

    test('strips JSON quotes from top_mood field', async () => {
        const mapRows = [
            {
                media_id: 'test-uuid',
                x: 0.5,
                y: 0.5,
                title: 'Track',
                artist_title: null,
                top_mood: '"aggressive"',
                custom_poster_url: null,
            },
        ];
        mockGetMapPoints.mockResolvedValue(mapRows);

        const res = await GET(makeEvent());
        const body = await res.json();
        expect(body.points[0].topMood).toBe('aggressive');
    });

    test('handles null top_mood gracefully', async () => {
        const mapRows = [
            {
                media_id: 'test-uuid',
                x: 0.1,
                y: 0.9,
                title: 'No Mood Track',
                artist_title: 'Artist',
                top_mood: null,
                custom_poster_url: null,
            },
        ];
        mockGetMapPoints.mockResolvedValue(mapRows);

        const res = await GET(makeEvent());
        const body = await res.json();
        expect(body.points[0].topMood).toBeNull();
    });
});
