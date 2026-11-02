// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { MAX_SEARCH_QUERY_LENGTH, normalizeSearchQuery } from './helpers.js';

describe('normalizeSearchQuery', () => {
    // Subsonic's search2/search3 have no "list everything" method — clients
    // enumerate the library by asking for a query that matches all. The
    // convention is an empty query, but real clients send it quoted.
    describe('match-all detection', () => {
        it('treats an empty query as match-all', () => {
            expect(normalizeSearchQuery('')).toBe('');
        });

        it('treats a whitespace-only query as match-all', () => {
            expect(normalizeSearchQuery('   ')).toBe('');
        });

        // Symfonium 14.x sends query="" (two literal quote chars, %22%22 on the
        // wire) for every library-sync page. Regression guard: treating that as
        // a literal search term returns nothing and the client syncs 0 tracks.
        it('treats a double-quoted empty query as match-all (Symfonium)', () => {
            expect(normalizeSearchQuery('""')).toBe('');
        });

        it('treats a single-quoted empty query as match-all', () => {
            expect(normalizeSearchQuery("''")).toBe('');
        });

        it('treats a quoted whitespace-only query as match-all', () => {
            expect(normalizeSearchQuery('"   "')).toBe('');
        });
    });

    describe('real search terms', () => {
        it('passes an ordinary term through unchanged', () => {
            expect(normalizeSearchQuery('INXS')).toBe('INXS');
        });

        it('unwraps a quoted phrase to its inner text', () => {
            expect(normalizeSearchQuery('"Tight"')).toBe('Tight');
            expect(normalizeSearchQuery('"kind of dawn"')).toBe('kind of dawn');
        });

        it('trims surrounding whitespace', () => {
            expect(normalizeSearchQuery('  INXS  ')).toBe('INXS');
        });

        it('leaves quotes that are not a surrounding pair alone', () => {
            expect(normalizeSearchQuery('say "hello"')).toBe('say "hello"');
            expect(normalizeSearchQuery('"unbalanced')).toBe('"unbalanced');
            expect(normalizeSearchQuery("rock'n'roll")).toBe("rock'n'roll");
        });

        it('does not strip mismatched quote characters', () => {
            expect(normalizeSearchQuery('"mixed\'')).toBe('"mixed\'');
        });
    });

    describe('length', () => {
        it('cuts a hostile query instead of rejecting the request', () => {
            expect(normalizeSearchQuery('a'.repeat(16_000)).length).toBeLessThanOrEqual(
                MAX_SEARCH_QUERY_LENGTH,
            );
            expect(normalizeSearchQuery(`"${'a'.repeat(16_000)}"`).length).toBeLessThanOrEqual(
                MAX_SEARCH_QUERY_LENGTH,
            );
        });
    });
});
