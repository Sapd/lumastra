// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Audio Cluster Queries (real database)
 *
 * The existing audio-clusters.queries.test.ts only mocks the sql tag, so it can
 * cover the write helpers but not the two access-scoped READ queries — their
 * whole point is which rows Postgres hands back.
 *
 * These are DIFFERENTIAL tests: the same fixture is queried twice, once with an
 * explicit unrestricted boundary and once restricted, and the restricted result
 * must be a STRICT SUBSET. That is what catches a boundary argument that arrives
 * but is never spliced into the SQL, or a predicate bound to the wrong alias —
 * both failure modes make the restricted result EQUAL the unrestricted one,
 * which no "resolves without throwing" test can detect.
 *
 * getClusters is the more interesting case: its filters live inside the
 * `accessible_tracks` CTE and every aggregate downstream (track_count,
 * top_genres, top_artists, cover_media_ids) is derived from it. A boundary that
 * failed to apply would leak denied tracks through those aggregates even if the
 * cluster list itself looked right, so the assertions check the aggregates, not
 * just the cluster ids.
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
import {
    getClusters,
    getClusterMembers,
    clusterExists,
    getClusterShuffleTrack,
    getClusterAssignmentMap,
    getHighestIssuedClusterId,
    recordIssuedClusterIds,
    CLUSTER_MODEL_ID,
} from './audio-clusters.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

/** Explicit unrestricted boundary — no permissive default exists any more. */
const UNRESTRICTED = unrestrictedAccess();

/** The library group the RESTRICTED boundary below denies. */
const DENIED_GROUP_ID = 'dddddddd-eeee-4fff-8000-111111111111';

/**
 * A boundary restricted on BOTH axes, so both splice sites emit a real
 * predicate. The age axis and the library axis are exercised by separate
 * fixtures below — an age-only test would leave the library splice site free to
 * be deleted without any test failing (verified by mutation).
 */
const RESTRICTED = restrictedAccess({
    deniedGroupIds: [DENIED_GROUP_ID],
    maxAgeRating: 13,
    allowUnrated: true,
});

/** Create the denied library group row the media_files FK needs. */
async function createDeniedGroup(sql: postgres.Sql): Promise<void> {
    await sql`
        INSERT INTO library_groups (id, name)
        VALUES (${DENIED_GROUP_ID}::uuid, 'Denied Cluster Group')
        ON CONFLICT (id) DO NOTHING
    `;
}

/**
 * Move every media_files row backing `trackId` into the denied library group.
 *
 * insertTestTrack creates the file with library_group_id NULL, and NULL passes
 * the library predicate — so a track must be explicitly re-homed here to be
 * denied on the library axis.
 */
async function denyTrackLibrary(sql: postgres.Sql, trackId: string): Promise<void> {
    await sql`
        UPDATE media_files SET library_group_id = ${DENIED_GROUP_ID}::uuid
        WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${trackId}::uuid)
    `;
}

/** Seed an artist -> album -> track chain assigned to `clusterId`. */
async function seedClusteredTrack(
    sql: postgres.Sql,
    opts: { clusterId: number; genre: string; artist: string },
): Promise<{ trackId: string; albumId: string }> {
    const artist = createTestArtist({ title: `Artist ${crypto.randomUUID().slice(0, 8)}` });
    await insertTestArtist(sql, artist);
    const album = createTestAlbum(artist.id);
    await insertTestAlbum(sql, album);

    // getClusters reads genres from custom_metadata->'genre' (a JSON ARRAY) and
    // the track artist from custom_metadata->>'artist'.
    const track = createTestTrack(album.id, 1, {
        custom_metadata: { genre: [opts.genre], artist: opts.artist },
    });
    await insertTestTrack(sql, track);

    await sql`
        INSERT INTO media_audio_clusters (media_id, model_id, cluster_id, computed_at)
        VALUES (${track.id}::uuid, ${CLUSTER_MODEL_ID}, ${opts.clusterId}, now())
    `;
    // getClusterMembers INNER JOINs media_audio_embeddings and orders by distance
    // to the cluster centroid, so every member needs an embedding to be visible.
    const vector = `[${Array.from({ length: 1024 }, () => Math.random()).join(',')}]`;
    await sql`
        INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
        VALUES (${track.id}::uuid, ${CLUSTER_MODEL_ID}, ${vector}::vector)
    `;
    return { trackId: track.id, albumId: album.id };
}

