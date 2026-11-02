// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ancestry projection for the admin media browser.
 *
 * A child row that cannot name its parent is unusable in a flat list: 49,022
 * episodes sorted by title showed two different shows both as "001", and
 * 31,809 music rows never said who a track was by.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { listAdminMediaItems } from './admin-media.queries.js';

describe('ancestry projection', () => {
    let sql: postgres.Sql;

    // Two shows whose episodes share a title — the case a flat list cannot
    // disambiguate without ancestry.
    const ids = {
        showA: '11111111-1111-4111-8111-111111111111',
        seasonA: '11111111-1111-4111-8111-111111111112',
        epA: '11111111-1111-4111-8111-111111111113',
        showB: '22222222-2222-4222-8222-222222222221',
        epB: '22222222-2222-4222-8222-222222222223', // parented DIRECTLY to the show
        artist: '33333333-3333-4333-8333-333333333331',
        album: '33333333-3333-4333-8333-333333333332',
        track: '33333333-3333-4333-8333-333333333333',
        fileA: '44444444-4444-4444-8444-444444444441',
        fileB: '44444444-4444-4444-8444-444444444442',
        // A second artist/album/track chain whose artist name sorts BEFORE
        // 'Some Band', so hierarchy-sort tests can assert actual relative
        // ORDER rather than mere membership. Its album/track titles sort
        // AFTER the first chain's ('Zzz...' > 'Some...'), so a wrongful
        // fall-back to plain title order would put this chain SECOND —
        // making the assertion able to fail.
        artist2: '55555555-5555-4555-8555-555555555551',
        album2: '55555555-5555-4555-8555-555555555552',
        track2: '55555555-5555-4555-8555-555555555553',
        // A third episode (distinct title, so epA/epB can stay identically
        // titled '001' for the disambiguation test above) and a track whose
        // title sorts BETWEEN epA's and this episode's. These exist only to
        // prove the mixed-type-set 'hierarchy' fallback actually interleaves
        // by title, rather than grouping TV rows ahead of music rows — see
        // the 'falls back to plain title order' test.
        epBracket: '66666666-6666-4666-8666-666666666661',
        trackInterleaved: '66666666-6666-4666-8666-666666666662',
        // Two tracks in the SAME album whose sort_order (track number) runs
        // OPPOSITE to their titles. Every other music fixture here sits under a
        // different artist, so artist_title alone decides the order and the
        // `mi.sort_order` term in the music hierarchy branch could be deleted
        // without failing a single test. These two are what make it fail.
        trackPos1: '77777777-7777-4777-8777-777777777771',
        trackPos2: '77777777-7777-4777-8777-777777777772',
        // A 2-DISC album. sort_order is the track number, which RESTARTS at 1 on
        // each disc, so sort_order alone cannot order this album — the disc
        // number has to come first. Titles are chosen so the broken order and
        // the correct one differ (see the test).
        discArtist: '88888888-8888-4888-8888-888888888881',
        discAlbum: '88888888-8888-4888-8888-888888888882',
        d1t1: '88888888-8888-4888-8888-888888888811',
        d1t2: '88888888-8888-4888-8888-888888888812',
        d2t1: '88888888-8888-4888-8888-888888888821',
        d2t2: '88888888-8888-4888-8888-888888888822',
        // A track whose disc_number is a STRING, not a number. The projection
        // must tolerate it: one such row makes a bare `::int` cast fail the
        // whole statement, taking every other row on the page with it.
        discStringTrack: '88888888-8888-4888-8888-888888888899',
    };

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Shared lumastra_tests DB — truncate so leftovers from other suites
        // cannot pad the page and push our rows past the limit.
        await truncateTables(sql, TEST_TABLES.media);
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, has_files, status, season_number, episode_number)
            VALUES
                (${ids.showA},   'Alpha Show', 'tv',      NULL,            true, 'active', NULL, NULL),
                (${ids.seasonA}, 'Season 2',   'season',  ${ids.showA},    true, 'active', 2,    NULL),
                (${ids.epA},     '001',        'episode', ${ids.seasonA},  true, 'active', 2,    12),
                (${ids.showB},   'Beta Show',  'tv',      NULL,            true, 'active', NULL, NULL),
                (${ids.epB},     '001',        'episode', ${ids.showB},    true, 'active', 2,    3),
                (${ids.artist},  'Some Band',  'artist',  NULL,            true, 'active', NULL, NULL),
                (${ids.album},   'Some Album', 'album',   ${ids.artist},   true, 'active', NULL, NULL),
                (${ids.track},   'Some Track', 'track',   ${ids.album},    true, 'active', NULL, NULL),
                (${ids.artist2}, 'Alpha Band', 'artist',  NULL,            true, 'active', NULL, NULL),
                (${ids.album2},  'Zzz Album',  'album',   ${ids.artist2},  true, 'active', NULL, NULL),
                (${ids.track2},  'Zzz Track',  'track',   ${ids.album2},   true, 'active', NULL, NULL),
                (${ids.epBracket}, '003', 'episode', ${ids.showA}, true, 'active', 3, 1),
                (${ids.trackInterleaved}, '002 Interleaved Track', 'track', ${ids.album}, true, 'active', NULL, NULL)
        `;
        // Same album, track numbers 1 and 2, titles in the reverse order.
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, has_files, status, sort_order)
            VALUES
                (${ids.trackPos1}, 'Zzz Beta Track',  'track', ${ids.album2}, true, 'active', 1),
                (${ids.trackPos2}, 'Zzz Alpha Track', 'track', ${ids.album2}, true, 'active', 2)
        `;
        // A 2-disc album: track numbers 1,2 on EACH disc. `disc_number` is
        // written at the top level of custom_metadata as a JSON number, which is
        // where audio-processor.ts puts it (tag `discNumber`, else the
        // resolveAlbumDir folder-name fallback).
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, has_files, status, sort_order, custom_metadata)
            VALUES
                (${ids.discArtist}, 'Disc Band',  'artist', NULL,             true, 'active', NULL, '{}'::jsonb),
                (${ids.discAlbum},  'Disc Album', 'album',  ${ids.discArtist}, true, 'active', NULL, '{}'::jsonb),
                (${ids.d1t1}, 'Disc Alpha One', 'track', ${ids.discAlbum}, true, 'active', 1, '{"disc_number": 1}'::jsonb),
                (${ids.d1t2}, 'Disc Alpha Two', 'track', ${ids.discAlbum}, true, 'active', 2, '{"disc_number": 1}'::jsonb),
                (${ids.d2t1}, 'Disc Beta One',  'track', ${ids.discAlbum}, true, 'active', 1, '{"disc_number": 2}'::jsonb),
                (${ids.d2t2}, 'Disc Beta Two',  'track', ${ids.discAlbum}, true, 'active', 2, '{"disc_number": 2}'::jsonb),
                (${ids.discStringTrack}, 'Disc Gamma String', 'track', ${ids.discAlbum}, true, 'active', 3, '{"disc_number": "1/2"}'::jsonb)
        `;
        // TWO files on the track. Without these the row-multiplication guard
        // below passes vacuously — an m:n join only multiplies when there is
        // more than one match.
        await sql`
            INSERT INTO media_files (id, file_path)
            VALUES (${ids.fileA}, '/data/music/some-track.flac'),
                   (${ids.fileB}, '/data/music/some-track.mp3')
        `;
        await sql`
            INSERT INTO media_file_items (media_item_id, file_id, is_default)
            VALUES (${ids.track}, ${ids.fileA}, true),
                   (${ids.track}, ${ids.fileB}, false)
        `;
    });

    async function fetchOne(id: string, types: string[]) {
        const rows = await listAdminMediaItems(sql, { types, limit: 200, offset: 0 });
        const row = rows.find((r) => r.id === id);
        expect(row, `expected ${id} in results`).toBeDefined();
        return row!;
    }

    it('names the season and series of a normally-nested episode', async () => {
        const row = await fetchOne(ids.epA, ['episode']);
        expect(row.season_title).toBe('Season 2');
        expect(row.series_title).toBe('Alpha Show');
    });

    it('names the series of an episode parented DIRECTLY to the show', async () => {
        // The integrity scanner's `episode-parent-not-season` case. Depth-based
        // resolution would report the show as the SEASON and leave series null.
        const row = await fetchOne(ids.epB, ['episode']);
        expect(row.series_title).toBe('Beta Show');
        expect(row.season_title).toBeNull();
    });

    it('disambiguates two identically-titled episodes from different shows', async () => {
        const rows = await listAdminMediaItems(sql, { types: ['episode'], limit: 200, offset: 0 });
        const both = rows.filter((r) => r.id === ids.epA || r.id === ids.epB);
        expect(both).toHaveLength(2);
        expect(new Set(both.map((r) => r.series_title))).toEqual(
            new Set(['Alpha Show', 'Beta Show']),
        );
    });

    it('names the album and artist of a track', async () => {
        const row = await fetchOne(ids.track, ['track']);
        expect(row.album_title).toBe('Some Album');
        expect(row.artist_title).toBe('Some Band');
    });

    it('names the artist of an album', async () => {
        const row = await fetchOne(ids.album, ['album']);
        expect(row.artist_title).toBe('Some Band');
        expect(row.album_title).toBeNull();
    });

    it('leaves every ancestry field null on a root artist', async () => {
        const row = await fetchOne(ids.artist, ['artist']);
        expect(row.artist_title).toBeNull();
        expect(row.album_title).toBeNull();
        expect(row.series_title).toBeNull();
        expect(row.season_title).toBeNull();
    });

    it('does not multiply rows — a track with TWO files still appears once', async () => {
        // Guards the m:n regression class: a media_file_items join once
        // multiplied rows and broke the paging total. The two file links seeded
        // in beforeEach are what make this assertion able to fail.
        const rows = await listAdminMediaItems(sql, { types: ['track'], limit: 200, offset: 0 });
        expect(rows.filter((r) => r.id === ids.track)).toHaveLength(1);
    });

    describe('hierarchy sort', () => {
        it('groups episodes by series, then season, then episode number', async () => {
            const rows = await listAdminMediaItems(sql, {
                types: ['episode'],
                limit: 200,
                offset: 0,
                sortBy: 'hierarchy',
            });
            const mine = rows.filter((r) => r.id === ids.epA || r.id === ids.epB);
            expect(mine).toHaveLength(2);
            // 'Alpha Show' sorts before 'Beta Show'.
            expect(mine[0].series_title).toBe('Alpha Show');
            expect(mine[1].series_title).toBe('Beta Show');
        });

        it('groups tracks by artist, then album, then title', async () => {
            const rows = await listAdminMediaItems(sql, {
                types: ['track'],
                limit: 200,
                offset: 0,
                sortBy: 'hierarchy',
            });
            const mine = rows.filter((r) => r.id === ids.track || r.id === ids.track2);
            expect(mine).toHaveLength(2);
            // 'Alpha Band' sorts before 'Some Band' — even though this track's
            // own title ('Zzz Track') sorts AFTER the other chain's ('Some
            // Track'), proving the grouping is by artist, not by title.
            expect(mine[0].id).toBe(ids.track2);
            expect(mine[0].artist_title).toBe('Alpha Band');
            expect(mine[1].id).toBe(ids.track);
            expect(mine[1].artist_title).toBe('Some Band');
        });

        it('orders tracks within one album by track number, not by title', async () => {
            // The failure this catches: drop `mi.sort_order` from the music
            // hierarchy branch and the two rows fall through to `mi.title ASC`,
            // which yields ['Zzz Alpha Track', 'Zzz Beta Track'] — the exact
            // reverse of the asserted order. Both rows share an artist AND an
            // album, so no earlier ORDER BY term can decide between them.
            const rows = await listAdminMediaItems(sql, {
                types: ['track'],
                limit: 200,
                offset: 0,
                sortBy: 'hierarchy',
            });
            const mine = rows.filter((r) => r.id === ids.trackPos1 || r.id === ids.trackPos2);
            expect(mine).toHaveLength(2);
            expect(mine.map((r) => r.title)).toEqual(['Zzz Beta Track', 'Zzz Alpha Track']);
            expect(mine.map((r) => r.id)).toEqual([ids.trackPos1, ids.trackPos2]);
        });

        it('orders a multi-disc album by disc, then track number', async () => {
            // The failure this catches: drop the disc term and the four rows
            // fall through to `mi.sort_order ASC` directly. Both discs restart
            // at 1, so the two "track 1" rows sort together ahead of the two
            // "track 2" rows, resolved by title —
            //   [Disc Alpha One, Disc Beta One, Disc Alpha Two, Disc Beta Two]
            // i.e. D1T1, D2T1, D1T2, D2T2, the interleave. Titles are picked so
            // that broken order is a genuine PERMUTATION of the correct one:
            // no earlier ORDER BY term can decide between these rows (same
            // artist, same album), and title order alone would give the same
            // wrong answer, so the assertion can only pass with the disc term.
            const rows = await listAdminMediaItems(sql, {
                types: ['track'],
                limit: 200,
                offset: 0,
                sortBy: 'hierarchy',
            });
            const mine = rows.filter((r) =>
                [ids.d1t1, ids.d1t2, ids.d2t1, ids.d2t2].includes(r.id),
            );
            expect(mine).toHaveLength(4);
            expect(mine.map((r) => r.id)).toEqual([ids.d1t1, ids.d1t2, ids.d2t1, ids.d2t2]);
            expect(mine.map((r) => r.title)).toEqual([
                'Disc Alpha One',
                'Disc Alpha Two',
                'Disc Beta One',
                'Disc Beta Two',
            ]);
        });

        it('survives a disc_number stored as a string rather than failing the page', async () => {
            // `api-music-responses.ts` types disc_number as `number | string`, so
            // a non-numeric value ("1/2" from a combined tag) can reach the
            // column. A bare `(custom_metadata->>'disc_number')::int` in the
            // ORDER BY raises 22P02 for the WHOLE statement — every row on the
            // page disappears, not just this one. The jsonb_typeof guard yields
            // NULL instead. This test throws, rather than merely re-ordering, if
            // the guard is dropped.
            const rows = await listAdminMediaItems(sql, {
                types: ['track'],
                limit: 200,
                offset: 0,
                sortBy: 'hierarchy',
            });
            expect(rows.some((r) => r.id === ids.discStringTrack)).toBe(true);
            // The numeric discs still ordered correctly alongside it.
            expect(rows.some((r) => r.id === ids.d1t1)).toBe(true);
        });

        it('leaves a single-disc album ordered by track number alone', async () => {
            // Regression guard on the NULLS FIRST choice: the untagged tracks
            // seeded above carry no disc_number at all, and must keep their
            // pre-existing sort_order ordering rather than being reshuffled by
            // the new term.
            const rows = await listAdminMediaItems(sql, {
                types: ['track'],
                limit: 200,
                offset: 0,
                sortBy: 'hierarchy',
            });
            const mine = rows.filter((r) => r.id === ids.trackPos1 || r.id === ids.trackPos2);
            expect(mine.map((r) => r.id)).toEqual([ids.trackPos1, ids.trackPos2]);
        });

        it('orders by the artist sort key', async () => {
            const rows = await listAdminMediaItems(sql, {
                types: ['album'],
                limit: 200,
                offset: 0,
                sortBy: 'artist',
            });
            const mine = rows.filter((r) => r.id === ids.album || r.id === ids.album2);
            expect(mine).toHaveLength(2);
            // 'Alpha Band' sorts before 'Some Band' — even though this album's
            // own title ('Zzz Album') sorts AFTER the other chain's ('Some
            // Album'), proving the ordering is by artist, not by title.
            expect(mine[0].id).toBe(ids.album2);
            expect(mine[0].artist_title).toBe('Alpha Band');
            expect(mine[1].id).toBe(ids.album);
            expect(mine[1].artist_title).toBe('Some Band');
        });

        it('falls back to plain title order when the type set spans both hierarchies', async () => {
            // The "Everything" domain's type set contains both TV and music
            // types (e.g. 'episode' and 'track'). There is no single hierarchy
            // to group by, so 'hierarchy' must fall through to title order
            // rather than applying the TV branch to rows that have no
            // series_title/season_number/episode_number.
            //
            // Membership or a same-titled-episodes fixture cannot discriminate
            // this from the bug: the TV branch's `series_title ASC` can never
            // interleave a music row between two episode rows (it always
            // groups all non-null-series_title rows first), while plain title
            // order can — so only a music row whose title sorts BETWEEN two
            // distinctly-titled episodes proves title order is actually being
            // used. epBracket ('003') and trackInterleaved ('002 Interleaved
            // Track') exist solely to make that interleaving observable; do
            // not "simplify" this back to reusing epA/epB (both titled '001'),
            // which cannot show a fall-back-vs-TV-branch difference.
            const rows = await listAdminMediaItems(sql, {
                types: ['episode', 'track'],
                limit: 200,
                offset: 0,
                sortBy: 'hierarchy',
            });
            const mine = rows.filter(
                (r) => r.id === ids.epA || r.id === ids.trackInterleaved || r.id === ids.epBracket,
            );
            expect(mine).toHaveLength(3);
            // Title order interleaves the track BETWEEN the two episodes:
            // '001' (epA) < '002 Interleaved Track' < '003' (epBracket).
            // Under the reverted TV-branch guard, both episodes (non-null
            // series_title) would sort ahead of the track regardless of title,
            // giving [epA, epBracket, trackInterleaved] instead.
            expect(mine.map((r) => r.id)).toEqual([ids.epA, ids.trackInterleaved, ids.epBracket]);
        });
    });
});
