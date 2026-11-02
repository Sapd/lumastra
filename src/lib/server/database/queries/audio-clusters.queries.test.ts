// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for audio-clusters.queries.ts.
 *
 * Tests verify the module's exported constants, the upsert write helper, and
 * the clear/count helpers using a mocked postgres.Sql.  The read queries
 * (getClusters, getClusterMembers) are covered by the SQL logic they call via
 * the builder helpers; integration tests would be needed for full SQL coverage.
 *
 * No real database connection is used.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Builder mocks — return empty sql fragments so the tagged-template calls succeed.
// ---------------------------------------------------------------------------

vi.mock('./builders/library-access.builder.js', () => ({
    buildLibraryAccessFilter: () => ({ strings: [], values: [] }),
}));

vi.mock('./builders/age-rating.builder.js', () => ({
    buildAgeRatingFilter: () => ({ strings: [], values: [] }),
}));

// ---------------------------------------------------------------------------
// Fake sql — records the template strings for verification.
// ---------------------------------------------------------------------------

type SqlCall = { strings: string[]; values: unknown[] };

function makeFakeSql(): { sql: ReturnType<typeof vi.fn>; calls: SqlCall[] } {
    const calls: SqlCall[] = [];

    // Create a function that captures query calls and supports chaining.
    const sql = vi.fn((...args: unknown[]): unknown => {
        // Tagged-template call: sql`SELECT ...`
        if (Array.isArray(args[0]) && 'raw' in (args[0] as object)) {
            const strings = args[0] as string[];
            const values = args.slice(1);
            calls.push({ strings: [...strings], values });
            return Promise.resolve([]);
        }
        // sql(matrix) bulk insert call
        if (Array.isArray(args[0]) && Array.isArray(args[0][0])) {
            return args[0]; // return as-is for interpolation
        }
        return Promise.resolve([]);
    });

    return { sql, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLUSTER_MODEL_ID', () => {
    test('equals "msclap-2023"', async () => {
        const { CLUSTER_MODEL_ID } = await import('./audio-clusters.queries.js');
        expect(CLUSTER_MODEL_ID).toBe('msclap-2023');
    });
});

describe('upsertClusterAssignments', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    test('does nothing when assignments array is empty', async () => {
        const { sql, calls } = makeFakeSql();
        const { upsertClusterAssignments } = await import('./audio-clusters.queries.js');
        await upsertClusterAssignments(
            sql as unknown as Parameters<typeof upsertClusterAssignments>[0],
            'msclap-2023',
            [],
        );
        expect(calls).toHaveLength(0);
    });

    test('executes one INSERT for a non-empty assignments array', async () => {
        const { sql } = makeFakeSql();
        const { upsertClusterAssignments } = await import('./audio-clusters.queries.js');

        const assignments = [
            { mediaId: 'aaaa-1111', clusterId: 0 },
            { mediaId: 'bbbb-2222', clusterId: 1 },
        ];

        await upsertClusterAssignments(
            sql as unknown as Parameters<typeof upsertClusterAssignments>[0],
            'msclap-2023',
            assignments,
        );

        // Should have called sql` ... ` at least once
        expect(sql).toHaveBeenCalled();
    });
});

describe('clearClusterAssignments', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    test('executes a DELETE query', async () => {
        const { sql } = makeFakeSql();
        const { clearClusterAssignments } = await import('./audio-clusters.queries.js');

        await clearClusterAssignments(
            sql as unknown as Parameters<typeof clearClusterAssignments>[0],
            'msclap-2023',
        );

        expect(sql).toHaveBeenCalledOnce();
    });
});

describe('countClusterAssignments', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    test('returns 0 when query returns no rows', async () => {
        const { sql: fakeSql } = makeFakeSql();
        // Override to return empty array (no rows)
        (fakeSql as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const { countClusterAssignments } = await import('./audio-clusters.queries.js');
        const count = await countClusterAssignments(
            fakeSql as unknown as Parameters<typeof countClusterAssignments>[0],
            'msclap-2023',
        );

        expect(count).toBe(0);
    });

    test('returns parsed integer from count row', async () => {
        const { sql: fakeSql } = makeFakeSql();
        (fakeSql as ReturnType<typeof vi.fn>).mockResolvedValue([{ count: '42' }]);

        const { countClusterAssignments } = await import('./audio-clusters.queries.js');
        const count = await countClusterAssignments(
            fakeSql as unknown as Parameters<typeof countClusterAssignments>[0],
            'msclap-2023',
        );

        expect(count).toBe(42);
    });
});

describe('getClusterCentroid', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    test('returns null when memberIds is empty', async () => {
        const { sql } = makeFakeSql();
        const { getClusterCentroid } = await import('./audio-clusters.queries.js');

        const result = await getClusterCentroid(
            sql as unknown as Parameters<typeof getClusterCentroid>[0],
            'msclap-2023',
            [],
        );

        // Empty memberIds — function returns before issuing a query.
        expect(result).toBeNull();
        expect(sql).not.toHaveBeenCalled();
    });

    test('returns null when query returns no rows', async () => {
        const { sql: fakeSql } = makeFakeSql();
        (fakeSql as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const { getClusterCentroid } = await import('./audio-clusters.queries.js');
        const result = await getClusterCentroid(
            fakeSql as unknown as Parameters<typeof getClusterCentroid>[0],
            'msclap-2023',
            ['aaaa-1111', 'bbbb-2222'],
        );

        expect(result).toBeNull();
    });

    test('returns null when centroid column is null', async () => {
        const { sql: fakeSql } = makeFakeSql();
        (fakeSql as ReturnType<typeof vi.fn>).mockResolvedValue([{ centroid: null }]);

        const { getClusterCentroid } = await import('./audio-clusters.queries.js');
        const result = await getClusterCentroid(
            fakeSql as unknown as Parameters<typeof getClusterCentroid>[0],
            'msclap-2023',
            ['aaaa-1111'],
        );

        expect(result).toBeNull();
    });

    test('parses bracketed pgvector text format correctly', async () => {
        const { sql: fakeSql } = makeFakeSql();
        (fakeSql as ReturnType<typeof vi.fn>).mockResolvedValue([
            { centroid: '[0.50000000,0.25000000,-0.75000000]' },
        ]);

        const { getClusterCentroid } = await import('./audio-clusters.queries.js');
        const result = await getClusterCentroid(
            fakeSql as unknown as Parameters<typeof getClusterCentroid>[0],
            'msclap-2023',
            ['aaaa-1111', 'bbbb-2222'],
        );

        expect(result).not.toBeNull();
        expect(result).toHaveLength(3);
        expect(result![0]).toBeCloseTo(0.5);
        expect(result![1]).toBeCloseTo(0.25);
        expect(result![2]).toBeCloseTo(-0.75);
    });

    test('issues an SQL query for non-empty memberIds', async () => {
        const { sql: fakeSql } = makeFakeSql();
        (fakeSql as ReturnType<typeof vi.fn>).mockResolvedValue([
            { centroid: '[1.00000000,0.00000000]' },
        ]);

        const { getClusterCentroid } = await import('./audio-clusters.queries.js');
        await getClusterCentroid(
            fakeSql as unknown as Parameters<typeof getClusterCentroid>[0],
            'msclap-2023',
            ['aaaa-1111'],
        );

        expect(fakeSql).toHaveBeenCalledOnce();
    });
});
