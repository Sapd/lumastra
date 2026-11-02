// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Music Alchemy Query Module — sonic mood-island anchors.
 *
 * Exercises {@link getSonicMoodGroupCounts} (+ {@link buildSonicMoodIslandAnchors})
 * against a real PostgreSQL + pgvector database (`lumastra_tests`):
 *
 *   each brew candidate is assigned to its NEAREST audio mood vector
 *   (mood_vectors row, model_id = MSCLAP_MODEL_ID) by cosine distance (`<=>`)
 *   over its MSCLAP embedding (media_audio_embeddings, model_id = MSCLAP_MODEL_ID),
 *   then grouped into per-mood counts.
 *
 * This mirrors the sonic-mood coloring in getMapPoints (music-map.queries) and
 * uses the SAME vector-literal / seeding helpers as
 * music-map.queries.integration.test.ts.
 *
 * Also covers the no-mood-vectors fallback (empty result → acoustic anchors).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    insertTestArtist,
    createTestAlbum,
    insertTestAlbum,
    createTestTrack,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getSonicMoodGroupCounts,
    buildSonicMoodIslandAnchors,
    buildMoodIslandAnchors,
    getBrewCandidates,
    getBrewCandidatesBySonic,
    getBrewSeedRows,
    getBrewSeedEmbeddings,
    type BrewCandidateRow,
    type PreFilteredCandidates,
} from './music-alchemy.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import { moodToColor } from '$lib/utils/mood-palette.js';

const VECTOR_DIMS = 1024;

/**
 * getSonicMoodGroupCounts aggregates over IDs the caller already scoped, so it
 * takes an attestation rather than a boundary. In these tests the IDs are
 * seeded directly, which is the same contract.
 */
