// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * SQL ASSEMBLY tests for the audiobook browse free-text filter — no database.
 *
 * Two defects live in this one small function, and neither is visible to the
 * layers above it.
 *
 * 1. **Semantics.** It used to match the whole query as ONE `%…%`, so every
 *    query whose words are not adjacent returned nothing: "potter fire" and
 *    "potter feuer" both scored zero against a shelf that plainly contains
 *    Milo Farrow, while the infix "feuerkel" matched "Feuerkelch" fine. The
 *    tests below pin the term-wise AND that replaced it.
 *
 * 2. **Assembly.** The fix composes one fragment per term, and postgres.js
 *    concatenates `${a}${b}` with NOTHING between them — a fragment ending in a
 *    bound value emits `$3AND (…)`, which Postgres rejects at parse time with
 *    `trailing junk after parameter`. Unit tests mock this module wholesale and
 *    the integration suite does not cover the multi-term case, so the guard has
 *    to be here: build the real fragment against a NON-CONNECTING postgres.js
 *    instance and inspect the SQL it would have sent. postgres.js builds the
 *    wire string lazily and only connects on `await`, so nothing here opens a
 *    socket.
 *
 * Renderer mirrors `assistant-rag.sql-assembly.test.ts`, including its
 * splice-with-no-separator behaviour — that splice IS the trap, so reproducing
 * it faithfully is what keeps this stand-in honest.
 */

import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import { searchPredicate } from './audiobook-browse.queries.js';

/** A postgres.js instance that is never awaited, so it never connects. */
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

/** Render the SQL text a fragment would produce, splicing nested fragments in
 *  with no separator exactly as postgres.js does. */
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
    return out;
}

/** Every bound value, in order, flattened across nested fragments. */
function collectArgs(query: unknown, out: unknown[] = []): unknown[] {
    if (!isBuiltQuery(query)) return out;
    for (const arg of query.args) {
        if (isBuiltQuery(arg)) collectArgs(arg, out);
        else out.push(arg);
    }
    return out;
}

const FIELDS = [
    'mi.title',
    'mi.sort_title',
    "mi.custom_metadata #>> '{audiobookshelf,derivedSeries,name}'",
    "mi.custom_metadata #>> '{audiobookshelf,authors}'",
    "mi.custom_metadata #>> '{audiobookshelf,narrators}'",
];

describe('audiobook browse searchPredicate — assembly', () => {
    it('never emits a parameter glued to the following keyword', () => {
        // THE regression this file exists for. `$3AND` is not a typo the
        // renderer could produce on its own — it is what postgres.js sends when
        // two value-ending fragments sit next to each other.
        const rendered = renderSql(searchPredicate(sql, 'milo farrow goblet fire'));
        expect(rendered).not.toMatch(/\$\d+[A-Za-z]/);
    });

    it('separates every term clause with an explicit AND', () => {
        const rendered = renderSql(searchPredicate(sql, 'potter fire'));
        // Two term clauses → exactly one joining AND between them, on top of
        // the leading `AND (` the caller splices into its WHERE.
        expect(rendered.trimStart().startsWith('AND (')).toBe(true);
        expect(rendered).toMatch(/\)\s+AND\s+\(/);
    });
});

describe('audiobook browse searchPredicate — semantics', () => {
    it('is empty for a missing or whitespace-only query', () => {
        expect(renderSql(searchPredicate(sql, undefined))).toBe('');
        expect(renderSql(searchPredicate(sql, '   '))).toBe('');
    });

    it('binds one pattern per term, not one for the whole string', () => {
        // The bug in one assertion: the old predicate bound `%potter fire%`,
        // which no title contains.
        const args = collectArgs(searchPredicate(sql, 'potter fire'));
        expect(new Set(args)).toEqual(new Set(['%potter%', '%fire%']));
        expect(args).not.toContain('%potter fire%');
    });

    it('checks every term against every field, so terms may match different fields', () => {
        // "king shining" must find The Glimmer by Stephen King — one term
        // matching the title and the other the author list.
        const rendered = renderSql(searchPredicate(sql, 'king shining'));
        for (const field of FIELDS) {
            // Once per term.
            expect(rendered.split(field).length - 1).toBe(2);
        }
    });

    it('keeps substring (not prefix) matching per term', () => {
        // What makes "feuerkel" find "Feuerkelch" and "king" find "Stephen
        // King" inside the jsonb text form of `["Stephen King"]`.
        expect(collectArgs(searchPredicate(sql, 'feuerkel'))).toEqual(
            Array.from({ length: FIELDS.length }, () => '%feuerkel%'),
        );
    });

    it('is order-independent — the two orderings bind the same patterns', () => {
        const a = new Set(collectArgs(searchPredicate(sql, 'potter goblet')));
        const b = new Set(collectArgs(searchPredicate(sql, 'goblet potter')));
        expect(a).toEqual(b);
    });

    it('escapes LIKE wildcards per term so they match literally', () => {
        // A user typing `%` searches for a percent sign; unescaped it would
        // match every row in the library.
        const args = collectArgs(searchPredicate(sql, '50% off_er'));
        expect(new Set(args)).toEqual(new Set(['%50\\%%', '%off\\_er%']));
    });

    it('collapses runs of whitespace instead of emitting empty terms', () => {
        const args = collectArgs(searchPredicate(sql, '  potter \t\n  fire  '));
        expect(new Set(args)).toEqual(new Set(['%potter%', '%fire%']));
    });

    it('caps the term count so a long query cannot fan out unbounded', () => {
        // Terms past the cap are dropped, which WIDENS the result set — the
        // conservative direction for a filter. 20 terms in, 12 distinct
        // patterns out.
        const query = Array.from({ length: 20 }, (_, i) => `t${i}`).join(' ');
        const distinct = new Set(collectArgs(searchPredicate(sql, query)));
        expect(distinct.size).toBe(12);
        expect(distinct.has('%t11%')).toBe(true);
        expect(distinct.has('%t12%')).toBe(false);
    });
});
