// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for searchMusic's credit-only-artist library-gate fix.
 *
 * Background (follow-up to the remixer-title-links / credit-only-artist
 * work): the `WHEN 'artist' THEN EXISTS (...)` branch of searchMusic's
 * library-access gate only walked the track→album→artist hierarchy, so a
 * "credit-only" artist — one that owns zero albums of its own and is only
 * ever referenced via another track's `custom_metadata.additional_artist_ids`
 * (e.g. a performer credited on someone else's compilation track) — was
 * invisible to any library-restricted user. This suite seeds exactly that
 * shape and asserts the gate now falls back to a direct
 * additional_artist_ids containment probe, scoped by the crediting track's
 * own library group.
 *
 * Run with:
 *   npm run test:integration -- src/lib/server/database/queries/search-credit-only-artist.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';
import { searchMusic } from './search.queries.js';
import { restrictedAccess, unrestrictedAccess } from './builders/media-access-boundary.js';

/** Access boundary with no restrictions (sees everything). */
const OPEN_ACCESS = unrestrictedAccess();
/** Query-shaping options. */
const OPEN_OPTS = { offset: 0 } as const;

/** Boundary denying exactly the given library groups, age unrestricted. */
function denyGroups(...ids: string[]): ReturnType<typeof restrictedAccess> {
    return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
}

describe('searchMusic — credit-only artist library gate', () => {
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

    /**
     * Seed: a credit-only artist (active, owns no albums), plus a distinct
     * album-owning artist → album → track whose additional_artist_ids
     * references the credit-only artist. The track's media_files row is
     * moved into `libraryGroupId` so the access gate has something to test.
     */
    async function seedCreditOnlyArtist(libraryGroupId: string): Promise<{
        creditOnlyArtistId: string;
        trackId: string;
    }> {
        const creditOnlyArtist = createTestArtist({
            title: `Credit Only Artist ${crypto.randomUUID().slice(0, 8)}`,
        });
        await insertTestArtist(sql, creditOnlyArtist);

        const albumOwner = createTestArtist({
            title: `Album Owner ${crypto.randomUUID().slice(0, 8)}`,
        });
        await insertTestArtist(sql, albumOwner);

        const album = createTestAlbum(albumOwner.id, {
            title: `Compilation Album ${crypto.randomUUID().slice(0, 8)}`,
        });
        await insertTestAlbum(sql, album);

        const track = createTestTrack(album.id, 1, {
            title: `Credited Track ${crypto.randomUUID().slice(0, 8)}`,
            custom_metadata: {
                artist: albumOwner.title,
                additional_artist_ids: [creditOnlyArtist.id],
            },
        });
        await insertTestTrack(sql, track);

        // Move the track's (fixture-created) media_files row into the given
        // library group so the access gate has a non-NULL group to test.
        await sql`
            UPDATE media_files mf
            SET library_group_id = ${libraryGroupId}::uuid
            FROM media_file_items mfi
            WHERE mfi.file_id = mf.id
              AND mfi.media_item_id = ${track.id}::uuid
        `;

        return { creditOnlyArtistId: creditOnlyArtist.id, trackId: track.id };
    }

    it('finds the credit-only artist for an unrestricted (no denied groups) search — regression guard', async () => {
        const libraryGroupId = crypto.randomUUID();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${libraryGroupId}::uuid, 'Group A')
        `;
        const { creditOnlyArtistId } = await seedCreditOnlyArtist(libraryGroupId);

        const artist = await sql<{ title: string }[]>`
            SELECT title FROM media_items WHERE id = ${creditOnlyArtistId}::uuid
        `;
        const results = await searchMusic(sql, artist[0].title, 50, OPEN_ACCESS, OPEN_OPTS);

        expect(results.some((r) => r.id === creditOnlyArtistId)).toBe(true);
    });

    it('still finds the credit-only artist when the denied group is a different group than the crediting track', async () => {
        const groupA = crypto.randomUUID();
        const groupB = crypto.randomUUID();
        await sql`
            INSERT INTO library_groups (id, name) VALUES (${groupA}::uuid, 'Group A')
        `;
        await sql`
            INSERT INTO library_groups (id, name) VALUES (${groupB}::uuid, 'Group B')
        `;
        const { creditOnlyArtistId } = await seedCreditOnlyArtist(groupA);

        const artist = await sql<{ title: string }[]>`
            SELECT title FROM media_items WHERE id = ${creditOnlyArtistId}::uuid
        `;
        const results = await searchMusic(sql, artist[0].title, 50, denyGroups(groupB), OPEN_OPTS);

        expect(results.some((r) => r.id === creditOnlyArtistId)).toBe(true);
    });

    it('hides the credit-only artist when the crediting track lives in a denied group', async () => {
        const groupA = crypto.randomUUID();
        await sql`
            INSERT INTO library_groups (id, name) VALUES (${groupA}::uuid, 'Group A')
        `;
        const { creditOnlyArtistId } = await seedCreditOnlyArtist(groupA);

        const artist = await sql<{ title: string }[]>`
            SELECT title FROM media_items WHERE id = ${creditOnlyArtistId}::uuid
        `;
        const results = await searchMusic(sql, artist[0].title, 50, denyGroups(groupA), OPEN_OPTS);

        expect(results.some((r) => r.id === creditOnlyArtistId)).toBe(false);
    });
});
