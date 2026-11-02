// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { getHomepageLibrarySnapshot } from './homepage-library.queries.js';

describe('getHomepageLibrarySnapshot', () => {
    let sql: postgres.Sql;

    const ids = {
        oldMovie: '11111111-1111-4111-8111-111111111111',
        newMovie: '11111111-1111-4111-8111-111111111112',
        ghostMovie: '11111111-1111-4111-8111-111111111113',
        show: '22222222-2222-4222-8222-222222222221',
        season: '22222222-2222-4222-8222-222222222222',
        episode: '22222222-2222-4222-8222-222222222223',
        artist: '33333333-3333-4333-8333-333333333331',
        album: '33333333-3333-4333-8333-333333333332',
        track: '33333333-3333-4333-8333-333333333333',
        deleted: '44444444-4444-4444-8444-444444444441',
        audiobook: '55555555-5555-4555-8555-555555555551',
        ghostAudiobook: '55555555-5555-4555-8555-555555555552',
    };

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, has_files, status, year, created_at, library_added_at)
            VALUES
                (${ids.oldMovie},   'Old Movie',   'movie',   NULL,          true,  'active', 1999, now() - interval '3 days', NULL),
                -- library_added_at wins over created_at for "recently added" order
                (${ids.newMovie},   'New Movie',   'movie',   NULL,          true,  'active', 2026, now() - interval '9 days', now() - interval '1 hour'),
                (${ids.ghostMovie}, 'Ghost Movie', 'movie',   NULL,          false, 'active', 2020, now(), NULL),
                (${ids.show},       'Some Show',   'tv',      NULL,          true,  'active', 2024, now() - interval '2 days', NULL),
                (${ids.season},     'Season 1',    'season',  ${ids.show},   true,  'active', NULL, now(), NULL),
                (${ids.episode},    'Pilot',       'episode', ${ids.season}, true,  'active', NULL, now(), NULL),
                (${ids.artist},     'Band',        'artist',  NULL,          true,  'active', NULL, now() - interval '5 days', NULL),
                (${ids.album},      'Album',       'album',   ${ids.artist}, true,  'active', NULL, now(), NULL),
                (${ids.track},      'Song',        'track',   ${ids.album},  true,  'active', NULL, now(), NULL),
                (${ids.deleted},    'Deleted',     'movie',   NULL,          true,  'deleted', 2010, now(), NULL),
                (${ids.audiobook},      'Long Book',   'audiobook', NULL,       true,  'active', NULL, now() - interval '4 days', NULL),
                (${ids.ghostAudiobook}, 'Ghost Book',  'audiobook', NULL,       false, 'active', NULL, now(), NULL)
        `;
    });

    it('counts only active items with files, per media type', async () => {
        const { counts } = await getHomepageLibrarySnapshot(sql);
        // Ghost (no files) and deleted (status) movies are excluded.
        expect(counts).toEqual({
            movies: 2,
            series: 1,
            episodes: 1,
            artists: 1,
            albums: 1,
            tracks: 1,
            audiobooks: 1,
        });
    });

    it('lists active top-level movies/series newest library add first', async () => {
        const { recent } = await getHomepageLibrarySnapshot(sql);
        expect(recent.map((r) => r.title)).toEqual([
            'New Movie',
            'Some Show',
            'Old Movie',
            'Long Book',
        ]);
        expect(recent[0]).toMatchObject({ media_type: 'movie', year: 2026 });
        expect(recent[0].added_at).toBeInstanceOf(Date);
    });

    it('honours the recent limit', async () => {
        const { recent } = await getHomepageLibrarySnapshot(sql, 1);
        expect(recent.map((r) => r.title)).toEqual(['New Movie']);
    });
});
