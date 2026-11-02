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
 * Unit tests for GET /api/music/sonic-mixes (the cluster listing).
 *
 * NOTE: This file is named server.test.ts (NOT +server.test.ts) — the `+`
 * prefix is reserved by SvelteKit for route files and breaks the vite build
 * if used on test files (even though svelte-check/eslint/vitest pass).
 *
 * All heavy dependencies (db, config, cache, queries) are mocked so tests
 * run fast without a real database.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Shared mutable mock state
// ---------------------------------------------------------------------------

const mockFeatures = { musicClusters: true };
const mockGetSql = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockScopedCacheKey = vi.fn();
const mockGetClusters = vi.fn();
const mockGetClusterMembers = vi.fn();
const mockClusterExists = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
    config: {},
    FEATURE_PER_TASK_QUEUES: false,
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

// `searchAccessBoundary` is deliberately NOT mocked: the route now projects the
// SearchAccessContext onto a required-by-shape MediaAccessBoundary before calling
// the query module, and the assertions below check the projected boundary. Stubbing
// it would make those assertions vacuous.
vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        buildSearchAccessContext: mockBuildSearchAccessContext,
        scopedCacheKey: mockScopedCacheKey,
        searchAccessBoundary: actual.searchAccessBoundary,
    };
});

vi.mock('$lib/server/database/queries/audio-clusters.queries.js', () => ({
    getClusters: mockGetClusters,
    getClusterMembers: mockGetClusterMembers,
    clusterExists: mockClusterExists,
    CLUSTER_MODEL_ID: 'msclap-2023',
}));

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({
            get: mockCacheGet,
            set: mockCacheSet,
        }),
    },
    CACHE_NAMESPACES: {
        musicClusters: { name: 'music-clusters-v1', l1TTL: 300000, l2TTL: 3600000 },
        musicClusterMembers: {
            name: 'music-cluster-members-v1',
            l1TTL: 300000,
            l2TTL: 1800000,
        },
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
    showUnavailableMedia: true,
};

function makeLocals(overrides: Record<string, unknown> = {}): App.Locals {
    return {
        user: {
            userId: 'user-uuid' as UserId,
            username: 'alice',
            groups: '',
            userGroups: [],
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            ownerIsAdmin: false,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: false,
            liveTvPriority: 'low',
        },
        ...overrides,
    } as Partial<App.Locals> as App.Locals;
}

function makeEvent(searchParams: Record<string, string> = {}, locals?: App.Locals): RequestEvent {
    const url = new URL('http://localhost/api/music/sonic-mixes');
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
    return {
        url,
        request: new Request(url),
        locals: locals ?? makeLocals(),
    } as Partial<RequestEvent> as RequestEvent;
}

