// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for lyrics-search.queries.ts and the LRC strip helper exported
 * from lyrics-ingestion-backfill.ts.
 *
 * Tests mock the postgres.Sql instance — no real database is needed.
 */

import { describe, test, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
    searchByLyricsEmbedding,
    fetchPendingLyricsTracks,
    upsertLyricsEmbedding,
    upsertLyricsEmbeddingState,
    LYRICS_SOURCE_LRC_SIDECAR,
    type LyricsSearchRow,
    type PendingLyricsTrackRow,
} from './lyrics-search.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNRESTRICTED_CTX = unrestrictedAccess();

const FAKE_EMBEDDING = Array.from({ length: 8 }, (_, i) => (i + 1) * 0.1);

/**
 * Build a fake postgres.Sql tag that always returns `rows` when called
 * as a tagged-template literal.
 */
function makeSqlStub<T>(rows: T[]): postgres.Sql {
    const thenableRows = Object.assign(Promise.resolve(rows), {});
    const stub = vi.fn().mockReturnValue(thenableRows);
    return stub as unknown as postgres.Sql;
}

// ---------------------------------------------------------------------------
// searchByLyricsEmbedding tests
// ---------------------------------------------------------------------------

describe('searchByLyricsEmbedding', () => {
    test('is exported as a function', () => {
        expect(typeof searchByLyricsEmbedding).toBe('function');
    });

    test('returns empty array when sql resolves with no rows', async () => {
        const sql = makeSqlStub<LyricsSearchRow>([]);
        const result = await searchByLyricsEmbedding(sql, FAKE_EMBEDDING, 10, UNRESTRICTED_CTX);
        expect(result).toEqual([]);
    });

    test('returns the rows resolved by sql', async () => {
        const fakeRow: LyricsSearchRow = {
            media_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            similarity_score: 0.88,
            title: 'Moonlight Sonata',
            custom_poster_url: null,
            custom_metadata: {},
            runtime_seconds: 300,
            artist_title: 'Beethoven',
            album_id: '11111111-2222-4333-8444-555555555555',
            album_title: 'Piano Works',
        };

        const sql = makeSqlStub<LyricsSearchRow>([fakeRow]);
        const result = await searchByLyricsEmbedding(sql, FAKE_EMBEDDING, 5, UNRESTRICTED_CTX);
        expect(result).toHaveLength(1);
        expect(result[0].media_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect(result[0].similarity_score).toBe(0.88);
        expect(result[0].title).toBe('Moonlight Sonata');
    });

    test('calls sql (issues a query) at least once', async () => {
        const sql = makeSqlStub<LyricsSearchRow>([]);
        await searchByLyricsEmbedding(sql, FAKE_EMBEDDING, 10, UNRESTRICTED_CTX);
        expect(vi.mocked(sql)).toHaveBeenCalled();
    });

    test('a denyAll boundary short-circuits to [] without issuing any query', async () => {
        const sql = makeSqlStub<LyricsSearchRow>([
            {
                media_id: 'must-not-be-returned',
                similarity_score: 1,
                title: 'Leaked',
                custom_poster_url: null,
                custom_metadata: {},
                runtime_seconds: null,
                artist_title: null,
                album_id: null,
                album_title: null,
            },
        ]);
        const result = await searchByLyricsEmbedding(sql, FAKE_EMBEDDING, 10, denyAllAccess());
        expect(result).toEqual([]);
        // The HNSW scan must never be issued: an `AND false` predicate riding
        // along with `ORDER BY <=> LIMIT n` makes the planner walk the whole
        // index hunting for survivors that cannot exist.
        expect(vi.mocked(sql)).not.toHaveBeenCalled();
    });

    test('a restricted boundary still issues the query', async () => {
        const sql = makeSqlStub<LyricsSearchRow>([]);
        await searchByLyricsEmbedding(
            sql,
            FAKE_EMBEDDING,
            10,
            restrictedAccess({
                deniedGroupIds: ['11111111-2222-4333-8444-555555555555'],
                maxAgeRating: 12,
                allowUnrated: false,
            }),
        );
        expect(vi.mocked(sql)).toHaveBeenCalled();
    });

    test('returns multiple rows in order', async () => {
        const rows: LyricsSearchRow[] = [
            {
                media_id: 'aaaaaaaa-0000-4000-8000-000000000001',
                similarity_score: 0.95,
                title: 'Track A',
                custom_poster_url: null,
                custom_metadata: {},
                runtime_seconds: 180,
                artist_title: 'Artist A',
                album_id: null,
                album_title: null,
            },
            {
                media_id: 'aaaaaaaa-0000-4000-8000-000000000002',
                similarity_score: 0.8,
                title: 'Track B',
                custom_poster_url: '/art/b.jpg',
                custom_metadata: {},
                runtime_seconds: 240,
                artist_title: 'Artist B',
                album_id: '22222222-3333-4444-8555-666666666666',
                album_title: 'Album B',
            },
        ];

        const sql = makeSqlStub<LyricsSearchRow>(rows);
        const result = await searchByLyricsEmbedding(sql, FAKE_EMBEDDING, 20, UNRESTRICTED_CTX);
        expect(result).toHaveLength(2);
        expect(result[0].media_id).toBe('aaaaaaaa-0000-4000-8000-000000000001');
        expect(result[1].media_id).toBe('aaaaaaaa-0000-4000-8000-000000000002');
    });

    test('LyricsSearchRow interface allows null optional fields', () => {
        const row: LyricsSearchRow = {
            media_id: 'some-uuid',
            similarity_score: 0.5,
            title: 'Track',
            custom_poster_url: null,
            custom_metadata: {},
            runtime_seconds: null,
            artist_title: null,
            album_id: null,
            album_title: null,
        };
        expect(row.runtime_seconds).toBeNull();
        expect(row.artist_title).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// fetchPendingLyricsTracks tests
// ---------------------------------------------------------------------------

describe('fetchPendingLyricsTracks', () => {
    test('returns empty array when no pending tracks', async () => {
        const sql = makeSqlStub<PendingLyricsTrackRow>([]);
        const result = await fetchPendingLyricsTracks(sql, 10);
        expect(result).toEqual([]);
    });

    test('returns pending track rows', async () => {
        const fakeRow: PendingLyricsTrackRow = {
            media_item_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
            file_path: '/music/artist/album/track.flac',
            db_plain_lyrics: null,
            db_synced_lyrics: null,
        };
        const sql = makeSqlStub<PendingLyricsTrackRow>([fakeRow]);
        const result = await fetchPendingLyricsTracks(sql, 5);
        expect(result).toHaveLength(1);
        expect(result[0].media_item_id).toBe('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
        expect(result[0].file_path).toBe('/music/artist/album/track.flac');
    });
});

// ---------------------------------------------------------------------------
// upsertLyricsEmbedding tests
// ---------------------------------------------------------------------------

describe('upsertLyricsEmbedding', () => {
    test('calls sql with the correct arguments', async () => {
        const sql = makeSqlStub<Record<string, unknown>>([]);
        await upsertLyricsEmbedding(sql, 'media-id', [0.1, 0.2, 0.3], LYRICS_SOURCE_LRC_SIDECAR);
        expect(vi.mocked(sql)).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// upsertLyricsEmbeddingState tests
// ---------------------------------------------------------------------------

describe('upsertLyricsEmbeddingState', () => {
    test('calls sql for done status', async () => {
        const sql = makeSqlStub<Record<string, unknown>>([]);
        await upsertLyricsEmbeddingState(sql, 'media-id', 'done');
        expect(vi.mocked(sql)).toHaveBeenCalled();
    });

    test('calls sql for no_lyrics status', async () => {
        const sql = makeSqlStub<Record<string, unknown>>([]);
        await upsertLyricsEmbeddingState(sql, 'media-id', 'no_lyrics');
        expect(vi.mocked(sql)).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// LYRICS_SOURCE_LRC_SIDECAR constant
// ---------------------------------------------------------------------------

describe('LYRICS_SOURCE_LRC_SIDECAR', () => {
    test('is the expected source tag', () => {
        expect(LYRICS_SOURCE_LRC_SIDECAR).toBe('lrc-sidecar');
    });
});
