// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic genre centroids against real Postgres + pgvector.
 *
 * These pin the two things only real SQL can show: that the rebuild is
 * genuinely atomic (a failed run must not leave the rail reading half a
 * dataset), and that the stored centroids are MEAN-CENTERED — the detail the
 * whole ranking depends on. Uncentered, every genre cosine lands in 0.85–0.98
 * and the recommendation is noise.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    rebuildGenreCentroids,
    getUserGenreAdjacency,
    MIN_ADJACENCY_SIMILARITY,
} from './music-genre-centroids.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';

const DIM = 1024;

/**
 * A deterministic vector from weighted components.
 *
 * Note one-hot vectors on NEARBY indices are still orthogonal — index
 * proximity is not sonic proximity. Genres that should read as adjacent must
 * genuinely SHARE components, which is what these fixtures do.
 */
function vec(components: Record<number, number>, jitter = 0): number[] {
    const v = new Array<number>(DIM).fill(0);
    for (const [axis, weight] of Object.entries(components)) {
        v[Number(axis) % DIM] = weight;
    }
    v[900] = jitter;
    return v;
}

/** Hard-dance cluster: Trance and Hardstyle share most of their mass. */
const AXES = {
    trance: { 10: 1.0, 11: 0.25 },
    hardstyle: { 10: 0.8, 11: 0.6 },
    blues: { 400: 1.0, 401: 0.3 },
    tiny: { 500: 1.0 },
} as const;

function vecLiteral(v: number[]): string {
    return `[${v.map((n) => n.toFixed(8)).join(',')}]`;
}

