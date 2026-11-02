// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    countFilelessDuplicatePairs,
    findFilelessDuplicatePairsWithTotal,
} from './admin-media.queries.js';

// Frozen deployed SQL: keep independent of the grouped implementation.
function oldCount(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        WITH norm AS (
            SELECT
                mi.id,
                mi.year,
                mi.media_type,
                mi.has_files,
                BTRIM(regexp_replace(
                    regexp_replace(LOWER(TRIM(mi.title)), '[^a-z0-9 ]', '', 'g'),
                    ' +', ' ', 'g'
                )) AS n,
                EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id) AS has_ext,
                (
                    SELECT ei.external_id FROM external_ids ei
                    WHERE ei.media_id = mi.id AND ei.provider = 'tmdb'
                    LIMIT 1
                ) AS tmdb_id
            FROM media_items mi
            WHERE mi.parent_id IS NULL
              AND mi.status = 'active'
              AND NOT mi.is_dismissed
              AND mi.media_type IN ('movie', 'tv')
        )
        SELECT COUNT(*)::int AS total
        FROM norm f
        JOIN norm d
          ON d.n = f.n
         AND d.year = f.year
         AND d.media_type = f.media_type
         AND d.id <> f.id
        WHERE f.year IS NOT NULL
          AND f.has_files = true AND f.has_ext = false
          AND d.has_files = false AND d.tmdb_id IS NOT NULL
          AND (
              SELECT COUNT(*) FROM norm x
              WHERE x.n = f.n AND x.year = f.year
                AND x.media_type = f.media_type
                AND x.has_files = true AND x.has_ext = false
          ) = 1
          AND (
              SELECT COUNT(*) FROM norm x
              WHERE x.n = f.n AND x.year = f.year
                AND x.media_type = f.media_type
                AND x.has_files = false AND x.tmdb_id IS NOT NULL
          ) = 1
    `;
}
function oldList(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        WITH norm AS (
            SELECT
                mi.id,
                mi.title,
                mi.year,
                mi.media_type,
                mi.has_files,
                BTRIM(regexp_replace(
                    regexp_replace(LOWER(TRIM(mi.title)), '[^a-z0-9 ]', '', 'g'),
                    ' +', ' ', 'g'
                )) AS n,
                EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id) AS has_ext,
                (
                    SELECT ei.external_id FROM external_ids ei
                    WHERE ei.media_id = mi.id AND ei.provider = 'tmdb'
                    LIMIT 1
                ) AS tmdb_id
            FROM media_items mi
            WHERE mi.parent_id IS NULL
              AND mi.status = 'active'
              AND NOT mi.is_dismissed
              AND mi.media_type IN ('movie', 'tv')
        ),
        pairs AS (
            SELECT
                f.id AS "fileId",
                f.title AS "fileTitle",
                d.id AS "discoveryId",
                d.title AS "discoveryTitle",
                d.tmdb_id AS "tmdbId",
                f.media_type AS "mediaType",
                f.year AS "year"
            FROM norm f
            JOIN norm d
              ON d.n = f.n
             AND d.year = f.year
             AND d.media_type = f.media_type
             AND d.id <> f.id
            WHERE f.year IS NOT NULL
              AND f.has_files = true AND f.has_ext = false
              AND d.has_files = false AND d.tmdb_id IS NOT NULL
              AND (
                  SELECT COUNT(*) FROM norm x
                  WHERE x.n = f.n AND x.year = f.year
                    AND x.media_type = f.media_type
                    AND x.has_files = true AND x.has_ext = false
              ) = 1
              AND (
                  SELECT COUNT(*) FROM norm x
                  WHERE x.n = f.n AND x.year = f.year
                    AND x.media_type = f.media_type
                    AND x.has_files = false AND x.tmdb_id IS NOT NULL
              ) = 1
            ORDER BY f.title
        )
        SELECT *, COUNT(*) OVER()::int AS "_total"
        FROM pairs
        LIMIT 1000000
    `;
}

