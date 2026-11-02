// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the sonic playlist suggestion query helpers.
 *
 * All tests are fully isolated — no database, no real sql.
 * They verify:
 *   - getPlaylistSuggestionsViaSonic is exported and callable.
 *   - It invokes the sql tagged-template and returns whatever sql resolves with.
 *   - It returns an empty array when sql resolves with [].
 *   - countPlaylistSonicEmbeddings parses the COUNT(*) string to a number.
 *   - countPlaylistSonicEmbeddings returns 0 when sql resolves with no rows.
 */

import { describe, test, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
    getPlaylistSuggestionsViaSonic,
    countPlaylistSonicEmbeddings,
    type PlaylistSuggestionFullRow,
} from './music.queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake postgres.Sql tag that resolves to `rows` for every tagged-
 * template call. Fragment calls (from trackDisplayArtistSql) are also
 * handled — they receive the same thenable, but the caller ignores their
 * result as they are interpolated into the parent template.
 *
 * Also stubs `.begin()` (the HNSW ef_search transaction wrapper used by
 * getPlaylistSuggestionsViaSonic) by invoking the callback with the same
 * stub as the transaction handle and returning its result, mirroring how
 * postgres.js's real `sql.begin` resolves to the callback's return value.
 */
function makeSqlStub(rows: unknown[]): postgres.Sql {
    const thenable = Object.assign(Promise.resolve(rows), {});
    const stub = vi.fn().mockReturnValue(thenable);
    const begin = vi.fn(async (fn: (tx: postgres.Sql) => unknown) =>
        fn(stub as unknown as postgres.Sql),
    );
    return Object.assign(stub, { begin }) as unknown as postgres.Sql;
}

/** Build a minimal PlaylistSuggestionFullRow fixture. */
function makeSuggestionRow(id: string): PlaylistSuggestionFullRow {
    return {
        id,
        title: `Track ${id}`,
        runtime_seconds: 210,
        custom_poster_url: null,
        artist_title: 'Test Artist',
        album_title: 'Test Album',
        similarity_score: 0.85,
    };
}

// ---------------------------------------------------------------------------
// getPlaylistSuggestionsViaSonic
// ---------------------------------------------------------------------------

describe('getPlaylistSuggestionsViaSonic', () => {
    test('is exported as a function', () => {
        expect(typeof getPlaylistSuggestionsViaSonic).toBe('function');
    });

    test('returns an empty array when sql resolves with no rows', async () => {
        const sql = makeSqlStub([]);
        const result = await getPlaylistSuggestionsViaSonic(sql, 42, 10);
        expect(result).toEqual([]);
    });

    test('returns the rows resolved by sql', async () => {
        const row = makeSuggestionRow('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        const sql = makeSqlStub([row]);
        const result = await getPlaylistSuggestionsViaSonic(sql, 1, 10);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(row.id);
        expect(result[0].similarity_score).toBe(0.85);
        expect(result[0].artist_title).toBe('Test Artist');
    });

    test('calls sql (issues a query) at least once', async () => {
        const sql = makeSqlStub([]);
        await getPlaylistSuggestionsViaSonic(sql, 99, 5);
        expect(vi.mocked(sql)).toHaveBeenCalled();
    });

    test('preserves row order from sql', async () => {
        const rows = [
            makeSuggestionRow('11111111-2222-4333-8444-555555555555'),
            makeSuggestionRow('66666666-7777-4888-8999-aaaaaaaaaaaa'),
        ];
        // Set distinct scores to verify ordering is not altered by the function
        rows[0].similarity_score = 0.95;
        rows[1].similarity_score = 0.72;

        const sql = makeSqlStub(rows);
        const result = await getPlaylistSuggestionsViaSonic(sql, 7, 20);
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe(rows[0].id);
        expect(result[1].id).toBe(rows[1].id);
    });

    test('PlaylistSuggestionFullRow allows null optional fields', () => {
        const row: PlaylistSuggestionFullRow = {
            id: 'some-uuid',
            title: 'Track',
            runtime_seconds: null,
            custom_poster_url: null,
            artist_title: null,
            album_title: null,
            similarity_score: 0.5,
        };
        expect(row.runtime_seconds).toBeNull();
        expect(row.custom_poster_url).toBeNull();
        expect(row.artist_title).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// countPlaylistSonicEmbeddings
// ---------------------------------------------------------------------------

describe('countPlaylistSonicEmbeddings', () => {
    test('is exported as a function', () => {
        expect(typeof countPlaylistSonicEmbeddings).toBe('function');
    });

    test('returns 0 when sql resolves with no rows', async () => {
        const sql = makeSqlStub([]);
        const result = await countPlaylistSonicEmbeddings(sql, 1);
        expect(result).toBe(0);
    });

    test('parses COUNT(*) string to a number', async () => {
        const sql = makeSqlStub([{ sonic_count: '7' }]);
        const result = await countPlaylistSonicEmbeddings(sql, 42);
        expect(result).toBe(7);
    });

    test('returns 0 when sonic_count is "0"', async () => {
        const sql = makeSqlStub([{ sonic_count: '0' }]);
        const result = await countPlaylistSonicEmbeddings(sql, 5);
        expect(result).toBe(0);
    });

    test('handles large counts correctly', async () => {
        const sql = makeSqlStub([{ sonic_count: '1024' }]);
        const result = await countPlaylistSonicEmbeddings(sql, 9);
        expect(result).toBe(1024);
    });

    test('calls sql exactly once', async () => {
        const sql = makeSqlStub([{ sonic_count: '3' }]);
        await countPlaylistSonicEmbeddings(sql, 11);
        expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    });
});
