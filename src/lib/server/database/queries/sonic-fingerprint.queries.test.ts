// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for sonic-fingerprint.queries.ts.
 *
 * Uses a mock postgres.Sql instance — no real database needed.
 *
 * The suite verifies:
 *   - Empty result when the user has no play history (first sql call → []).
 *   - Empty result when seeds have no embeddings.
 *   - Correct kNN call structure when seeds exist.
 *   - Return type shape is correct.
 *   - Meta reflects seedCount and hasSufficientHistory.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import {
    findSonicFingerprintNeighbors,
    type FingerprintNeighborRow,
} from './sonic-fingerprint.queries.js';
import { denyAllAccess, unrestrictedAccess } from './builders/media-access-boundary.js';
import type { UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-123' as UserId;

/**
 * Explicit unrestricted boundary. There is no permissive default any more — a
 * test that wants unfiltered rows has to say so, same as production code.
 */
const UNRESTRICTED = unrestrictedAccess();

/**
 * Build a fake embedding text in pgvector format `[a,b,...,z]` with 1024 dims.
 */
function fakEmbeddingText(baseVal = 0.1): string {
    const dims = new Array<number>(1024).fill(baseVal);
    return `[${dims.join(',')}]`;
}

/**
 * Build a fake seed row as returned by fetchSeedRows inner SQL.
 */
function fakeSeedSqlRow(
    trackId: string,
    playCount = 5,
    hoursAgo = 1,
): {
    track_id: string;
    play_count: number;
    last_played_at: Date;
    embedding: string;
} {
    const d = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    return {
        track_id: trackId,
        play_count: playCount,
        last_played_at: d,
        embedding: fakEmbeddingText(0.2),
    };
}

/**
 * Build a fake FingerprintNeighborRow for the kNN result.
 */
function fakeNeighborRow(mediaId: string): FingerprintNeighborRow {
    return {
        media_id: mediaId,
        similarity_score: 0.88,
        title: `Track ${mediaId}`,
        custom_poster_url: null,
        custom_metadata: {},
        runtime_seconds: 200,
        artist_title: 'Test Artist',
        artist_id: null,
        track_artists: null,
        album_id: null,
        album_title: null,
    };
}

/**
 * Create a multi-call mock postgres.Sql.
 *
 * Call 0: returns seedRows (the fetchSeedRows inner query)
 * Call 1+: returns neighborRows (the kNN query + any fragment builders)
 *
 * Fragment builders from library-access and age-rating builders also call
 * `sql\`...\`` but for unrestricted context they return `sql\`\`` which this
 * mock handles by always returning a thenable (so fragment interpolation works).
 */
function makeSqlMock(
    seedRows: Array<{
        track_id: string;
        play_count: number;
        last_played_at: Date;
        embedding: string;
    }>,
    neighborRows: FingerprintNeighborRow[],
): postgres.Sql {
    let callCount = 0;

    const stub = vi.fn((..._args: unknown[]) => {
        const idx = callCount++;
        const rows = idx === 0 ? seedRows : neighborRows;
        return Object.assign(Promise.resolve(rows), {});
    });

    return stub as unknown as postgres.Sql;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findSonicFingerprintNeighbors', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('is exported as a function', () => {
        expect(typeof findSonicFingerprintNeighbors).toBe('function');
    });

    test('returns hasSufficientHistory=false when user has no play history', async () => {
        const sql = makeSqlMock([], []);
        const result = await findSonicFingerprintNeighbors(sql, USER_ID, 20, UNRESTRICTED);

        expect(result.tracks).toEqual([]);
        expect(result.meta.hasSufficientHistory).toBe(false);
        expect(result.meta.seedCount).toBe(0);
    });

    test('returns tracks when seeds and neighbors exist', async () => {
        const seedRows = [
            fakeSeedSqlRow('aaaa-bbbb-cccc-dddd-0001', 10, 1),
            fakeSeedSqlRow('aaaa-bbbb-cccc-dddd-0002', 8, 2),
        ];
        const neighborRows = [
            fakeNeighborRow('nnnn-oooo-pppp-qqqq-0001'),
            fakeNeighborRow('nnnn-oooo-pppp-qqqq-0002'),
        ];
        const sql = makeSqlMock(seedRows, neighborRows);

        const result = await findSonicFingerprintNeighbors(sql, USER_ID, 20, UNRESTRICTED);

        expect(result.meta.hasSufficientHistory).toBe(true);
        expect(result.meta.seedCount).toBe(2);
        expect(result.tracks).toHaveLength(2);
        expect(result.tracks[0].media_id).toBe('nnnn-oooo-pppp-qqqq-0001');
        expect(result.tracks[1].media_id).toBe('nnnn-oooo-pppp-qqqq-0002');
    });

    test('calls sql at least twice (seed fetch + kNN query)', async () => {
        const seedRows = [fakeSeedSqlRow('seed-0001', 3, 5)];
        const neighborRows = [fakeNeighborRow('neigh-0001')];
        const sql = makeSqlMock(seedRows, neighborRows);

        await findSonicFingerprintNeighbors(sql, USER_ID, 10, UNRESTRICTED);

        // At least 2 calls: seed query + kNN query
        expect(
            vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThanOrEqual(2);
    });

    test('meta.seedCount reflects number of seeds with embeddings', async () => {
        const seedRows = [
            fakeSeedSqlRow('s1', 5, 1),
            fakeSeedSqlRow('s2', 3, 2),
            fakeSeedSqlRow('s3', 1, 3),
        ];
        const sql = makeSqlMock(seedRows, []);

        const result = await findSonicFingerprintNeighbors(sql, USER_ID, 20, UNRESTRICTED);

        expect(result.meta.seedCount).toBe(3);
    });

    test('FingerprintNeighborRow interface allows null optional fields', () => {
        const row: FingerprintNeighborRow = {
            media_id: 'some-uuid',
            similarity_score: 0.75,
            title: 'Track',
            custom_poster_url: null,
            custom_metadata: {},
            runtime_seconds: null,
            artist_title: null,
            artist_id: null,
            track_artists: null,
            album_id: null,
            album_title: null,
        };
        expect(row.custom_poster_url).toBeNull();
        expect(row.artist_title).toBeNull();
    });

    test('returns empty tracks array when kNN yields no results', async () => {
        const seedRows = [fakeSeedSqlRow('seed-only', 1, 10)];
        const sql = makeSqlMock(seedRows, []);

        const result = await findSonicFingerprintNeighbors(sql, USER_ID, 20, UNRESTRICTED);

        expect(result.tracks).toEqual([]);
        // Still has history — we just happened to get no neighbours
        expect(result.meta.hasSufficientHistory).toBe(true);
        expect(result.meta.seedCount).toBe(1);
    });

    test('denyAll boundary short-circuits without touching the database', async () => {
        // Same fixture that produces rows under UNRESTRICTED (see above), so an
        // empty result here is the boundary working, not an empty fixture.
        const seedRows = [fakeSeedSqlRow('seed-0001', 3, 5)];
        const neighborRows = [fakeNeighborRow('neigh-0001')];
        const sql = makeSqlMock(seedRows, neighborRows);

        const result = await findSonicFingerprintNeighbors(sql, USER_ID, 20, denyAllAccess());

        expect(result.tracks).toEqual([]);
        expect(result.meta.accessDenied).toBe(true);
        expect(result.meta.hasSufficientHistory).toBe(false);
        // Not one round trip — not even the seed fetch, whose ids feed the
        // kNN exclusion list.
        expect(vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    test('a non-denying boundary does reach the database (denyAll guard is not blanket)', async () => {
        const seedRows = [fakeSeedSqlRow('seed-0001', 3, 5)];
        const sql = makeSqlMock(seedRows, [fakeNeighborRow('neigh-0001')]);

        const result = await findSonicFingerprintNeighbors(sql, USER_ID, 20, UNRESTRICTED);

        expect(result.meta.accessDenied).toBe(false);
        expect(result.tracks).toHaveLength(1);
    });
});
