// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Sonic Taste Picks (real database)
 *
 * sonic-taste.queries.test.ts is pure math plus a hand-rolled mock `sql`, so it
 * cannot verify that the access boundary is actually spliced into the kNN — a
 * boundary argument that arrives and is never used, or a predicate bound to the
 * wrong alias, both look identical to a mock.
 *
 * These tests run getSonicTastePicks against a real database with real pgvector
 * columns and assert the DIFFERENTIAL: the same fixture under a restricted
 * boundary must be a STRICT SUBSET of the same fixture under an unrestricted
 * one, and a denyAll boundary must return nothing at all.
 *
 * Both axes are covered separately (library group and age rating) because
 * buildLibraryAccessFilter hardcodes `mi.id` while buildAgeRatingFilter takes an
 * alias parameter — a regression can break one without touching the other.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import { getSonicTastePicks } from './sonic-taste.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';

/** Explicit unrestricted boundary — no permissive default exists any more. */
const UNRESTRICTED = unrestrictedAccess();

/** Insert an MSCLAP embedding for a track, as a fixed-dimension vector literal. */
async function insertAudioEmbedding(
    sql: postgres.Sql,
    trackId: string,
    vector: number[],
): Promise<void> {
    const vectorString = `[${vector.join(',')}]`;
    await sql`
        INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
        VALUES (${trackId}::uuid, ${MSCLAP_MODEL_ID}, ${vectorString}::vector)
    `;
}

/** Build a base vector plus a helper that nudges one dimension of it. */
function vectorFamily(): { base: number[]; nudge: (index: number) => number[] } {
    const base = Array.from({ length: 1024 }, () => Math.random());
    const nudge = (index: number): number[] => {
        const v = [...base];
        v[index % v.length] += 0.01;
        return v;
    };
    return { base, nudge };
}

/** Seed one embedded track under a shared album/artist and return its id. */
async function seedEmbeddedTrack(
    sql: postgres.Sql,
    albumId: string,
    trackNumber: number,
    vector: number[],
): Promise<string> {
    const track = createTestTrack(albumId, trackNumber, { id: crypto.randomUUID() });
    await insertTestTrack(sql, track);
    await insertAudioEmbedding(sql, track.id, vector);
    return track.id;
}

/** Create a library group and move a track's file rows into it. */
async function putTrackInLibraryGroup(
    sql: postgres.Sql,
    trackId: string,
    groupName: string,
): Promise<string> {
    const [{ id }] = await sql<[{ id: string }]>`
        INSERT INTO library_groups (name) VALUES (${groupName}) RETURNING id::text AS id
    `;
    await sql`
        UPDATE media_files mf
        SET library_group_id = ${id}::uuid
        FROM media_file_items mfi
        WHERE mfi.file_id = mf.id AND mfi.media_item_id = ${trackId}::uuid
    `;
    return id;
}

describe('getSonicTastePicks (real DB)', () => {
    let sql: postgres.Sql;
    const userId = '11111111-2222-4333-8444-555555555555' as UserId;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.sonic,
            ...TEST_TABLES.userData,
            ...TEST_TABLES.media,
        ]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        await ensureTestUser(sql, userId);
    });

    /**
     * Seed a taste profile plus two equally-close candidates.
     *
     * The seed track is rated 8 (the "loved" positive arm), which also excludes
     * it from the candidate set — getSonicTastePicks never re-surfaces tracks
     * the taste was built from. The two candidates are unrated and unplayed, so
     * only the access boundary can separate them.
     */
    async function seedTasteAndCandidates(sql: postgres.Sql): Promise<{
        allowedTrackId: string;
        deniedTrackId: string;
    }> {
        const { base, nudge } = vectorFamily();

        const artist = createTestArtist({ title: 'Taste Artist' });
        await insertTestArtist(sql, artist);
        const album = createTestAlbum(artist.id);
        await insertTestAlbum(sql, album);

        // Positive seed: loved (rating >= 8) → drives the Rocchio centroid.
        const seedTrackId = await seedEmbeddedTrack(sql, album.id, 1, base);
        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating, skipped)
            VALUES (${userId}, ${seedTrackId}::uuid, 9, false)
        `;

        const allowedTrackId = await seedEmbeddedTrack(sql, album.id, 2, nudge(1));
        const deniedTrackId = await seedEmbeddedTrack(sql, album.id, 3, nudge(2));

        return { allowedTrackId, deniedTrackId };
    }

    it('returns a STRICT SUBSET under an age-restricted boundary vs an unrestricted one', async () => {
        const { allowedTrackId, deniedTrackId } = await seedTasteAndCandidates(sql);

        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${deniedTrackId}::uuid`;

        const restricted = restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: 13,
            allowUnrated: true,
        });

        const unrestrictedIds = (await getSonicTastePicks(sql, userId, 20, UNRESTRICTED)).map(
            (r) => r.id,
        );
        const restrictedIds = (await getSonicTastePicks(sql, userId, 20, restricted)).map(
            (r) => r.id,
        );

        // Both candidates are visible without a boundary...
        expect(unrestrictedIds).toContain(allowedTrackId);
        expect(unrestrictedIds).toContain(deniedTrackId);

        // ...and the age-restricted one is dropped with it.
        expect(restrictedIds).toContain(allowedTrackId);
        expect(restrictedIds).not.toContain(deniedTrackId);

        // Strict subset: every restricted id appears unrestricted, and the
        // restricted set is genuinely smaller (not merely equal). An argument
        // that arrives but is never spliced makes these two sets EQUAL.
        expect(restrictedIds.every((id) => unrestrictedIds.includes(id))).toBe(true);
        expect(restrictedIds.length).toBeLessThan(unrestrictedIds.length);
    });

    it('returns a STRICT SUBSET under a denied-library-group boundary', async () => {
        // Separate test for the library axis: buildLibraryAccessFilter hardcodes
        // `mi.id` in its correlated subqueries and takes no alias parameter, so
        // it can regress independently of the age filter.
        const { allowedTrackId, deniedTrackId } = await seedTasteAndCandidates(sql);

        const deniedGroupId = await putTrackInLibraryGroup(sql, deniedTrackId, 'Denied Group');

        const restricted = restrictedAccess({
            deniedGroupIds: [deniedGroupId],
            maxAgeRating: null,
            allowUnrated: true,
        });

        const unrestrictedIds = (await getSonicTastePicks(sql, userId, 20, UNRESTRICTED)).map(
            (r) => r.id,
        );
        const restrictedIds = (await getSonicTastePicks(sql, userId, 20, restricted)).map(
            (r) => r.id,
        );

        expect(unrestrictedIds).toContain(allowedTrackId);
        expect(unrestrictedIds).toContain(deniedTrackId);

        expect(restrictedIds).toContain(allowedTrackId);
        expect(restrictedIds).not.toContain(deniedTrackId);

        expect(restrictedIds.every((id) => unrestrictedIds.includes(id))).toBe(true);
        expect(restrictedIds.length).toBeLessThan(unrestrictedIds.length);
    });

    it('returns EMPTY under a denyAll boundary against a non-empty fixture', async () => {
        await seedTasteAndCandidates(sql);

        // Sanity: there IS something to find, so an empty denyAll result is the
        // boundary working rather than an empty fixture.
        expect(await getSonicTastePicks(sql, userId, 20, UNRESTRICTED)).not.toHaveLength(0);

        expect(await getSonicTastePicks(sql, userId, 20, denyAllAccess())).toEqual([]);
    });
});
