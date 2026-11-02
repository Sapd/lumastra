// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Music Map Query Module — sonic-mood coloring.
 *
 * Exercises {@link getMapPoints}'s `top_mood` resolution against a real
 * PostgreSQL + pgvector database (`lumastra_tests`):
 *
 *   top_mood = COALESCE(
 *       NULLIF(custom_metadata->'essentia'->'mood_tags'->>0, ''),
 *       <nearest sonic mood>
 *   )
 *
 * where <nearest sonic mood> is the mood_vectors row (model_id=MAP_MODEL_ID)
 * whose `vector` has the smallest cosine distance (`<=>`) to the track's
 * MSCLAP embedding (media_audio_embeddings, model_id=MAP_MODEL_ID).
 *
 * Also covers access-scoping (denied library group excluded).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    insertTestArtist,
    createTestAlbum,
    insertTestAlbum,
    createTestTrack,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';

import { getMapPoints, countSonicEmbeddingCoverage, MAP_MODEL_ID } from './music-map.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

/** Explicit unrestricted boundary (sees everything on both axes). */
const UNRESTRICTED: MediaAccessBoundary = unrestrictedAccess();

/** Boundary that denies the given library groups and nothing else. */
function denyGroups(...ids: string[]): MediaAccessBoundary {
    return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
}

const VECTOR_DIMS = 1024;

/**
 * Build a 1024-dim vector that is (almost) a unit vector along `axis`.
 * A tiny epsilon is added to every other dimension so the vector is never the
 * zero vector (cosine distance is undefined for a zero vector) and so two
 * different-axis vectors stay clearly separated in cosine space.
 */
function unitVector(axis: number): number[] {
    const v = new Array<number>(VECTOR_DIMS).fill(0.0001);
    v[axis] = 1;
    return v;
}

/** Format a numeric array as a pgvector literal (e.g. "[1,0,0,...]"). */
function toVectorLiteral(values: number[]): string {
    return `[${values.join(',')}]`;
}

/** Insert one mood_vectors row for the MSCLAP model. */
async function insertMoodVector(
    sql: postgres.Sql,
    moodKey: string,
    vector: number[],
): Promise<void> {
    await sql`
        INSERT INTO mood_vectors (mood_key, model_id, display_name, vector)
        VALUES (
            ${moodKey},
            ${MAP_MODEL_ID},
            ${moodKey},
            ${toVectorLiteral(vector)}::vector
        )
    `;
}

/** Insert one media_audio_embeddings row (MSCLAP model) for a track. */
async function insertAudioEmbedding(
    sql: postgres.Sql,
    mediaId: string,
    vector: number[],
): Promise<void> {
    await sql`
        INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
        VALUES (${mediaId}::uuid, ${MAP_MODEL_ID}, ${toVectorLiteral(vector)}::vector)
    `;
}

/** Insert one media_audio_map_coords row (MSCLAP model) for a track. */
async function insertMapCoord(
    sql: postgres.Sql,
    mediaId: string,
    x: number,
    y: number,
): Promise<void> {
    await sql`
        INSERT INTO media_audio_map_coords (media_id, model_id, x, y)
        VALUES (${mediaId}::uuid, ${MAP_MODEL_ID}, ${x}::real, ${y}::real)
    `;
}

