// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the version-bound taste-station handles in stations.service.ts:
 * the version hash, snapshot storage on listing, resolution of stored ids after
 * a re-clustering, the expired (410) path, and malformed ids.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';

const mockWarmMusicCollages = vi.fn();
vi.mock('./collage-warmup.js', () => ({ warmMusicCollages: mockWarmMusicCollages }));

const mockFeatures = { musicClusters: true };
vi.mock('$lib/server/config.js', () => ({ features: mockFeatures }));

// Cache stand-in: a Map keyed by userId + key, shared across calls.
const store = new Map<string, unknown>();
const cacheFaults = { failReads: false };
const cacheWrites: string[] = [];
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({
            get: async (key: string, userId?: string) => {
                if (cacheFaults.failReads) throw new Error('valkey down');
                return store.get(`${userId}|${key}`) ?? null;
            },
            set: async (key: string, value: unknown, _ttl?: number, userId?: string) => {
                cacheWrites.push(`${userId}|${key}`);
                store.set(`${userId}|${key}`, value);
            },
        }),
    },
    CACHE_NAMESPACES: { musicTasteStationSnapshots: { name: 'music-taste-station-snapshots-v1' } },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) },
}));

const mockSonicClusters = vi.fn();
const mockMetadataClusters = vi.fn();
vi.mock('./taste-clusters.service.js', () => ({
    getUserSonicTasteClusters: (...a: unknown[]) => mockSonicClusters(...a),
    getUserTasteClusters: (...a: unknown[]) => mockMetadataClusters(...a),
}));

