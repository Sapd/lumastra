// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for media-access-batch
 *
 * Tests batch media access filtering with mocked postgres SQL.
 */

import { describe, it, expect, vi } from 'vitest';
import { filterAccessibleMediaIds, filterAccessibleRows } from './media-access-batch';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary';
import type { Sql } from 'postgres';

function createMockSql(returnRows: Array<{ id: string }> = []): Sql {
    const mockFn = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
        return Promise.resolve(returnRows);
    });
    return mockFn as unknown as Sql;
}

/** Count executed reads, not the composable SQL fragments used to build them. */
function expectDatabaseRead(sql: Sql): void {
    if (!vi.isMockFunction(sql)) throw new Error('Expected a SQL mock');
    const reads = sql.mock.calls.filter(
        ([strings]) => Array.isArray(strings) && strings.join(' ').includes('FROM media_items mi'),
    );
    expect(reads).toHaveLength(1);
}

// ---------------------------------------------------------------------------
// filterAccessibleMediaIds
// ---------------------------------------------------------------------------

describe('filterAccessibleMediaIds', () => {
    it('returns empty Set for empty mediaIds', async () => {
        const sql = createMockSql();
        const result = await filterAccessibleMediaIds(sql, [], unrestrictedAccess());
        expect(result.size).toBe(0);
        expect(sql).not.toHaveBeenCalled();
    });

    it('returns all ids untouched when access is unrestricted', async () => {
        const sql = createMockSql();
        const ids = ['uuid-1', 'uuid-2', 'uuid-3'];
        const result = await filterAccessibleMediaIds(sql, ids, unrestrictedAccess());
        expect(result).toEqual(new Set(ids));
        expect(sql).not.toHaveBeenCalled();
    });

    it('queries the database when the library axis is denyGroups', async () => {
        const ids = ['a', 'b', 'c'];
        const sql = createMockSql([{ id: 'a' }, { id: 'c' }]);
        const result = await filterAccessibleMediaIds(
            sql,
            ids,
            restrictedAccess({
                deniedGroupIds: ['group-1'],
                maxAgeRating: null,
                allowUnrated: false,
            }),
        );
        expectDatabaseRead(sql);
        expect(result).toEqual(new Set(['a', 'c']));
    });

    it('queries the database when the age axis is a limit', async () => {
        const ids = ['x', 'y', 'z'];
        const sql = createMockSql([{ id: 'y' }]);
        const result = await filterAccessibleMediaIds(
            sql,
            ids,
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 13, allowUnrated: false }),
        );
        expectDatabaseRead(sql);
        expect(result).toEqual(new Set(['y']));
    });

    it('queries the database when both axes are restricted', async () => {
        const ids = ['id-1', 'id-2', 'id-3', 'id-4'];
        const sql = createMockSql([{ id: 'id-1' }, { id: 'id-3' }]);
        const result = await filterAccessibleMediaIds(
            sql,
            ids,
            restrictedAccess({
                deniedGroupIds: ['grp-a', 'grp-b'],
                maxAgeRating: 18,
                allowUnrated: true,
            }),
        );
        expectDatabaseRead(sql);
        expect(result).toEqual(new Set(['id-1', 'id-3']));
    });

    it('returns empty Set when SQL returns no rows', async () => {
        const ids = ['a', 'b'];
        const sql = createMockSql([]);
        const result = await filterAccessibleMediaIds(
            sql,
            ids,
            restrictedAccess({ deniedGroupIds: ['grp'], maxAgeRating: null, allowUnrated: false }),
        );
        expect(result.size).toBe(0);
    });

    it('collapses an empty denied-group list to unrestricted library access', async () => {
        // restrictedAccess normalises `deniedGroupIds: []` to `{ kind: 'all' }`,
        // so only the age fragment is active — matching the legacy builder, which
        // emitted no library predicate for an empty list either.
        const ids = ['a', 'b'];
        const sql = createMockSql([]);
        const result = await filterAccessibleMediaIds(
            sql,
            ids,
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 18, allowUnrated: true }),
        );
        expectDatabaseRead(sql);
        expect(result).toEqual(new Set([]));
    });

    it('collapses a null maxAgeRating to unrestricted age access', async () => {
        const ids = ['a', 'b'];
        const sql = createMockSql([{ id: 'a' }]);
        const result = await filterAccessibleMediaIds(
            sql,
            ids,
            restrictedAccess({ deniedGroupIds: ['grp'], maxAgeRating: null, allowUnrated: true }),
        );
        // No age bound means no age fragment — only the library filter runs.
        expectDatabaseRead(sql);
        expect(result).toEqual(new Set(['a']));
    });

    // -----------------------------------------------------------------------
    // Regression: a boundary that is restricted-but-emits-no-predicate must
    // still hit the database.
    //
    // The unrestricted fast path is keyed on `{ all, any }` ONLY. A hand-written
    // `denyGroups` with an empty id list denies nothing and therefore emits no
    // predicate, but it is NOT `{ kind: 'all' }` — it must fall through to
    // `SELECT mi.id FROM media_items WHERE mi.id = ANY(...)`, which doubles as an
    // existence check and drops ids whose media_items row is gone. Short-circuiting
    // it would make this security filter start *returning* dangling ids (cached
    // lists and watch_history rows outlive their media_items row).
    // -----------------------------------------------------------------------

    it('still queries (existence check) for a denyGroups boundary with an empty id list', async () => {
        // 'ghost' is absent from media_items — the query must drop it.
        const sql = createMockSql([{ id: 'real' }]);
        const result = await filterAccessibleMediaIds(sql, ['real', 'ghost'], {
            library: { kind: 'denyGroups', ids: [] },
            age: { kind: 'any' },
        });
        expect(sql).toHaveBeenCalled();
        expect(result).toEqual(new Set(['real']));
    });

    it('emits NO access predicates for that shape — only the id existence check', async () => {
        const fragments: string[] = [];
        const sqlFn = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
            fragments.push(strings.join('?'));
            return Promise.resolve([{ id: 'real' }]);
        });
        const sql = sqlFn as unknown as Sql;
        await filterAccessibleMediaIds(sql, ['real', 'ghost'], {
            library: { kind: 'denyGroups', ids: [] },
            age: { kind: 'any' },
        });
        const joined = fragments.join('\n');
        expect(joined).toContain('FROM media_items mi');
        expect(joined).toContain('mi.id = ANY(');
        // Neither axis contributes a predicate.
        expect(joined).not.toContain('library_group_id');
        expect(joined).not.toContain('age_rating');
    });

    it('propagates a readonly array of ids', async () => {
        const ids = Object.freeze(['id-1', 'id-2']) as readonly string[];
        const sql = createMockSql([{ id: 'id-1' }]);
        const result = await filterAccessibleMediaIds(
            sql,
            ids,
            restrictedAccess({ deniedGroupIds: ['grp'], maxAgeRating: null, allowUnrated: false }),
        );
        expect(result).toEqual(new Set(['id-1']));
    });
});

