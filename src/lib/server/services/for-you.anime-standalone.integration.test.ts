// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `fetchAnimeRecommendations` keeps every row that has an internal id or a
 * primary external id; a Jellyfin id is not required. This drives the real
 * function against real rows (TMDB and embeddings are not involved: the
 * function only reads local tables), with an anime item that has NO
 * `jellyfin` row in `external_ids`. (The SQL inner-joins the primary tmdb id,
 * so a row without one never reaches the TS filter; that is unchanged.)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../tests/integration/fixtures/index.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { fetchAnimeRecommendations } from './for-you.service.js';

/** Anime-eligible item: `anime_genres` projects has_anime_genres, `keywords` the strong anime keyword. */
async function seedAnimeItem(
    sql: postgres.Sql,
    tmdbId: number,
    opts: { available: boolean } = { available: true },
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${id}::uuid, ${'StandaloneAnime ' + tmdbId}, 'tv', 'active', ${opts.available})
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
        VALUES (${id}::uuid, 'tmdb', ${String(tmdbId)}, 'tv', true)
    `;
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
        VALUES (${id}::uuid, 'tmdb', ${sql.json({
            anime_genres: [{ id: 1 }],
            keywords: ['anime'],
            mdblist_score: 80,
            imdb_rating: 7.5,
        })}, NOW())
    `;
    return id;
}

describe('fetchAnimeRecommendations without Jellyfin ids (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    });

    it('lists an available anime item that has no Jellyfin id in external_ids', async () => {
        const userId = generateTestUserId('itest-anime-standalone');
        await ensureTestUser(sql, userId);

        // Three anime items satisfy the "watched enough anime" TMDB-id gate.
        const gateTmdbIds = [882001, 882002, 882003];
        for (const tmdbId of gateTmdbIds) await seedAnimeItem(sql, tmdbId);

        const targetId = await seedAnimeItem(sql, 882004);

        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM external_ids WHERE provider = 'jellyfin'
        `;
        expect(count).toBe('0');

        const items = await fetchAnimeRecommendations(
            sql,
            50,
            userId,
            gateTmdbIds,
            null,
            unrestrictedAccess(),
        );

        const byInternal = new Map(
            items.map((item) => [getExternalIdFor(item.externalIds, 'internal'), item]),
        );
        const target = byInternal.get(targetId);
        expect(target).toBeDefined();
        expect(target!.isAvailable).toBe(true);
        expect(target!.externalIds).not.toHaveProperty('jellyfin');
    });
});
