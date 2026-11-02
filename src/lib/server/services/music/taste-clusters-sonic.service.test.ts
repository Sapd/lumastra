// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for getUserSonicTasteClusters (taste-clusters.service.ts).
 *
 * All external dependencies (postgres, cacheManager, features, getClusterCentroid,
 * getTopPlayedEmbeddings, getDislikedEmbeddings) are mocked so no DB or Valkey
 * instance is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic import of the module
// ---------------------------------------------------------------------------

// features.musicClusters is the gate for getUserSonicTasteClusters. We default
// it to `true` so most tests exercise the happy path; individual tests override
// by reassigning the exported property.
const mockWarmMusicCollages = vi.fn();
vi.mock('./collage-warmup.js', () => ({ warmMusicCollages: mockWarmMusicCollages }));

const mockFeatures = { musicClusters: true };

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
}));

// Cache: default miss (returns null), set is a no-op.
const mockCacheGet = vi.fn().mockResolvedValue(null);
const mockCacheSet = vi.fn().mockResolvedValue(undefined);
vi.mock('$lib/server/cache', () => ({
    cacheManager: {
        for: vi.fn(() => ({
            get: mockCacheGet,
            set: mockCacheSet,
        })),
    },
    CACHE_NAMESPACES: {
        musicTasteClusters: { name: 'music-taste-clusters-v3' },
        musicSonicTasteClusters: { name: 'music-sonic-taste-clusters-v1' },
    },
}));

// Logger: no-op
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) },
}));

// Embedding utils: parseEmbedding, averageVectors, etc. — forward to real impl
vi.mock('$lib/server/utils/embedding-utils.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('$lib/server/utils/embedding-utils.js')>();
    return real;
});

// getTopPlayedEmbeddings / getDislikedEmbeddings — unused by sonic path directly
vi.mock('$lib/server/database/queries/music-quick-picks.queries.js', () => ({
    getTopPlayedEmbeddings: vi.fn().mockResolvedValue([]),
    getDislikedEmbeddings: vi.fn().mockResolvedValue([]),
}));

// getClusterCentroid — controls whether sonic coverage is sufficient.
const mockGetClusterCentroid = vi.fn();
vi.mock('$lib/server/database/queries/audio-clusters.queries.js', () => ({
    getClusterCentroid: mockGetClusterCentroid,
}));

// sonic-constants — expose the real constant.
vi.mock('$lib/server/database/queries/sonic-constants.js', () => ({
    MSCLAP_MODEL_ID: 'msclap-2023',
}));

// ---------------------------------------------------------------------------
// Fake sql helper
// ---------------------------------------------------------------------------

/**
 * Build a fake postgres.Sql that returns configurable rows per call sequence.
 *
 * Each call to the tagged-template consumes the next entry in `responses`.
 * Once exhausted it returns [].
 */
