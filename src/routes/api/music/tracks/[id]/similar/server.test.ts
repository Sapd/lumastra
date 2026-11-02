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
 * Unit tests for GET /api/music/tracks/{id}/similar (basis=sonic|auto|metadata).
 *
 * NOTE: This file is named server.test.ts (NOT +server.test.ts) — the `+`
 * prefix is reserved by SvelteKit for route files and breaks the vite build
 * if used on test files (even though svelte-check/eslint/vitest pass).
 *
 * All heavy dependencies (db, config, access checks, queries) are mocked so
 * tests run fast without a real database or python embedder.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Shared mutable mock state
// ---------------------------------------------------------------------------

const mockFeatures = vi.hoisted(() => ({ sonicEmbeddings: true }));
const mockGetSql = vi.hoisted(() => vi.fn());
const mockCheckMediaAccess = vi.hoisted(() => vi.fn());
const mockBuildSearchAccessContext = vi.hoisted(() => vi.fn());
const mockFindSonicNeighbors = vi.hoisted(() => vi.fn());
const mockGetSimilarTracks = vi.hoisted(() => vi.fn());
const mockGetTrackDetail = vi.hoisted(() => vi.fn());
const mockFilterAccessibleRows = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/config.js', () => ({
    config: {},
    features: mockFeatures,
    // Read at module-load by the transitively-imported task registry.
    FEATURE_PER_TASK_QUEUES: false,
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTrackDetail: mockGetTrackDetail,
    getSimilarTracks: mockGetSimilarTracks,
}));

vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleRows: mockFilterAccessibleRows,
}));

vi.mock('$lib/server/utils/search-access-context.js', async () => {
    // Use the REAL context -> boundary projection rather than a hand-written
    // double: the whole point of the required-by-shape boundary is that the
    // handler can't accidentally hand the query a permissive value.
    const { restrictedAccess } =
        await import('$lib/server/database/queries/builders/media-access-boundary.js');
    type Ctx = {
        deniedGroupIds: string[] | null;
        ageRating: { maxAgeRating: number | null; allowUnrated: boolean } | null;
    };
    return {
        buildSearchAccessContext: mockBuildSearchAccessContext,
        // Deterministic scoped cache key that still PARTITIONS BY ACCESS: the
        // cached row list is access-filtered in SQL, so two callers with
        // different boundaries sharing a key would serve one the other's rows.
        scopedCacheKey: (prefix: string, ctx: Ctx, parts: unknown[]) => {
            const suffix = [
                ctx.deniedGroupIds?.length ? `denied:${[...ctx.deniedGroupIds].sort()}` : '',
                ctx.ageRating?.maxAgeRating != null ? `age:${ctx.ageRating.maxAgeRating}` : '',
            ]
                .filter(Boolean)
                .join(',');
            return `${prefix}:${parts.join(':')}${suffix ? `|${suffix}` : ''}`;
        },
        searchAccessBoundary: (ctx: Ctx) =>
            restrictedAccess({
                deniedGroupIds: ctx.deniedGroupIds ?? [],
                maxAgeRating: ctx.ageRating?.maxAgeRating ?? null,
                allowUnrated: ctx.ageRating?.allowUnrated ?? false,
            }),
    };
});

// The handler wraps the neighbour probe in a scoped cache + single-flight.
// Stub the cache to always miss and the single-flight to run compute() inline
// so findSonicNeighbors is actually invoked (the tests assert on its calls).
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({
            get: vi.fn().mockResolvedValue(undefined),
            set: vi.fn().mockResolvedValue(undefined),
        }),
    },
    CACHE_NAMESPACES: {
        musicSimilarTracks: { name: 'music-similar-tracks', l2TTL: 60_000 },
    },
}));

/** Raw Valkey keys handed to the single-flight, in call order. */
const singleFlightKeys: string[] = [];

vi.mock('$lib/server/cache/single-flight.js', () => ({
    getOrComputeSingleFlight: (opts: { cacheKey: string; compute: () => Promise<string> }) => {
        singleFlightKeys.push(opts.cacheKey);
        return opts.compute();
    },
}));

