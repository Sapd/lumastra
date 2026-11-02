// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi } from 'vitest';
import postgres from 'postgres';
import { getTracksByIds, buildMoodMatchSql } from './music.queries';

/**
 * Minimal shape of a postgres.js tagged-template fragment, sufficient to
 * walk `strings`/`args` recursively without executing any query. Nested
 * fragments (from composed `sql\`...\`` calls) appear as further Fragment
 * objects in `args` rather than plain values.
 */
interface Fragment {
    strings?: readonly string[];
    args?: readonly unknown[];
}

function isFragment(value: unknown): value is Fragment {
    return (
        typeof value === 'object' && value !== null && Array.isArray((value as Fragment).strings)
    );
}

/** Flattens a (possibly nested) postgres.js fragment into SQL text + bound values, without executing it. */
function flattenFragment(frag: Fragment): { text: string; values: unknown[] } {
    const args = frag.args ?? [];
    let text = '';
    const values: unknown[] = [];
    frag.strings!.forEach((part, i) => {
        text += part;
        if (i < args.length) {
            const arg = args[i];
            if (isFragment(arg)) {
                const nested = flattenFragment(arg);
                text += nested.text;
                values.push(...nested.values);
            } else {
                values.push(arg);
            }
        }
    });
    return { text, values };
}

type TrackRow = {
    id: string;
    title: string;
    sort_order: number | null;
    runtime_seconds: number | null;
    custom_poster_url: string | null;
    custom_metadata: Record<string, unknown>;
    album_id: string;
    album_title: string;
    album_custom_poster_url: string | null;
    artist_id: string | null;
    artist_title: string | null;
    year: number | null;
};

function makeSqlStub(rows: TrackRow[]): postgres.Sql {
    const fn = vi.fn().mockResolvedValue(rows);
    return fn as unknown as postgres.Sql;
}

describe('getTracksByIds', () => {
    test('returns empty array for empty input without calling SQL', async () => {
        const fn = vi.fn();
        const sql = fn as unknown as postgres.Sql;
        const result = await getTracksByIds(sql, []);
        expect(result).toEqual([]);
        expect(fn).not.toHaveBeenCalled();
    });

    test('calls SQL with the provided ID list and returns rows in caller-specified order', async () => {
        const rows: TrackRow[] = [
            {
                id: 't2',
                title: 'Song B',
                sort_order: null,
                runtime_seconds: 200,
                custom_poster_url: null,
                custom_metadata: {},
                album_id: 'a1',
                album_title: 'Album',
                album_custom_poster_url: null,
                artist_id: 'ar1',
                artist_title: 'Artist',
                year: 2020,
            },
            {
                id: 't1',
                title: 'Song A',
                sort_order: null,
                runtime_seconds: 180,
                custom_poster_url: null,
                custom_metadata: {},
                album_id: 'a1',
                album_title: 'Album',
                album_custom_poster_url: null,
                artist_id: 'ar1',
                artist_title: 'Artist',
                year: 2020,
            },
        ];
        const sql = makeSqlStub(rows);
        const result = await getTracksByIds(sql, ['t1', 't2']);
        expect(result.map((r) => r.id)).toEqual(['t1', 't2']);
    });

    test('silently drops IDs that the DB did not return', async () => {
        const rows: TrackRow[] = [
            {
                id: 't1',
                title: 'Song A',
                sort_order: null,
                runtime_seconds: 180,
                custom_poster_url: null,
                custom_metadata: {},
                album_id: 'a1',
                album_title: 'Album',
                album_custom_poster_url: null,
                artist_id: 'ar1',
                artist_title: 'Artist',
                year: 2020,
            },
        ];
        const sql = makeSqlStub(rows);
        const result = await getTracksByIds(sql, ['t1', 't2', 't3']);
        expect(result.map((r) => r.id)).toEqual(['t1']);
    });
});

describe('buildMoodMatchSql key scale bonus', () => {
    // A real (unconnected) postgres.js Sql instance — postgres.js connects
    // lazily, so building tagged-template fragments never touches the
    // network. This lets us inspect the generated SQL text/params for the
    // keyBonus branch without a live DB (see
    // builders/external-id-subquery.builder.test.ts for the same pattern).
    const sql = postgres('postgres://localhost/does-not-need-to-exist');

    test('minor mood (e.g. "sad") emits a single LIKE %m check, not an unsatisfiable AND', () => {
        // Previously generated `LIKE '%m' AND ... NOT LIKE '%'`, and
        // `NOT LIKE '%'` is always false, so the bonus could never apply.
        const { text, values } = flattenFragment(buildMoodMatchSql(sql, 'sad') as Fragment);
        expect(text).toContain('LIKE');
        expect(text).not.toContain('NOT LIKE');
        expect(values).toContain('%m');
    });

    test('major mood (e.g. "happy") emits NOT LIKE %m (key does not end in "m")', () => {
        const { text, values } = flattenFragment(buildMoodMatchSql(sql, 'happy') as Fragment);
        expect(text).toContain('NOT LIKE');
        expect(values).toContain('%m');
    });

    test('mood without a keyScale (e.g. "workout") has no key-bonus clause at all', () => {
        const { text } = flattenFragment(buildMoodMatchSql(sql, 'workout') as Fragment);
        expect(text).not.toMatch(/LIKE/);
    });

    test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
        'the inherited key %j falls back to taste instead of throwing',
        (key) => {
            const { text } = flattenFragment(buildMoodMatchSql(sql, key) as Fragment);
            expect(text.trim()).toBe('0.0');
        },
    );

    test('unknown mood returns a flat 0.0 expression', () => {
        const { text } = flattenFragment(buildMoodMatchSql(sql, 'not-a-real-mood') as Fragment);
        expect(text.trim()).toBe('0.0');
    });
});
