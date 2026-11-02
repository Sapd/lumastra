// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the sonic-path access boundary (real database).
 *
 * sonic-path.queries.test.ts mocks the sql tag, so it can prove the boundary is
 * threaded through and that the fragments it emits are the right TEXT — but it
 * can never prove that text is valid SQL against the surrounding query. Two
 * failure modes only a real Postgres catches:
 *
 *   1. THE ALIAS CONTRACT. `buildLibraryAccessFilter` hardcodes `mi.id` and
 *      `buildAgeRatingFilter` defaults its alias to `mi`. If a query aliases the
 *      candidate media_items row anything else, Postgres raises "missing
 *      FROM-clause entry for table mi" — but ONLY for restricted callers,
 *      because both builders emit an empty fragment when unrestricted. The
 *      sibling module shipped exactly that bug once.
 *   2. THE SEED JOIN. `fetchSeedEmbedding` now joins media_items so the boundary
 *      can apply to seed reads. That join must not silently drop seeds.
 *
 * The differential tests here run the SAME fixture under an unrestricted and a
 * restricted boundary and assert the restricted result is a STRICT SUBSET. That
 * is what catches a boundary argument that arrives but is never spliced in, or
 * one bound to the wrong alias: both make the two results EQUAL, which no
 * "resolves without throwing" test can detect.
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
import { buildSonicPath, fetchSeedEmbedding } from './sonic-path.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';

/** Explicit unrestricted boundary — no permissive default exists any more. */
const UNRESTRICTED = unrestrictedAccess();

const DENIED_GROUP_ID = 'dddddddd-eeee-4fff-8000-111111111111';

/** A real restricted user: one denied library group plus an age ceiling. */
const RESTRICTED = restrictedAccess({
    deniedGroupIds: [DENIED_GROUP_ID],
    maxAgeRating: 13,
    allowUnrated: true,
});

const EMBED_DIMS = 1024;

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

/** Seed an artist -> album -> single embedded track chain. */
async function seedEmbeddedTrack(
    sql: postgres.Sql,
    title: string,
    vector: number[],
): Promise<string> {
    const artist = createTestArtist({ title: `${title} Artist` });
    await insertTestArtist(sql, artist);
    const album = createTestAlbum(artist.id, { title: `${title} Album` });
    await insertTestAlbum(sql, album);
    // Distinct titles matter: same-title tracks collapse under the title-dedup
    // window and would drop out of the bridge for reasons unrelated to access.
    //
    // custom_metadata.artist MUST echo the artist we just created above.
    // createTestTrack's own default is the literal 'Test Artist' for every
    // track regardless of caller, which was harmless while sonic-path read
    // artist_id off the bare album-artist join, but trackArtistIdSql (wired in
    // by d3058e551) requires the tag to actually name the joined artist before
    // trusting its id. Left at the shared default, EVERY track in this fixture
    // resolves the same fallback bucket key ('Test Artist', from
    // trackDisplayArtistSql's per-track-tag priority) despite having genuinely
    // distinct artists — which silently trips the real MAX_TRACKS_PER_ARTIST
    // cap partway through a bridge and makes the open/closed candidate sets
    // diverge for a reason that has nothing to do with the access boundary
    // under test.
    const track = createTestTrack(album.id, 1, {
        title,
        custom_metadata: { artist: artist.title, album: album.title, track_number: 1 },
    });
    await insertTestTrack(sql, track);
    await insertAudioEmbedding(sql, track.id, vector);
    return track.id;
}

/** Move a track's file into the denied library group. */
async function denyTrackLibraryGroup(sql: postgres.Sql, trackId: string): Promise<void> {
    await sql`
        INSERT INTO library_groups (id, name)
        VALUES (${DENIED_GROUP_ID}::uuid, 'Denied Group')
        ON CONFLICT (id) DO NOTHING
    `;
    await sql`
        UPDATE media_files SET library_group_id = ${DENIED_GROUP_ID}::uuid
        WHERE id IN (
            SELECT file_id FROM media_file_items WHERE media_item_id = ${trackId}::uuid
        )
    `;
}

