// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `mergeVariousArtistsAliases` / `mergeOversizedCompilationArtists`
 * integration tests.
 *
 * Verifies the scanner self-heal pass recognizes localized "Various Artists"
 * buckets (e.g. Turkish "Çeşitli Sanatçılar") in addition to the English
 * ASCII-folded forms ("VA", "Various", "Various Artist(s)"), merging them
 * into the canonical `Various Artists` artist row and flagging the survivor
 * with `is_various_artists = true`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    mergeVariousArtistsAliases,
    mergeOversizedCompilationArtists,
} from '../media-sources/_helpers/file-scanner/audio-processor.js';
import type { FileScannerContext } from '../media-sources/_helpers/file-scanner/shared.js';
import { findOrCreateMusicArtist } from '$lib/server/database/queries/media-items.queries.js';

async function linkAlbumFiles(tx: postgres.TransactionSql, albumId: string): Promise<void> {
    const tracks = await tx<
        { id: string }[]
    >`SELECT id FROM media_items WHERE parent_id=${albumId} AND media_type='track'`;
    for (const track of tracks) {
        await tx`UPDATE media_items SET custom_metadata=COALESCE(custom_metadata,'{}'::jsonb) || '{"compilation":true}'::jsonb WHERE id=${track.id}`;
        const [file] = await tx<
            { id: string }[]
        >`INSERT INTO media_files (file_path) VALUES (${'/music/fixtures/' + track.id + '.mp3'}) RETURNING id`;
        await tx`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file.id},${track.id},true)`;
    }
}

describe('mergeVariousArtistsAliases — localized aliases (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    it('merges a localized (Turkish) VA bucket into canonical Various Artists', async () => {
        await sql
            .begin(async (tx: postgres.TransactionSql) => {
                const [tr] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type)
                    VALUES ('Çeşitli Sanatçılar', 'artist')
                    RETURNING id
                `;
                const [al] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, parent_id)
                    VALUES ('HUE Vol 2', 'album', ${tr.id})
                    RETURNING id
                `;
                await tx`
                    INSERT INTO media_items (title, media_type, parent_id)
                    VALUES ('trk', 'track', ${al.id})
                `;

                await linkAlbumFiles(tx, al.id);
                const merged = await mergeVariousArtistsAliases(
                    tx as unknown as postgres.Sql,
                    {
                        logger: mockLogger(),
                    } as unknown as FileScannerContext,
                );
                expect(merged).toBe(1);

                const gone = await tx`SELECT 1 FROM media_items WHERE id = ${tr.id}`;
                expect(gone.length).toBe(0);

                const [va] = await tx<{ id: string; is_various_artists: boolean }[]>`
                    SELECT id, is_various_artists FROM media_items
                    WHERE media_type = 'artist' AND title = 'Various Artists'
                `;
                expect(va).toBeDefined();
                expect(va.is_various_artists).toBe(true);

                const album = await tx`
                    SELECT 1 FROM media_items
                    WHERE parent_id = ${va.id} AND title = 'HUE Vol 2'
                `;
                expect(album.length).toBe(1);

                throw new Error('__rollback__');
            })
            .catch((e: unknown) => {
                if (!(e instanceof Error) || e.message !== '__rollback__') throw e;
            });
    });

    it('case-insensitively merges a localized VA bucket tagged in a different case than the curated literal (finding #3)', async () => {
        await sql
            .begin(async (tx: postgres.TransactionSql) => {
                // Curated literal is 'Çeşitli Sanatçılar' (Turkish, Title Case).
                // Seed the bucket ALL-LOWERCASE — the self-heal's localized-alias
                // branch must fold case to catch this, matching
                // isVariousArtistsName's lowercase comparison.
                const [tr] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type)
                    VALUES ('çeşitli sanatçılar', 'artist')
                    RETURNING id
                `;
                const [al] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, parent_id)
                    VALUES ('Case Fold Vol 1', 'album', ${tr.id})
                    RETURNING id
                `;
                await tx`
                    INSERT INTO media_items (title, media_type, parent_id)
                    VALUES ('trk', 'track', ${al.id})
                `;

                await linkAlbumFiles(tx, al.id);
                const merged = await mergeVariousArtistsAliases(
                    tx as unknown as postgres.Sql,
                    {
                        logger: mockLogger(),
                    } as unknown as FileScannerContext,
                );
                expect(merged).toBe(1);

                const gone = await tx`SELECT 1 FROM media_items WHERE id = ${tr.id}`;
                expect(gone.length).toBe(0);

                const [va] = await tx<{ id: string; is_various_artists: boolean }[]>`
                    SELECT id, is_various_artists FROM media_items
                    WHERE media_type = 'artist' AND title = 'Various Artists'
                `;
                expect(va).toBeDefined();
                expect(va.is_various_artists).toBe(true);

                const album = await tx`
                    SELECT 1 FROM media_items
                    WHERE parent_id = ${va.id} AND title = 'Case Fold Vol 1'
                `;
                expect(album.length).toBe(1);

                throw new Error('__rollback__');
            })
            .catch((e: unknown) => {
                if (!(e instanceof Error) || e.message !== '__rollback__') throw e;
            });
    });

    it("moves a favorited colliding alias album's references to the canonical album and deletes it", async () => {
        await sql
            .begin(async (tx: postgres.TransactionSql) => {
                const db = tx as unknown as postgres.Sql;
                const title = `Hits ${crypto.randomUUID()}`;
                const canonical = await findOrCreateMusicArtist(db, {
                    name: 'Various Artists',
                    libraryGroupId: null,
                });
                const [target] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, parent_id, has_files)
                    VALUES (${title}, 'album', ${canonical}, true) RETURNING id
                `;
                const [alias] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type) VALUES ('V.A.', 'artist') RETURNING id
                `;
                const [loved] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, parent_id, has_files)
                    VALUES (${title}, 'album', ${alias.id}, true) RETURNING id
                `;
                const [track] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, parent_id)
                    VALUES ('trk', 'track', ${loved.id}) RETURNING id
                `;
                const user = crypto.randomUUID();
                await tx`INSERT INTO users (id, username) VALUES (${user}, ${user})`;
                await tx`INSERT INTO user_media_state (media_id, user_id, is_favorite) VALUES (${loved.id}, ${user}, true)`;

                await linkAlbumFiles(tx, loved.id);
                await mergeVariousArtistsAliases(db, {
                    logger: mockLogger(),
                } as unknown as FileScannerContext);

                expect(await tx`SELECT 1 FROM media_items WHERE id = ${alias.id}`).toHaveLength(0);
                expect(await tx`SELECT 1 FROM media_items WHERE id = ${loved.id}`).toHaveLength(0);
                expect(
                    await tx`SELECT media_id::text AS media_id, is_favorite FROM user_media_state WHERE user_id = ${user}`,
                ).toEqual([{ media_id: target.id, is_favorite: true }]);
                expect(
                    await tx`SELECT parent_id::text AS parent_id FROM media_items WHERE id = ${track.id}`,
                ).toEqual([{ parent_id: target.id }]);
                throw new Error('__rollback__');
            })
            .catch((e: unknown) => {
                if (!(e instanceof Error) || e.message !== '__rollback__') throw e;
            });
    });
});

