// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * findLocalArtworkOwnedByOtherLibrary against real Postgres: the predicate
 * the scanner uses to stop two library folders re-pointing one item's local
 * artwork row at each other on every scan.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { findLocalArtworkOwnedByOtherLibrary } from './local-artwork-owner.queries.js';

describe('findLocalArtworkOwnedByOtherLibrary', () => {
    let sql: postgres.Sql;
    let itemId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_artwork',
            'media_items',
            'library_paths',
            'library_groups',
        ]);
        const [group] = await sql<[{ id: string }]>`
            INSERT INTO library_groups (name) VALUES ('Movies') RETURNING id`;
        await sql`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES ('/data/movies', 'movie', ${group.id}, true),
                   ('/data/4kmovies', 'movie', ${group.id}, true),
                   ('/data/old', 'movie', ${group.id}, false)`;
        const [item] = await sql<[{ id: string }]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('movie', 'Film', 'active', true) RETURNING id`;
        itemId = item.id;
    });

    async function pointRowAt(filePath: string, language = ''): Promise<void> {
        await sql`
            INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path, language)
            VALUES (${itemId}, 'poster', 'local', ${filePath}, ${language})`;
    }

    it("names the other enabled library's file", async () => {
        await pointRowAt('/data/4kmovies/Film/poster.jpg');

        await expect(
            findLocalArtworkOwnedByOtherLibrary(sql, itemId, 'poster', '/data/movies'),
        ).resolves.toBe('/data/4kmovies/Film/poster.jpg');
    });

    it("returns null for this library's own file", async () => {
        await pointRowAt('/data/movies/Film/poster.jpg');

        await expect(
            findLocalArtworkOwnedByOtherLibrary(sql, itemId, 'poster', '/data/movies'),
        ).resolves.toBeNull();
    });

    it('does not treat a sibling folder sharing the prefix as this library', async () => {
        // '/data/movies' must not claim '/data/movies2/…' or vice versa.
        await pointRowAt('/data/4kmovies/Film/poster.jpg');

        await expect(
            findLocalArtworkOwnedByOtherLibrary(sql, itemId, 'poster', '/data/4k'),
        ).resolves.toBe('/data/4kmovies/Film/poster.jpg');
    });

    it('gives a disabled library no claim', async () => {
        await pointRowAt('/data/old/Film/poster.jpg');

        await expect(
            findLocalArtworkOwnedByOtherLibrary(sql, itemId, 'poster', '/data/movies'),
        ).resolves.toBeNull();
    });

    it('ignores language-specific rows, which are not the scanner row', async () => {
        await pointRowAt('/data/4kmovies/Film/poster.de.jpg', 'de');

        await expect(
            findLocalArtworkOwnedByOtherLibrary(sql, itemId, 'poster', '/data/movies'),
        ).resolves.toBeNull();
    });
});
