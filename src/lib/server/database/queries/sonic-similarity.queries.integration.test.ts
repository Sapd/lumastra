// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Sonic Similarity Queries (real database)
 *
 * The existing sonic-similarity.queries.test.ts only mocks the sql tag (it
 * exercises findSonicNeighbors, not findSonicNeighborArtists), so it can't
 * verify the is_various_artists exclusion end-to-end. This file runs
 * findSonicNeighborArtists against a real database with real pgvector
 * columns.
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
import { findSonicNeighborArtists, findSonicNeighborAlbums } from './sonic-similarity.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';

/** Explicit unrestricted boundary — no permissive default exists any more. */
const UNRESTRICTED = unrestrictedAccess();

/**
 * A restricted boundary (a denied library group AND a max age rating) — this is
 * the shape that previously crashed findSonicNeighborArtists /
 * findSonicNeighborAlbums with a real Postgres "missing FROM-clause entry
 * for table mi" error, because the candidate-track join was aliased `track`
 * while buildLibraryAccessFilter/buildAgeRatingFilter reference `mi`. Under
 * UNRESTRICTED both filters compile to empty fragments, so only a restricted
 * boundary exercises the bug.
 */
const RESTRICTED = restrictedAccess({
    deniedGroupIds: ['dddddddd-eeee-4fff-8000-111111111111'],
    maxAgeRating: 13,
    allowUnrated: true,
});

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

/** Seed an artist -> album -> single track chain with an MSCLAP embedding. */
async function seedEmbeddedArtist(
    sql: postgres.Sql,
    title: string,
    vector: number[],
): Promise<string> {
    const { artistId } = await seedEmbeddedArtistChain(sql, title, vector);
    return artistId;
}

/**
 * Like {@link seedEmbeddedArtist} but also hands back the album and track ids,
 * so a test can age-restrict the candidate TRACK — which is the grain the access
 * boundary actually constrains in these queries (see the module's grain note).
 */
