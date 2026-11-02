// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression: the mal-anime-id-enrichment coverage predicates must be safe against
 * a SCALAR `anime_genres` value.
 *
 * PROD INCIDENT (surfaced 2026-07-16): mdblist-sync writes `anime_genres: null`
 * (a JSON scalar) for every non-anime series — 11,500+ rows. Both the stage's
 * `eligibility` heal and its `not-in-anime-catalog` terminalDisposition tested
 * membership with `jsonb_typeof(x)='array' AND jsonb_array_length(x) > 0`.
 * Postgres does NOT reliably short-circuit that AND, so `jsonb_array_length`
 * was evaluated against the scalar and threw `cannot get array length of a
 * scalar` — aborting BOTH the heal and the disposition UPDATE on every 60s sweep
 * tick. 500+ non-anime series could never be tombstoned and looped forever.
 *
 * The fix tests non-emptiness with `x <> '[]'::jsonb`, which never throws. This
 * test reproduces the exact predicate shapes against real json-null data.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../tests/integration/helpers/cleanup.js';

const TABLES = ['provider_metadata', 'media_items'];

async function seedItem(sql: postgres.Sql, id: string, animeGenres: unknown): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${id}::uuid, ${'item-' + id.slice(0, 8)}, 'tv', 'active', true)
    `;
    // sql.json(null) writes a JSON null scalar; sql.json([...]) writes an array.
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
        VALUES (${id}::uuid, 'mdblist', ${sql.json({ anime_genres: animeGenres } as never)}, NOW(), NOW())
    `;
}

const NON_ANIME = '11111111-0000-0000-0000-000000000001'; // anime_genres: null (scalar)
const EMPTY = '11111111-0000-0000-0000-000000000002'; //     anime_genres: []
const ANIME = '11111111-0000-0000-0000-000000000003'; //     anime_genres: ['Shounen']

describe('mal-anime anime_genres predicate — scalar safety', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = await getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TABLES);
        await seedItem(sql, NON_ANIME, null);
        await seedItem(sql, EMPTY, []);
        await seedItem(sql, ANIME, ['Shounen', 'Action']);
    });

    it('the OLD jsonb_array_length predicate throws on a scalar (documents the bug)', async () => {
        await expect(
            sql`
                SELECT count(*) FROM media_items mi
                WHERE EXISTS (
                    SELECT 1 FROM provider_metadata pm
                     WHERE pm.media_id = mi.id
                       AND jsonb_typeof(pm.metadata->'anime_genres') = 'array'
                       AND jsonb_array_length(pm.metadata->'anime_genres') > 0
                )
            `,
        ).rejects.toThrow(/array length of a scalar/i);
    });

    it('the FIXED <> [] predicate never throws and identifies exactly the anime item', async () => {
        const rows = await sql<{ id: string }[]>`
            SELECT mi.id::text AS id FROM media_items mi
            WHERE EXISTS (
                SELECT 1 FROM provider_metadata pm
                 WHERE pm.media_id = mi.id
                   AND jsonb_typeof(pm.metadata->'anime_genres') = 'array'
                   AND pm.metadata->'anime_genres' <> '[]'::jsonb
            )
        `;
        expect(rows.map((r) => r.id).sort()).toEqual([ANIME]);
    });

    it('the FIXED NOT EXISTS (tombstone) predicate selects non-anime + empty, never the anime item', async () => {
        // This is the shape of the not-in-anime-catalog disposition's `excludes`.
        const rows = await sql<{ id: string }[]>`
            SELECT mi.id::text AS id FROM media_items mi
            WHERE NOT EXISTS (
                SELECT 1 FROM provider_metadata pm
                 WHERE pm.media_id = mi.id
                   AND jsonb_typeof(pm.metadata->'anime_genres') = 'array'
                   AND pm.metadata->'anime_genres' <> '[]'::jsonb
            )
        `;
        expect(rows.map((r) => r.id).sort()).toEqual([NON_ANIME, EMPTY].sort());
    });
});
