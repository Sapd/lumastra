// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration tests for findOrCreateMusicArtist / findOrCreateMusicAlbum.
 *
 * These exercise the concurrency-safety fix from migration 16.77.0: the
 * resolvers rely on UNIQUE partial indexes (uq_music_artist_norm_title,
 * uq_music_album_parent_title) so that `INSERT ... ON CONFLICT (<expr>) WHERE
 * <predicate> DO NOTHING` actually fires and concurrent scan workers converge
 * on a single row instead of each minting a duplicate. The race can only be
 * reproduced against a real PostgreSQL with the real unique indexes — the pool
 * (max:10) lets Promise.all run the calls on distinct connections.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    findOrCreateMusicArtist,
    findOrCreateMusicAlbum,
    updateAndLockMediaItem,
} from './media-items.queries.js';

async function countActiveArtists(sql: postgres.Sql, name: string): Promise<number> {
    const rows = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM media_items
        WHERE media_type = 'artist' AND parent_id IS NULL AND status = 'active'
          AND regexp_replace(LOWER(TRIM(title)), '[^a-z0-9 ]', '', 'g')
            = regexp_replace(LOWER(TRIM(${name})), '[^a-z0-9 ]', '', 'g')
    `;
    return rows[0].n;
}

describe('findOrCreateMusicArtist / findOrCreateMusicAlbum', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    describe('the unique indexes exist (migration 16.77.0)', () => {
        it('uq_music_artist_title_nfc and uq_music_album_parent_title are UNIQUE', async () => {
            // 16.393.0 replaced the ASCII-stripping uq_music_artist_norm_title.
            const rows = await sql<{ indexname: string; indexdef: string }[]>`
                SELECT indexname, indexdef FROM pg_indexes
                WHERE tablename = 'media_items'
                  AND indexname IN ('uq_music_artist_title_nfc', 'uq_music_album_parent_title')
            `;
            const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
            expect(byName.get('uq_music_artist_title_nfc')).toMatch(/CREATE UNIQUE INDEX/);
            expect(byName.get('uq_music_album_parent_title')).toMatch(/CREATE UNIQUE INDEX/);
        });
    });

    describe('findOrCreateMusicArtist', () => {
        it('is idempotent: same name returns the same id and creates one row', async () => {
            const a = await findOrCreateMusicArtist(sql, { name: 'David Vale' });
            const b = await findOrCreateMusicArtist(sql, { name: 'David Vale' });
            expect(b).toBe(a);
            expect(await countActiveArtists(sql, 'David Vale')).toBe(1);
        });

        it('matches case-insensitively and ignoring leading/trailing whitespace', async () => {
            const a = await findOrCreateMusicArtist(sql, { name: 'Metalune' });
            const b = await findOrCreateMusicArtist(sql, { name: 'metalune' });
            const c = await findOrCreateMusicArtist(sql, { name: '  METALUNE  ' });
            expect(b).toBe(a);
            expect(c).toBe(a);
        });

        it('preserves punctuation so distinct artist names do not collapse', async () => {
            const a = await findOrCreateMusicArtist(sql, { name: 'AC/DC' });
            const b = await findOrCreateMusicArtist(sql, { name: 'AC.DC' });
            const c = await findOrCreateMusicArtist(sql, { name: 'acdc' });
            expect(new Set([a, b, c]).size).toBe(3);
            // A real space is also a distinct conservative identity key.
            const spaced = await findOrCreateMusicArtist(sql, { name: 'ac dc' });
            expect(spaced).not.toBe(a);
        });

        it('collapses Various-Artists aliases onto a single row', async () => {
            const ids = await Promise.all(
                ['Various Artists', 'VA', 'V.A.', 'V/A', 'Various'].map((name) =>
                    findOrCreateMusicArtist(sql, { name }),
                ),
            );
            expect(new Set(ids).size).toBe(1);
        });

        it('does not collapse genuinely different names', async () => {
            const a = await findOrCreateMusicArtist(sql, { name: 'Eloren' });
            const b = await findOrCreateMusicArtist(sql, { name: 'Arlen' });
            expect(b).not.toBe(a);
        });

        it('CONCURRENCY: parallel calls for the same name converge on one row', async () => {
            // The regression guard. Before migration 16.77.0 (no unique index)
            // these inserts each succeeded → N duplicate rows.
            const ids = await Promise.all(
                Array.from({ length: 8 }, () =>
                    findOrCreateMusicArtist(sql, { name: 'Race Condition Artist' }),
                ),
            );
            expect(new Set(ids).size).toBe(1);
            expect(await countActiveArtists(sql, 'Race Condition Artist')).toBe(1);
        });

        it('a soft-deleted same-name artist does not shadow a fresh active one', async () => {
            const first = await findOrCreateMusicArtist(sql, { name: 'Reborn Artist' });
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${first}::uuid`;

            const second = await findOrCreateMusicArtist(sql, { name: 'Reborn Artist' });
            expect(second).not.toBe(first);
            // Exactly one *active* row; the soft-deleted one is left untouched.
            expect(await countActiveArtists(sql, 'Reborn Artist')).toBe(1);
        });
    });

    describe('findOrCreateMusicAlbum', () => {
        it('is idempotent under one artist and scoped by parent', async () => {
            const artist1 = await findOrCreateMusicArtist(sql, { name: 'Artist One' });
            const artist2 = await findOrCreateMusicArtist(sql, { name: 'Artist Two' });

            const a = await findOrCreateMusicAlbum(sql, {
                title: 'Greatest Hits',
                artistId: artist1,
            });
            const aAgain = await findOrCreateMusicAlbum(sql, {
                title: 'greatest hits',
                artistId: artist1,
            });
            const underArtist2 = await findOrCreateMusicAlbum(sql, {
                title: 'Greatest Hits',
                artistId: artist2,
            });

            expect(aAgain).toBe(a);
            // Same title under a different artist is a different album.
            expect(underArtist2).not.toBe(a);
        });

        it('CONCURRENCY: parallel calls for the same (artist, title) converge on one row', async () => {
            const artist = await findOrCreateMusicArtist(sql, { name: 'Album Race Artist' });
            const ids = await Promise.all(
                Array.from({ length: 8 }, () =>
                    findOrCreateMusicAlbum(sql, { title: 'Contested Album', artistId: artist }),
                ),
            );
            expect(new Set(ids).size).toBe(1);
            const rows = await sql<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM media_items
                WHERE media_type = 'album' AND parent_id = ${artist}::uuid AND status = 'active'
                  AND LOWER(TRIM(title)) = 'contested album'
            `;
            expect(rows[0].n).toBe(1);
        });
    });

    // -----------------------------------------------------------------------
    // Admin rename must not split the album/artist in two.
    //
    // The resolvers address these rows by title, so before scan_aliases a
    // rename in /admin/library/media made the row invisible to the very files
    // it owns: the next added or moved file still carried the ORIGINAL tag,
    // missed the renamed row, and minted a duplicate beside it.
    // -----------------------------------------------------------------------
    describe('rename absorption via custom_metadata.scan_aliases', () => {
        async function countActiveAlbums(artistId: string): Promise<number> {
            const rows = await sql<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM media_items
                WHERE media_type = 'album' AND parent_id = ${artistId}::uuid AND status = 'active'
            `;
            return rows[0].n;
        }

        it('a renamed album still absorbs files whose tags carry the old title', async () => {
            const artist = await findOrCreateMusicArtist(sql, { name: 'Rename Album Artist' });
            const album = await findOrCreateMusicAlbum(sql, {
                title: 'Discovery',
                artistId: artist,
            });

            await updateAndLockMediaItem(sql, album, 'admin', {
                title: 'Discovery (Remastered)',
            });

            // The scanner still reads "Discovery" out of the unchanged tags.
            const resolved = await findOrCreateMusicAlbum(sql, {
                title: 'Discovery',
                artistId: artist,
            });

            expect(resolved).toBe(album);
            expect(await countActiveAlbums(artist)).toBe(1);
        });

        it('keeps the aliases when custom_metadata is replaced without a rename', async () => {
            // A later metadata edit that carries no title replaced
            // custom_metadata wholesale and took scan_aliases with it, so the
            // album stopped answering to the title still in the file tags and
            // the scanner minted a duplicate. The rename path guarded this; the
            // edit-without-rename path beside it did not.
            const artist = await findOrCreateMusicArtist(sql, { name: 'Alias Keep Artist' });
            const album = await findOrCreateMusicAlbum(sql, {
                title: 'Original',
                artistId: artist,
            });
            await updateAndLockMediaItem(sql, album, 'admin', { title: 'Renamed' });

            await updateAndLockMediaItem(sql, album, 'admin', {
                customMetadata: { some_other_key: 'value' },
            });

            expect(await findOrCreateMusicAlbum(sql, { title: 'Original', artistId: artist })).toBe(
                album,
            );
            expect(await countActiveAlbums(artist)).toBe(1);
        });

        it('matches the old title case-insensitively, as the live-title lookup does', async () => {
            const artist = await findOrCreateMusicArtist(sql, { name: 'Rename Case Artist' });
            const album = await findOrCreateMusicAlbum(sql, {
                title: 'Homework',
                artistId: artist,
            });
            await updateAndLockMediaItem(sql, album, 'admin', { title: 'Homework [Deluxe]' });

            expect(
                await findOrCreateMusicAlbum(sql, { title: '  hOmEwOrK ', artistId: artist }),
            ).toBe(album);
            expect(await countActiveAlbums(artist)).toBe(1);
        });

        it('survives a chain of renames — every former title still resolves', async () => {
            const artist = await findOrCreateMusicArtist(sql, { name: 'Rename Chain Artist' });
            const album = await findOrCreateMusicAlbum(sql, { title: 'First', artistId: artist });
            await updateAndLockMediaItem(sql, album, 'admin', { title: 'Second' });
            await updateAndLockMediaItem(sql, album, 'admin', { title: 'Third' });

            expect(await findOrCreateMusicAlbum(sql, { title: 'First', artistId: artist })).toBe(
                album,
            );
            expect(await findOrCreateMusicAlbum(sql, { title: 'Second', artistId: artist })).toBe(
                album,
            );
            expect(await countActiveAlbums(artist)).toBe(1);
        });

        it('does not leak an alias across artists — same old title, different parent', async () => {
            const artistA = await findOrCreateMusicArtist(sql, { name: 'Alias Scope A' });
            const artistB = await findOrCreateMusicArtist(sql, { name: 'Alias Scope B' });
            const album = await findOrCreateMusicAlbum(sql, { title: 'Shared', artistId: artistA });
            await updateAndLockMediaItem(sql, album, 'admin', { title: 'Renamed Shared' });

            const underB = await findOrCreateMusicAlbum(sql, {
                title: 'Shared',
                artistId: artistB,
            });

            expect(underB).not.toBe(album);
            expect(await countActiveAlbums(artistA)).toBe(1);
            expect(await countActiveAlbums(artistB)).toBe(1);
        });

        it('a genuinely new album under a renamed-album artist is still created', async () => {
            const artist = await findOrCreateMusicArtist(sql, { name: 'New Album Artist' });
            const album = await findOrCreateMusicAlbum(sql, {
                title: 'Old Name',
                artistId: artist,
            });
            await updateAndLockMediaItem(sql, album, 'admin', { title: 'New Name' });

            const other = await findOrCreateMusicAlbum(sql, {
                title: 'Something Else',
                artistId: artist,
            });

            expect(other).not.toBe(album);
            expect(await countActiveAlbums(artist)).toBe(2);
        });

        it('a renamed artist still absorbs files whose tags carry the old name', async () => {
            const artist = await findOrCreateMusicArtist(sql, { name: 'Puff Daddy' });
            await updateAndLockMediaItem(sql, artist, 'admin', { title: 'Diddy' });

            const resolved = await findOrCreateMusicArtist(sql, { name: 'Puff Daddy' });

            expect(resolved).toBe(artist);
            expect(await countActiveArtists(sql, 'Puff Daddy')).toBe(0);
            expect(await countActiveArtists(sql, 'Diddy')).toBe(1);
        });

        it('records no alias for non-music types (a movie rename is not addressable by title)', async () => {
            const [movie] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('Cloud Runner', 'movie', 'active')
                RETURNING id
            `;
            await updateAndLockMediaItem(sql, movie.id, 'admin', {
                title: 'Cloud Runner (1982)',
            });

            const [row] = await sql<{ aliases: unknown }[]>`
                SELECT custom_metadata->'scan_aliases' AS aliases
                FROM media_items WHERE id = ${movie.id}
            `;
            expect(row.aliases).toBeNull();
        });

        it('a no-op title save records no alias', async () => {
            const artist = await findOrCreateMusicArtist(sql, { name: 'No Op Artist' });
            const album = await findOrCreateMusicAlbum(sql, { title: 'Steady', artistId: artist });
            await updateAndLockMediaItem(sql, album, 'admin', { title: 'Steady' });

            const [row] = await sql<{ aliases: unknown }[]>`
                SELECT custom_metadata->'scan_aliases' AS aliases
                FROM media_items WHERE id = ${album}
            `;
            expect(row.aliases).toBeNull();
        });

        it('renaming back to the original clears the stale alias', async () => {
            const artist = await findOrCreateMusicArtist(sql, { name: 'Revert Artist' });
            const album = await findOrCreateMusicAlbum(sql, {
                title: 'Original',
                artistId: artist,
            });
            await updateAndLockMediaItem(sql, album, 'admin', { title: 'Typo' });
            await updateAndLockMediaItem(sql, album, 'admin', { title: 'Original' });

            const [row] = await sql<{ aliases: string[] }[]>`
                SELECT custom_metadata->'scan_aliases' AS aliases
                FROM media_items WHERE id = ${album}
            `;
            // "Typo" is retained (it is a real former title); "Original" is not
            // an alias of itself.
            expect(row.aliases).toEqual(['Typo']);
        });

        it('writes custom_metadata as a jsonb OBJECT, not a jsonb string scalar', async () => {
            // Regression: the writer bound a pre-stringified JSON.stringify()
            // to a `::jsonb` cast. postgres.js JSON-encodes bound jsonb values,
            // so the string was stored as a jsonb *string scalar* — every
            // `custom_metadata->>'key'` read back NULL and the saved metadata
            // was invisible to every consumer.
            const [item] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('Lesson One', 'educational', 'active')
                RETURNING id
            `;
            await updateAndLockMediaItem(sql, item.id, 'admin', {
                title: 'Lesson One',
                customMetadata: { author: 'Ada', lesson_number: 3 },
            });

            const [row] = await sql<{ kind: string; author: string | null }[]>`
                SELECT jsonb_typeof(custom_metadata) AS kind,
                       custom_metadata->>'author'    AS author
                FROM media_items WHERE id = ${item.id}
            `;
            expect(row.kind).toBe('object');
            expect(row.author).toBe('Ada');
        });
    });
});