describe('Music Map Queries — sonic-mood coloring', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        // Final safety net for the rows we created outside the media cascade.
        await sql`DELETE FROM mood_vectors WHERE model_id = ${MAP_MODEL_ID}`;
        // library_paths RESTRICT-references library_groups
        // (fk_library_paths_library_group), so any library_paths rows left by a
        // prior file must be cleared FIRST or the DELETE below raises a FK
        // violation. (This file never inserts library_paths itself.)
        await sql`DELETE FROM library_paths`;
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        // Connection lifecycle is owned by the harness (per-fork pool closed on
        // process exit); closeTestDb() is a no-op kept for back-compat.
    });

    beforeEach(async () => {
        // Make this file self-isolating: TRUNCATE every table getMapPoints reads
        // BEFORE seeding, so rows another (sequentially-run) test file leaves
        // behind can't bleed into the nearest-sonic-mood resolution.
        //
        // Truncating media_items CASCADEs to media_audio_embeddings and
        // media_audio_map_coords (both FK media_items ON DELETE CASCADE). We also
        // truncate the TEST_TABLES.sonic set explicitly — its mood_vectors table
        // is STANDALONE (no FK to media_items), so it survives the media cascade
        // and a stray mood_vectors row would silently flip a `top_mood`
        // assertion (or make the "no mood vectors" case non-null). Clearing it
        // for ALL model_ids (not just MAP_MODEL_ID) keeps us robust even if a
        // future model id is introduced. library_groups is likewise standalone.
        await truncateTables(sql, TEST_TABLES.media);
        await truncateTables(sql, TEST_TABLES.sonic);
        // library_paths RESTRICT-references library_groups
        // (fk_library_paths_library_group), so clear any paths a prior file left
        // behind BEFORE deleting groups, or the DELETE raises a FK violation.
        await sql`DELETE FROM library_paths`;
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
    });

    describe('nearest sonic mood', () => {
        it('colors each point with the mood_vectors row closest to its embedding', async () => {
            // Two clearly-separated moods in MSCLAP space.
            await insertMoodVector(sql, 'moodA', unitVector(0));
            await insertMoodVector(sql, 'moodB', unitVector(1));

            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            // Track A: embedding near moodA (axis 0). No essentia mood_tags so
            // the sonic fallback decides the color.
            const trackA = createTestTrack(album.id, 1, {
                custom_metadata: { artist: 'Test Artist' },
            });
            await insertTestTrack(sql, trackA);
            await insertAudioEmbedding(sql, trackA.id, unitVector(0));
            await insertMapCoord(sql, trackA.id, 0.1, 0.1);

            // Track B: embedding near moodB (axis 1).
            const trackB = createTestTrack(album.id, 2, {
                custom_metadata: { artist: 'Test Artist' },
            });
            await insertTestTrack(sql, trackB);
            await insertAudioEmbedding(sql, trackB.id, unitVector(1));
            await insertMapCoord(sql, trackB.id, 0.9, 0.9);

            const points = await getMapPoints(sql, UNRESTRICTED);

            const a = points.find((p) => p.media_id === trackA.id);
            const b = points.find((p) => p.media_id === trackB.id);

            expect(a).toBeDefined();
            expect(b).toBeDefined();
            expect(a?.top_mood).toBe('moodA');
            expect(b?.top_mood).toBe('moodB');
        });
    });

    describe('essentia tag precedence', () => {
        it('prefers custom_metadata.essentia.mood_tags[0] over the nearest sonic mood', async () => {
            // The only sonic mood is 'moodB' (axis 1) and the embedding sits on
            // axis 1, so the sonic fallback would pick 'moodB'. The explicit
            // essentia tag 'happy' must win via COALESCE/NULLIF order.
            await insertMoodVector(sql, 'moodB', unitVector(1));

            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const track = createTestTrack(album.id, 1, {
                custom_metadata: {
                    artist: 'Test Artist',
                    essentia: { mood_tags: ['happy', 'energetic'] },
                },
            });
            await insertTestTrack(sql, track);
            await insertAudioEmbedding(sql, track.id, unitVector(1));
            await insertMapCoord(sql, track.id, 0.5, 0.5);

            const points = await getMapPoints(sql, UNRESTRICTED);
            const point = points.find((p) => p.media_id === track.id);

            expect(point).toBeDefined();
            expect(point?.top_mood).toBe('happy');
        });
    });

    describe('no mood vectors', () => {
        it('returns top_mood = null when no MSCLAP mood_vectors exist', async () => {
            // Intentionally insert NO mood_vectors. Track has an embedding and a
            // map coord but no essentia mood_tags → top_mood must be null.
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const track = createTestTrack(album.id, 1, {
                custom_metadata: { artist: 'Test Artist' },
            });
            await insertTestTrack(sql, track);
            await insertAudioEmbedding(sql, track.id, unitVector(0));
            await insertMapCoord(sql, track.id, 0.2, 0.3);

            const points = await getMapPoints(sql, UNRESTRICTED);
            const point = points.find((p) => p.media_id === track.id);

            expect(point).toBeDefined();
            expect(point?.top_mood).toBeNull();
        });
    });

    describe('access scoping', () => {
        it('excludes tracks whose only file is in a denied library group', async () => {
            await insertMoodVector(sql, 'moodA', unitVector(0));

            const deniedGroupId = crypto.randomUUID();
            await sql`
                INSERT INTO library_groups (id, name)
                VALUES (${deniedGroupId}::uuid, 'Denied Group')
            `;

            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            // Visible track — its media_files row has a NULL library_group_id
            // (set by the fixture), so it passes the access filter.
            const visibleTrack = createTestTrack(album.id, 1, {
                custom_metadata: { artist: 'Test Artist' },
            });
            await insertTestTrack(sql, visibleTrack);
            await insertAudioEmbedding(sql, visibleTrack.id, unitVector(0));
            await insertMapCoord(sql, visibleTrack.id, 0.1, 0.1);

            // Denied track — move all its files into the denied library group.
            const deniedTrack = createTestTrack(album.id, 2, {
                custom_metadata: { artist: 'Test Artist' },
            });
            await insertTestTrack(sql, deniedTrack);
            await insertAudioEmbedding(sql, deniedTrack.id, unitVector(0));
            await insertMapCoord(sql, deniedTrack.id, 0.9, 0.9);
            await sql`
                UPDATE media_files mf
                SET library_group_id = ${deniedGroupId}::uuid
                FROM media_file_items mfi
                WHERE mfi.file_id = mf.id
                  AND mfi.media_item_id = ${deniedTrack.id}::uuid
            `;

            const points = await getMapPoints(sql, denyGroups(deniedGroupId));

            const ids = points.map((p) => p.media_id);
            expect(ids).toContain(visibleTrack.id);
            expect(ids).not.toContain(deniedTrack.id);
        });
    });

    /**
     * Differential access tests — the ones that catch a boundary argument that
     * arrived but was never spliced into the SQL, or that landed on the wrong
     * `media_items` alias (`getMapPoints` joins media_items three times: `mi`,
     * `album`, `artist`; only `mi` is the access-bearing one).
     *
     * The shape is always: run the SAME query against the SAME fixture twice and
     * compare. An ignored argument makes restricted == unrestricted, which the
     * strict-subset assertions below reject. A predicate on the wrong alias
     * either drops nothing (same failure) or drops everything (caught by the
     * positive control asserting the unrestricted run is non-empty).
     */
    describe('access boundary is actually applied (differential)', () => {
        /**
         * Seed two tracks: one whose file sits in `groupId`, one whose file has
         * a NULL library_group_id. Both get a map coord so both are candidates.
         */
        async function seedTwoTracks(
            groupId: string,
        ): Promise<{ openTrackId: string; groupedTrackId: string }> {
            await sql`
                INSERT INTO library_groups (id, name)
                VALUES (${groupId}::uuid, 'Differential Group')
            `;

            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const openTrack = createTestTrack(album.id, 1, {
                custom_metadata: { artist: 'Test Artist' },
            });
            await insertTestTrack(sql, openTrack);
            await insertMapCoord(sql, openTrack.id, 0.1, 0.1);

            const groupedTrack = createTestTrack(album.id, 2, {
                custom_metadata: { artist: 'Test Artist' },
            });
            await insertTestTrack(sql, groupedTrack);
            await insertMapCoord(sql, groupedTrack.id, 0.9, 0.9);
            await sql`
                UPDATE media_files mf
                SET library_group_id = ${groupId}::uuid
                FROM media_file_items mfi
                WHERE mfi.file_id = mf.id
                  AND mfi.media_item_id = ${groupedTrack.id}::uuid
            `;

            return { openTrackId: openTrack.id, groupedTrackId: groupedTrack.id };
        }

        it('getMapPoints: restricted result is a STRICT subset of unrestricted', async () => {
            const groupId = crypto.randomUUID();
            const { openTrackId, groupedTrackId } = await seedTwoTracks(groupId);

            const openIds = (await getMapPoints(sql, UNRESTRICTED)).map((p) => p.media_id);
            const restrictedIds = (await getMapPoints(sql, denyGroups(groupId))).map(
                (p) => p.media_id,
            );

            // Positive control: without this, an always-empty query would pass
            // the subset assertion vacuously.
            expect(openIds).toEqual(expect.arrayContaining([openTrackId, groupedTrackId]));

            // Subset: every restricted row is also an unrestricted row.
            for (const id of restrictedIds) expect(openIds).toContain(id);
            // STRICT: at least one row was actually dropped.
            expect(restrictedIds.length).toBeLessThan(openIds.length);
            expect(restrictedIds).toContain(openTrackId);
            expect(restrictedIds).not.toContain(groupedTrackId);
        });

        it('getMapPoints: denyAll returns EMPTY', async () => {
            const groupId = crypto.randomUUID();
            await seedTwoTracks(groupId);

            expect((await getMapPoints(sql, UNRESTRICTED)).length).toBeGreaterThan(0);
            expect(await getMapPoints(sql, denyAllAccess())).toEqual([]);
        });

        it('getMapPoints: an age limit that excludes unrated drops every unrated track', async () => {
            // Fixture tracks carry no age_rating, so `allowUnrated` alone flips
            // the whole result. This exercises the AGE axis independently of the
            // library axis — a boundary wired only on `library` passes the
            // subset test above but fails here.
            const groupId = crypto.randomUUID();
            await seedTwoTracks(groupId);

            const allowUnrated = await getMapPoints(
                sql,
                restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: true }),
            );
            const denyUnrated = await getMapPoints(
                sql,
                restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false }),
            );

            expect(allowUnrated.length).toBeGreaterThan(0);
            expect(denyUnrated).toEqual([]);
        });

        it('countSonicEmbeddingCoverage: restricted total is a STRICT subset count of unrestricted', async () => {
            const groupId = crypto.randomUUID();
            const { openTrackId, groupedTrackId } = await seedTwoTracks(groupId);
            // Give exactly one track an embedding so `embedded` is meaningful.
            await insertAudioEmbedding(sql, openTrackId, unitVector(0));
            await insertAudioEmbedding(sql, groupedTrackId, unitVector(1));

            const open = await countSonicEmbeddingCoverage(sql, UNRESTRICTED);
            const restricted = await countSonicEmbeddingCoverage(sql, denyGroups(groupId));

            expect(open.total).toBeGreaterThanOrEqual(2);
            expect(restricted.total).toBeLessThan(open.total);
            expect(restricted.embedded).toBeLessThan(open.embedded);
        });

        it('countSonicEmbeddingCoverage: denyAll returns zeroes', async () => {
            const groupId = crypto.randomUUID();
            const { openTrackId } = await seedTwoTracks(groupId);
            await insertAudioEmbedding(sql, openTrackId, unitVector(0));

            expect((await countSonicEmbeddingCoverage(sql, UNRESTRICTED)).total).toBeGreaterThan(0);
            expect(await countSonicEmbeddingCoverage(sql, denyAllAccess())).toEqual({
                embedded: 0,
                total: 0,
            });
        });
    });
});