// ---------------------------------------------------------------------------
// filterAccessibleMediaIds — new boundary shape
// ---------------------------------------------------------------------------

describe('filterAccessibleMediaIds with a MediaAccessBoundary', () => {
    it('returns all ids for an explicitly unrestricted boundary', async () => {
        const sql = createMockSql();
        const ids = ['a', 'b'];
        const result = await filterAccessibleMediaIds(sql, ids, unrestrictedAccess());
        expect(result).toEqual(new Set(ids));
        expect(sql).not.toHaveBeenCalled();
    });

    it('returns NOTHING for a denyAll boundary and never touches the database', async () => {
        // Regression guard: the old fast path short-circuited on "both fields
        // null" and would have handed a deny-everything caller every id.
        const sql = createMockSql([{ id: 'a' }, { id: 'b' }]);
        const result = await filterAccessibleMediaIds(sql, ['a', 'b'], denyAllAccess());
        expect(result.size).toBe(0);
        expect(sql).not.toHaveBeenCalled();
    });

    it('returns nothing when only the library axis is denyAll', async () => {
        const sql = createMockSql([{ id: 'a' }]);
        const result = await filterAccessibleMediaIds(sql, ['a'], {
            library: { kind: 'denyAll' },
            age: { kind: 'any' },
        });
        expect(result.size).toBe(0);
        expect(sql).not.toHaveBeenCalled();
    });

    it('returns nothing when only the age axis is denyAll', async () => {
        const sql = createMockSql([{ id: 'a' }]);
        const result = await filterAccessibleMediaIds(sql, ['a'], {
            library: { kind: 'all' },
            age: { kind: 'denyAll' },
        });
        expect(result.size).toBe(0);
        expect(sql).not.toHaveBeenCalled();
    });

    it('queries the database for a genuinely restricted boundary', async () => {
        const sql = createMockSql([{ id: 'a' }]);
        const result = await filterAccessibleMediaIds(
            sql,
            ['a', 'b'],
            restrictedAccess({
                deniedGroupIds: ['grp'],
                maxAgeRating: 13,
                allowUnrated: false,
            }),
        );
        expectDatabaseRead(sql);
        expect(result).toEqual(new Set(['a']));
    });

    it('short-circuits denyAll before the empty-ids check is irrelevant', async () => {
        const sql = createMockSql();
        const result = await filterAccessibleMediaIds(sql, [], denyAllAccess());
        expect(result.size).toBe(0);
        expect(sql).not.toHaveBeenCalled();
    });
});

