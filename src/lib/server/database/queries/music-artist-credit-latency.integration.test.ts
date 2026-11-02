// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 *
 * Latency bench for the canonical artist-credit read fragments on the music
 * recommendation, cluster and sonic queries. Seeds a library the size of
 * production (37k tracks, 6.6k artists, 183k media_items rows), times each
 * query and prints EXPLAIN ANALYZE execution time plus a hash of every result
 * set. The seed is deterministic, so two runs (before and after a query change)
 * must print identical hashes.
 *
 * Opt-in: the seed alone takes about 15 minutes, so it only runs with
 * MUSIC_CREDIT_BENCH=1:
 *   MUSIC_CREDIT_BENCH=1 npm run test:integration -- \
 *     src/lib/server/database/queries/music-artist-credit-latency.integration.test.ts
 * MUSIC_CREDIT_BENCH_REUSE=1 keeps the library from an earlier run on the same
 * database, MUSIC_CREDIT_BENCH_PLAN=<name> prints one query's EXPLAIN ANALYZE,
 * MUSIC_CREDIT_BENCH_DUMP=<name>[,<name>] prints result sets for diffing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id';
import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import {
    getMusicBecauseYouListened,
    getMusicSmartMixes,
    getMusicMoodRecommendations,
    getMoodShelfTracks,
    getNewForYouTracks,
} from './music-recommendations.queries.js';
import { getClusterMembers } from './audio-clusters.queries.js';
import { findSonicNeighbors } from './sonic-similarity.queries.js';
import { getSonicQueueCandidates } from './sonic-queue.queries.js';
import { findSonicFingerprintNeighbors } from './sonic-fingerprint.queries.js';
import { getSonicTastePicks } from './sonic-taste.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';

const ARTISTS = 6_600;
const ALBUMS = 3_400;
const TRACKS = 37_000;
const TOTAL_MEDIA_ITEMS = 183_000;
const RUNS = 5;

const USER = toUserId('00000000-0000-4000-8000-0000000b3c01');
const uuidOf = (kind: string, i: number): string =>
    createHash('md5')
        .update(`${kind}-${i}`)
        .digest('hex')
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