describe('mergeOversizedCompilationArtists — separator-agnostic prefilter (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    it('collapses an "&"-joined sampler credit with zero commas (finding #15)', async () => {
        // Regression for the candidate query's comma-only prefilter: a title
        // joined entirely by "&" carries ZERO comma parts, so
        // `array_length(string_to_array(title, ','), 1)` never reaches
        // COMPILATION_ARTIST_THRESHOLD and the row was never a candidate for
        // this pass, no matter how many names `parseArtistNames` would split
        // it into. That is how a single legitimate artist row ended up
        // parenting 190 unrelated compilation albums on prod.
        const AMPERSAND_TITLE = 'Pinball & Topmodelz & Aquagen & Scotty & 89ers & Deso Latee';

        await sql
            .begin(async (tx: postgres.TransactionSql) => {
                const [bogus] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type)
                    VALUES (${AMPERSAND_TITLE}, 'artist')
                    RETURNING id
                `;
                const [al] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, parent_id)
                    VALUES ('Sampler Vol 1', 'album', ${bogus.id})
                    RETURNING id
                `;
                await tx`
                    INSERT INTO media_items (title, media_type, parent_id, custom_metadata)
                    VALUES ('Sampler Track', 'track', ${al.id}, ${tx.json({ artist: 'Pinball', compilation: true })})
                `;

                await linkAlbumFiles(tx, al.id);
                const merged = await mergeOversizedCompilationArtists(
                    tx as unknown as postgres.Sql,
                    { logger: mockLogger() } as unknown as FileScannerContext,
                );
                expect(merged).toBe(1);

                // The bogus combined-name row is gone.
                const gone = await tx`SELECT 1 FROM media_items WHERE id = ${bogus.id}`;
                expect(gone.length).toBe(0);

                // Its album now lives under the canonical Various Artists row.
                const [va] = await tx<{ id: string }[]>`
                    SELECT id FROM media_items
                    WHERE media_type = 'artist' AND title = 'Various Artists'
                `;
                expect(va).toBeDefined();
                const album = await tx`
                    SELECT 1 FROM media_items
                    WHERE parent_id = ${va.id} AND title = 'Sampler Vol 1'
                `;
                expect(album.length).toBe(1);

                throw new Error('__rollback__');
            })
            .catch((e: unknown) => {
                if (!(e instanceof Error) || e.message !== '__rollback__') throw e;
            });
    });

    it('still ignores a genuine 2-way collaboration ("A & B")', async () => {
        // The widened prefilter over-selects on "&" alone; parseArtistNames
        // must still be the one deciding, or every ordinary collab row would
        // get swept into Various Artists too.
        await sql
            .begin(async (tx: postgres.TransactionSql) => {
                const [collab] = await tx<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type)
                    VALUES ('Santiano & Nathan Evans', 'artist')
                    RETURNING id
                `;

                const merged = await mergeOversizedCompilationArtists(
                    tx as unknown as postgres.Sql,
                    { logger: mockLogger() } as unknown as FileScannerContext,
                );
                expect(merged).toBe(0);

                const stillThere = await tx`SELECT 1 FROM media_items WHERE id = ${collab.id}`;
                expect(stillThere.length).toBe(1);

                throw new Error('__rollback__');
            })
            .catch((e: unknown) => {
                if (!(e instanceof Error) || e.message !== '__rollback__') throw e;
            });
    });
});
