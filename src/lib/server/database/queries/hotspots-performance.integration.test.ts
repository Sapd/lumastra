// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { DamperContext } from '$lib/server/services/taste-damper.service.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import { findCollaborationArtists } from './artist-merge.queries.js';
import { countMusicHygieneFinding } from './music-hygiene.queries.js';
import {
    collaborationFingerprintsSql,
    collaborationFingerprintSql,
} from './collaboration-review.queries.js';
import { getRecentlyAddedForOps } from './attention.queries.js';
import { getLastEndedSession } from './play-sessions.queries.js';
import { getMediaBrowserStats } from './admin-media.queries.js';
import { getTrickplayBacklogCounts } from './trickplay-params.queries.js';
import { fetchPerfectMatch } from './featured-pick.queries.js';
import { buildAdminBrowserBaseScope } from './builders/admin-media-scope.builder.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';
import { MUSIC_HYGIENE_ARTIST_UNSPLIT } from '$lib/shared/music-hygiene.js';
import { toUserId } from '$lib/shared/user-id';
import {
    baselineFingerprintSql,
    baselineNeedsReviewSql,
    baselinePerfectMatchSql,
    baselineGetRecentlyAddedForOpsSql,
    baselineGetLastEndedSessionSql,
    baselineGetMediaBrowserStatsSql,
    baselineGetTrickplayBacklogCountsSql,
} from './hotspot-baselines.test-support.js';

interface Plan {
    'Execution Time': number;
    Plan: { 'Shared Hit Blocks': number; 'Shared Read Blocks': number };
}
const large = process.env.PERF_HOTSPOTS === '1';
const reports: Record<string, unknown> = {};
const captured: { query: string; parameters: unknown[] }[] = [];
const schema = `hotspots_${crypto.randomUUID().replaceAll('-', '')}`;
const uid = toUserId('76146ceb-4260-459f-b86d-626e4d04a82f');
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * The two hotspot indexes as the base schema defines them. The test tables are bare
 * `LIKE` copies in an isolated schema, and the indexes go in after bulk seeding.
 */
async function createHotspotIndexes(db: postgres.Sql): Promise<void> {
    await db`
        CREATE INDEX IF NOT EXISTS idx_play_sessions_last_ended
        ON play_sessions (stopped_at DESC) INCLUDE (user_id, media_id)
        WHERE status IN ('COMPLETED', 'CRASHED', 'KILLED') AND stopped_at IS NOT NULL
    `;
    await db`
        CREATE INDEX IF NOT EXISTS idx_media_items_ops_arrival
        ON media_items (COALESCE(library_added_at, created_at) DESC)
        WHERE status='active' AND has_files=true AND media_type IN ('movie', 'episode')
    `;
}