const PRE_FILTERED: PreFilteredCandidates = {
    kind: 'preFiltered',
    reason: 'ids seeded directly by the test fixture',
};

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
            ${MSCLAP_MODEL_ID},
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
        VALUES (${mediaId}::uuid, ${MSCLAP_MODEL_ID}, ${toVectorLiteral(vector)}::vector)
    `;
}

describe('Music Alchemy Queries — sonic mood islands', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        // Final safety net for the rows we created outside the media cascade.
        await sql`DELETE FROM mood_vectors WHERE model_id = ${MSCLAP_MODEL_ID}`;
        await closeTestDb();
    });

    beforeEach(async () => {
        // Truncating media_items CASCADEs to media_audio_embeddings
        // (FK media_items ON DELETE CASCADE).
        await truncateTables(sql, TEST_TABLES.media);
        // mood_vectors is not in the media cascade set — clear it explicitly.
        await sql`DELETE FROM mood_vectors WHERE model_id = ${MSCLAP_MODEL_ID}`;
    });

    describe('nearest sonic mood grouping', () => {
        it('groups each candidate by its nearest audio mood vector', async () => {
            // Two clearly-separated audio moods in MSCLAP space. Use the
            // namespaced keys produced by generateAudioMoodVectors so the anchor
            // label/color stripping is exercised.
            await insertMoodVector(sql, 'music:chill', unitVector(0));
            await insertMoodVector(sql, 'music:party', unitVector(1));

            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            // 3 candidates near chill (axis 0), 2 near party (axis 1).
            const chillIds: string[] = [];
            const partyIds: string[] = [];
            for (let i = 0; i < 3; i++) {
                const t = createTestTrack(album.id, i + 1);
                await insertTestTrack(sql, t);
                await insertAudioEmbedding(sql, t.id, unitVector(0));
                chillIds.push(t.id);
            }
            for (let i = 0; i < 2; i++) {
                const t = createTestTrack(album.id, i + 1);
                await insertTestTrack(sql, t);
                await insertAudioEmbedding(sql, t.id, unitVector(1));
                partyIds.push(t.id);
            }

            const candidateIds = [...chillIds, ...partyIds];
            const groups = await getSonicMoodGroupCounts(sql, candidateIds, PRE_FILTERED);

            // Two non-empty groups, counts matching the seeded distribution.
            const byKey = new Map(groups.map((g) => [g.mood_key, g]));
            expect(byKey.get('music:chill')?.count).toBe(3);
            expect(byKey.get('music:party')?.count).toBe(2);

            // Anchors: one per mood, labels stripped of namespace, colors from
            // the shared palette, deterministic positions inside [0,1]².
            const anchors = buildSonicMoodIslandAnchors(groups);
            expect(anchors).toHaveLength(2);

            const byLabel = new Map(anchors.map((a) => [a.label, a]));
            expect(byLabel.has('chill')).toBe(true);
            expect(byLabel.has('party')).toBe(true);

            const chill = byLabel.get('chill');
            const party = byLabel.get('party');
            expect(chill?.size).toBe(3);
            expect(party?.size).toBe(2);

            for (const a of anchors) {
                expect(a.x).toBeGreaterThanOrEqual(0);
                expect(a.x).toBeLessThanOrEqual(1);
                expect(a.y).toBeGreaterThanOrEqual(0);
                expect(a.y).toBeLessThanOrEqual(1);
            }

            // Colors resolve via the shared palette (stripped label is the key).
            expect(moodToColor(chill?.label ?? '')).toBe(moodToColor('chill'));
            expect(moodToColor(party?.label ?? '')).toBe(moodToColor('party'));

            // Determinism: same input → identical positions.
            const anchors2 = buildSonicMoodIslandAnchors(groups);
            expect(anchors2).toEqual(anchors);

            // Two distinct moods → distinct positions (spread around circle).
            expect(chill?.x !== party?.x || chill?.y !== party?.y).toBe(true);
        });

        it('assigns every candidate to the single available mood', async () => {
            await insertMoodVector(sql, 'music:happy', unitVector(2));

            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const ids: string[] = [];
            for (let i = 0; i < 4; i++) {
                const t = createTestTrack(album.id, i + 1);
                await insertTestTrack(sql, t);
                // Embeddings on various axes — all closer to the only mood than
                // to nothing; the LATERAL picks the single mood regardless.
                await insertAudioEmbedding(sql, t.id, unitVector(2 + (i % 2)));
                ids.push(t.id);
            }

            const groups = await getSonicMoodGroupCounts(sql, ids, PRE_FILTERED);
            expect(groups).toHaveLength(1);
            expect(groups[0].mood_key).toBe('music:happy');
            expect(groups[0].count).toBe(4);

            const anchors = buildSonicMoodIslandAnchors(groups);
            expect(anchors).toHaveLength(1);
            // Single mood is centered.
            expect(anchors[0].label).toBe('happy');
            expect(anchors[0].x).toBeCloseTo(0.5, 5);
            expect(anchors[0].y).toBeCloseTo(0.5, 5);
        });
    });

    describe('no-mood-vectors fallback', () => {
        it('returns no sonic groups/anchors when no MSCLAP mood vectors exist', async () => {
            // Intentionally insert NO mood_vectors. Candidates have embeddings
            // but there is nothing to assign them to.
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const ids: string[] = [];
            for (let i = 0; i < 3; i++) {
                const t = createTestTrack(album.id, i + 1);
                await insertTestTrack(sql, t);
                await insertAudioEmbedding(sql, t.id, unitVector(0));
                ids.push(t.id);
            }

            const groups = await getSonicMoodGroupCounts(sql, ids, PRE_FILTERED);
            expect(groups).toHaveLength(0);

            // buildSonicMoodIslandAnchors must yield [] → brew endpoint then
            // falls back to the acoustic buildMoodIslandAnchors path.
            expect(buildSonicMoodIslandAnchors(groups)).toEqual([]);

            // Sanity: the acoustic fallback still produces islands from the
            // default Essentia data the fixture seeds (energy/danceability +
            // no mood_tags → grouping skips, so this is the realistic "no
            // mood_tags" case where acoustic ALSO yields nothing). Confirm the
            // function is callable and returns an array.
            const candidatesForAcoustic: BrewCandidateRow[] = [];
            expect(Array.isArray(buildMoodIslandAnchors(candidatesForAcoustic))).toBe(true);
        });

        it('returns [] for an empty candidate list without hitting the DB hard', async () => {
            const groups = await getSonicMoodGroupCounts(sql, [], PRE_FILTERED);
            expect(groups).toEqual([]);
            expect(buildSonicMoodIslandAnchors(groups)).toEqual([]);
        });
    });
});

// =============================================================================
// Access-boundary differential tests
// =============================================================================

/**
 * Every access-filtered query in this module takes a REQUIRED
 * {@link MediaAccessBoundary}. These tests run the SAME fixture through each
 * query three times — unrestricted, restricted, deny-all — and assert:
 *
 *   1. `unrestrictedAccess()` — POSITIVE CONTROL, must return rows. A swallowed
 *      error or an unreachable fixture shows up here as an empty set, which
 *      would otherwise make the restricted assertions vacuously true.
 *   2. restricted — a STRICT SUBSET of the unrestricted result: nothing new
 *      appears, and the denied row is gone.
 *   3. `denyAllAccess()` — EMPTY.
 *
 * This is what catches a boundary argument that arrived but was never spliced
 * into the SQL, and a predicate applied to the wrong table alias (the builders
 * hardcode / default to `mi`, so a mis-aliased query throws "missing FROM-clause
 * entry for table mi" — but ONLY under a restricted boundary, since both
 * builders emit an empty fragment when unrestricted).
 *
 * SAMPLING CAVEAT: getBrewCandidates draws `FROM media_items mi TABLESAMPLE
 * BERNOULLI(20)`, and sampling happens BEFORE the WHERE clause. Its result size
 * is therefore random, so it is asserted on ABSENCE (the denied track never
 * appears across repeated draws) rather than on counts.
 */
describe('music-alchemy queries — access boundary is honoured (differential)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    /** Boundary denying exactly the given library groups; age unrestricted. */
    function denyGroups(...ids: string[]): MediaAccessBoundary {
        return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
    }

    async function createLibraryGroup(name: string): Promise<string> {
        const id = crypto.randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
        return id;
    }

    /**
     * Put the track's already-inserted media_files row into a library group so
     * the library-access predicate has a non-NULL group it can exclude. The
     * fixture inserts files with library_group_id NULL, which the predicate
     * always admits.
     */
    async function putTrackInGroup(trackId: string, libraryGroupId: string): Promise<void> {
        await sql`
            UPDATE media_files SET library_group_id = ${libraryGroupId}::uuid
            WHERE id IN (
                SELECT file_id FROM media_file_items WHERE media_item_id = ${trackId}::uuid
            )
        `;
    }

    /** Give the track an age rating so the age axis has something to filter on. */
    async function setAgeRating(trackId: string, ageRating: number): Promise<void> {
        await sql`
            UPDATE media_items SET age_rating = ${ageRating} WHERE id = ${trackId}::uuid
        `;
    }

    let groupA: string;
    let allowedTrackId: string;
    let deniedTrackId: string;
    let albumId: string;

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        await sql`DELETE FROM mood_vectors WHERE model_id = ${MSCLAP_MODEL_ID}`;

        groupA = await createLibraryGroup('Restricted Group A');

        const artist = createTestArtist();
        const album = createTestAlbum(artist.id);
        await insertTestArtist(sql, artist);
        await insertTestAlbum(sql, album);
        albumId = album.id;

        // One track in a denied-able group, one with no group (always visible).
        const denied = createTestTrack(album.id, 1);
        await insertTestTrack(sql, denied);
        await putTrackInGroup(denied.id, groupA);
        deniedTrackId = denied.id;

        const allowed = createTestTrack(album.id, 2);
        await insertTestTrack(sql, allowed);
        allowedTrackId = allowed.id;

        // Both tracks get MSCLAP embeddings so the sonic queries can see them.
        await insertAudioEmbedding(sql, deniedTrackId, unitVector(0));
        await insertAudioEmbedding(sql, allowedTrackId, unitVector(0));
    });

    describe('getBrewCandidatesBySonic', () => {
        const centroid = toVectorLiteral(unitVector(0));

        async function run(access: MediaAccessBoundary): Promise<string[]> {
            const rows = await getBrewCandidatesBySonic(
                sql,
                { seedIds: [], avoidIds: [], access, limit: 10 },
                centroid,
            );
            return rows.map((r) => r.id);
        }

        it('returns a strict subset under a library restriction, and nothing under deny-all', async () => {
            const open = await run(unrestrictedAccess());
            expect(open.length, 'unrestricted boundary must return rows').toBeGreaterThan(0);
            expect(open).toContain(deniedTrackId);
            expect(open).toContain(allowedTrackId);

            const narrowed = await run(denyGroups(groupA));
            const openSet = new Set(open);
            expect(narrowed.every((id) => openSet.has(id))).toBe(true);
            expect(narrowed.length).toBeLessThan(open.length);
            expect(narrowed).not.toContain(deniedTrackId);
            expect(narrowed).toContain(allowedTrackId);

            expect(await run(denyAllAccess())).toEqual([]);
        });

        it('honours the age axis independently of the library axis', async () => {
            await setAgeRating(deniedTrackId, 18);
            await setAgeRating(allowedTrackId, 6);

            const open = await run(unrestrictedAccess());
            expect(open).toHaveLength(2);

            // Library unrestricted, age capped at 12 → only the age-6 track.
            const ageCapped = await run(
                restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false }),
            );
            expect(ageCapped).toEqual([allowedTrackId]);
        });
    });

    describe('getBrewSeedRows', () => {
        async function run(access: MediaAccessBoundary): Promise<string[]> {
            const rows = await getBrewSeedRows(sql, [deniedTrackId, allowedTrackId], access);
            return rows.map((r) => r.id);
        }

        it('returns a strict subset under a library restriction, and nothing under deny-all', async () => {
            const open = await run(unrestrictedAccess());
            expect(open.length, 'unrestricted boundary must return rows').toBe(2);

            const narrowed = await run(denyGroups(groupA));
            expect(narrowed).toEqual([allowedTrackId]);

            expect(await run(denyAllAccess())).toEqual([]);
        });
    });

    describe('getBrewSeedEmbeddings', () => {
        async function run(access: MediaAccessBoundary): Promise<string[]> {
            const rows = await getBrewSeedEmbeddings(sql, [deniedTrackId, allowedTrackId], access);
            return rows.map((r) => r.media_id);
        }

        it('returns a strict subset under a library restriction, and nothing under deny-all', async () => {
            // The unrestricted result must still be BOTH rows — the media_items
            // JOIN added for scoping must not drop rows when nothing is denied.
            const open = await run(unrestrictedAccess());
            expect(open.length, 'unrestricted boundary must return rows').toBe(2);
            expect(new Set(open)).toEqual(new Set([deniedTrackId, allowedTrackId]));

            const narrowed = await run(denyGroups(groupA));
            expect(narrowed).toEqual([allowedTrackId]);

            expect(await run(denyAllAccess())).toEqual([]);
        });
    });

    describe('getBrewCandidates (TABLESAMPLE — absence, not counts)', () => {
        async function run(access: MediaAccessBoundary): Promise<string[]> {
            const rows = await getBrewCandidates(sql, { seedIds: [], avoidIds: [], access });
            return rows.map((r) => r.id);
        }

        it('never returns a denied track across repeated sampled draws', async () => {
            // BERNOULLI(20) samples before WHERE, so any single draw may be
            // empty. Draw repeatedly: assert the positive control eventually
            // sees rows, and that a denied track NEVER appears.
            let sawAnyRowUnrestricted = false;
            for (let i = 0; i < 40; i++) {
                if ((await run(unrestrictedAccess())).length > 0) {
                    sawAnyRowUnrestricted = true;
                    break;
                }
            }
            expect(sawAnyRowUnrestricted, 'unrestricted boundary must return rows').toBe(true);

            for (let i = 0; i < 40; i++) {
                expect(await run(denyGroups(groupA))).not.toContain(deniedTrackId);
            }
        });

        it('returns nothing at all under deny-all', async () => {
            // Deterministic despite the sampling: the query short-circuits
            // before issuing SQL.
            for (let i = 0; i < 10; i++) {
                expect(await run(denyAllAccess())).toEqual([]);
            }
        });
    });

    describe('getSonicMoodGroupCounts', () => {
        it('aggregates over pre-filtered ids without re-applying a boundary', async () => {
            await insertMoodVector(sql, 'music:chill', unitVector(0));

            // Passing ONLY the allowed id (as the real caller does, having
            // already scoped the pool) must count exactly that one track — the
            // denied track is absent because it was never supplied, which is
            // precisely the delegated-scoping contract the attestation records.
            const groups = await getSonicMoodGroupCounts(sql, [allowedTrackId], PRE_FILTERED);
            expect(groups).toHaveLength(1);
            expect(groups[0].count).toBe(1);
            expect(albumId).toBeTruthy();
        });
    });
});
