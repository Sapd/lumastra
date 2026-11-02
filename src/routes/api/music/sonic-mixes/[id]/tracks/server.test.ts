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

import type { Track } from '$lib/schemas/api-music-dto';
/**
 * Unit tests for GET /api/music/sonic-mixes /[id]/tracks (cluster members).
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

function makeEvent(
    searchParams: Record<string, string> = {},
    locals?: App.Locals,
    id = '0',
): RequestEvent {
    const url = new URL('http://localhost/api/music/sonic-mixes/0/tracks');
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
    return {
        url,
        request: new Request(url),
        params: { id },
        locals: locals ?? makeLocals(),
    } as Partial<RequestEvent> as RequestEvent;
}

function makeMemberRow(id: string): Record<string, unknown> {
    return {
        media_id: id,
        title: `Track ${id}`,
        custom_poster_url: null,
        custom_metadata: {},
        runtime_seconds: 200,
        artist_title: 'Artist',
        album_id: null,
        album_title: null,
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
    mockGetClusterMembers.mockResolvedValue([]);
    mockClusterExists.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/music/sonic-mixes/[id]/tracks', () => {
    test('returns 401 when user is not authenticated', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({}, makeLocals({ user: null })));
        expect(res.status).toBe(401);
    });

    test('returns 422 for a non-integer cluster id', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({}, undefined, 'abc'));
        expect(res.status).toBe(422);
    });

    test('returns 200 with empty items when the cluster exists but nothing is visible', async () => {
        mockGetClusterMembers.mockResolvedValue([]);
        mockClusterExists.mockResolvedValue(true);

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({}, undefined, '3'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            items: [],
            page: { limit: 200, offset: 0, hasMore: false },
        });
    });

    test('returns 404 for a cluster id the model never issued', async () => {
        mockGetClusterMembers.mockResolvedValue([]);
        mockClusterExists.mockResolvedValue(false);

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({}, undefined, '99'));
        expect(res.status).toBe(404);
        expect(mockClusterExists).toHaveBeenCalledWith(fakeSql, 'msclap-2023', 99);
    });

    test('a retired cluster id is a 404 even when its members are still cached', async () => {
        mockClusterExists.mockResolvedValue(false);
        mockCacheGet.mockResolvedValue({
            items: [],
            page: { limit: 200, offset: 0, hasMore: false },
        });

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({}, undefined, '7'));
        expect(res.status).toBe(404);
        expect(mockCacheGet).not.toHaveBeenCalled();
        expect(mockGetClusterMembers).not.toHaveBeenCalled();
    });

    test('rejects a cluster id above the int4 range', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({}, undefined, '2147483648'));
        expect(res.status).toBe(422);
        expect(mockClusterExists).not.toHaveBeenCalled();
    });

    test('returns mapped Track objects for cluster members', async () => {
        const rows = [
            makeMemberRow('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
            makeMemberRow('11111111-2222-4333-8444-555555555555'),
        ];
        mockGetClusterMembers.mockResolvedValue(rows);

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);

        const body = (await res.json()) as Record<string, unknown>;
        expect(body).not.toHaveProperty('clusterId');
        expect(body.page).toEqual({ limit: 200, offset: 0, hasMore: false });
        const items = body.items as Track[];
        expect(items).toHaveLength(2);
        expect(items[0].id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect(items[0].type).toBe('track');
        expect(items[0].artists[0]?.title).toBe('Artist');
    });

    test('fetches limit + 1 rows and reports truncated when there are more', async () => {
        mockGetClusterMembers.mockResolvedValue([
            makeMemberRow('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1'),
            makeMemberRow('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2'),
            makeMemberRow('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3'),
        ]);

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({ limit: '2' }, undefined, '5'));

        expect(mockGetClusterMembers).toHaveBeenCalledWith(
            fakeSql,
            'msclap-2023',
            5,
            { library: { kind: 'all' }, age: { kind: 'any' } },
            3,
            0,
        );
        const body = (await res.json()) as { items: Track[]; page: unknown };
        expect(body.items).toHaveLength(2);
        expect(body.page).toEqual({ limit: 2, offset: 0, hasMore: true });
    });

    test('an exact-limit page is terminal when the lookahead has no extra track', async () => {
        mockGetClusterMembers.mockResolvedValue([
            makeMemberRow('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1'),
            makeMemberRow('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2'),
        ]);
        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({ limit: '2' }));
        expect((await res.json()).page).toEqual({ limit: 2, offset: 0, hasMore: false });
    });

    test('passes offset to the ordered query and emits a terminal page', async () => {
        mockGetClusterMembers.mockResolvedValue([]);
        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({ limit: '2', offset: '4' }));
        expect(res.status).toBe(200);
        expect(mockGetClusterMembers).toHaveBeenCalledWith(
            fakeSql,
            'msclap-2023',
            0,
            expect.any(Object),
            3,
            4,
        );
        expect(await res.json()).toEqual({
            items: [],
            page: { limit: 2, offset: 4, hasMore: false },
        });
    });

    test('rejects a limit above 500', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({ limit: '9999' }));

        expect(res.status).toBe(422);
        expect(mockGetClusterMembers).not.toHaveBeenCalled();
    });

    test('defaults limit to 200 when not specified', async () => {
        const { GET } = await import('./+server.js');
        await GET!(makeEvent({}, undefined, '1'));

        expect(mockGetClusterMembers).toHaveBeenCalledWith(
            fakeSql,
            'msclap-2023',
            1,
            expect.anything(),
            201,
            0,
        );
    });

    test('returns cached members when cache hits', async () => {
        const cached = {
            items: [
                {
                    id: 'some-uuid',
                    type: 'track',
                    title: 'Cached Track',
                    artists: [{ id: null, title: 'A' }],
                    albumArtist: null,
                    album: null,
                    trackNumber: null,
                    discNumber: null,
                    durationMs: null,
                    genres: [],
                    year: null,
                    images: {},
                    isRadio: false,
                },
            ],
            page: { limit: 200, offset: 0, hasMore: false },
        };
        mockCacheGet.mockResolvedValue(cached);

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({}, undefined, '2'));
        expect(res.status).toBe(200);
        expect(mockGetClusterMembers).not.toHaveBeenCalled();
        expect(await res.json()).toEqual(cached);
    });

    test('refetches members when the cache contains the old shape', async () => {
        mockCacheGet.mockResolvedValue({
            clusterId: 2,
            tracks: [{ id: 'some-uuid', type: 'track', title: 'Cached Track', artist: 'A' }],
        });
        mockGetClusterMembers.mockResolvedValue([]);

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent({}, undefined, '2'));
        expect(res.status).toBe(200);
        expect(mockGetClusterMembers).toHaveBeenCalled();
        expect(await res.json()).toEqual({
            items: [],
            page: { limit: 200, offset: 0, hasMore: false },
        });
    });

    test('does NOT cache empty member list', async () => {
        mockGetClusterMembers.mockResolvedValue([]);

        const { GET } = await import('./+server.js');
        await GET!(makeEvent());
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    test('uses artist from custom_metadata when artist_title is null', async () => {
        const row = {
            ...makeMemberRow('uuid-1'),
            artist_title: null,
            custom_metadata: { artist: 'Meta Artist' },
        };
        mockGetClusterMembers.mockResolvedValue([row]);

        const { GET } = await import('./+server.js');
        const res = await GET!(makeEvent());
        const body = (await res.json()) as Record<string, unknown>;
        const items = body.items as Track[];
        expect(items[0].artists[0]?.title).toBe('Meta Artist');
    });
});