describe('filterAccessibleRows with a MediaAccessBoundary', () => {
    it('drops every row for a denyAll boundary', async () => {
        const sql = createMockSql([{ id: 'r1' }]);
        const rows = [
            { id: 'r1', title: 'A' },
            { id: 'r2', title: 'B' },
        ];
        const result = await filterAccessibleRows(sql, rows, denyAllAccess());
        expect(result).toEqual([]);
        expect(sql).not.toHaveBeenCalled();
    });

    it('keeps every row for an unrestricted boundary', async () => {
        const sql = createMockSql();
        const rows = [{ id: 'r1', title: 'A' }];
        const result = await filterAccessibleRows(sql, rows, unrestrictedAccess());
        expect(result).toEqual(rows);
        expect(sql).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// filterAccessibleRows
// ---------------------------------------------------------------------------

describe('filterAccessibleRows', () => {
    it('returns empty array for empty rows', async () => {
        const sql = createMockSql();
        const result = await filterAccessibleRows(sql, [], unrestrictedAccess());
        expect(result).toEqual([]);
        expect(sql).not.toHaveBeenCalled();
    });

    it('returns all rows untouched when access is unrestricted', async () => {
        const sql = createMockSql();
        const rows = [
            { id: 'r1', title: 'A' },
            { id: 'r2', title: 'B' },
        ];
        const result = await filterAccessibleRows(sql, rows, unrestrictedAccess());
        expect(result).toEqual(rows);
        expect(sql).not.toHaveBeenCalled();
    });

    it('filters rows by allowed ids from SQL result', async () => {
        const sql = createMockSql([{ id: 'r2' }]);
        const rows = [
            { id: 'r1', title: 'A' },
            { id: 'r2', title: 'B' },
            { id: 'r3', title: 'C' },
        ];
        const result = await filterAccessibleRows(
            sql,
            rows,
            restrictedAccess({ deniedGroupIds: ['grp'], maxAgeRating: null, allowUnrated: false }),
        );
        expectDatabaseRead(sql);
        expect(result).toEqual([{ id: 'r2', title: 'B' }]);
    });

    it('preserves row order from input', async () => {
        const sql = createMockSql([{ id: 'c' }, { id: 'a' }]);
        const rows = [
            { id: 'a', val: 1 },
            { id: 'b', val: 2 },
            { id: 'c', val: 3 },
        ];
        const result = await filterAccessibleRows(
            sql,
            rows,
            restrictedAccess({ deniedGroupIds: ['grp'], maxAgeRating: 13, allowUnrated: false }),
        );
        // Input order is a, b, c — only a and c are allowed
        expect(result).toEqual([
            { id: 'a', val: 1 },
            { id: 'c', val: 3 },
        ]);
    });

    it('returns empty array when no rows are allowed', async () => {
        const sql = createMockSql([]);
        const rows = [{ id: 'x', data: 1 }];
        const result = await filterAccessibleRows(
            sql,
            rows,
            restrictedAccess({ deniedGroupIds: ['grp'], maxAgeRating: null, allowUnrated: false }),
        );
        expect(result).toEqual([]);
    });
});