const mockSonicKnn = vi.fn();
const mockMetadataKnn = vi.fn();
vi.mock('$lib/server/database/queries/music-quick-picks.queries.js', () => ({
    getSonicTracksNearCentroid: (...a: unknown[]) => mockSonicKnn(...a),
    getTracksNearCentroid: (...a: unknown[]) => mockMetadataKnn(...a),
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getRecentlyPlayed: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('./track-projection', () => ({
    toMusicTrack: (row: { id: string }) => ({ id: row.id }),
}));

const {
    computeStationsVersion,
    getUserStations,
    getStationQueue,
    parseStationId,
    formatStationId,
} = await import('./stations.service.js');

const USER = 'user-1' as UserId;

function cluster(centroid: number[], size: number) {
    return { centroid, size, sampleTrackIds: [] as string[] };
}

function candidate(id: string, artist: string) {
    return {
        id,
        title: `Title ${id}`,
        artist_id: artist,
        artist_title: artist,
        embedding: [1, 0, 0],
        similarity: 0.9,
    };
}

// A sql double that answers the label query with nothing (labels fall back).
const sql = (() => Promise.resolve([])) as never;

beforeEach(() => {
    store.clear();
    cacheWrites.length = 0;
    cacheFaults.failReads = false;
    vi.clearAllMocks();
    mockFeatures.musicClusters = true;
    mockSonicClusters.mockResolvedValue(null);
    mockMetadataClusters.mockResolvedValue(null);
    mockSonicKnn.mockResolvedValue([candidate('s1', 'a'), candidate('s2', 'b')]);
    mockMetadataKnn.mockResolvedValue([candidate('m1', 'a')]);
});

describe('computeStationsVersion', () => {
    const base = [cluster([0.1, 0.2], 5), cluster([0.3, 0.4], 7)];

    it('is 12 hex chars and stable for equal input', () => {
        const a = computeStationsVersion('sonic', base);
        expect(a).toMatch(/^[0-9a-f]{12}$/);
        expect(computeStationsVersion('sonic', structuredClone(base))).toBe(a);
    });

    it('ignores noise below the fifth decimal', () => {
        const noisy = [cluster([0.1 + 1e-9, 0.2], 5), cluster([0.3, 0.4 - 1e-9], 7)];
        expect(computeStationsVersion('sonic', noisy)).toBe(computeStationsVersion('sonic', base));
    });

    it('changes when a centroid, a size or the space changes', () => {
        const v = computeStationsVersion('sonic', base);
        expect(computeStationsVersion('sonic', [cluster([0.1, 0.21], 5), base[1]])).not.toBe(v);
        expect(computeStationsVersion('sonic', [cluster([0.1, 0.2], 6), base[1]])).not.toBe(v);
        expect(computeStationsVersion('metadata', base)).not.toBe(v);
    });
});

describe('parseStationId', () => {
    it('round-trips a formatted id', () => {
        expect(parseStationId(formatStationId('a1b2c3d4e5f6', 2))).toEqual({
            version: 'a1b2c3d4e5f6',
            n: 2,
        });
    });

    it.each([
        '',
        '0',
        'a1b2c3d4e5f6',
        'a1b2c3d4e5f6.',
        'a1b2c3d4e5f6.x',
        'ZZZZZZZZZZZZ.1',
        '1.2.3',
    ])('rejects the malformed id %j', (id) => {
        expect(parseStationId(id)).toBeNull();
    });
});

describe('getUserStations', () => {
    it('returns version-bound ids and playedTrackCount, and stores the snapshot', async () => {
        const clusters = [cluster([1, 0, 0], 5), cluster([0, 1, 0], 9)];
        mockSonicClusters.mockResolvedValue(clusters);
        const stations = await getUserStations(sql, USER);
        expect(mockWarmMusicCollages).toHaveBeenCalledWith(
            sql,
            stations!.map((station) => station.coverTrackIds),
        );
        const version = computeStationsVersion('sonic', clusters);

        expect(stations?.map((s) => s.id)).toEqual([`${version}.0`, `${version}.1`]);
        expect(stations?.map((s) => s.playedTrackCount)).toEqual([5, 9]);
        expect(store.get(`${USER}|snapshot:${version}`)).toEqual({
            space: 'sonic',
            centroids: [
                [1, 0, 0],
                [0, 1, 0],
            ],
        });
    });

    it('returns null when there are no clusters', async () => {
        expect(await getUserStations(sql, USER)).toBeNull();
    });
});

describe('getStationQueue', () => {
    it('rejects a malformed id', async () => {
        expect(await getStationQueue(sql, USER, 'nonsense')).toEqual({ kind: 'invalid' });
    });

    it('resolves a listed id against its snapshot after the clustering changed', async () => {
        const old = [cluster([1, 0, 0], 5), cluster([0, 1, 0], 9)];
        mockSonicClusters.mockResolvedValue(old);
        const listed = await getUserStations(sql, USER);
        const oldId = listed![1].id;

        // Re-clustering: different centroids, hence a different version.
        mockSonicClusters.mockResolvedValue([cluster([0, 0, 1], 12)]);

        const result = await getStationQueue(sql, USER, oldId, 10);
        expect(result.kind).toBe('ok');
        expect(mockSonicKnn).toHaveBeenCalledTimes(1);
        expect(mockSonicKnn.mock.calls[0][2]).toEqual([0, 1, 0]);
    });

    it('uses the snapshot space, not the current one', async () => {
        mockSonicClusters.mockResolvedValue(null);
        mockMetadataClusters.mockResolvedValue([cluster([1, 0, 0], 5)]);
        const listed = await getUserStations(sql, USER);

        // Sonic coverage appears later; the stored id must still play metadata.
        mockSonicClusters.mockResolvedValue([cluster([0, 1, 0], 5)]);
        const result = await getStationQueue(sql, USER, listed![0].id, 10);
        expect(result.kind).toBe('ok');
        expect(mockMetadataKnn).toHaveBeenCalledTimes(1);
        expect(mockSonicKnn).not.toHaveBeenCalled();
    });

    it('answers expired when the snapshot is gone and the clustering moved on', async () => {
        mockSonicClusters.mockResolvedValue([cluster([1, 0, 0], 5)]);
        const listed = await getUserStations(sql, USER);
        store.clear();
        mockSonicClusters.mockResolvedValue([cluster([0, 1, 0], 5)]);

        expect(await getStationQueue(sql, USER, listed![0].id)).toEqual({ kind: 'expired' });
        expect(mockSonicKnn).not.toHaveBeenCalled();
    });

    it('answers expired when the snapshot is gone and the user has no clustering', async () => {
        const id = formatStationId('a1b2c3d4e5f6', 0);
        expect(await getStationQueue(sql, USER, id)).toEqual({ kind: 'expired' });
    });

    it('recomputes and re-stores the snapshot when the current version matches', async () => {
        const clusters = [cluster([1, 0, 0], 5)];
        mockSonicClusters.mockResolvedValue(clusters);
        const listed = await getUserStations(sql, USER);
        store.clear();

        const result = await getStationQueue(sql, USER, listed![0].id, 10);
        expect(result.kind).toBe('ok');
        const version = computeStationsVersion('sonic', clusters);
        expect(store.has(`${USER}|snapshot:${version}`)).toBe(true);
    });

    it('does not resolve another user’s snapshot', async () => {
        mockSonicClusters.mockResolvedValue([cluster([1, 0, 0], 5)]);
        const listed = await getUserStations(sql, USER);
        mockSonicClusters.mockResolvedValue(null);

        const other = 'user-2' as UserId;
        expect(await getStationQueue(sql, other, listed![0].id)).toEqual({ kind: 'expired' });
    });

    it('answers not_found for a position past the snapshot', async () => {
        mockSonicClusters.mockResolvedValue([cluster([1, 0, 0], 5)]);
        const listed = await getUserStations(sql, USER);
        const { version } = parseStationId(listed![0].id)!;
        expect(await getStationQueue(sql, USER, formatStationId(version, 5))).toEqual({
            kind: 'not_found',
        });
    });

    it('reports truncated when more deduped candidates than the limit exist', async () => {
        mockSonicClusters.mockResolvedValue([cluster([1, 0, 0], 5)]);
        const listed = await getUserStations(sql, USER);
        mockSonicKnn.mockResolvedValue([
            candidate('s1', 'a'),
            candidate('s2', 'b'),
            candidate('s3', 'c'),
        ]);

        const capped = await getStationQueue(sql, USER, listed![0].id, 2);
        expect(capped).toMatchObject({ kind: 'ok', truncated: true });
        const all = await getStationQueue(sql, USER, listed![0].id, 10);
        expect(all).toMatchObject({ kind: 'ok', truncated: false });
    });
});

describe('snapshot storage and resolution edge cases', () => {
    it('writes the snapshot only when the key is missing', async () => {
        mockSonicClusters.mockResolvedValue([cluster([1, 0, 0], 5)]);
        await getUserStations(sql, USER);
        await getUserStations(sql, USER);
        expect(cacheWrites).toHaveLength(1);
    });

    it('stores rounded centroids', async () => {
        const clusters = [cluster([0.123456789, 0.5, 0], 5)];
        mockSonicClusters.mockResolvedValue(clusters);
        await getUserStations(sql, USER);
        const version = computeStationsVersion('sonic', clusters);
        expect(store.get(`${USER}|snapshot:${version}`)).toEqual({
            space: 'sonic',
            centroids: [[0.12346, 0.5, 0]],
        });
    });

    it('skips the write when the snapshot read fails', async () => {
        mockSonicClusters.mockResolvedValue([cluster([1, 0, 0], 5)]);
        cacheFaults.failReads = true;
        await getUserStations(sql, USER);
        expect(cacheWrites).toHaveLength(0);
    });

    it('answers unavailable, not expired, when the read fails and the clustering moved', async () => {
        mockSonicClusters.mockResolvedValue([cluster([1, 0, 0], 5)]);
        const listed = await getUserStations(sql, USER);
        mockSonicClusters.mockResolvedValue([cluster([0, 1, 0], 5)]);
        cacheFaults.failReads = true;
        expect(await getStationQueue(sql, USER, listed![0].id)).toEqual({ kind: 'unavailable' });
    });

    it('serves from the current clustering when the read fails but its version matches', async () => {
        mockSonicClusters.mockResolvedValue([cluster([1, 0, 0], 5)]);
        const listed = await getUserStations(sql, USER);
        cacheFaults.failReads = true;
        const result = await getStationQueue(sql, USER, listed![0].id, 10);
        expect(result.kind).toBe('ok');
        expect(mockSonicKnn.mock.calls[0][2]).toEqual([1, 0, 0]);
    });

    it('treats a stored sonic snapshot as expired when musicClusters is off', async () => {
        mockSonicClusters.mockResolvedValue([cluster([1, 0, 0], 5)]);
        const listed = await getUserStations(sql, USER);
        mockFeatures.musicClusters = false;
        expect(await getStationQueue(sql, USER, listed![0].id)).toEqual({ kind: 'expired' });
        expect(mockSonicKnn).not.toHaveBeenCalled();
    });
});
