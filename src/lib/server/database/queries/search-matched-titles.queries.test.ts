// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

vi.mock('./builders/library-access.builder.js', () => ({ buildLibraryAccessFilter: () => '' }));
vi.mock('./builders/age-rating.builder.js', () => ({ buildSeriesOwnedAgeRatingFilter: () => '' }));
vi.mock('../../utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { unrestrictedAccess, denyAllAccess } from './builders/media-access-boundary.js';
import {
    decorateSearchMatchedTitles,
    storedSearchTitles,
    MATCHED_TITLE_STATEMENT_TIMEOUT_MS,
} from './search-matched-titles.queries.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

interface Captured {
    values: unknown[];
    unsafe: string[];
}

function fakeSql(rows: Array<{ media_id: string; title: string }> | Error): {
    sql: postgres.Sql;
    captured: Captured;
    begin: ReturnType<typeof vi.fn>;
} {
    const captured: Captured = { values: [], unsafe: [] };
    const tx = Object.assign(
        async (_strings: TemplateStringsArray, ...values: unknown[]) => {
            captured.values = values;
            if (rows instanceof Error) throw rows;
            return rows;
        },
        {
            unsafe: async (statement: string) => {
                captured.unsafe.push(statement);
            },
        },
    );
    const begin = vi.fn(async (fn: (trx: unknown) => Promise<unknown>) => fn(tx));
    return { sql: { begin } as unknown as postgres.Sql, captured, begin };
}

const item = (
    id: string,
    title: string,
): { id: string; type: string; title: string; matchedTitle?: string } => ({
    id,
    type: 'series',
    title,
});

describe('storedSearchTitles', () => {
    beforeEach(() => vi.clearAllMocks());

    it('is bounded to the given ids and runs under a short local statement_timeout', async () => {
        const { sql, captured, begin } = fakeSql([{ media_id: A, title: 'Eine lausige Hexe' }]);
        await storedSearchTitles(sql, [A], unrestrictedAccess(), 'lausige');
        expect(begin).toHaveBeenCalledTimes(1);
        expect(captured.unsafe).toEqual([
            `SET LOCAL statement_timeout = ${MATCHED_TITLE_STATEMENT_TIMEOUT_MS}`,
        ]);
        expect(captured.values).toContainEqual([A]);
        expect(MATCHED_TITLE_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(500);
    });

    it('skips the database when there is nothing to look up', async () => {
        const { sql, begin } = fakeSql([]);
        expect(await storedSearchTitles(sql, [], unrestrictedAccess(), 'lausige')).toEqual([]);
        expect(await storedSearchTitles(sql, [A], denyAllAccess(), 'lausige')).toEqual([]);
        expect(await storedSearchTitles(sql, [A], unrestrictedAccess(), 'x')).toEqual([]);
        expect(begin).not.toHaveBeenCalled();
    });
});

describe('decorateSearchMatchedTitles', () => {
    it('only looks up catalog UUID ids of the returned items', async () => {
        const { sql, captured } = fakeSql([]);
        await decorateSearchMatchedTitles(
            sql,
            [item(A, 'One'), { id: B, type: 'track', title: 'Song' }, item('tmdb:1:movie', 'X')],
            'query',
            unrestrictedAccess(),
        );
        expect(captured.values).toContainEqual([A]);
    });

    it('lets the SQL-ranked match win over the in-process selector', async () => {
        // SQL ranked "Hexe Spezial Edition" first; the JS selector alone would prefer the exact
        // shorter title. The SQL order is authoritative.
        const { sql } = fakeSql([
            { media_id: A, title: 'Hexe Spezial Edition' },
            { media_id: A, title: 'Hexe' },
        ]);
        const [out] = await decorateSearchMatchedTitles(
            sql,
            [item(A, 'The Worst Witch')],
            'Hexe',
            unrestrictedAccess(),
        );
        expect(out.matchedTitle).toBe('Hexe Spezial Edition');
    });

    it('never claims a match SQL did not return', async () => {
        const { sql } = fakeSql([]);
        const [out] = await decorateSearchMatchedTitles(
            sql,
            [item(A, 'The Worst Witch')],
            'Eine lausige Hexe',
            unrestrictedAccess(),
        );
        expect(out).not.toHaveProperty('matchedTitle');
    });

    it('omits the explanation when the displayed title already matches or equals the alias', async () => {
        const { sql } = fakeSql([
            { media_id: A, title: 'The Worst Witch' },
            { media_id: B, title: 'The Worst Witch' },
        ]);
        const out = await decorateSearchMatchedTitles(
            sql,
            [item(A, 'Worst Witch Primary'), item(B, 'the worst witch')],
            'worst witch',
            unrestrictedAccess(),
        );
        expect(out[0]).not.toHaveProperty('matchedTitle');
        expect(out[1]).not.toHaveProperty('matchedTitle');
    });

    it('returns clones without decoration when the lookup times out or fails', async () => {
        const { sql } = fakeSql(new Error('canceling statement due to statement timeout'));
        const source = Object.freeze({ id: A, type: 'series', title: 'T', matchedTitle: 'stale' });
        const out = await decorateSearchMatchedTitles(sql, [source], 'q1', unrestrictedAccess());
        expect(out).toHaveLength(1);
        expect(out[0]).not.toBe(source);
        expect(out[0]).not.toHaveProperty('matchedTitle');
        expect(out[0].title).toBe('T');
    });
});