describe('Database hotspots differential and scale measurements', () => {
    let sql: postgres.Sql;
    beforeAll(
        async () => {
            await getTestDb()`CREATE SCHEMA ${getTestDb()(schema)}`;
            sql = postgres(getTestDatabaseUrl(), {
                max: 1,
                connection: {
                    search_path: `${schema},public`,
                    statement_timeout: 180000,
                    maintenance_work_mem: large ? '512MB' : '64MB',
                },
                debug: (_connection, query, parameters) => {
                    if (process.env.PERF_CAPTURE === '1')
                        captured.push({ query, parameters: [...parameters] });
                },
            });
            for (const table of [
                'media_items',
                'media_files',
                'media_file_items',
                'external_ids',
                'media_embeddings',
                'provider_metadata',
                'play_sessions',
                'users',
                'user_ratings',
                'user_media_state',
                'media_genres',
                'media_keywords',
                'media_item_stage_state',
                'trickplay_params',
            ]) {
                await sql`CREATE TABLE ${sql(table)} (LIKE ${sql('public.' + table)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`;
            }
            await sql`SET hnsw.iterative_scan = 'strict_order'`;
            // Keep unrelated title/trigram indexes out of this isolated benchmark.
            // The relevant production indexes are installed after bulk seeding.
            const artists = large ? 6700 : 8;
            const albums = large ? 3800 : 16;
            const tracks = large ? 37000 : 160;
            const movies = large ? 46000 : 600;
            const episodes = large ? 48000 : 80;
            const uuidExpr = (
                n: postgres.PendingQuery<postgres.Row[]>,
            ): postgres.PendingQuery<postgres.Row[]> =>
                sql`('00000000-0000-4000-8000-' || lpad((${n})::text,12,'0'))::uuid`;
            await sql`INSERT INTO users (id,username) VALUES (${uid},'Mira Quill')`;
            await sql`INSERT INTO media_items (id,title,media_type,has_files,custom_metadata)
            SELECT ${uuidExpr(sql`n`)},'Cedar ' || n || ' feat. Lumen','artist',true,
                CASE WHEN n<=64 THEN '{"collaboration_reviewed":"stale"}'::jsonb ELSE '{}'::jsonb END
            FROM generate_series(1,${artists}) n`;
            await sql`INSERT INTO media_items (id,title,media_type,parent_id,has_files)
            SELECT ${uuidExpr(sql`10000+n`)},'Woven '||n,'album',${uuidExpr(sql`1+(n%${artists})`)},true
            FROM generate_series(1,${albums}) n`;
            await sql`INSERT INTO media_items (id,title,media_type,parent_id,has_files,custom_metadata)
            SELECT ${uuidExpr(sql`100000+n`)},'Signal '||n,'track',${uuidExpr(sql`10001+(n%${albums})`)},true,
                jsonb_build_object('file_artist_ids',jsonb_build_array(${uuidExpr(sql`1+(n%${artists})`)}::text),
                    'padding',(SELECT string_agg(md5((n+k)::text),'') FROM generate_series(1,36) k))
            FROM generate_series(1,${tracks}) n`;
            await sql`INSERT INTO media_items (id,title,media_type,has_files,created_at,library_added_at,custom_metadata)
            SELECT ${uuidExpr(sql`300000+n`)},'Quiet Orbit '||n,'movie',n%3<>0,
                NOW()-n*INTERVAL '1 second',CASE WHEN n%2=0 THEN NOW()-n*INTERVAL '1 minute' END,
                jsonb_build_object('padding',(SELECT string_agg(md5((n+k)::text),'') FROM generate_series(1,36) k))
            FROM generate_series(1,${movies}) n`;
            await sql`INSERT INTO media_items (id,title,media_type,has_files,created_at)
            SELECT ${uuidExpr(sql`500000+n`)},'Distant Shore '||n,'episode',true,NOW()-n*INTERVAL '2 seconds'-INTERVAL '0.25 seconds'
            FROM generate_series(1,${episodes}) n`;
            if (large)
                await sql`INSERT INTO media_items (id,title,media_type)
            SELECT ${uuidExpr(sql`800000+n`)},'Fictional season '||n,'season'
            FROM generate_series(1,34500) n`;
            await sql`INSERT INTO media_files (id,file_path)
            SELECT id,'/fictional/'||id||'.flac' FROM media_items WHERE media_type IN ('track','episode')`;
            await sql`INSERT INTO media_file_items (file_id,media_item_id)
            SELECT id,id FROM media_files`;
            await sql`INSERT INTO trickplay_params (media_item_id,file_id,width,height,interval_ms,tile_width,
            tile_height,thumbnail_count,source)
            SELECT id,id,w,90,1000,10,10,500,'synthetic' FROM media_items
            CROSS JOIN (VALUES (160),(320)) widths(w) WHERE media_type='episode'`;
            await sql`INSERT INTO play_sessions (media_id,user_id,device_id,ip_address,play_method,status,stopped_at)
            SELECT ${id(500001)},${uid},'fictional-player','127.0.0.1','direct',
                CASE WHEN n%10=0 THEN 'ACTIVE' ELSE 'COMPLETED' END,
                CASE WHEN n%10=0 THEN NULL ELSE NOW()-n*INTERVAL '1 second' END
            FROM generate_series(1,${large ? 14000 : 30}) n`;
            await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type)
            SELECT id,'tmdb',row_number() OVER ()::text,'movie' FROM media_items WHERE media_type='movie'`;
            await sql`INSERT INTO provider_metadata (media_id,provider,metadata,fetched_at)
            SELECT id,'tmdb',jsonb_build_object('vote_count',500,'adult',false,'genres',jsonb_build_array('Drama')),
                NOW() FROM media_items WHERE media_type='movie'`;
            // Two varying dimensions plus a nonzero background, with no equal distances.
            const [dimension] = await sql`SELECT atttypmod AS n FROM pg_attribute
            WHERE attrelid='media_embeddings'::regclass AND attname='embedding'`;
            await sql`INSERT INTO media_embeddings (media_id,source,embedding)
            SELECT id,CASE WHEN n%2=0 THEN 'library' ELSE 'discovery' END,
                (ARRAY[cos(n*0.00007)::real,sin(n*0.00007)::real] ||
                    array_fill(0.001::real,ARRAY[${Number(dimension.n) - 2}::int]))::vector
            FROM (SELECT id,row_number() OVER (ORDER BY id) AS n FROM media_items WHERE media_type='movie') items`;
            await sql`INSERT INTO user_ratings (user_id,media_id,rating) VALUES (${uid},${id(300001)},9)`;
            for (const query of [
                sql`CREATE UNIQUE INDEX media_items_pkey ON media_items (id)`,
                sql`CREATE INDEX idx_media_items_status_type ON media_items (status,media_type)`,
                sql`CREATE INDEX idx_media_items_parent_id ON media_items (parent_id) WHERE parent_id IS NOT NULL`,
                sql`CREATE INDEX idx_media_items_custom_metadata ON media_items USING gin (custom_metadata)
                WHERE custom_metadata <> '{}'::jsonb`,
                sql`CREATE UNIQUE INDEX media_files_pkey ON media_files (id)`,
                sql`CREATE INDEX idx_file_items_media ON media_file_items (media_item_id,file_id)`,
                sql`CREATE INDEX idx_external_ids_media ON external_ids (media_id,provider)`,
                sql`CREATE INDEX idx_provider_metadata_media ON provider_metadata (media_id,provider)`,
                sql`CREATE INDEX idx_embeddings_media ON media_embeddings (media_id,source)`,
                sql`CREATE INDEX idx_me_library_hnsw ON media_embeddings USING hnsw (embedding vector_cosine_ops)
                WITH (m=16,ef_construction=100) WHERE source='library'`,
                sql`CREATE INDEX idx_me_discovery_hnsw ON media_embeddings USING hnsw (embedding vector_cosine_ops)
                WITH (m=16,ef_construction=100) WHERE source='discovery'`,
                sql`CREATE UNIQUE INDEX users_pkey ON users (id)`,
                sql`CREATE INDEX idx_ratings_user ON user_ratings (user_id,media_id)`,
                sql`CREATE INDEX idx_state_user ON user_media_state (user_id,media_id)`,
                sql`CREATE INDEX idx_stage_media ON media_item_stage_state (media_item_id,stage_id)`,
                sql`CREATE INDEX idx_trickplay_media_file ON trickplay_params (media_item_id,file_id)`,
            ])
                await query;
            for (const table of [
                'media_items',
                'media_file_items',
                'media_files',
                'media_embeddings',
                'external_ids',
                'provider_metadata',
                'trickplay_params',
                'play_sessions',
            ])
                await sql`VACUUM ANALYZE ${sql(table)}`;
        },
        large ? 600000 : 180000,
    );
    afterAll(async () => {
        if (sql) await sql.end();
        await getTestDb()`DROP SCHEMA IF EXISTS ${getTestDb()(schema)} CASCADE`;
        if (process.env.PERF_CAPTURE === '1') {
            mkdirSync('perf-artifacts', { recursive: true });
            writeFileSync('perf-artifacts/queries.json', JSON.stringify(captured));
            writeFileSync('perf-artifacts/measurements.json', JSON.stringify(reports, null, 2));
        }
    });

    async function measure(
        name: string,
        query: postgres.PendingQuery<postgres.Row[]>,
    ): Promise<void> {
        const rows = await sql<
            { 'QUERY PLAN': Plan[] }[]
        >`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`;
        const p = rows[0]['QUERY PLAN'][0];
        reports[name] = p;
        console.log(
            'PERF',
            name,
            p['Execution Time'],
            p.Plan['Shared Hit Blocks'],
            p.Plan['Shared Read Blocks'],
        );
    }

    it(
        'matches all fingerprints and queue rows in one snapshot',
        async () => {
            const artists = sql`SELECT id,title,custom_metadata FROM media_items WHERE media_type='artist'`;
            const before = await sql`SELECT id,${baselineFingerprintSql(sql, 'mi')} AS fingerprint
            FROM media_items mi WHERE media_type='artist' AND id<=${id(64)}`;
            const after =
                await sql`SELECT * FROM (${collaborationFingerprintsSql(sql, artists)}) fp WHERE id<=${id(64)}`;
            expect(new Map(after.map((r) => [r.id, r.fingerprint]))).toEqual(
                new Map(before.map((r) => [r.id, r.fingerprint])),
            );
            const expected = await sql`SELECT id FROM media_items mi WHERE media_type='artist'
            AND ${baselineNeedsReviewSql(sql, 'mi')}`;
            expect((await findCollaborationArtists(sql)).map((r) => r.id).sort()).toEqual(
                expected.map((r) => r.id).sort(),
            );
            const [single] =
                await sql`SELECT ${collaborationFingerprintSql(sql, 'mi')} AS fingerprint
                FROM media_items mi WHERE id=${id(1)}`;
            expect(single.fingerprint).toBe(before.find((r) => r.id === id(1))?.fingerprint);
            const scope = buildAdminBrowserBaseScope(sql, { types: ['artist'] });
            const [hygiene] = await sql`SELECT COUNT(*)::int AS n FROM media_items mi WHERE ${scope}
            AND ${baselineNeedsReviewSql(sql, 'mi')}`;
            expect(await countMusicHygieneFinding(sql, MUSIC_HYGIENE_ARTIST_UNSPLIT)).toBe(
                hygiene.n,
            );
            if (large) {
                await measure(
                    'collaboration-before',
                    sql`SELECT id FROM media_items mi WHERE media_type='artist'
                AND ${baselineNeedsReviewSql(sql, 'mi')}`,
                );
                await measure(
                    'hygiene-before',
                    sql`SELECT COUNT(*)::int AS n FROM media_items mi WHERE ${scope}
                AND ${baselineNeedsReviewSql(sql, 'mi')}`,
                );
            }
        },
        large ? 600000 : 180000,
    );

    it(
        'preserves the complete random selection pool and certifies ANN misses',
        async () => {
            const access = unrestrictedAccess();
            const before = await baselinePerfectMatchSql(sql, uid, [], 5, access);
            const calls: { query: string; parameters: unknown[] }[] = [];
            const probe = postgres(getTestDatabaseUrl(), {
                max: 1,
                connection: { search_path: `${schema},public` },
                debug: (_c, query, parameters) =>
                    calls.push({ query, parameters: [...parameters] }),
            });
            try {
                await fetchPerfectMatch(probe, uid, [], 5, access);
            } finally {
                await probe.end();
            }
            const query = calls.find((q) => q.query.includes('ann_candidates AS'))!;
            // Fetch the entire top-five pool before random transformation. Intentionally
            // empty ANN seeds force the exactness guard to recover every true winner.
            for (const emptyThrough of [0, 64, 256, 1024]) {
                const text = query.query.replace(/LIMIT (64|256|1024)\b/g, (match, size: string) =>
                    Number(size) <= emptyThrough ? 'LIMIT 0' : match,
                );
                const ctes = text.slice(
                    0,
                    text.lastIndexOf('        SELECT\n            media_id,'),
                );
                const [counts] = await sql.unsafe(
                    ctes +
                        `SELECT
                    (SELECT count(*)::int FROM seed_64) AS small,
                    (SELECT count(*)::int FROM seed_256) AS medium,
                    (SELECT count(*)::int FROM seed_1024) AS large`,
                    query.parameters.slice(0, -1) as postgres.ParameterOrJSON<never>[],
                );
                expect(counts).toEqual({
                    small: emptyThrough === 0 ? 5 : 0,
                    medium: emptyThrough === 64 ? 5 : 0,
                    large: emptyThrough === 256 ? 5 : 0,
                });
                const after = await sql.unsafe(
                    text,
                    query.parameters as postgres.ParameterOrJSON<never>[],
                );
                expect(
                    [...after].sort((a, b) => String(a.media_id).localeCompare(String(b.media_id))),
                ).toEqual(
                    [...before].sort((a, b) =>
                        String(a.media_id).localeCompare(String(b.media_id)),
                    ),
                );
            }
            if (large) {
                await measure(
                    'perfect-match-before',
                    baselinePerfectMatchSql(sql, uid, [], 5, access),
                );
                const after = await sql.unsafe(
                    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query.query,
                    query.parameters as postgres.ParameterOrJSON<never>[],
                );
                reports['perfect-match-after'] = after[0]['QUERY PLAN'][0];
            }
        },
        large ? 600000 : 180000,
    );

    it.skipIf(large)(
        'preserves damping, suppression, metadata gates and unindexed vectors',
        async () => {
            const access = unrestrictedAccess();
            const [{ vector }] = await sql<{ vector: string }[]>`SELECT embedding::text AS vector
            FROM media_embeddings WHERE media_id=${id(300001)}`;
            const vec = JSON.parse(vector) as number[];
            const damper: DamperContext = {
                dampers: [{ vec, weight: 1 }],
                mean: vec.map(() => 0),
                hash: 'synthetic',
            };
            await sql`UPDATE provider_metadata SET metadata=metadata || '{"adult":true}'::jsonb
            WHERE media_id=${id(300001)}`;
            await sql`UPDATE provider_metadata SET metadata=metadata || '{"is_color":"false"}'::jsonb
            WHERE media_id=${id(300002)}`;
            await sql`UPDATE provider_metadata SET metadata=metadata || '{"vote_count":1}'::jsonb
            WHERE media_id=${id(300003)}`;
            await sql`INSERT INTO media_genres (media_id,genre_id,source)
            SELECT id,10751,'tmdb' FROM media_items WHERE media_type='movie' AND id<=${id(300040)}`;
            const compare = async (context: DamperContext | null): Promise<void> => {
                const exclude = [id(300004), id(300005)];
                const before = await baselinePerfectMatchSql(
                    sql,
                    uid,
                    exclude,
                    5,
                    access,
                    50,
                    true,
                    true,
                    context,
                );
                const calls: { query: string; parameters: unknown[] }[] = [];
                const probe = postgres(getTestDatabaseUrl(), {
                    max: 1,
                    connection: { search_path: `${schema},public` },
                    debug: (_c, query, parameters) =>
                        calls.push({ query, parameters: [...parameters] }),
                });
                try {
                    await fetchPerfectMatch(
                        probe,
                        uid,
                        exclude,
                        5,
                        access,
                        50,
                        true,
                        true,
                        context,
                    );
                } finally {
                    await probe.end();
                }
                const q = calls.find((q) => q.query.includes('ann_candidates AS'))!;
                const after = await sql.unsafe(
                    q.query,
                    q.parameters as postgres.ParameterOrJSON<never>[],
                );
                expect(
                    [...after].sort((a, b) => String(a.media_id).localeCompare(String(b.media_id))),
                ).toEqual(
                    [...before].sort((a, b) =>
                        String(a.media_id).localeCompare(String(b.media_id)),
                    ),
                );
                expect(after).toHaveLength(5);
            };
            await compare(damper);
            // HNSW excludes null and zero vectors. Certification retains their SQL
            // ordering semantics even when no such row appears among the seeds.
            await sql`INSERT INTO media_embeddings (media_id,source,embedding)
            SELECT media_id,'discovery',NULL FROM media_embeddings
            WHERE source='library' AND media_id>=${id(300100)} ORDER BY media_id LIMIT 5`;
            await compare(null);
            await sql`UPDATE media_embeddings SET embedding=${`[${vec.map(() => 0).join(',')}]`}::vector
            WHERE embedding IS NULL`;
            await compare(null);
        },
    );

    it(
        'preserves all admin aggregates and uses the hotspot indexes at realistic size',
        async () => {
            await measure('ended-before', baselineGetLastEndedSessionSql(sql));
            await measure('arrival-before', baselineGetRecentlyAddedForOpsSql(sql, 500));
            await measure('stats-before', baselineGetMediaBrowserStatsSql(sql));
            await measure(
                'count-before',
                sql`SELECT count(*) FROM media_items WHERE status='active'`,
            );
            await measure('trickplay-before', baselineGetTrickplayBacklogCountsSql(sql, 3));
            await createHotspotIndexes(sql);
            expect(await getLastEndedSession(sql)).toEqual(
                (await baselineGetLastEndedSessionSql(sql))[0],
            );
            expect(await getRecentlyAddedForOps(sql, 500)).toEqual(
                await baselineGetRecentlyAddedForOpsSql(sql, 500),
            );
            expect(await getMediaBrowserStats(sql)).toEqual(
                (await baselineGetMediaBrowserStatsSql(sql))[0],
            );
            expect(await getTrickplayBacklogCounts(sql, 3)).toEqual(
                (await baselineGetTrickplayBacklogCountsSql(sql, 3))[0],
            );
            // Capture real module SQL, not independently reimplemented query shapes.
            for (const [name, run] of [
                ['ended-after', getLastEndedSession],
                ['arrival-after', (db: postgres.Sql) => getRecentlyAddedForOps(db, 500)],
                ['stats-after', getMediaBrowserStats],
                ['trickplay-after', (db: postgres.Sql) => getTrickplayBacklogCounts(db, 3)],
                ['collaboration-after', findCollaborationArtists],
                [
                    'hygiene-after',
                    (db: postgres.Sql) =>
                        countMusicHygieneFinding(db, MUSIC_HYGIENE_ARTIST_UNSPLIT),
                ],
            ] as const) {
                const calls: { query: string; parameters: unknown[] }[] = [];
                const probe = postgres(getTestDatabaseUrl(), {
                    max: 1,
                    connection: { search_path: `${schema},public` },
                    debug: (_c, query, parameters) =>
                        calls.push({ query, parameters: [...parameters] }),
                });
                try {
                    await run(probe);
                } finally {
                    await probe.end();
                }
                const q = calls[calls.length - 1];
                const plan = await sql.unsafe(
                    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + q.query,
                    q.parameters as postgres.ParameterOrJSON<never>[],
                );
                reports[name] = plan[0]['QUERY PLAN'][0];
            }
            await measure(
                'count-after',
                sql`SELECT count(*) FROM media_items WHERE status='active'`,
            );
            if (large) {
                expect(JSON.stringify(reports['ended-after'])).toContain(
                    'idx_play_sessions_last_ended',
                );
                expect(JSON.stringify(reports['arrival-after'])).toContain(
                    'idx_media_items_ops_arrival',
                );
                expect(JSON.stringify(reports['perfect-match-after'])).toContain(
                    'idx_me_library_hnsw',
                );
                expect(JSON.stringify(reports['perfect-match-after'])).toContain(
                    'idx_me_discovery_hnsw',
                );
            }
            if (large)
                console.log(
                    'PERF_SUMMARY',
                    JSON.stringify(
                        Object.fromEntries(
                            Object.entries(reports).map(([name, p]) => [
                                name,
                                (p as Plan)['Execution Time'],
                            ]),
                        ),
                    ),
                );
        },
        large ? 600000 : 180000,
    );
});