const rollback = new Error('rollback duplicate scale fixture');
// Scale proof (6,000 rows, up to 3 minutes): opt-in like the other scale tests.
// Run with LUMASTRA_SCALE_TEST=1. Correctness edge cases stay covered by
// admin-media.queries.integration.test.ts in the normal suite.
describe.skipIf(!process.env.LUMASTRA_SCALE_TEST)(
    'Fileless duplicate count and list differential proof',
    () => {
        it('keeps nonempty result counts and ordered row hashes at catalogue scale', async () => {
            try {
                await getTestDb().begin(async (transaction) => {
                    const tx = transaction as unknown as postgres.Sql;
                    const schema = `duplicates_${crypto.randomUUID().replaceAll('-', '')}`;
                    await tx`CREATE SCHEMA ${tx(schema)}`;
                    await tx`SET LOCAL search_path TO ${tx(schema)}, public`;
                    await tx`CREATE TABLE media_items (LIKE public.media_items INCLUDING ALL)`;
                    await tx`CREATE TABLE external_ids (LIKE public.external_ids INCLUDING ALL)`;
                    await tx`INSERT INTO media_items (id,title,media_type,year,has_files,status,is_dismissed)
                    SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
                        'Scale film ' || ((n-1)/2), CASE WHEN n%10<5 THEN 'movie' ELSE 'tv' END,
                        2000 + n/1000, n%2=1, 'active', false
                    FROM generate_series(1,6000) n`;
                    await tx`INSERT INTO external_ids (media_id,provider,external_id,media_type)
                    SELECT id,'tmdb',(row_number() OVER())::text,media_type FROM media_items WHERE NOT has_files`;
                    await tx`ANALYZE media_items`;
                    await tx`ANALYZE external_ids`;
                    const summary = async (q: postgres.PendingQuery<postgres.Row[]>) => {
                        const [row] = await tx`SELECT count(*)::int AS count,
                        md5(string_agg(result::text,'|' ORDER BY result."fileId",result."discoveryId")) AS hash
                        FROM (${q}) result`;
                        return row;
                    };
                    const oldSummary = await summary(oldList(tx));
                    expect(oldSummary.count).toBeGreaterThan(1000);
                    const times: Record<string, number[]> = {
                        old_count: [],
                        new_count: [],
                        old_list: [],
                        new_list: [],
                    };
                    for (let i = 0; i < 3; i++) {
                        for (const [name, run] of [
                            ['old_count', async () => (await oldCount(tx))[0].total],
                            ['new_count', () => countFilelessDuplicatePairs(tx)],
                            ['old_list', async () => await oldList(tx)],
                            [
                                'new_list',
                                async () => {
                                    const result = await findFilelessDuplicatePairsWithTotal(
                                        tx,
                                        1000000,
                                    );
                                    expect(result.total).toBe(oldSummary.count);
                                    // Hash the ACTUAL function's rows on the same DB, not an SQL reimplementation.
                                    const [hash] =
                                        await tx`SELECT md5(string_agg(row(r."fileId",r."fileTitle",r."discoveryId",r."discoveryTitle",r."tmdbId",r."mediaType",r.year,r._total)::text,'|' ORDER BY r."fileId",r."discoveryId")) AS value
                                FROM jsonb_to_recordset(${tx.json(result.pairs.map((p) => ({ ...p, _total: result.total })))}::jsonb)
                                AS r("fileId" uuid,"fileTitle" text,"discoveryId" uuid,"discoveryTitle" text,"tmdbId" text,"mediaType" text,year int,_total int)`;
                                    expect(hash.value).toBe(oldSummary.hash);
                                    return result;
                                },
                            ],
                        ] as const) {
                            const start = performance.now();
                            const value = await run();
                            times[name].push(performance.now() - start);
                            if (name.endsWith('count')) expect(value).toBe(oldSummary.count);
                        }
                    }
                    console.log(
                        'DUPLICATE_SCALE_PROOF',
                        JSON.stringify({
                            count: oldSummary.count,
                            hash: oldSummary.hash,
                            times,
                            median: Object.fromEntries(
                                Object.entries(times).map(([k, v]) => [
                                    k,
                                    v.sort((a, b) => a - b)[1],
                                ]),
                            ),
                        }),
                    );
                    throw rollback;
                });
            } catch (error) {
                if (error !== rollback) throw error;
            }
        }, 180000);
    },
);