describe('music genre centroids', () => {
    let sql: postgres.Sql;
    const created: string[] = [];

    beforeAll(async () => {
        sql = await getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        await sql`DELETE FROM music_genre_centroids`;
        await sql`DELETE FROM music_sonic_model_stats`;
        if (created.length > 0) {
            await sql`DELETE FROM media_audio_embeddings WHERE media_id = ANY(${created}::uuid[])`;
            await sql`DELETE FROM user_music_state WHERE track_id = ANY(${created}::uuid[])`;
            await sql`DELETE FROM media_items WHERE id = ANY(${created}::uuid[])`;
            created.length = 0;
        }
    });

    /** Seed `count` tracks in `genre`, each embedded near `axis`. */
    async function seedGenre(
        genre: string,
        count: number,
        axis: Record<number, number>,
    ): Promise<string[]> {
        const [album] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES (${`Album ${genre}`}, 'album', 'active')
            RETURNING id
        `;
        created.push(album.id);
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
            const [track] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, has_files, parent_id, custom_metadata)
                VALUES (
                    ${`${genre} ${i}`}, 'track', 'active', true, ${album.id}::uuid,
                    ${sql.json({ genre: [genre] })}
                )
                RETURNING id
            `;
            created.push(track.id);
            ids.push(track.id);
            await sql`
                INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
                VALUES (${track.id}::uuid, ${MSCLAP_MODEL_ID}, ${vecLiteral(vec(axis, i / count))}::vector)
            `;
        }
        return ids;
    }

    it('stores one centroid per eligible genre and records the corpus mean', async () => {
        await seedGenre('Trance', 120, AXES.trance);
        await seedGenre('Hardstyle', 120, AXES.hardstyle);

        const result = await rebuildGenreCentroids(sql, [
            { genreKey: 'trance', displayName: 'Trance', variants: ['trance'] },
            { genreKey: 'hardstyle', displayName: 'Hardstyle', variants: ['hardstyle'] },
        ]);

        expect(result.centroids).toBe(2);
        expect(result.corpusTracks).toBeGreaterThanOrEqual(240);

        const [stats] = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM music_sonic_model_stats WHERE model_id = ${MSCLAP_MODEL_ID}
        `;
        expect(Number(stats.n)).toBe(1);
    });

    it('stores centroids MEAN-CENTERED, not raw', async () => {
        // Two genres on different axes: raw means would both be ~positive on
        // their own axis and near-identical elsewhere. Centered, they must
        // point in genuinely different directions — cosine well below 1.
        await seedGenre('Trance', 120, AXES.trance);
        await seedGenre('Blues', 120, AXES.blues);

        await rebuildGenreCentroids(sql, [
            { genreKey: 'trance', displayName: 'Trance', variants: ['trance'] },
            { genreKey: 'blues', displayName: 'Blues', variants: ['blues'] },
        ]);

        const [row] = await sql<{ sim: number }[]>`
            SELECT (1 - (a.centroid <=> b.centroid))::double precision AS sim
            FROM music_genre_centroids a, music_genre_centroids b
            WHERE a.genre_key = 'trance' AND b.genre_key = 'blues'
        `;
        // Uncentered these would sit near +1. Centered, they oppose.
        expect(row.sim).toBeLessThan(0.5);
    });

    it('skips a genre below the track floor', async () => {
        await seedGenre('Trance', 120, AXES.trance);
        await seedGenre('Tiny', 5, AXES.tiny);

        const result = await rebuildGenreCentroids(sql, [
            { genreKey: 'trance', displayName: 'Trance', variants: ['trance'] },
            { genreKey: 'tiny', displayName: 'Tiny', variants: ['tiny'] },
        ]);

        expect(result.centroids).toBe(1);
        const keys = await sql<
            { genre_key: string }[]
        >`SELECT genre_key FROM music_genre_centroids`;
        expect(keys.map((k) => k.genre_key)).toEqual(['trance']);
    });

    it('counts a track once when it carries two variants of the same genre, and only embedded tracks', async () => {
        // The rebuild maps exploded tags to genres by equality; a track tagged
        // both 'Hip Hop' and 'Hip-Hop' must still be ONE (genre, track) pair, and
        // a track without an embedding must not count toward the floor.
        const [album] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('Album Hip Hop', 'album', 'active') RETURNING id
        `;
        created.push(album.id);
        for (let i = 0; i < 125; i++) {
            const [track] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, has_files, parent_id, custom_metadata)
                VALUES (${`hh ${i}`}, 'track', 'active', true, ${album.id}::uuid,
                        ${sql.json({ genre: ['Hip Hop', 'Hip-Hop'] })})
                RETURNING id
            `;
            created.push(track.id);
            // 5 tracks stay un-embedded.
            if (i < 120) {
                await sql`
                    INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
                    VALUES (${track.id}::uuid, ${MSCLAP_MODEL_ID}, ${vecLiteral(vec(AXES.trance, i / 120))}::vector)
                `;
            }
        }

        const result = await rebuildGenreCentroids(sql, [
            { genreKey: 'hip hop', displayName: 'Hip Hop', variants: ['hip hop', 'hip-hop'] },
        ]);

        expect(result.centroids).toBe(1);
        const [row] = await sql<{ track_count: number; album_count: number }[]>`
            SELECT track_count, album_count FROM music_genre_centroids WHERE genre_key = 'hip hop'
        `;
        expect(row).toEqual({ track_count: 120, album_count: 1 });
    });

    it('stores exactly (genre mean - corpus mean), counting a multi-variant track once', async () => {
        // Pins the VALUE, not just counts: a rewrite that double-weights a track
        // carrying two variants, joins embeddings twice, or subtracts the corpus
        // mean twice would all keep the counts right and move this vector.
        const trance = await seedGenre('Trance', 120, AXES.trance);
        await seedGenre('Blues', 120, AXES.blues);
        // Give the first Trance track a second variant of the same genre.
        await sql`
            UPDATE media_items SET custom_metadata = ${sql.json({ genre: ['Trance', 'trance '] })}
            WHERE id = ${trance[0]}::uuid
        `;

        await rebuildGenreCentroids(sql, [
            { genreKey: 'trance', displayName: 'Trance', variants: ['trance'] },
            { genreKey: 'blues', displayName: 'Blues', variants: ['blues'] },
        ]);

        const embedded = async (ids: string[] | null): Promise<number[][]> => {
            const rows = await sql<{ e: string }[]>`
                SELECT embedding::text AS e FROM media_audio_embeddings
                WHERE model_id = ${MSCLAP_MODEL_ID}
                  AND (${ids}::uuid[] IS NULL OR media_id = ANY(${ids}::uuid[]))
            `;
            return rows.map((r) => JSON.parse(r.e) as number[]);
        };
        const mean = (vs: number[][]): number[] =>
            vs[0].map((_, i) => vs.reduce((acc, v) => acc + v[i], 0) / vs.length);

        const corpus = mean(await embedded(null));
        const genreMean = mean(await embedded(trance));
        const expected = genreMean.map((x, i) => x - corpus[i]);

        const [row] = await sql<{ c: string; track_count: number }[]>`
            SELECT centroid::text AS c, track_count FROM music_genre_centroids WHERE genre_key = 'trance'
        `;
        const stored = JSON.parse(row.c) as number[];

        expect(row.track_count).toBe(120);
        const maxDiff = Math.max(...stored.map((x, i) => Math.abs(x - expected[i])));
        expect(maxDiff).toBeLessThan(1e-5);
    });

    it('a duplicated genre key in the input stores one row, not two', async () => {
        await seedGenre('Trance', 120, AXES.trance);

        const result = await rebuildGenreCentroids(sql, [
            { genreKey: 'trance', displayName: 'Trance', variants: ['trance'] },
            { genreKey: 'trance', displayName: 'TRANCE', variants: ['trance'] },
        ]);

        expect(result.centroids).toBe(1);
    });

    it('replaces the previous generation rather than accumulating', async () => {
        await seedGenre('Trance', 120, AXES.trance);
        const input = [{ genreKey: 'trance', displayName: 'Trance', variants: ['trance'] }];

        await rebuildGenreCentroids(sql, input);
        await rebuildGenreCentroids(sql, input);

        const [row] = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM music_genre_centroids
        `;
        expect(Number(row.n)).toBe(1);
    });

    it('recommends the nearest zero-play genre and excludes played ones', async () => {
        const tranceIds = await seedGenre('Trance', 120, AXES.trance);
        await seedGenre('Hardstyle', 120, AXES.hardstyle); // sonically adjacent
        await seedGenre('Blues', 120, AXES.blues); // far away

        await rebuildGenreCentroids(sql, [
            { genreKey: 'trance', displayName: 'Trance', variants: ['trance'] },
            { genreKey: 'hardstyle', displayName: 'Hardstyle', variants: ['hardstyle'] },
            { genreKey: 'blues', displayName: 'Blues', variants: ['blues'] },
        ]);

        const [user] = await sql<{ id: string }[]>`
            INSERT INTO users (username) VALUES ('centroid-listener')
            ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
            RETURNING id
        `;
        // 30 completed Trance tracks — above the confidence gate.
        for (const id of tranceIds.slice(0, 30)) {
            await sql`
                INSERT INTO user_music_state (user_id, track_id, play_count, complete_count)
                VALUES (${user.id}::uuid, ${id}::uuid, 3, 3)
                ON CONFLICT (user_id, track_id) DO NOTHING
            `;
        }

        // Candidates exclude Trance (played) — that is the caller's job.
        const match = await getUserGenreAdjacency(
            sql,
            user.id,
            ['hardstyle', 'blues'],
            unrestrictedAccess(),
        );

        expect(match?.genreKey).toBe('hardstyle');
        expect(match!.similarity).toBeGreaterThanOrEqual(MIN_ADJACENCY_SIMILARITY);

        await sql`DELETE FROM user_music_state WHERE user_id = ${user.id}::uuid`;
        await sql`DELETE FROM users WHERE id = ${user.id}::uuid`;
    });

    it('returns nothing for a listener below the history gate', async () => {
        const tranceIds = await seedGenre('Trance', 120, AXES.trance);
        await seedGenre('Hardstyle', 120, AXES.hardstyle);
        await rebuildGenreCentroids(sql, [
            { genreKey: 'trance', displayName: 'Trance', variants: ['trance'] },
            { genreKey: 'hardstyle', displayName: 'Hardstyle', variants: ['hardstyle'] },
        ]);

        const [user] = await sql<{ id: string }[]>`
            INSERT INTO users (username) VALUES ('centroid-newbie')
            ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
            RETURNING id
        `;
        // Only 3 completes — well under the 20 the gate requires.
        for (const id of tranceIds.slice(0, 3)) {
            await sql`
                INSERT INTO user_music_state (user_id, track_id, play_count, complete_count)
                VALUES (${user.id}::uuid, ${id}::uuid, 1, 1)
                ON CONFLICT (user_id, track_id) DO NOTHING
            `;
        }

        const match = await getUserGenreAdjacency(
            sql,
            user.id,
            ['hardstyle'],
            unrestrictedAccess(),
        );
        expect(match).toBeNull();

        await sql`DELETE FROM user_music_state WHERE user_id = ${user.id}::uuid`;
        await sql`DELETE FROM users WHERE id = ${user.id}::uuid`;
    });

    it('returns nothing when the centroid table has never been built', async () => {
        const match = await getUserGenreAdjacency(
            sql,
            '00000000-0000-4000-8000-000000000001',
            ['hardstyle'],
            unrestrictedAccess(),
        );
        expect(match).toBeNull();
    });

    it('returns nothing when there are no candidates left', async () => {
        const match = await getUserGenreAdjacency(
            sql,
            '00000000-0000-4000-8000-000000000001',
            [],
            unrestrictedAccess(),
        );
        expect(match).toBeNull();
    });
});
