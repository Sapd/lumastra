// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for lyrics-search.queries.ts.
 *
 * The point of this suite is the ACCESS BOUNDARY, not the kNN ranking:
 * `searchByLyricsEmbedding` takes a required-by-shape `MediaAccessBoundary` and
 * must apply both axes to the TRACK row (`mi`). The differential tests run the
 * same query over the same fixture with an unrestricted boundary and with a
 * restricted one and assert the restricted result is a strict subset — which is
 * what catches a boundary argument that arrived but was never used, or a
 * predicate bound to the wrong alias (this query joins media_items three times:
 * `mi`, `album`, `artist`, and `buildLibraryAccessFilter` hardcodes `mi`).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestAlbum,
    createTestArtist,
    createTestTrack,
    insertTestAlbum,
    insertTestArtist,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/music.fixtures.js';

import { searchByLyricsEmbedding, LYRICS_SOURCE_LRC_SIDECAR } from './lyrics-search.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

describe('searchByLyricsEmbedding — access boundary', () => {
    let sql: postgres.Sql;

    /**
     * The lyrics embedding column is dimension-parameterized at schema-apply
     * time (`__EMBEDDING_DIM__`), so read the real width from the DB rather
     * than hardcoding one — a mismatched literal is a pgvector error, not a
     * test failure that tells you anything.
     */
    let dim: number;

    let openTrackId: string;
    let groupTrackId: string;
    let adultTrackId: string;
    let deniedGroup: string;

    /** Deterministic vector; `seed` shifts it so distances differ per track. */
    function vectorFor(seed: number): number[] {
        return Array.from({ length: dim }, (_, i) => Math.sin((i + 1) * 0.01 + seed));
    }

    beforeAll(async () => {
        sql = getTestDb();
        const [col] = await sql<{ dim: number }[]>`
            SELECT a.atttypmod AS dim
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            WHERE c.relname = 'media_lyrics_embeddings'
              AND a.attname = 'embedding'
        `;
        dim = col.dim;
        expect(dim).toBeGreaterThan(0);
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['media_lyrics_embeddings', ...TEST_TABLES.media]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;

        deniedGroup = crypto.randomUUID();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${deniedGroup}::uuid, 'Denied Lyrics Group')
        `;

        const artist = createTestArtist({ title: 'Boundary Artist' });
        await insertTestArtist(sql, artist);
        const album = createTestAlbum(artist.id, { title: 'Boundary Album' });
        await insertTestAlbum(sql, album);

        openTrackId = await seedTrack(album.id, 1, { libraryGroupId: null, ageRating: null });
        groupTrackId = await seedTrack(album.id, 2, {
            libraryGroupId: deniedGroup,
            ageRating: null,
        });
        adultTrackId = await seedTrack(album.id, 3, { libraryGroupId: null, ageRating: 18 });
    });

    async function seedTrack(
        albumId: string,
        trackNumber: number,
        opts: { libraryGroupId: string | null; ageRating: number | null },
    ): Promise<string> {
        const track = createTestTrack(albumId, trackNumber, {
            title: `Boundary Track ${trackNumber}`,
        });
        await insertTestTrack(sql, track);

        if (opts.ageRating !== null) {
            await sql`
                UPDATE media_items SET age_rating = ${opts.ageRating} WHERE id = ${track.id}::uuid
            `;
        }

        // insertTestTrack already created a media_files row with a NULL
        // library_group_id; move it into the denied group when asked.
        if (opts.libraryGroupId) {
            await sql`
                UPDATE media_files SET library_group_id = ${opts.libraryGroupId}::uuid
                WHERE id IN (
                    SELECT file_id FROM media_file_items WHERE media_item_id = ${track.id}::uuid
                )
            `;
        }

        await sql`
            INSERT INTO media_lyrics_embeddings (media_id, source, embedding, created_at)
            VALUES (
                ${track.id}::uuid,
                ${LYRICS_SOURCE_LRC_SIDECAR},
                ${`[${vectorFor(trackNumber * 0.05).join(',')}]`}::vector,
                now()
            )
        `;

        return track.id;
    }

    async function idsFor(access: MediaAccessBoundary): Promise<Set<string>> {
        const rows = await searchByLyricsEmbedding(sql, vectorFor(0), 50, access);
        return new Set(rows.map((r) => r.media_id));
    }

    it('unrestricted access sees every seeded track', async () => {
        const all = await idsFor(unrestrictedAccess());
        expect(all).toContain(openTrackId);
        expect(all).toContain(groupTrackId);
        expect(all).toContain(adultTrackId);
    });

    it('still projects the ungated album parent for an accessible track', async () => {
        const rows = await searchByLyricsEmbedding(sql, vectorFor(0), 50, unrestrictedAccess());
        const open = rows.find((r) => r.media_id === openTrackId);
        expect(open).toBeDefined();
        expect(open!.album_title).toBe('Boundary Album');
    });

    it('a denied library group yields a strict subset missing that track', async () => {
        const all = await idsFor(unrestrictedAccess());
        const restricted = await idsFor(
            restrictedAccess({
                deniedGroupIds: [deniedGroup],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );

        for (const id of restricted) expect(all).toContain(id);
        expect(restricted.size).toBeLessThan(all.size);
        expect(restricted).not.toContain(groupTrackId);
        // The other axis must be untouched.
        expect(restricted).toContain(openTrackId);
        expect(restricted).toContain(adultTrackId);
    });

    it('an age limit yields a strict subset missing the over-limit track', async () => {
        const all = await idsFor(unrestrictedAccess());
        const restricted = await idsFor(
            restrictedAccess({
                deniedGroupIds: [],
                maxAgeRating: 12,
                allowUnrated: true,
            }),
        );

        for (const id of restricted) expect(all).toContain(id);
        expect(restricted.size).toBeLessThan(all.size);
        expect(restricted).not.toContain(adultTrackId);
        expect(restricted).toContain(openTrackId);
        expect(restricted).toContain(groupTrackId);
    });

    it('allowUnrated=false also drops tracks with no age rating', async () => {
        const restricted = await idsFor(
            restrictedAccess({
                deniedGroupIds: [],
                maxAgeRating: 12,
                allowUnrated: false,
            }),
        );
        expect(restricted.size).toBe(0);
    });

    it('both axes restricted intersect rather than replace each other', async () => {
        const all = await idsFor(unrestrictedAccess());
        const restricted = await idsFor(
            restrictedAccess({
                deniedGroupIds: [deniedGroup],
                maxAgeRating: 12,
                allowUnrated: true,
            }),
        );

        for (const id of restricted) expect(all).toContain(id);
        expect([...restricted]).toEqual([openTrackId]);
    });

    it('a denyAll boundary returns nothing', async () => {
        expect(await searchByLyricsEmbedding(sql, vectorFor(0), 50, denyAllAccess())).toEqual([]);
    });
});