function makeFakeSql(responses: unknown[][] = []): ReturnType<typeof vi.fn> {
    let callIndex = 0;
    return vi.fn((...args: unknown[]): unknown => {
        if (Array.isArray(args[0]) && 'raw' in (args[0] as object)) {
            const response = responses[callIndex++] ?? [];
            return Promise.resolve(response);
        }
        return Promise.resolve([]);
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake centroid vector. */
function fakeCentroid(dim = 3): number[] {
    return Array.from({ length: dim }, (_, i) => (i + 1) / dim);
}

/** Build fake TrackClusterRow results (top-played + cluster assignments). */
function fakeAssignments(
    entries: Array<{ track_id: string; cluster_id: number }>,
): { track_id: string; cluster_id: number }[] {
    return entries;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getUserSonicTasteClusters', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFeatures.musicClusters = true;
        mockCacheGet.mockResolvedValue(null);
        mockGetClusterCentroid.mockResolvedValue(null);
    });

    it('returns null immediately when features.musicClusters is false', async () => {
        mockFeatures.musicClusters = false;
        const { getUserSonicTasteClusters } = await import('./taste-clusters.service.js');
        const sql = makeFakeSql();

        const result = await getUserSonicTasteClusters(
            sql as unknown as Parameters<typeof getUserSonicTasteClusters>[0],
            'user1' as UserId,
        );

        expect(result).toBeNull();
        expect(sql).not.toHaveBeenCalled();
    });

    it('returns null immediately when userId is empty string', async () => {
        const { getUserSonicTasteClusters } = await import('./taste-clusters.service.js');
        const sql = makeFakeSql();

        const result = await getUserSonicTasteClusters(
            sql as unknown as Parameters<typeof getUserSonicTasteClusters>[0],
            '' as Parameters<typeof getUserSonicTasteClusters>[1],
        );

        expect(result).toBeNull();
    });

    it('returns null when user has fewer than MIN_PLAYS_FOR_CLUSTERING plays', async () => {
        const { getUserSonicTasteClusters, MIN_PLAYS_FOR_CLUSTERING } =
            await import('./taste-clusters.service.js');
        // play count below threshold
        const sql = makeFakeSql([
            [{ played_count: MIN_PLAYS_FOR_CLUSTERING - 1 }],
            [{ dislike_count: 0 }],
        ]);

        const result = await getUserSonicTasteClusters(
            sql as unknown as Parameters<typeof getUserSonicTasteClusters>[0],
            'user1' as UserId,
        );

        expect(result).toBeNull();
    });

    it('returns cached value on cache hit', async () => {
        const cachedClusters = [{ centroid: fakeCentroid(), size: 5, sampleTrackIds: ['a', 'b'] }];
        mockCacheGet.mockResolvedValue(cachedClusters);

        const { getUserSonicTasteClusters, MIN_PLAYS_FOR_CLUSTERING } =
            await import('./taste-clusters.service.js');
        const sql = makeFakeSql([
            [{ played_count: MIN_PLAYS_FOR_CLUSTERING + 5 }],
            [{ dislike_count: 0 }],
        ]);

        const result = await getUserSonicTasteClusters(
            sql as unknown as Parameters<typeof getUserSonicTasteClusters>[0],
            'user1' as UserId,
        );

        expect(result).toEqual(cachedClusters);
        // Should not issue the cluster-assignment query after a cache hit.
        expect(sql).toHaveBeenCalledTimes(2); // only the play/dislike count queries
    });

    it('returns null when sonic cluster assignments are below threshold', async () => {
        const { getUserSonicTasteClusters, MIN_PLAYS_FOR_CLUSTERING, TOP_N_TRACKS } =
            await import('./taste-clusters.service.js');
        // play count OK, but very few assignments
        const sql = makeFakeSql([
            [{ played_count: MIN_PLAYS_FOR_CLUSTERING + 20 }],
            [{ dislike_count: 0 }],
            fakeAssignments([{ track_id: 'a', cluster_id: 0 }]), // only 1 < threshold
        ]);

        const result = await getUserSonicTasteClusters(
            sql as unknown as Parameters<typeof getUserSonicTasteClusters>[0],
            'user1' as UserId,
            { k: TOP_N_TRACKS },
        );

        expect(result).toBeNull();
    });

    it('returns null when getClusterCentroid returns null for all clusters', async () => {
        const { getUserSonicTasteClusters, MIN_PLAYS_FOR_CLUSTERING } =
            await import('./taste-clusters.service.js');
        mockGetClusterCentroid.mockResolvedValue(null);

        // Build MIN_PLAYS_FOR_CLUSTERING assignments, all in cluster 0
        const assignments = fakeAssignments(
            Array.from({ length: MIN_PLAYS_FOR_CLUSTERING }, (_, i) => ({
                track_id: `track-${i}`,
                cluster_id: 0,
            })),
        );
        const sql = makeFakeSql([
            [{ played_count: MIN_PLAYS_FOR_CLUSTERING + 5 }],
            [{ dislike_count: 0 }],
            assignments,
        ]);

        const result = await getUserSonicTasteClusters(
            sql as unknown as Parameters<typeof getUserSonicTasteClusters>[0],
            'user1' as UserId,
        );

        expect(result).toBeNull();
    });

    it('returns TasteCluster[] when there are enough assignments and valid centroids', async () => {
        const { getUserSonicTasteClusters, MIN_PLAYS_FOR_CLUSTERING } =
            await import('./taste-clusters.service.js');
        const centroid0 = fakeCentroid(4);
        const centroid1 = fakeCentroid(4).map((v) => v * 2);
        mockGetClusterCentroid.mockResolvedValueOnce(centroid0).mockResolvedValueOnce(centroid1);

        const assignments = fakeAssignments([
            ...Array.from({ length: Math.ceil(MIN_PLAYS_FOR_CLUSTERING / 2) }, (_, i) => ({
                track_id: `track-a-${i}`,
                cluster_id: 0,
            })),
            ...Array.from({ length: Math.ceil(MIN_PLAYS_FOR_CLUSTERING / 2) }, (_, i) => ({
                track_id: `track-b-${i}`,
                cluster_id: 1,
            })),
        ]);

        const sql = makeFakeSql([
            [{ played_count: assignments.length + 5 }],
            [{ dislike_count: 0 }],
            assignments,
        ]);

        const result = await getUserSonicTasteClusters(
            sql as unknown as Parameters<typeof getUserSonicTasteClusters>[0],
            'user1' as UserId,
        );

        expect(result).not.toBeNull();
        expect(result!.length).toBeGreaterThanOrEqual(1);
        for (const cluster of result!) {
            expect(cluster.centroid.length).toBe(4);
            expect(cluster.size).toBeGreaterThan(0);
            expect(Array.isArray(cluster.sampleTrackIds)).toBe(true);
        }
    });

    it('caps result to k clusters', async () => {
        const { getUserSonicTasteClusters, MIN_PLAYS_FOR_CLUSTERING } =
            await import('./taste-clusters.service.js');
        const centroid = fakeCentroid(4);
        // Return a valid centroid for every call (3 clusters available)
        mockGetClusterCentroid.mockResolvedValue(centroid);

        const assignments = fakeAssignments([
            ...Array.from({ length: 5 }, (_, i) => ({ track_id: `a-${i}`, cluster_id: 0 })),
            ...Array.from({ length: 5 }, (_, i) => ({ track_id: `b-${i}`, cluster_id: 1 })),
            ...Array.from({ length: 5 }, (_, i) => ({ track_id: `c-${i}`, cluster_id: 2 })),
        ]);
        expect(assignments.length).toBeGreaterThanOrEqual(MIN_PLAYS_FOR_CLUSTERING);

        const sql = makeFakeSql([[{ played_count: 20 }], [{ dislike_count: 0 }], assignments]);

        const result = await getUserSonicTasteClusters(
            sql as unknown as Parameters<typeof getUserSonicTasteClusters>[0],
            'user1' as UserId,
            { k: 2 },
        );

        expect(result).not.toBeNull();
        // k=2 caps to at most 2 clusters
        expect(result!.length).toBeLessThanOrEqual(2);
    });

    it('writes result to cache on miss', async () => {
        const { getUserSonicTasteClusters, MIN_PLAYS_FOR_CLUSTERING } =
            await import('./taste-clusters.service.js');
        mockGetClusterCentroid.mockResolvedValue(fakeCentroid(4));

        const assignments = fakeAssignments(
            Array.from({ length: MIN_PLAYS_FOR_CLUSTERING }, (_, i) => ({
                track_id: `t-${i}`,
                cluster_id: 0,
            })),
        );
        const sql = makeFakeSql([
            [{ played_count: assignments.length + 5 }],
            [{ dislike_count: 0 }],
            assignments,
        ]);

        const result = await getUserSonicTasteClusters(
            sql as unknown as Parameters<typeof getUserSonicTasteClusters>[0],
            'user1' as UserId,
        );

        expect(mockWarmMusicCollages).toHaveBeenCalledWith(
            sql,
            result!.map((cluster) => cluster.sampleTrackIds),
        );
        expect(mockCacheSet).toHaveBeenCalledOnce();
    });
});