function makeClusterRow(
    clusterId: number,
    label = `Cluster ${clusterId}`,
    trackCount = 10,
    topGenres: string[] = [],
    topArtists: string[] = [],
    coverMediaIds: string[] = [],
): Record<string, unknown> {
    return {
        cluster_id: clusterId,
        label,
        track_count: trackCount,
        top_genres: topGenres,
        top_artists: topArtists,
        cover_media_ids: coverMediaIds,
    };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();

    mockFeatures.musicClusters = true;
    mockGetSql.mockResolvedValue(fakeSql);
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_ACCESS_CTX);
    mockScopedCacheKey.mockReturnValue('scoped-key');
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockGetClusters.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/music/sonic-mixes — cluster listing', () => {
    test('returns 401 when user is not authenticated', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({}, makeLocals({ user: null }));
        const res = await GET!(event);
        expect(res.status).toBe(401);
    });

    test('returns 5xx when database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent());
        expect(res.status).toBeGreaterThanOrEqual(500);
    });

    test('returns 200 with empty items when no clustering has run', async () => {
        mockGetClusters.mockResolvedValue([]);
        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ items: [] });
    });

    test('returns mapped clusters on success, with a collage instead of coverMediaIds', async () => {
        const rows = [
            makeClusterRow(
                0,
                'Rock · Pop',
                15,
                ['Rock', 'Pop'],
                ['The Band'],
                ['cover-uuid-1', 'cover-uuid-2'],
            ),
            makeClusterRow(1, 'Aggressive', 8),
        ];
        mockGetClusters.mockResolvedValue(rows);

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);

        const body = (await res.json()) as Record<string, unknown>;
        expect(body).not.toHaveProperty('hasClusters');
        expect(body).not.toHaveProperty('clusters');
        const items = body.items as Array<Record<string, unknown>>;
        expect(items).toHaveLength(2);
        expect(items[0].id).toBe(0);
        expect(items[0]).not.toHaveProperty('clusterId');
        expect(items[0].label).toBe('Rock · Pop');
        expect(items[0].trackCount).toBe(15);
        expect(items[0].topGenres).toEqual(['Rock', 'Pop']);
        expect(items[0].topArtists).toEqual(['The Band']);
        expect(items[0]).not.toHaveProperty('coverMediaIds');
        expect(JSON.stringify(items[0].images)).toContain(
            '/api/music/images/collage?ids=cover-uuid-1,cover-uuid-2',
        );
        expect(items[1].topGenres).toEqual([]);
        expect(items[1].topArtists).toEqual([]);
        expect(items[1]).not.toHaveProperty('images');
    });

    test('index decodes one fixed id/label shape', async () => {
        mockGetClusters.mockResolvedValue([
            makeClusterRow(3, 'Rock · Pop', 15, ['Rock'], ['The Band'], ['cover-1']),
        ]);
        const { GET } = await import('./index/+server.js');
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ items: [{ id: 3, label: 'Rock · Pop' }] });
    });

    test('rejects retired compact query', async () => {
        const { GET } = await import('./+server.js');
        expect((await GET!(makeEvent({ compact: '1' }))).status).toBe(422);
    });

    test('returns cached list when cache hits', async () => {
        const cached = {
            items: [
                {
                    id: 0,
                    label: 'Calm',
                    trackCount: 5,
                    topGenres: [],
                    topArtists: [],
                },
            ],
        };
        mockCacheGet.mockResolvedValue(cached);

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        expect(mockGetClusters).not.toHaveBeenCalled();
        expect(await res.json()).toEqual(cached);
    });

    test('recomputes when the cache holds the old listing shape', async () => {
        mockCacheGet.mockResolvedValue({ clusters: [], hasClusters: false });
        mockGetClusters.mockResolvedValue([makeClusterRow(0)]);

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        expect(mockGetClusters).toHaveBeenCalled();
    });

    test('keys the cache by surface, since cover hrefs differ per surface', async () => {
        mockGetClusters.mockResolvedValue([]);
        const { GET } = await import('./+server.js');
        await GET!(makeEvent());
        expect(mockScopedCacheKey).toHaveBeenCalledWith(
            expect.stringContaining('internal'),
            UNRESTRICTED_ACCESS_CTX,
        );
    });

    test('does NOT cache empty cluster list', async () => {
        mockGetClusters.mockResolvedValue([]);

        const { GET } = await import('./+server.js');
        await GET!(makeEvent());
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    test('caches non-empty cluster list', async () => {
        mockGetClusters.mockResolvedValue([makeClusterRow(0)]);

        const { GET } = await import('./+server.js');
        await GET!(makeEvent());
        expect(mockCacheSet).toHaveBeenCalledOnce();
    });

    test('passes the projected access boundary to getClusters', async () => {
        const restrictedCtx = {
            ...UNRESTRICTED_ACCESS_CTX,
            deniedGroupIds: ['group-uuid-1'],
            ageRating: { maxAgeRating: 13, allowUnrated: true },
        };
        mockBuildSearchAccessContext.mockResolvedValue(restrictedCtx);
        mockGetClusters.mockResolvedValue([]);

        const { GET } = await import('./+server.js');
        await GET!(makeEvent());

        // Required-by-shape boundary, not the raw permissive pair.
        expect(mockGetClusters).toHaveBeenCalledWith(fakeSql, 'msclap-2023', {
            library: { kind: 'denyGroups', ids: ['group-uuid-1'] },
            age: { kind: 'limit', maxAgeRating: 13, allowUnrated: true },
        });
    });

    test('projects an unrestricted context to an explicit unrestricted boundary', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_ACCESS_CTX);
        mockGetClusters.mockResolvedValue([]);

        const { GET } = await import('./+server.js');
        await GET!(makeEvent());

        expect(mockGetClusters).toHaveBeenCalledWith(fakeSql, 'msclap-2023', {
            library: { kind: 'all' },
            age: { kind: 'any' },
        });
    });
});