describe('audio-clusters access boundary (real DB)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_audio_clusters',
            'audio_cluster_ids',
            ...TEST_TABLES.sonic,
            ...TEST_TABLES.media,
        ]);
        await createDeniedGroup(sql);
    });

    describe('getClusters', () => {
        it('ignores non-array genre and empty artist values while retaining track counts', async () => {
            const normal = await seedClusteredTrack(sql, {
                clusterId: 0,
                genre: 'Ambient',
                artist: 'Allowed',
            });
            const legacy = await seedClusteredTrack(sql, {
                clusterId: 0,
                genre: 'Ignored',
                artist: 'Ignored',
            });
            await sql`UPDATE media_items SET custom_metadata = ${sql.json({ genre: 'Legacy', artist: '' })} WHERE id = ${legacy.trackId}::uuid`;
            const [cluster] = await getClusters(sql, CLUSTER_MODEL_ID, UNRESTRICTED);
            expect(cluster.track_count).toBe(2);
            expect(cluster.top_genres).toEqual(['Ambient']);
            expect(cluster.top_artists).toEqual(['Allowed']);
            expect(cluster.cover_media_ids).toEqual(
                expect.arrayContaining([normal.trackId, legacy.trackId]),
            );
        });

        it('returns a STRICT SUBSET of clusters under an age-restricted boundary', async () => {
            // Cluster 0: one allowed track. Cluster 1: one adult-only track, so
            // restricting must drop the WHOLE cluster (it has no other members).
            await seedClusteredTrack(sql, { clusterId: 0, genre: 'Ambient', artist: 'Allowed' });
            const adult = await seedClusteredTrack(sql, {
                clusterId: 1,
                genre: 'Industrial',
                artist: 'Adult',
            });
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adult.trackId}::uuid`;

            const unrestricted = (await getClusters(sql, CLUSTER_MODEL_ID, UNRESTRICTED)).map(
                (c) => c.cluster_id,
            );
            const restricted = (await getClusters(sql, CLUSTER_MODEL_ID, RESTRICTED)).map(
                (c) => c.cluster_id,
            );

            expect(unrestricted).toEqual([0, 1]);
            expect(restricted).toEqual([0]);

            expect(restricted.every((id) => unrestricted.includes(id))).toBe(true);
            expect(restricted.length).toBeLessThan(unrestricted.length);
        });

        it('excludes denied tracks from the per-cluster AGGREGATES, not just the cluster list', async () => {
            // Both tracks share cluster 0, so the cluster survives restriction and
            // the only observable difference is in the aggregates computed from the
            // accessible_tracks CTE. A boundary spliced into the outer query instead
            // of the CTE would pass the previous test and fail this one.
            await seedClusteredTrack(sql, { clusterId: 0, genre: 'Ambient', artist: 'Allowed' });
            const adult = await seedClusteredTrack(sql, {
                clusterId: 0,
                genre: 'Industrial',
                artist: 'Adult',
            });
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adult.trackId}::uuid`;

            const [openCluster] = await getClusters(sql, CLUSTER_MODEL_ID, UNRESTRICTED);
            const [closedCluster] = await getClusters(sql, CLUSTER_MODEL_ID, RESTRICTED);

            expect(openCluster.track_count).toBe(2);
            expect(openCluster.top_genres).toEqual(
                expect.arrayContaining(['Ambient', 'Industrial']),
            );
            expect(openCluster.top_artists).toEqual(expect.arrayContaining(['Allowed', 'Adult']));
            expect(openCluster.cover_media_ids).toHaveLength(2);

            expect(closedCluster.track_count).toBe(1);
            expect(closedCluster.top_genres).toEqual(['Ambient']);
            expect(closedCluster.top_artists).toEqual(['Allowed']);
            expect(closedCluster.cover_media_ids).not.toContain(adult.trackId);
            expect(closedCluster.cover_media_ids).toHaveLength(1);
        });

        it('excludes tracks in a DENIED LIBRARY GROUP (library axis, independent of age)', async () => {
            // The library axis needs its own fixture: insertTestTrack leaves
            // library_group_id NULL, which passes the predicate, so an age-only
            // suite lets the library splice site be deleted with every test still
            // green (confirmed by mutating buildLibraryAccessFilter to `all`).
            await seedClusteredTrack(sql, { clusterId: 0, genre: 'Ambient', artist: 'Allowed' });
            const offLimits = await seedClusteredTrack(sql, {
                clusterId: 1,
                genre: 'Industrial',
                artist: 'Hidden',
            });
            await denyTrackLibrary(sql, offLimits.trackId);

            const unrestricted = (await getClusters(sql, CLUSTER_MODEL_ID, UNRESTRICTED)).map(
                (c) => c.cluster_id,
            );
            const restricted = (await getClusters(sql, CLUSTER_MODEL_ID, RESTRICTED)).map(
                (c) => c.cluster_id,
            );

            expect(unrestricted).toEqual([0, 1]);
            expect(restricted).toEqual([0]);
            expect(restricted.length).toBeLessThan(unrestricted.length);
        });

        it('returns EMPTY under a denyAll boundary', async () => {
            await seedClusteredTrack(sql, { clusterId: 0, genre: 'Ambient', artist: 'Allowed' });

            // Sanity: there IS something to find, so an empty denyAll result is the
            // boundary working rather than an empty fixture.
            expect(await getClusters(sql, CLUSTER_MODEL_ID, UNRESTRICTED)).not.toHaveLength(0);

            expect(await getClusters(sql, CLUSTER_MODEL_ID, denyAllAccess())).toEqual([]);
        });
    });

    describe('getClusterMembers', () => {
        it('pages representative tracks after access filtering without duplicates', async () => {
            for (let i = 0; i < 5; i++)
                await seedClusteredTrack(sql, {
                    clusterId: 0,
                    genre: 'Ambient',
                    artist: `Artist ${i}`,
                });
            const full = await getClusterMembers(sql, CLUSTER_MODEL_ID, 0, RESTRICTED, 100);
            const ids: string[] = [];
            for (let offset = 0; offset < full.length; offset += 2) {
                ids.push(
                    ...(
                        await getClusterMembers(sql, CLUSTER_MODEL_ID, 0, RESTRICTED, 2, offset)
                    ).map((row) => row.media_id),
                );
            }
            expect(ids).toEqual(full.map((row) => row.media_id));
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids.length).toBeGreaterThanOrEqual(5);
            expect(
                await getClusterMembers(sql, CLUSTER_MODEL_ID, 0, RESTRICTED, 2, full.length),
            ).toEqual([]);
        });

        it('returns a STRICT SUBSET of member tracks under an age-restricted boundary', async () => {
            const allowed = await seedClusteredTrack(sql, {
                clusterId: 0,
                genre: 'Ambient',
                artist: 'Allowed',
            });
            const adult = await seedClusteredTrack(sql, {
                clusterId: 0,
                genre: 'Industrial',
                artist: 'Adult',
            });
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${adult.trackId}::uuid`;

            const unrestricted = (
                await getClusterMembers(sql, CLUSTER_MODEL_ID, 0, UNRESTRICTED)
            ).map((r) => r.media_id);
            const restricted = (await getClusterMembers(sql, CLUSTER_MODEL_ID, 0, RESTRICTED)).map(
                (r) => r.media_id,
            );

            expect(unrestricted).toEqual(expect.arrayContaining([allowed.trackId, adult.trackId]));

            expect(restricted).toContain(allowed.trackId);
            expect(restricted).not.toContain(adult.trackId);

            expect(restricted.every((id) => unrestricted.includes(id))).toBe(true);
            expect(restricted.length).toBeLessThan(unrestricted.length);
        });

        it('excludes member tracks in a DENIED LIBRARY GROUP (library axis)', async () => {
            const allowed = await seedClusteredTrack(sql, {
                clusterId: 0,
                genre: 'Ambient',
                artist: 'Allowed',
            });
            const offLimits = await seedClusteredTrack(sql, {
                clusterId: 0,
                genre: 'Industrial',
                artist: 'Hidden',
            });
            await denyTrackLibrary(sql, offLimits.trackId);

            const unrestricted = (
                await getClusterMembers(sql, CLUSTER_MODEL_ID, 0, UNRESTRICTED)
            ).map((r) => r.media_id);
            const restricted = (await getClusterMembers(sql, CLUSTER_MODEL_ID, 0, RESTRICTED)).map(
                (r) => r.media_id,
            );

            expect(unrestricted).toEqual(
                expect.arrayContaining([allowed.trackId, offLimits.trackId]),
            );
            expect(restricted).toContain(allowed.trackId);
            expect(restricted).not.toContain(offLimits.trackId);
            expect(restricted.every((id) => unrestricted.includes(id))).toBe(true);
            expect(restricted.length).toBeLessThan(unrestricted.length);
        });

        it('resolves under a restricted boundary despite three media_items joins', async () => {
            // Alias guard: getClusterMembers joins media_items as `mi`, `album` and
            // `artist`. Both builders hardcode/default to `mi`. If the track join
            // were ever re-aliased, this throws a real Postgres "missing FROM-clause
            // entry for table mi" — but ONLY for a restricted boundary, since both
            // filters compile to empty fragments when unrestricted.
            const allowed = await seedClusteredTrack(sql, {
                clusterId: 0,
                genre: 'Ambient',
                artist: 'Allowed',
            });

            const rows = await getClusterMembers(sql, CLUSTER_MODEL_ID, 0, RESTRICTED);
            expect(rows.map((r) => r.media_id)).toContain(allowed.trackId);
            // The album join is deliberately NOT boundary-scoped — it is a display
            // title lookup — so it still resolves for a restricted caller.
            expect(rows[0].album_id).toBe(allowed.albumId);
        });

        it('returns EMPTY under a denyAll boundary', async () => {
            await seedClusteredTrack(sql, { clusterId: 0, genre: 'Ambient', artist: 'Allowed' });

            expect(
                await getClusterMembers(sql, CLUSTER_MODEL_ID, 0, UNRESTRICTED),
            ).not.toHaveLength(0);

            expect(await getClusterMembers(sql, CLUSTER_MODEL_ID, 0, denyAllAccess())).toEqual([]);
        });
    });

    describe('clusterExists', () => {
        it('tells an issued cluster id from an unknown one, regardless of access', async () => {
            await seedClusteredTrack(sql, { clusterId: 4, genre: 'Ambient', artist: 'Allowed' });

            expect(await clusterExists(sql, CLUSTER_MODEL_ID, 4)).toBe(true);
            expect(await clusterExists(sql, CLUSTER_MODEL_ID, 5)).toBe(false);
            expect(await clusterExists(sql, 'other-model', 4)).toBe(false);
        });
    });

    describe('getClusterShuffleTrack', () => {
        async function seedCluster(clusterId: number, n: number): Promise<string[]> {
            const ids: string[] = [];
            for (let k = 0; k < n; k++) {
                const t = await seedClusteredTrack(sql, {
                    clusterId,
                    genre: 'Ambient',
                    artist: `Artist ${k}`,
                });
                ids.push(t.trackId);
            }
            return ids;
        }

        async function round(seed: number, count: number): Promise<string[]> {
            const out: string[] = [];
            for (let i = 0; i < count; i++) {
                const row = await getClusterShuffleTrack(
                    sql,
                    CLUSTER_MODEL_ID,
                    0,
                    seed,
                    i,
                    UNRESTRICTED,
                );
                out.push(row!.media_id);
            }
            return out;
        }

        it('walks every track of the cluster exactly once per round', async () => {
            const members = await seedCluster(0, 6);
            await seedCluster(1, 3);

            const order = await round(42, 6);
            expect([...order].sort()).toEqual([...members].sort());
        });

        it('wraps i modulo the count and reports position and count', async () => {
            await seedCluster(0, 5);
            const first = await getClusterShuffleTrack(
                sql,
                CLUSTER_MODEL_ID,
                0,
                7,
                2,
                UNRESTRICTED,
            );
            const wrapped = await getClusterShuffleTrack(
                sql,
                CLUSTER_MODEL_ID,
                0,
                7,
                12,
                UNRESTRICTED,
            );
            expect(wrapped!.media_id).toBe(first!.media_id);
            expect(wrapped!.position).toBe(2);
            expect(wrapped!.track_count).toBe(5);
            expect(first!.title).toBeTruthy();
            expect(first!.artist_title).toMatch(/^Artist \d$/);
        });

        it('gives a different order for a different seed, the same for the same seed', async () => {
            await seedCluster(0, 8);
            const a = await round(1, 8);
            expect(await round(1, 8)).toEqual(a);
            expect(await round(2, 8)).not.toEqual(a);
        });

        it('never serves a track the caller may not see', async () => {
            const members = await seedCluster(0, 4);
            await denyTrackLibrary(sql, members[0]);

            const seen = new Set<string>();
            for (let i = 0; i < 8; i++) {
                const row = await getClusterShuffleTrack(
                    sql,
                    CLUSTER_MODEL_ID,
                    0,
                    3,
                    i,
                    RESTRICTED,
                );
                seen.add(row!.media_id);
                expect(row!.track_count).toBe(3);
            }
            expect(seen.has(members[0])).toBe(false);
        });

        it('is null for an unknown cluster and under denyAll', async () => {
            await seedCluster(0, 2);
            expect(
                await getClusterShuffleTrack(sql, CLUSTER_MODEL_ID, 99, 1, 0, UNRESTRICTED),
            ).toBeNull();
            expect(
                await getClusterShuffleTrack(sql, CLUSTER_MODEL_ID, 0, 1, 0, denyAllAccess()),
            ).toBeNull();
        });
    });

    describe('stable id registry', () => {
        it('reads assignments and the highest issued id, and never lowers it', async () => {
            const t = await seedClusteredTrack(sql, {
                clusterId: 4,
                genre: 'Ambient',
                artist: 'A',
            });
            expect(await getHighestIssuedClusterId(sql, CLUSTER_MODEL_ID)).toBe(-1);

            await recordIssuedClusterIds(sql, CLUSTER_MODEL_ID, [4, 9]);
            await recordIssuedClusterIds(sql, CLUSTER_MODEL_ID, [4]);
            expect(await getHighestIssuedClusterId(sql, CLUSTER_MODEL_ID)).toBe(9);
            expect(await getHighestIssuedClusterId(sql, 'other-model')).toBe(-1);

            expect(await getClusterAssignmentMap(sql, CLUSTER_MODEL_ID)).toEqual(
                new Map([[t.trackId, 4]]),
            );
        });
    });
});