describe.skipIf(!process.env.MUSIC_CREDIT_BENCH)('artist-credit fragment latency bench', () => {
    let sql: postgres.Sql;
    /** Separate pool whose debug hook records the last statement, for EXPLAIN. */
    let traced: postgres.Sql;
    let last: { query: string; params: unknown[] } | null = null;

    beforeAll(async () => {
        sql = getTestDb();
        traced = postgres(getTestDatabaseUrl(), {
            max: 2,
            onnotice: () => {},
            debug: (_conn, query, params) => {
                if (!/^\s*(EXPLAIN|SELECT set_config|begin|commit|rollback)/i.test(query)) {
                    last = { query, params: params as unknown[] };
                }
            },
        });

        // MUSIC_CREDIT_BENCH_REUSE=1 keeps a library seeded by an earlier run
        // (the seed takes ~15 minutes; the slot database survives between runs).
        const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM media_items`;
        if (process.env.MUSIC_CREDIT_BENCH_REUSE && n === TOTAL_MEDIA_ITEMS) return;

        await sql.unsafe(
            'TRUNCATE TABLE media_items, mood_vectors, user_music_state, media_audio_clusters, user_ratings CASCADE',
        );
        await sql`INSERT INTO users (id, username) VALUES (${USER}::uuid, 'bench-user') ON CONFLICT (id) DO NOTHING`;

        const [{ dims }] = await sql<{ dims: number }[]>`
            SELECT atttypmod AS dims FROM pg_attribute
            WHERE attrelid = 'media_embeddings'::regclass AND attname = 'embedding'`;

        // One connection, so setseed() makes every random() below reproducible.
        const conn = await sql.reserve();
        try {
            await conn`SELECT setseed(0.42)`;
            await conn`
                INSERT INTO media_items (id, title, media_type, status, is_various_artists, created_at, updated_at)
                SELECT md5('artist-' || i)::uuid,
                       CASE WHEN i = 1 THEN 'Various Artists' ELSE 'Bench Artist ' || lpad(i::text, 5, '0') END,
                       'artist', 'active', i = 1, '2025-01-01', '2025-01-01'
                FROM generate_series(1, ${ARTISTS}) i`;
            // Every 12th album is a Various Artists compilation.
            await conn`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at, updated_at)
                SELECT md5('album-' || j)::uuid, 'Bench Album ' || j, 'album', 'active',
                       md5('artist-' || CASE WHEN j % 12 = 0 THEN 1 ELSE 2 + (j * 7) % (${ARTISTS} - 1) END)::uuid,
                       '2025-01-01', '2025-01-01'
                FROM generate_series(1, ${ALBUMS}) j`;
            await conn`
                CREATE TEMP TABLE bench_track AS
                SELECT k,
                       1 + (k - 1) % ${ALBUMS} AS album_idx,
                       CASE WHEN (1 + (k - 1) % ${ALBUMS}) % 12 = 0
                            THEN 2 + floor(random() * (${ARTISTS} - 1))::int
                            ELSE 2 + ((1 + (k - 1) % ${ALBUMS}) * 7) % (${ARTISTS} - 1) END AS artist_idx,
                       2 + floor(random() * (${ARTISTS} - 1))::int AS guest_idx,
                       random() AS shape,
                       random() AS extra,
                       random() AS energy,
                       floor(random() * 30)::int AS genre_a,
                       floor(random() * 30)::int AS genre_b,
                       random() AS age
                FROM generate_series(1, ${TRACKS}) k`;
            // Credit shapes, matching what the scanner writes on production:
            //  - 80% canonical credits (25% with a second performer, 3% with an
            //    unresolved name, 10% of compilation tracks also credit VA)
            //  - 5% an empty credit list (falls back to the album artist)
            //  - 15% legacy: no credits, artist tag + additional_artist_ids
            //  - 6% have a remixer
            await conn`
                INSERT INTO media_items (id, title, media_type, status, parent_id, sort_order,
                    runtime_seconds, has_files, custom_metadata, created_at, updated_at)
                SELECT md5('track-' || k)::uuid,
                       'Bench Song ' || (k % 9000) || CASE WHEN k % 17 = 0 THEN ' (Club Remix)' ELSE '' END,
                       'track', 'active', md5('album-' || album_idx)::uuid, k, 180 + k % 120, true,
                       jsonb_build_object(
                           'artist', 'Bench Artist ' || lpad(artist_idx::text, 5, '0'),
                           'genre', jsonb_build_array('genre ' || genre_a, 'genre ' || genre_b),
                           'essentia', jsonb_build_object('energy', round(energy::numeric, 3))
                       )
                       || CASE
                           WHEN shape < 0.80 THEN jsonb_build_object('track_artist_credits',
                               CASE WHEN album_idx % 12 = 0 AND extra < 0.10
                                    THEN jsonb_build_array(jsonb_build_object('id', md5('artist-1')::uuid, 'credited_name', 'Various Artists'))
                                    ELSE '[]'::jsonb END
                               || jsonb_build_array(jsonb_build_object('id', md5('artist-' || artist_idx)::uuid,
                                      'credited_name', 'Bench Artist ' || lpad(artist_idx::text, 5, '0')))
                               || CASE WHEN extra < 0.25
                                    THEN jsonb_build_array(jsonb_build_object('id', md5('artist-' || guest_idx)::uuid,
                                         'credited_name', 'Bench Artist ' || lpad(guest_idx::text, 5, '0')))
                                    ELSE '[]'::jsonb END
                               || CASE WHEN extra > 0.97
                                    THEN jsonb_build_array(jsonb_build_object('id', NULL, 'credited_name', 'Guest ' || k))
                                    ELSE '[]'::jsonb END)
                           WHEN shape < 0.85 THEN jsonb_build_object('track_artist_credits', '[]'::jsonb)
                           ELSE jsonb_build_object('additional_artist_ids',
                               jsonb_build_array(md5('artist-' || artist_idx)::uuid::text))
                       END
                       || CASE WHEN extra BETWEEN 0.5 AND 0.56
                            THEN jsonb_build_object('remixer_artist_ids', jsonb_build_array(md5('artist-' || guest_idx)::uuid::text))
                            ELSE '{}'::jsonb END,
                       -- 10% added in the last 30 days (New For You), the rest a year ago.
                       CASE WHEN age < 0.10 THEN date_trunc('day', NOW()) - make_interval(days => (age * 290)::int)
                            ELSE '2025-06-01'::timestamptz END,
                       '2025-06-01'
                FROM bench_track ORDER BY k`;
            // Pad media_items to the production row count with video rows.
            await conn`
                INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
                SELECT md5('pad-' || p)::uuid, 'Padding ' || p, 'episode', 'active', '2025-01-01', '2025-01-01'
                FROM generate_series(1, ${TOTAL_MEDIA_ITEMS - ARTISTS - ALBUMS - TRACKS}) p`;

            // Embeddings cluster by artist like real ones: artist base + noise.
            await conn`
                CREATE TEMP TABLE bench_artist_vec AS
                SELECT i AS artist_idx, array_agg(random()::real ORDER BY d) AS v
                FROM generate_series(2, ${ARTISTS}) i, generate_series(1, ${dims}) d
                GROUP BY i`;
            await conn`
                CREATE TEMP TABLE bench_track_vec AS
                SELECT t.k, (SELECT array_agg((b + (random() - 0.5) * 0.4)::real ORDER BY o)
                             FROM unnest(av.v) WITH ORDINALITY u(b, o)) AS v
                FROM bench_track t JOIN bench_artist_vec av ON av.artist_idx = t.artist_idx`;
            await conn`
                INSERT INTO media_embeddings (media_id, source, embedding)
                SELECT md5('track-' || k)::uuid, 'music', v::vector FROM bench_track_vec ORDER BY k`;
            await conn`
                INSERT INTO media_audio_embeddings (media_id, model_id, embedding)
                SELECT md5('track-' || k)::uuid, ${MSCLAP_MODEL_ID}, v::vector FROM bench_track_vec ORDER BY k`;
            await conn`
                INSERT INTO media_audio_clusters (media_id, model_id, cluster_id)
                SELECT md5('track-' || k)::uuid, ${MSCLAP_MODEL_ID}, artist_idx % 40 FROM bench_track`;
            await conn`
                INSERT INTO mood_vectors (mood_key, display_name, vector, model_id)
                SELECT 'bench-mood', 'Bench Mood', v::vector, ${MSCLAP_MODEL_ID}
                FROM bench_artist_vec WHERE artist_idx = 77`;
            // A listener with 1,500 played tracks.
            await conn`
                INSERT INTO user_music_state (user_id, track_id, play_count, complete_count, last_played_at, first_played_at)
                SELECT ${USER}::uuid, md5('track-' || k)::uuid, 1 + k % 20, 1 + k % 20,
                       date_trunc('day', NOW()) - make_interval(hours => k % 2000),
                       '2025-06-01'
                FROM generate_series(1, ${TRACKS}, ${Math.floor(TRACKS / 1500)}) k`;
        } finally {
            conn.release();
        }
        await sql`ANALYZE media_items`;
        await sql`ANALYZE media_embeddings`;
        await sql`ANALYZE media_audio_embeddings`;
        await sql`ANALYZE media_audio_clusters`;
        await sql`ANALYZE user_music_state`;
    }, 1_800_000);

    async function measure(name: string, run: (s: postgres.Sql) => Promise<unknown>) {
        await run(traced); // warm-up, and records the statement for EXPLAIN
        const statement = last as { query: string; params: unknown[] } | null;
        const times: number[] = [];
        let result: unknown = null;
        for (let i = 0; i < RUNS; i++) {
            const start = performance.now();
            result = await run(sql);
            times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        let explainMs: number | null = null;
        if (statement) {
            const plan = await traced.unsafe(
                `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.query}`,
                statement.params as postgres.ParameterOrJSON<never>[],
            );
            explainMs = (plan[0]['QUERY PLAN'] as Array<{ 'Execution Time': number }>)[0][
                'Execution Time'
            ];
            // MUSIC_CREDIT_BENCH_PLAN=<name> prints that query's full text plan.
            if (process.env.MUSIC_CREDIT_BENCH_PLAN === name) {
                const text = await traced.unsafe(
                    `EXPLAIN (ANALYZE, VERBOSE, BUFFERS) ${statement.query}`,
                    statement.params as postgres.ParameterOrJSON<never>[],
                );
                console.log(text.map((r) => r['QUERY PLAN']).join('\n'));
            }
        }
        // hours_since_played is computed from NOW(), so it differs on every run.
        const json = JSON.stringify(result, (key, value) =>
            key === 'hours_since_played' ? undefined : value,
        );
        // MUSIC_CREDIT_BENCH_DUMP=<name>[,<name>] prints those result sets.
        if ((process.env.MUSIC_CREDIT_BENCH_DUMP ?? '').split(',').includes(name.split(' ')[0])) {
            console.log(`[dump] ${name} ${json}`);
        }
        const rows = Array.isArray(result) ? result.length : null;
        console.log(
            `[bench] ${name.padEnd(28)} median ${times[Math.floor(RUNS / 2)].toFixed(1).padStart(8)} ms` +
                `  explain ${explainMs === null ? '-' : explainMs.toFixed(1).padStart(8)} ms` +
                `  rows ${rows ?? '-'}  hash ${createHash('sha1').update(json).digest('hex').slice(0, 12)}`,
        );
        return result;
    }

    it('times every query that reads the artist-credit fragments', async () => {
        const access = { deniedGroupIds: null, ageRating: null };
        const seed = uuidOf('track', 4_242);
        const results = [
            await measure('becauseYouListened', (s) =>
                getMusicBecauseYouListened(s, seed, [], 15, access),
            ),
            await measure('smartMixes', (s) => getMusicSmartMixes(s, USER, 5, access)),
            await measure('moodRecommendations', (s) =>
                getMusicMoodRecommendations(s, 'bench-mood', 21, access),
            ),
            await measure('moodShelf', (s) =>
                getMoodShelfTracks(s, USER, 'bench-mood', 20, access),
            ),
            await measure('moodShelf energy>=0.5', (s) =>
                getMoodShelfTracks(s, USER, 'bench-mood', 20, access, { energyMin: 0.5 }),
            ),
            await measure('newForYou 30d', (s) =>
                getNewForYouTracks(s, USER, [], 20, {
                    access: unrestrictedAccess(),
                    sinceDays: 30,
                }),
            ),
            await measure('clusterMembers 200', (s) =>
                getClusterMembers(s, MSCLAP_MODEL_ID, 7, unrestrictedAccess(), 200),
            ),
            await measure('sonicNeighbors 20', (s) =>
                findSonicNeighbors(s, seed, 20, unrestrictedAccess()),
            ),
            await measure('sonicQueueCandidates 50', (s) =>
                getSonicQueueCandidates(s, {
                    queueTrackIds: [seed, uuidOf('track', 4_243)],
                    tasteVector: null,
                    moodVector: null,
                    excludeIds: [],
                    limit: 50,
                    access: unrestrictedAccess(),
                }),
            ),
            await measure('sonicFingerprint 20', (s) =>
                findSonicFingerprintNeighbors(s, USER, 20, unrestrictedAccess()),
            ),
            await measure('sonicTastePicks 20', (s) =>
                getSonicTastePicks(s, USER, 20, unrestrictedAccess()),
            ),
        ];
        await traced.end();
        expect(results.length).toBe(11);
    }, 1_800_000);
});
