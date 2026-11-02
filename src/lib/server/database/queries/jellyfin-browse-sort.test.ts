// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin `SortBy` / `SortOrder` parsing and the ORDER BY it renders — no
 * database. Semantics follow Jellyfin's RequestHelpers.GetOrderBy and
 * OrderMapper (origin/master).
 */

import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { buildBrowseOrderBy, parseJellyfinSort } from './jellyfin-browse.queries.js';
import { toUserId } from '$lib/shared/user-id';

/** Never awaited, so it never connects. */
const sql = postgres({ host: '127.0.0.1', port: 1, max: 1 });

interface BuiltQuery {
    strings: string[];
    args: unknown[];
}

function isBuiltQuery(value: unknown): value is BuiltQuery {
    return (
        typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as BuiltQuery).strings) &&
        Array.isArray((value as BuiltQuery).args)
    );
}

function renderSql(query: unknown, counter = { n: 0 }): string {
    if (!isBuiltQuery(query)) return '';
    let out = '';
    query.strings.forEach((part, i) => {
        out += part;
        if (i < query.args.length) {
            const arg = query.args[i];
            out += isBuiltQuery(arg) ? renderSql(arg, counter) : `$${++counter.n}`;
        }
    });
    return out.replace(/\s+/g, ' ');
}

const GLUED_PARAMETER = /\$\d+[A-Za-z]/;
const USER = toUserId('00000000-0000-0000-0000-000000000001');

describe('parseJellyfinSort', () => {
    it('pairs each key with its own order', () => {
        expect(parseJellyfinSort('DateCreated,SortName', 'Descending,Ascending')).toEqual([
            { key: 'DateCreated', descending: true },
            { key: 'SortName', descending: false },
        ]);
    });

    it('applies the first order to keys beyond the order list', () => {
        expect(
            parseJellyfinSort('SeriesSortName,ParentIndexNumber,IndexNumber', 'Descending'),
        ).toEqual([
            { key: 'SeriesSortName', descending: true },
            { key: 'ParentIndexNumber', descending: true },
            { key: 'IndexNumber', descending: true },
        ]);
    });

    it('defaults to ascending without SortOrder', () => {
        expect(parseJellyfinSort('ProductionYear', null)).toEqual([
            { key: 'ProductionYear', descending: false },
        ]);
    });

    it('skips unknown keys without dropping the known ones or shifting their order', () => {
        expect(
            parseJellyfinSort('Budget,DateCreated,Bogus,Runtime', 'Ascending,Descending'),
        ).toEqual([
            { key: 'DateCreated', descending: true },
            { key: 'Runtime', descending: false },
        ]);
    });

    it('matches keys and orders case-insensitively and ignores blanks/duplicates', () => {
        expect(parseJellyfinSort(' sortname , ,SORTNAME,communityrating', 'descending')).toEqual([
            { key: 'SortName', descending: true },
            { key: 'CommunityRating', descending: true },
        ]);
    });

    it('returns no specs for an empty or all-unknown SortBy', () => {
        expect(parseJellyfinSort(null, 'Descending')).toEqual([]);
        expect(parseJellyfinSort('Budget,Revenue', null)).toEqual([]);
    });
});

describe('buildBrowseOrderBy', () => {
    const render = (sortBy: string | null, sortOrder: string | null): string =>
        renderSql(buildBrowseOrderBy(sql, parseJellyfinSort(sortBy, sortOrder), USER));

    it('emits one term per key in order, with the SortName + id tiebreak', () => {
        const out = render('DateCreated,ProductionYear', 'Descending,Ascending');
        const created = out.indexOf('mi.created_at DESC NULLS LAST');
        const year = out.indexOf('mi.year ASC NULLS FIRST');
        expect(created).toBeGreaterThanOrEqual(0);
        expect(year).toBeGreaterThan(created);
        expect(out.trimEnd().endsWith('mi.id ASC')).toBe(true);
        expect(out).toContain("NULLIF(mi.sort_title, '')");
    });

    it('does not append a second SortName tiebreak when SortName is a key', () => {
        const out = render('SortName', 'Descending');
        expect(out.match(/NULLIF\(mi\.sort_title, ''\)/g)).toHaveLength(1);
        expect(out).toContain('DESC NULLS LAST');
    });

    it('falls back to SortName ascending when no key is usable', () => {
        const out = render('Budget', 'Descending');
        expect(out).toContain("NULLIF(mi.sort_title, '')");
        expect(out).not.toContain('DESC');
    });

    it('sorts episodes in season/episode order under SortName', () => {
        const out = render('SortName', null);
        expect(out).toMatch(/lpad\(COALESCE\(eo\.order_season_number, mi\.season_number, 0\)/);
    });

    it.each([
        'SortName',
        'Name',
        'DateCreated',
        'PremiereDate',
        'ProductionYear',
        'CommunityRating',
        'CriticRating',
        'OfficialRating',
        'Runtime',
        'DatePlayed',
        'PlayCount',
        'Random',
        'SeriesSortName',
        'IndexNumber',
        'ParentIndexNumber',
        'AirTime',
        'StartDate',
        'IsFolder',
        'IsFavoriteOrLiked',
        'IsPlayed',
        'IsUnplayed',
    ])('renders valid SQL for %s in both directions', (key) => {
        for (const order of ['Ascending', 'Descending']) {
            const out = render(`${key},SortName`, order);
            expect(out).not.toMatch(GLUED_PARAMETER);
            expect(out.length).toBeGreaterThan(10);
        }
    });

    it('passes the user id as a bound parameter, never inline', () => {
        const out = render('DatePlayed,PlayCount', 'Descending');
        expect(out).not.toContain(USER);
        expect(out).toMatch(/_u\.user_id = \$\d+::uuid/);
    });
});
