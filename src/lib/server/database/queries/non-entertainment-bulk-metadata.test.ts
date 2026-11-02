// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for bulkUpdateCustomMetadata.
 * These test the shape/contract of the query function using a sql mock.
 * Integration tests (real DB) would go in a *.integration.test.ts file.
 */

import { describe, it, expect, vi } from 'vitest';
import { bulkUpdateCustomMetadata } from './non-entertainment-browse.queries.js';

/**
 * Build a minimal postgres.Sql mock that returns an object with a `count`
 * property and supports `.json()` tagging.
 */
function makeSqlMock(count: number) {
    // The tagged template literal call returns the mock result object
    const sql = vi.fn().mockImplementation((..._args: unknown[]) => {
        const result = Object.assign([], { count });
        return Promise.resolve(result);
    }) as unknown as Parameters<typeof bulkUpdateCustomMetadata>[0];

    // postgres.Sql also exposes a .json() helper that we call inside the query
    (sql as unknown as Record<string, unknown>).json = vi.fn().mockReturnValue('"__json__"');

    return sql;
}

describe('bulkUpdateCustomMetadata', () => {
    it('returns 0 without calling sql when ids array is empty', async () => {
        const sql = makeSqlMock(5);
        const result = await bulkUpdateCustomMetadata(sql, [], { department: 'HR' });
        expect(result).toBe(0);
        // The tagged template should NOT have been called
        expect(sql).not.toHaveBeenCalled();
    });

    it('returns the count from the sql result when ids are provided', async () => {
        const sql = makeSqlMock(3);
        const ids = [
            '11111111-0000-0000-0000-000000000001',
            '11111111-0000-0000-0000-000000000002',
            '11111111-0000-0000-0000-000000000003',
        ];
        const result = await bulkUpdateCustomMetadata(sql, ids, { department: 'Compliance' });
        expect(result).toBe(3);
        // The tagged template should have been called once
        expect(sql).toHaveBeenCalledTimes(1);
    });
});