vi.mock('$lib/server/database/queries/sonic-similarity.queries.js', () => ({
    findSonicNeighbors: mockFindSonicNeighbors,
}));

vi.mock('$lib/server/tasks/api-auth.js', () => ({
    authenticate: vi.fn(),
    requireScope: vi.fn(),
    scopeGranted: vi.fn().mockReturnValue(false),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Fake SQL + helpers
// ---------------------------------------------------------------------------

const fakeSql = vi.fn();

const TRACK_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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
    id: string,
    searchParams: Record<string, string> = {},
    locals?: App.Locals,
): RequestEvent {
    const url = new URL(`http://localhost/api/music/tracks/${id}/similar`);
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
    return {
        params: { id },
        url,
        request: new Request(url),
        locals: locals ?? makeLocals(),
    } as Partial<RequestEvent> as RequestEvent;
}

function makeSonicRow(id: string, score = 0.9): Record<string, unknown> {
    return {
        media_id: id,
        similarity_score: score,
        title: `Track ${id}`,
        custom_poster_url: null,
        custom_metadata: {},
        runtime_seconds: 200,
        artist_title: 'Artist',
        album_id: null,
        album_title: null,
    };
}

function makeMetadataRow(id: string, score = 0.8): Record<string, unknown> {
    return {
        id,
        title: `Track ${id}`,
        custom_metadata: {},
        similarity_score: score,
    };
}

const SONIC = { basis: 'sonic' };
const UNRESTRICTED_BOUNDARY = { library: { kind: 'all' }, age: { kind: 'any' } };

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();

    mockFeatures.sonicEmbeddings = true;
    mockGetSql.mockResolvedValue(fakeSql);
    mockCheckMediaAccess.mockResolvedValue(true);
    mockGetTrackDetail.mockResolvedValue({ id: TRACK_UUID });
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_ACCESS_CTX);
    mockFindSonicNeighbors.mockResolvedValue([]);
    mockGetSimilarTracks.mockResolvedValue([]);
    mockFilterAccessibleRows.mockReset();
    mockFilterAccessibleRows.mockImplementation(async (_sql: unknown, rows: unknown[]) => rows);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/music/tracks/{id}/similar', () => {
    test('returns 401 when user is not authenticated', async () => {
        const { GET } = await import('./+server.js');
        const response = await GET!(makeEvent(TRACK_UUID, {}, makeLocals({ user: null })));
        expect(response.status).toBe(401);
    });

    test('returns 503 when database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const { GET } = await import('./+server.js');
        const response = await GET!(makeEvent(TRACK_UUID));
        expect(response.status).toBe(503);
    });

    test('returns 404 when the seed track is not accessible', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const { GET } = await import('./+server.js');
        const response = await GET!(makeEvent(TRACK_UUID, SONIC));
        expect(response.status).toBe(404);
    });

    test('basis=sonic on a server without sonic embeddings is a 422', async () => {
        mockFeatures.sonicEmbeddings = false;
        const { GET } = await import('./+server.js');
        const response = await GET!(makeEvent(TRACK_UUID, SONIC));
        expect(response.status).toBe(422);
        expect(mockFindSonicNeighbors).not.toHaveBeenCalled();
    });

    describe('basis=sonic', () => {
        test('returns 200 with empty items when no neighbours found', async () => {
            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID, SONIC));
            expect(response.status).toBe(200);
            const data = (await response.json()) as Record<string, unknown>;
            expect(data.items).toEqual([]);
            expect(data.source).toBe('sonic');
            expect(data.page).toEqual({ limit: 20, truncated: false });
        });

        test('returns mapped tracks with similarityScore on success', async () => {
            mockFindSonicNeighbors.mockResolvedValue([
                makeSonicRow('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 0.95),
                makeSonicRow('11111111-2222-4333-8444-555555555555', 0.88),
            ]);

            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID, SONIC));
            expect(response.status).toBe(200);

            const data = (await response.json()) as Record<string, unknown>;
            const items = data.items as Array<Record<string, unknown>>;
            expect(items).toHaveLength(2);
            expect(items[0].id).toBe('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
            expect(items[0].type).toBe('track');
            expect(items[0].artists).toEqual([expect.objectContaining({ title: 'Artist' })]);
            expect(items[0].similarityScore).toBe(0.95);
            expect(data).not.toHaveProperty('tracks');
            expect(data).not.toHaveProperty('sourceTrackId');
        });

        test('asks for limit+1 rows and reports truncation honestly', async () => {
            mockFindSonicNeighbors.mockResolvedValue([
                makeSonicRow('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'),
                makeSonicRow('11111111-2222-4333-8444-555555555555'),
                makeSonicRow('22222222-3333-4444-8555-666666666666'),
            ]);
            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID, { ...SONIC, limit: '2' }));
            const data = (await response.json()) as {
                items: unknown[];
                page: Record<string, unknown>;
            };
            expect(mockFindSonicNeighbors).toHaveBeenCalledWith(
                fakeSql,
                TRACK_UUID,
                3,
                UNRESTRICTED_BOUNDARY,
            );
            expect(data.items).toHaveLength(2);
            expect(data.page).toEqual({ limit: 2, truncated: true });
        });

        test('uses a default limit of 20 (probe of 21)', async () => {
            const { GET } = await import('./+server.js');
            await GET!(makeEvent(TRACK_UUID, SONIC));
            expect(mockFindSonicNeighbors).toHaveBeenCalledWith(
                fakeSql,
                TRACK_UUID,
                21,
                UNRESTRICTED_BOUNDARY,
            );
        });

        test('projects the access context to a MediaAccessBoundary for findSonicNeighbors', async () => {
            mockBuildSearchAccessContext.mockResolvedValue({
                ...UNRESTRICTED_ACCESS_CTX,
                deniedGroupIds: ['group-uuid-1'],
                ageRating: { maxAgeRating: 12, allowUnrated: false },
            });

            const { GET } = await import('./+server.js');
            await GET!(makeEvent(TRACK_UUID, SONIC));

            // Exact boundary (not objectContaining) so a handler that silently
            // widened either axis fails here.
            expect(mockFindSonicNeighbors).toHaveBeenCalledWith(fakeSql, TRACK_UUID, 21, {
                library: { kind: 'denyGroups', ids: ['group-uuid-1'] },
                age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
            });
        });

        test('cache key differs between an unrestricted and a restricted caller', async () => {
            // The access boundary is applied in SQL, so the cached row list is
            // boundary-specific. Colliding keys would make the single-flight
            // share one computed result between a restricted and an
            // unrestricted requester.
            singleFlightKeys.length = 0;

            const { GET } = await import('./+server.js');

            mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_ACCESS_CTX);
            await GET!(makeEvent(TRACK_UUID, SONIC));

            mockBuildSearchAccessContext.mockResolvedValue({
                ...UNRESTRICTED_ACCESS_CTX,
                deniedGroupIds: ['group-uuid-1'],
                ageRating: { maxAgeRating: 12, allowUnrated: false },
            });
            await GET!(makeEvent(TRACK_UUID, SONIC));

            expect(singleFlightKeys).toHaveLength(2);
            expect(singleFlightKeys[0]).not.toBe(singleFlightKeys[1]);
        });

        test('extracts essentia audio features from custom_metadata', async () => {
            mockFindSonicNeighbors.mockResolvedValue([
                {
                    ...makeSonicRow(TRACK_UUID, 0.9),
                    custom_metadata: {
                        essentia: { bpm: 128, key: 'Am', energy: 0.8, mood_tags: ['energetic'] },
                    },
                },
            ]);

            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID, SONIC));
            const data = (await response.json()) as { items: Array<Record<string, unknown>> };

            const af = data.items[0].audioFeatures as Record<string, unknown> | undefined;
            expect(af).toBeDefined();
            expect(af?.bpm).toBe(128);
            expect(af?.key).toBe('Am');
            expect(af?.energy).toBe(0.8);
            expect(af?.moodTags).toEqual(['energetic']);
            expect(af).not.toHaveProperty('mood_tags');
        });
    });

    describe('basis=auto', () => {
        test('takes sonic when the track has sonic neighbours', async () => {
            mockFindSonicNeighbors.mockResolvedValue([
                makeSonicRow('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'),
            ]);
            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID));
            const data = (await response.json()) as { source: string };
            expect(data.source).toBe('sonic');
            expect(mockGetSimilarTracks).not.toHaveBeenCalled();
        });

        test('falls back to metadata when the sonic query has no neighbours', async () => {
            mockGetSimilarTracks.mockResolvedValue([makeMetadataRow('m1', 0.81234)]);
            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID));
            const data = (await response.json()) as {
                source: string;
                items: Array<Record<string, unknown>>;
            };
            expect(data.source).toBe('metadata');
            expect(data.items[0].id).toBe('m1');
            expect(data.items[0].similarityScore).toBe(0.8123);
        });

        test('falls back to metadata when the sonic probe throws', async () => {
            mockFindSonicNeighbors.mockRejectedValue(new Error('hnsw down'));
            mockGetSimilarTracks.mockResolvedValue([makeMetadataRow('m1')]);
            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID));
            expect(response.status).toBe(200);
            const data = (await response.json()) as { source: string };
            expect(data.source).toBe('metadata');
        });

        test('goes straight to metadata on a server without sonic embeddings', async () => {
            mockFeatures.sonicEmbeddings = false;
            mockGetSimilarTracks.mockResolvedValue([makeMetadataRow('m1')]);
            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID));
            const data = (await response.json()) as { source: string };
            expect(response.status).toBe(200);
            expect(data.source).toBe('metadata');
            expect(mockFindSonicNeighbors).not.toHaveBeenCalled();
        });
    });

    describe('basis=sonic failures', () => {
        test('a throwing sonic probe is not swallowed', async () => {
            mockFindSonicNeighbors.mockRejectedValue(new Error('hnsw down'));
            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID, SONIC));
            expect(response.status).toBeGreaterThanOrEqual(500);
            expect(mockGetSimilarTracks).not.toHaveBeenCalled();
        });
    });

    describe('basis=metadata', () => {
        test('judges truncation after the access filter, on an overfetched pool', async () => {
            const pool = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((id) =>
                makeMetadataRow(id),
            );
            mockGetSimilarTracks.mockResolvedValue(pool);
            // Only 3 of the 7 pooled rows are visible to the caller.
            mockFilterAccessibleRows.mockImplementation(async (_sql: unknown, rows: unknown[]) =>
                (rows as Array<{ id: string }>).filter((r) => ['m2', 'm4', 'm6'].includes(r.id)),
            );
            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID, { basis: 'metadata', limit: '2' }));
            const data = (await response.json()) as {
                items: Array<{ id: string }>;
                page: Record<string, unknown>;
            };
            expect(data.items.map((i) => i.id)).toEqual(['m2', 'm4']);
            expect(data.page).toEqual({ limit: 2, truncated: true });
        });

        test('is not truncated when the filter leaves no more than limit rows', async () => {
            mockGetSimilarTracks.mockResolvedValue(
                ['m1', 'm2', 'm3'].map((id) => makeMetadataRow(id)),
            );
            mockFilterAccessibleRows.mockImplementation(async (_sql: unknown, rows: unknown[]) =>
                (rows as Array<{ id: string }>).slice(0, 2),
            );
            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID, { basis: 'metadata', limit: '2' }));
            const data = (await response.json()) as { page: Record<string, unknown> };
            expect(data.page).toEqual({ limit: 2, truncated: false });
        });

        test('never probes the sonic index and reports truncation', async () => {
            mockGetSimilarTracks.mockResolvedValue([
                makeMetadataRow('m1'),
                makeMetadataRow('m2'),
                makeMetadataRow('m3'),
            ]);
            const { GET } = await import('./+server.js');
            const response = await GET!(makeEvent(TRACK_UUID, { basis: 'metadata', limit: '2' }));
            const data = (await response.json()) as {
                source: string;
                items: unknown[];
                page: Record<string, unknown>;
            };
            expect(data.source).toBe('metadata');
            expect(data.items).toHaveLength(2);
            expect(data.page).toEqual({ limit: 2, truncated: true });
            expect(mockGetSimilarTracks).toHaveBeenCalledWith(fakeSql, TRACK_UUID, 7);
            expect(mockFindSonicNeighbors).not.toHaveBeenCalled();
        });
    });
});
