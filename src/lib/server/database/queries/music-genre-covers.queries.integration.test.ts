// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `getGenreCoverAlbums` against real Postgres.
 *
 * This query hands album art to a specific viewer, so the access filters are
 * the whole point — and they are hand-written SQL inside a LATERAL, exactly
 * the shape where a flipped `!=` reads fine and leaks everything. Types cannot
 * show that a predicate is applied, that it targets the right alias, or that
 * it survived into the subquery, so each axis is checked DIFFERENTIALLY,
 * mirroring `getTracksByGenre — access boundary` in music.queries.integration:
 *
 *   1. unrestricted — POSITIVE CONTROL, must be non-empty;
 *   2. restricted   — must be a STRICT SUBSET of (1);
 *   3. deny-all     — must be EMPTY.
 *
 * Without (1) a broken fixture makes (2) and (3) pass vacuously.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';
import { createLibraryGroup } from './library-groups.queries.js';
import { getGenreCoverAlbums } from './music.queries.js';

const GENRE = 'Zylvorakcore';
const OTHER_GENRE = 'Qwintarblat';

const OPEN = { deniedGroupIds: null, ageRating: null };

describe('getGenreCoverAlbums', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE media_embeddings, media_file_items, media_files, watch_history, media_items CASCADE',
        );
    });

    /** Point a track's fixture-created media_files row at a library group. */
    async function moveTrackFileToGroup(trackId: string, libraryGroupId: string): Promise<void> {
        await sql`
            UPDATE media_files mf
            SET library_group_id = ${libraryGroupId}::uuid
            FROM media_file_items mfi
            WHERE mfi.file_id = mf.id
              AND mfi.media_item_id = ${trackId}::uuid
        `;
    }

    /** An album carrying its own poster plus one track tagged `genre`. */
    async function makeAlbumWithTrack(
        artistId: string,
        label: string,
        genre: string,
        opts: { withPoster?: boolean; trackNo?: number } = {},
    ): Promise<{ albumId: string; trackId: string }> {
        const album = createTestAlbum(artistId, { title: `Cover Album ${label}` });
        await insertTestAlbum(sql, album);
        if (opts.withPoster !== false) {
            await sql`
                UPDATE media_items SET custom_poster_url = ${`/local/${label}.jpg`}
                WHERE id = ${album.id}::uuid
            `;
        }
        const track = createTestTrack(album.id, opts.trackNo ?? 1, {
            title: `Cover Track ${label}`,
            custom_metadata: { genre },
        });
        await insertTestTrack(sql, track);
        return { albumId: album.id, trackId: track.id };
    }

    async function albumIdsFor(
        access: Parameters<typeof getGenreCoverAlbums>[2],
        genres: string[] = [GENRE],
    ): Promise<string[]> {
        const rows = await getGenreCoverAlbums(sql, genres, access);
        return rows.map((r) => r.album_id);
    }

    it('returns albums whose tracks carry the genre, keyed by genre', async () => {
        const artist = createTestArtist({ title: 'Cover Artist' });
        await insertTestArtist(sql, artist);
        const a = await makeAlbumWithTrack(artist.id, 'A', GENRE);
        const b = await makeAlbumWithTrack(artist.id, 'B', OTHER_GENRE);

        const rows = await getGenreCoverAlbums(sql, [GENRE], OPEN);

        expect(rows.map((r) => r.album_id)).toEqual([a.albumId]);
        expect(rows.every((r) => r.genre === GENRE)).toBe(true);
        expect(rows.map((r) => r.album_id)).not.toContain(b.albumId);
    });

    it('matches case-insensitively, since stored tags are lowercased by the index fn', async () => {
        const artist = createTestArtist({ title: 'Case Artist' });
        await insertTestArtist(sql, artist);
        const a = await makeAlbumWithTrack(artist.id, 'Case', 'zYlVoRaKcOrE');

        // The genre list comes from getDistinctMusicGenres in original case.
        expect(await albumIdsFor(OPEN, [GENRE])).toEqual([a.albumId]);
    });

    it('skips albums with no local poster — a blank tile is worse than a smaller grid', async () => {
        const artist = createTestArtist({ title: 'Poster Artist' });
        await insertTestArtist(sql, artist);
        const withArt = await makeAlbumWithTrack(artist.id, 'Has', GENRE);
        const noArt = await makeAlbumWithTrack(artist.id, 'None', GENRE, { withPoster: false });

        const ids = await albumIdsFor(OPEN);

        expect(ids).toContain(withArt.albumId);
        expect(ids).not.toContain(noArt.albumId);
    });

    it('caps results per genre', async () => {
        const artist = createTestArtist({ title: 'Cap Artist' });
        await insertTestArtist(sql, artist);
        for (let i = 0; i < 6; i++) {
            await makeAlbumWithTrack(artist.id, `Cap${i}`, GENRE);
        }

        expect(await albumIdsFor(OPEN)).toHaveLength(4);
        expect((await getGenreCoverAlbums(sql, [GENRE], OPEN, 2)).length).toBe(2);
    });

    it('returns each album once even when several of its tracks share the genre', async () => {
        const artist = createTestArtist({ title: 'Dedupe Artist' });
        await insertTestArtist(sql, artist);
        const album = createTestAlbum(artist.id, { title: 'Dedupe Album' });
        await insertTestAlbum(sql, album);
        await sql`UPDATE media_items SET custom_poster_url = '/local/d.jpg' WHERE id = ${album.id}::uuid`;
        for (let n = 1; n <= 3; n++) {
            const t = createTestTrack(album.id, n, {
                title: `Dedupe Track ${n}`,
                custom_metadata: { genre: GENRE },
            });
            await insertTestTrack(sql, t);
        }

        expect(await albumIdsFor(OPEN)).toEqual([album.id]);
    });

    it('short-circuits an empty genre list', async () => {
        expect(await getGenreCoverAlbums(sql, [], OPEN)).toEqual([]);
    });

    // ---------------------------------------------------------------------
    // Access: library groups (differential)
    // ---------------------------------------------------------------------
    it('library group: restricted is a strict subset, deny-all is empty', async () => {
        const groupA = await createLibraryGroup(sql, { name: 'Cover Group A' });
        const groupB = await createLibraryGroup(sql, { name: 'Cover Group B' });

        const artist = createTestArtist({ title: 'Group Artist' });
        await insertTestArtist(sql, artist);
        const a = await makeAlbumWithTrack(artist.id, 'GroupA', GENRE);
        const b = await makeAlbumWithTrack(artist.id, 'GroupB', GENRE);
        await moveTrackFileToGroup(a.trackId, groupA.id);
        await moveTrackFileToGroup(b.trackId, groupB.id);

        // (1) POSITIVE CONTROL
        const open = await albumIdsFor(OPEN);
        const openSet = new Set(open);
        expect(openSet.has(a.albumId)).toBe(true);
        expect(openSet.has(b.albumId)).toBe(true);

        // (2) STRICT SUBSET — denying A hides A's album, keeps B's, adds nothing
        const narrowed = await albumIdsFor({ deniedGroupIds: [groupA.id], ageRating: null });
        expect(narrowed.every((id) => openSet.has(id))).toBe(true);
        expect(narrowed).not.toContain(a.albumId);
        expect(narrowed).toContain(b.albumId);

        // (3) DENY ALL
        const denied = await albumIdsFor({
            deniedGroupIds: [groupA.id, groupB.id],
            ageRating: null,
        });
        expect(denied).toEqual([]);
    });

    // ---------------------------------------------------------------------
    // Access: age rating (differential)
    // ---------------------------------------------------------------------
    it('age rating: over-ceiling tracks drop out, unrated follows allowUnrated', async () => {
        const artist = createTestArtist({ title: 'Age Artist' });
        await insertTestArtist(sql, artist);
        const mild = await makeAlbumWithTrack(artist.id, 'Mild', GENRE);
        const adult = await makeAlbumWithTrack(artist.id, 'Adult', GENRE);
        const unrated = await makeAlbumWithTrack(artist.id, 'Unrated', GENRE);
        await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${mild.trackId}::uuid`;
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adult.trackId}::uuid`;

        // (1) POSITIVE CONTROL
        const open = new Set(await albumIdsFor(OPEN));
        expect(open.has(mild.albumId)).toBe(true);
        expect(open.has(adult.albumId)).toBe(true);
        expect(open.has(unrated.albumId)).toBe(true);

        // (2) ceiling 12, unrated allowed → adult drops, the rest stay
        const capped = await albumIdsFor({
            deniedGroupIds: null,
            ageRating: { maxAgeRating: 12, allowUnrated: true },
        });
        expect(capped.every((id) => open.has(id))).toBe(true);
        expect(capped).toContain(mild.albumId);
        expect(capped).toContain(unrated.albumId);
        expect(capped).not.toContain(adult.albumId);

        // (3) same ceiling, unrated refused → the unrated album drops too
        const strict = await albumIdsFor({
            deniedGroupIds: null,
            ageRating: { maxAgeRating: 12, allowUnrated: false },
        });
        expect(strict).toContain(mild.albumId);
        expect(strict).not.toContain(unrated.albumId);
        expect(strict).not.toContain(adult.albumId);
    });

    it('applies both axes at once rather than letting one mask the other', async () => {
        const group = await createLibraryGroup(sql, { name: 'Combined Group' });
        const artist = createTestArtist({ title: 'Combined Artist' });
        await insertTestArtist(sql, artist);
        // Denied by GROUP but within the age ceiling.
        const byGroup = await makeAlbumWithTrack(artist.id, 'ByGroup', GENRE);
        // Allowed by group but OVER the age ceiling.
        const byAge = await makeAlbumWithTrack(artist.id, 'ByAge', GENRE);
        await moveTrackFileToGroup(byGroup.trackId, group.id);
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${byAge.trackId}::uuid`;

        expect(new Set(await albumIdsFor(OPEN)).size).toBe(2);

        const both = await albumIdsFor({
            deniedGroupIds: [group.id],
            ageRating: { maxAgeRating: 12, allowUnrated: true },
        });
        expect(both).toEqual([]);
    });
});