async function seedEmbeddedArtistChain(
    sql: postgres.Sql,
    title: string,
    vector: number[],
): Promise<{ artistId: string; albumId: string; trackId: string }> {
    const artist = createTestArtist({ title });
    await insertTestArtist(sql, artist);
    const album = createTestAlbum(artist.id);
    await insertTestAlbum(sql, album);
    const track = createTestTrack(album.id, 1);
    await insertTestTrack(sql, track);
    await insertAudioEmbedding(sql, track.id, vector);
    return { artistId: artist.id, albumId: album.id, trackId: track.id };
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

describe('findSonicNeighborArtists (real DB)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.sonic, ...TEST_TABLES.media]);
    });

    it('excludes a flagged Various Artists neighbor but returns an ordinary neighbor', async () => {
        // Base vector shared by all three artists so they all sit close to the
        // seed centroid — the only thing that should keep the VA artist out
        // of the results is the is_various_artists flag, not distance.
        const base = Array.from({ length: 1024 }, () => Math.random());
        const nudge = (index: number): number[] => {
            const v = [...base];
            v[index % v.length] += 0.01;
            return v;
        };

        const seedArtistId = await seedEmbeddedArtist(sql, 'Seed Artist', base);
        const ordinaryArtistId = await seedEmbeddedArtist(sql, 'Ordinary Neighbor', nudge(1));
        const vaArtistId = await seedEmbeddedArtist(sql, 'Foreign VA Bucket', nudge(2));
        await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${vaArtistId}::uuid`;

        const results = await findSonicNeighborArtists(sql, seedArtistId, 10, UNRESTRICTED);
        const ids = results.map((r) => r.artist_id);

        expect(ids).toContain(ordinaryArtistId);
        expect(ids).not.toContain(vaArtistId);
    });

    it('resolves (does not throw "missing FROM-clause entry for table mi") under a restricted access context', async () => {
        const base = Array.from({ length: 1024 }, () => Math.random());
        const nudge = (index: number): number[] => {
            const v = [...base];
            v[index % v.length] += 0.01;
            return v;
        };

        const seedArtistId = await seedEmbeddedArtist(sql, 'Seed Artist', base);
        const neighborArtistId = await seedEmbeddedArtist(sql, 'Neighbor Artist', nudge(1));

        // Regression guard for the `mi` alias bug: this used to throw a real
        // Postgres error ("missing FROM-clause entry for table mi") for any
        // restricted user because the access filters referenced an alias the
        // outer query never defined.
        const results = await findSonicNeighborArtists(sql, seedArtistId, 10, RESTRICTED);
        const ids = results.map((r) => r.artist_id);

        expect(ids).toContain(neighborArtistId);
    });

    it('returns a STRICT SUBSET under an age-restricted boundary vs an unrestricted one', async () => {
        // Differential test. Two equally-close neighbors; one of them has an
        // age-restricted TRACK. Restricting must drop exactly that one.
        //
        // This is what catches a boundary argument that arrives but is never
        // spliced into the query, or a predicate bound to the wrong alias: both
        // failure modes make the restricted result EQUAL the unrestricted one,
        // which no "resolves without throwing" test can detect.
        const { base, nudge } = vectorFamily();

        const seedArtistId = await seedEmbeddedArtist(sql, 'Seed Artist', base);
        const allowedArtistId = await seedEmbeddedArtist(sql, 'Allowed Neighbor', nudge(1));
        const adultChain = await seedEmbeddedArtistChain(sql, 'Adult Neighbor', nudge(2));

        // Age-restrict the candidate TRACK, not the artist row — the boundary
        // constrains `mi` (the track), and an artist whose tracks are all denied
        // loses its entire GROUP BY input and vanishes from the results.
        await sql`
            UPDATE media_items SET age_rating = 18 WHERE id = ${adultChain.trackId}::uuid
        `;

        const unrestricted = (
            await findSonicNeighborArtists(sql, seedArtistId, 10, UNRESTRICTED)
        ).map((r) => r.artist_id);
        const restricted = (await findSonicNeighborArtists(sql, seedArtistId, 10, RESTRICTED)).map(
            (r) => r.artist_id,
        );

        // Both neighbors are visible without a boundary...
        expect(unrestricted).toContain(allowedArtistId);
        expect(unrestricted).toContain(adultChain.artistId);

        // ...and the age-restricted one is dropped with it.
        expect(restricted).toContain(allowedArtistId);
        expect(restricted).not.toContain(adultChain.artistId);

        // Strict subset: every restricted id appears unrestricted, and the
        // restricted set is genuinely smaller (not merely equal).
        expect(restricted.every((id) => unrestricted.includes(id))).toBe(true);
        expect(restricted.length).toBeLessThan(unrestricted.length);
    });

    it('returns EMPTY under a denyAll boundary', async () => {
        const { base, nudge } = vectorFamily();

        const seedArtistId = await seedEmbeddedArtist(sql, 'Seed Artist', base);
        await seedEmbeddedArtist(sql, 'Neighbor Artist', nudge(1));

        // Sanity: there IS something to find, so an empty denyAll result is the
        // boundary working rather than an empty fixture.
        expect(
            await findSonicNeighborArtists(sql, seedArtistId, 10, UNRESTRICTED),
        ).not.toHaveLength(0);

        expect(await findSonicNeighborArtists(sql, seedArtistId, 10, denyAllAccess())).toEqual([]);
    });
});

describe('findSonicNeighborAlbums (real DB)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.sonic, ...TEST_TABLES.media]);
    });

    it('resolves (does not throw "missing FROM-clause entry for table mi") under a restricted access context', async () => {
        const base = Array.from({ length: 1024 }, () => Math.random());
        const nudge = (index: number): number[] => {
            const v = [...base];
            v[index % v.length] += 0.01;
            return v;
        };

        const artist = createTestArtist({ title: 'Seed Album Artist' });
        await insertTestArtist(sql, artist);

        const seedAlbum = createTestAlbum(artist.id);
        await insertTestAlbum(sql, seedAlbum);
        const seedTrack = createTestTrack(seedAlbum.id, 1);
        await insertTestTrack(sql, seedTrack);
        await insertAudioEmbedding(sql, seedTrack.id, base);

        const neighborAlbum = createTestAlbum(artist.id);
        await insertTestAlbum(sql, neighborAlbum);
        const neighborTrack = createTestTrack(neighborAlbum.id, 1);
        await insertTestTrack(sql, neighborTrack);
        await insertAudioEmbedding(sql, neighborTrack.id, nudge(1));

        // Regression guard for the `mi` alias bug (see findSonicNeighborArtists
        // test above) — this used to throw for any restricted user.
        const results = await findSonicNeighborAlbums(sql, seedAlbum.id, 10, RESTRICTED);
        const ids = results.map((r) => r.album_id);

        expect(ids).toContain(neighborAlbum.id);
    });

    it('returns a STRICT SUBSET under an age-restricted boundary, and EMPTY under denyAll', async () => {
        const { base, nudge } = vectorFamily();

        const artist = createTestArtist({ title: 'Seed Album Artist' });
        await insertTestArtist(sql, artist);

        const seedAlbum = createTestAlbum(artist.id);
        await insertTestAlbum(sql, seedAlbum);
        const seedTrack = createTestTrack(seedAlbum.id, 1);
        await insertTestTrack(sql, seedTrack);
        await insertAudioEmbedding(sql, seedTrack.id, base);

        const allowedAlbum = createTestAlbum(artist.id);
        await insertTestAlbum(sql, allowedAlbum);
        const allowedTrack = createTestTrack(allowedAlbum.id, 1);
        await insertTestTrack(sql, allowedTrack);
        await insertAudioEmbedding(sql, allowedTrack.id, nudge(1));

        const adultAlbum = createTestAlbum(artist.id);
        await insertTestAlbum(sql, adultAlbum);
        const adultTrack = createTestTrack(adultAlbum.id, 1);
        await insertTestTrack(sql, adultTrack);
        await insertAudioEmbedding(sql, adultTrack.id, nudge(2));

        // Restrict the candidate TRACK. An album whose tracks are ALL denied
        // loses its entire GROUP BY input and disappears — this album has one
        // track, so it vanishes. (A MIXED album would still surface, with
        // similarity_score/track_count computed over the allowed tracks only;
        // that grain is deliberate and documented in the query module.)
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adultTrack.id}::uuid`;

        const unrestricted = (
            await findSonicNeighborAlbums(sql, seedAlbum.id, 10, UNRESTRICTED)
        ).map((r) => r.album_id);
        const restricted = (await findSonicNeighborAlbums(sql, seedAlbum.id, 10, RESTRICTED)).map(
            (r) => r.album_id,
        );

        expect(unrestricted).toContain(allowedAlbum.id);
        expect(unrestricted).toContain(adultAlbum.id);

        expect(restricted).toContain(allowedAlbum.id);
        expect(restricted).not.toContain(adultAlbum.id);

        expect(restricted.every((id) => unrestricted.includes(id))).toBe(true);
        expect(restricted.length).toBeLessThan(unrestricted.length);

        // denyAll closes the surface entirely, against the same non-empty fixture.
        expect(await findSonicNeighborAlbums(sql, seedAlbum.id, 10, denyAllAccess())).toEqual([]);
    });
});
