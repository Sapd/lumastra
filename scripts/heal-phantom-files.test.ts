// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for scripts/heal-phantom-files.ts.
 *
 * Run with:
 *   npm run test -- scripts/heal-phantom-files
 *
 * The script is normally driven by the production postgres connection and
 * `node:fs/promises#stat`. To test it offline we expose `healPhantomFiles`
 * with injectable `sql`, `fileExists`, and `deleteStaleMediaFile` so the
 * test can:
 *
 *   - Materialize a tmpdir of REAL files on disk.
 *   - Build an in-memory rows table that the mock `sql` returns in batches.
 *   - Provide a counting `deleteStaleMediaFile` that doesn't touch a DB.
 *
 * What we verify:
 *   - Every row is scanned across batch boundaries.
 *   - A row whose path exists is left alone.
 *   - A row whose path does not exist is reported as missing.
 *   - With apply=false, `deleteStaleMediaFile` is never called.
 *   - With apply=true, `deleteStaleMediaFile` is called exactly for the
 *     missing rows.
 *   - A delete that throws is counted as an error (the script keeps going).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type postgres from 'postgres';
import { healPhantomFiles } from './heal-phantom-files.js';

interface MockRow {
    id: string;
    file_path: string;
}

/**
 * Build a mock postgres client that handles only the two queries the
 * script issues:
 *   - First page: `SELECT id, file_path FROM media_files ORDER BY id LIMIT $1`
 *   - Subsequent: `... WHERE id > $1::uuid ORDER BY id LIMIT $2`
 *
 * The script uses tagged templates, which postgres.js executes against the
 * `sql` function. We mimic that by inspecting the template strings array
 * and dispatching based on which one is invoked.
 */
function makeMockSql(rows: MockRow[]): postgres.Sql {
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    function fn(strings: TemplateStringsArray, ...values: unknown[]): unknown {
        const joined = strings.join('?');
        // First-page query has no cursor; we look for "WHERE id >" to tell.
        const isCursor = joined.includes('WHERE id >');
        if (isCursor) {
            const cursor = values[0] as string;
            const limit = values[1] as number;
            const page = sorted.filter((r) => r.id > cursor).slice(0, limit);
            return Promise.resolve(page);
        }
        const limit = values[0] as number;
        return Promise.resolve(sorted.slice(0, limit));
    }
    return fn as unknown as postgres.Sql;
}

describe('healPhantomFiles', () => {
    let dir: string;
    const realFiles: string[] = [];
    const ghostPaths: string[] = [];
    let rows: MockRow[];

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'heal-phantom-files-'));

        // Three real files actually written to disk.
        for (let i = 0; i < 3; i++) {
            const filePath = path.join(dir, `real-${i}.mkv`);
            await writeFile(filePath, 'x');
            realFiles.push(filePath);
        }

        // Five ghost paths — never created.
        for (let i = 0; i < 5; i++) {
            ghostPaths.push(path.join(dir, `ghost-${i}.mkv`));
        }

        // Use lex-sortable UUID-ish ids so cursor pagination is deterministic
        // — the script orders by id, so id ordering must be stable.
        rows = [
            ...realFiles.map((p, i) => ({
                id: `00000000-0000-0000-0000-real${String(i).padStart(8, '0')}`,
                file_path: p,
            })),
            ...ghostPaths.map((p, i) => ({
                id: `00000000-0000-0000-0000-ghos${String(i).padStart(8, '0')}`,
                file_path: p,
            })),
        ];
    });

    afterAll(async () => {
        try {
            await rm(dir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    it('dry-run: scans every row, reports missing, does not delete', async () => {
        const deleteCalls: string[] = [];
        const result = await healPhantomFiles({
            sql: makeMockSql(rows),
            apply: false,
            batchSize: 3,
            deleteStaleMediaFile: async (_sql, filePath) => {
                deleteCalls.push(filePath);
            },
            log: () => {},
        });

        expect(result.scanned).toBe(rows.length);
        expect(result.missing).toBe(ghostPaths.length);
        expect(result.deleted).toBe(0);
        expect(result.errors).toBe(0);
        expect(deleteCalls).toEqual([]);
    });

    it('apply: calls deleteStaleMediaFile for each missing row, leaves real files alone', async () => {
        const deleteCalls: string[] = [];
        const result = await healPhantomFiles({
            sql: makeMockSql(rows),
            apply: true,
            batchSize: 4,
            deleteStaleMediaFile: async (_sql, filePath) => {
                deleteCalls.push(filePath);
            },
            log: () => {},
        });

        expect(result.scanned).toBe(rows.length);
        expect(result.missing).toBe(ghostPaths.length);
        expect(result.deleted).toBe(ghostPaths.length);
        expect(result.errors).toBe(0);
        expect(new Set(deleteCalls)).toEqual(new Set(ghostPaths));
        // Real files were never passed to deleteStaleMediaFile.
        for (const real of realFiles) {
            expect(deleteCalls).not.toContain(real);
        }
    });

    it('counts errors when deleteStaleMediaFile throws and keeps going', async () => {
        let callCount = 0;
        const result = await healPhantomFiles({
            sql: makeMockSql(rows),
            apply: true,
            batchSize: 8,
            deleteStaleMediaFile: async () => {
                callCount++;
                if (callCount === 1) {
                    throw new Error('simulated failure');
                }
            },
            log: () => {},
        });

        expect(result.missing).toBe(ghostPaths.length);
        expect(result.errors).toBe(1);
        expect(result.deleted).toBe(ghostPaths.length - 1);
    });

    it('returns clean counts when there are no rows at all', async () => {
        const result = await healPhantomFiles({
            sql: makeMockSql([]),
            apply: true,
            batchSize: 100,
            deleteStaleMediaFile: async () => {
                throw new Error('should not be called');
            },
            log: () => {},
        });
        expect(result).toEqual({
            scanned: 0,
            missing: 0,
            deleted: 0,
            errors: 0,
        });
    });

    it('honours custom fileExists predicate (used to test classifications without disk)', async () => {
        const seenPaths: string[] = [];
        const result = await healPhantomFiles({
            sql: makeMockSql(rows),
            apply: false,
            batchSize: 2,
            fileExists: async (p) => {
                seenPaths.push(p);
                // Pretend everything is missing.
                return false;
            },
            deleteStaleMediaFile: async () => {},
            log: () => {},
        });
        expect(result.missing).toBe(rows.length);
        expect(seenPaths).toHaveLength(rows.length);
    });
});
