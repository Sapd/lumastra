// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for text-sound-search.queries.ts.
 *
 * Tests mock the postgres.Sql instance — no real database is needed.
 * The suite verifies:
 *   - The function is exported and callable.
 *   - It invokes the sql tagged-template (i.e. issues a query).
 *   - It returns whatever the sql stub resolves with.
 *   - It returns an empty array when the sql stub resolves with [].
 *   - The TextSoundSearchRow interface allows null optional fields.
 */

import { describe, test, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { textSoundSearch, type TextSoundSearchRow } from './text-sound-search.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNRESTRICTED = unrestrictedAccess();

/** Fake 1024-dim float vector (all zeros, fast to construct). */
function fakeVector(dim = 1024): number[] {
    return Array.from({ length: dim }, (_, i) => i / dim);
}

/**
 * Build a fake postgres.Sql tag that returns the given rows when called as a
 * template literal. The stub handles both the main query call and fragment
 * builder calls from library-access and age-rating builders.
 */
function makeSqlStub(rows: TextSoundSearchRow[]): postgres.Sql {
    const thenableRows = Object.assign(Promise.resolve(rows), {});
    const stub = vi.fn().mockReturnValue(thenableRows);
    return stub as unknown as postgres.Sql;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('textSoundSearch', () => {
    test('is exported as a function', () => {
        expect(typeof textSoundSearch).toBe('function');
    });

    test('returns empty array when sql resolves with no rows', async () => {
        const sql = makeSqlStub([]);
        const result = await textSoundSearch(sql, fakeVector(), 10, UNRESTRICTED);
        expect(result).toEqual([]);
    });

    test('returns the rows resolved by sql', async () => {
        const fakeRow: TextSoundSearchRow = {
            media_id: '22222222-3333-4444-8555-666666666666',
            similarity_score: 0.88,
            title: 'Calm Piano Track',
            custom_poster_url: null,
            custom_metadata: {},
            runtime_seconds: 240,
            artist_title: 'Test Artist',
            album_id: '33333333-4444-5555-8666-777777777777',
            album_title: 'Test Album',
            album_edition_year: 1994,
        };

        const sql = makeSqlStub([fakeRow]);
        const result = await textSoundSearch(sql, fakeVector(), 5, UNRESTRICTED);
        expect(result).toHaveLength(1);
        expect(result[0].media_id).toBe(fakeRow.media_id);
        expect(result[0].similarity_score).toBe(0.88);
        expect(result[0].title).toBe('Calm Piano Track');
    });

    test('calls sql (issues a query) at least once', async () => {
        const sql = makeSqlStub([]);
        await textSoundSearch(sql, fakeVector(), 10, UNRESTRICTED);
        expect(vi.mocked(sql)).toHaveBeenCalled();
    });

    test('returns multiple rows in order', async () => {
        const rows: TextSoundSearchRow[] = [
            {
                media_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                similarity_score: 0.95,
                title: 'Track A',
                custom_poster_url: null,
                custom_metadata: {},
                runtime_seconds: 180,
                artist_title: 'Artist A',
                album_id: null,
                album_title: null,
                album_edition_year: 1994,
            },
            {
                media_id: 'ffffffff-0000-4111-8222-333333333333',
                similarity_score: 0.82,
                title: 'Track B',
                custom_poster_url: '/art/b.jpg',
                custom_metadata: { genre: 'classical' },
                runtime_seconds: 300,
                artist_title: 'Artist B',
                album_id: '44444444-5555-4666-8777-888888888888',
                album_title: 'Album B',
                album_edition_year: 1994,
            },
        ];

        const sql = makeSqlStub(rows);
        const result = await textSoundSearch(sql, fakeVector(), 20, UNRESTRICTED);
        expect(result).toHaveLength(2);
        expect(result[0].media_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect(result[1].media_id).toBe('ffffffff-0000-4111-8222-333333333333');
    });

    test('TextSoundSearchRow interface allows null optional fields', () => {
        const row: TextSoundSearchRow = {
            media_id: 'some-uuid',
            similarity_score: 0.5,
            title: 'Track',
            custom_poster_url: null,
            custom_metadata: {},
            runtime_seconds: null,
            artist_title: null,
            album_id: null,
            album_title: null,
            album_edition_year: 1994,
        };
        expect(row.runtime_seconds).toBeNull();
        expect(row.artist_title).toBeNull();
        expect(row.album_id).toBeNull();
        expect(row.album_title).toBeNull();
    });

    test('accepts a restricted access boundary', async () => {
        const restricted = restrictedAccess({
            deniedGroupIds: ['group-uuid-1', 'group-uuid-2'],
            maxAgeRating: 16,
            allowUnrated: false,
        });
        const sql = makeSqlStub([]);
        // Should not throw; both builders handle a restricted scope.
        await expect(textSoundSearch(sql, fakeVector(), 10, restricted)).resolves.toEqual([]);
    });

    test('a denyAll boundary short-circuits to [] without issuing a query', async () => {
        const sql = makeSqlStub([
            {
                media_id: 'should-never-be-returned',
                similarity_score: 1,
                title: 'Leaked Track',
                custom_poster_url: null,
                custom_metadata: {},
                runtime_seconds: null,
                artist_title: null,
                album_id: null,
                album_title: null,
                album_edition_year: 1994,
            },
        ]);

        await expect(textSoundSearch(sql, fakeVector(), 10, denyAllAccess())).resolves.toEqual([]);
        // Never round-trips: a never-satisfiable predicate next to the HNSW
        // ORDER BY ... LIMIT can make the planner walk the entire index.
        expect(vi.mocked(sql)).not.toHaveBeenCalled();
    });
});