/**
 * A `from` seed at one corner of the space, a `to` seed at another, and N
 * candidates spread along the straight line between them so the interpolated
 * waypoints have something to land on.
 */
function pathVectors(count: number): { from: number[]; to: number[]; between: number[][] } {
    const from = new Array<number>(EMBED_DIMS).fill(0);
    from[0] = 1;
    const to = new Array<number>(EMBED_DIMS).fill(0);
    to[1] = 1;

    const between: number[][] = [];
    for (let i = 1; i <= count; i++) {
        const t = i / (count + 1);
        const v = new Array<number>(EMBED_DIMS).fill(0);
        v[0] = 1 - t;
        v[1] = t;
        between.push(v);
    }
    return { from, to, between };
}

describe('sonic path access boundary (real DB)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.sonic, ...TEST_TABLES.media]);
        await sql`DELETE FROM library_groups WHERE id = ${DENIED_GROUP_ID}::uuid`;
    });

    it('resolves under a restricted boundary (the "missing FROM-clause entry for table mi" guard)', async () => {
        const { from, to, between } = pathVectors(3);
        const fromId = await seedEmbeddedTrack(sql, 'Seed From', from);
        const toId = await seedEmbeddedTrack(sql, 'Seed To', to);
        for (const [i, v] of between.entries()) {
            await seedEmbeddedTrack(sql, `Bridge ${i}`, v);
        }

        // Under UNRESTRICTED both builders emit an empty fragment, so only a
        // restricted boundary actually compiles the access predicates against
        // the surrounding query's aliases.
        const result = await buildSonicPath(sql, fromId, toId, 3, RESTRICTED);

        expect(result.missingEmbedding).toBeNull();
        expect(result.steps.length).toBeGreaterThan(0);
    });

    it('returns a STRICT SUBSET under an age-restricted boundary', async () => {
        // Differential test on the age axis. Three candidates lie on the line
        // between the seeds; exactly one is age-restricted above the ceiling.
        const { from, to, between } = pathVectors(3);
        const fromId = await seedEmbeddedTrack(sql, 'Seed From', from);
        const toId = await seedEmbeddedTrack(sql, 'Seed To', to);
        const bridgeIds: string[] = [];
        for (const [i, v] of between.entries()) {
            bridgeIds.push(await seedEmbeddedTrack(sql, `Bridge ${i}`, v));
        }

        const adultId = bridgeIds[1];
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adultId}::uuid`;

        const open = (await buildSonicPath(sql, fromId, toId, 3, UNRESTRICTED)).steps.map(
            (s) => s.media_id,
        );
        const closed = (await buildSonicPath(sql, fromId, toId, 3, RESTRICTED)).steps.map(
            (s) => s.media_id,
        );

        // The adult track is reachable without a boundary...
        expect(open).toContain(adultId);
        // ...and gone with one.
        expect(closed).not.toContain(adultId);
        // Strict subset: nothing new appeared, and the set really did shrink.
        expect(closed.every((id) => open.includes(id))).toBe(true);
        expect(closed.length).toBeLessThan(open.length);
    });

    it('returns a STRICT SUBSET under a library-group-restricted boundary', async () => {
        // The same differential on the OTHER axis. The two axes emit different
        // predicates (a correlated EXISTS/NOT EXISTS pair vs a column
        // comparison), so passing one proves nothing about the other.
        const { from, to, between } = pathVectors(3);
        const fromId = await seedEmbeddedTrack(sql, 'Seed From', from);
        const toId = await seedEmbeddedTrack(sql, 'Seed To', to);
        const bridgeIds: string[] = [];
        for (const [i, v] of between.entries()) {
            bridgeIds.push(await seedEmbeddedTrack(sql, `Bridge ${i}`, v));
        }

        const deniedId = bridgeIds[1];
        await denyTrackLibraryGroup(sql, deniedId);

        const open = (await buildSonicPath(sql, fromId, toId, 3, UNRESTRICTED)).steps.map(
            (s) => s.media_id,
        );
        const closed = (await buildSonicPath(sql, fromId, toId, 3, RESTRICTED)).steps.map(
            (s) => s.media_id,
        );

        expect(open).toContain(deniedId);
        expect(closed).not.toContain(deniedId);
        expect(closed.every((id) => open.includes(id))).toBe(true);
        expect(closed.length).toBeLessThan(open.length);
    });

    it('returns an EMPTY bridge under a denyAll boundary', async () => {
        const { from, to, between } = pathVectors(3);
        const fromId = await seedEmbeddedTrack(sql, 'Seed From', from);
        const toId = await seedEmbeddedTrack(sql, 'Seed To', to);
        for (const [i, v] of between.entries()) {
            await seedEmbeddedTrack(sql, `Bridge ${i}`, v);
        }

        // Sanity: there IS a bridge to find, so the empty denyAll result is the
        // boundary working rather than an empty fixture.
        expect(
            (await buildSonicPath(sql, fromId, toId, 3, UNRESTRICTED)).steps.length,
        ).toBeGreaterThan(0);

        expect(await buildSonicPath(sql, fromId, toId, 3, denyAllAccess())).toEqual({
            steps: [],
            missingEmbedding: null,
        });
    });

    it('fetchSeedEmbedding still finds an accessible seed through the new media_items join', async () => {
        // The join added for the boundary must not drop seeds. The FK from
        // media_audio_embeddings is ON DELETE CASCADE, so it cannot — but assert
        // it, because a wrong join condition would silently return null and
        // surface as a bogus "no embedding, go run the embedder" error.
        const { from } = pathVectors(1);
        const seedId = await seedEmbeddedTrack(sql, 'Seed From', from);

        const open = await fetchSeedEmbedding(sql, seedId, UNRESTRICTED);
        expect(open).toHaveLength(EMBED_DIMS);

        const restricted = await fetchSeedEmbedding(sql, seedId, RESTRICTED);
        expect(restricted).toHaveLength(EMBED_DIMS);
    });

    it('fetchSeedEmbedding hides a seed outside the boundary', async () => {
        const { from } = pathVectors(1);
        const seedId = await seedEmbeddedTrack(sql, 'Seed From', from);
        await denyTrackLibraryGroup(sql, seedId);

        // Visible without a boundary...
        expect(await fetchSeedEmbedding(sql, seedId, UNRESTRICTED)).toHaveLength(EMBED_DIMS);
        // ...invisible with one, and indistinguishable from "no embedding yet".
        expect(await fetchSeedEmbedding(sql, seedId, RESTRICTED)).toBeNull();
        expect(await fetchSeedEmbedding(sql, seedId, denyAllAccess())).toBeNull();
    });

    it('a seed outside the boundary cannot be used as a bridge endpoint', async () => {
        // End-to-end consequence of the test above: the boundary is enforced in
        // the query layer, not only by a route-level checkMediaAccess a future
        // caller could forget.
        const { from, to, between } = pathVectors(3);
        const fromId = await seedEmbeddedTrack(sql, 'Seed From', from);
        const toId = await seedEmbeddedTrack(sql, 'Seed To', to);
        for (const [i, v] of between.entries()) {
            await seedEmbeddedTrack(sql, `Bridge ${i}`, v);
        }
        await denyTrackLibraryGroup(sql, fromId);

        // The same call succeeds for an unrestricted caller.
        expect(
            (await buildSonicPath(sql, fromId, toId, 3, UNRESTRICTED)).steps.length,
        ).toBeGreaterThan(0);

        const result = await buildSonicPath(sql, fromId, toId, 3, RESTRICTED);
        expect(result.missingEmbedding).toBe('from');
        expect(result.steps).toHaveLength(0);
    });
});
