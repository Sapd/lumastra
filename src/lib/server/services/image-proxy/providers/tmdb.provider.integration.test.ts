// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * getEpisodeStillPath's episode lookup against real Postgres. The key is either
 * the episode's own uuid or its TMDB episode id, and the query must resolve BOTH:
 * a SQL-side guard like `$1 ~ '<uuid>' AND ep.id = $1::uuid` does not stop the
 * cast of a bound parameter, and the query's `.catch` turns that error into
 * "no row" — a TMDB-keyed lookup would silently lose its still.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../tests/integration/helpers/cleanup.js';
import { TmdbImageProvider } from './tmdb.provider';

type StillLookup = (episodeKey: string) => Promise<string | null>;

describe('TmdbImageProvider.getEpisodeStillPath — episode lookup', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function seedEpisode(): Promise<string> {
        const [series] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type) VALUES ('Still Show', 'tv') RETURNING id`;
        const [season] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number)
            VALUES ('Season 1', 'season', ${series.id}::uuid, 1) RETURNING id`;
        const [episode] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
            VALUES ('Pilot', 'episode', ${season.id}::uuid, 1, 1) RETURNING id`;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${series.id}::uuid, 'tmdb', '990601', 'tv', true),
                   (${episode.id}::uuid, 'tmdb', '990602', 'episode', true)`;
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${episode.id}::uuid, 'tmdb', ${sql.json({ still_path: '/stored-still.jpg' })}, NOW())`;
        return episode.id;
    }

    function lookup(): StillLookup {
        const provider = new TmdbImageProvider(sql);
        return (
            provider as unknown as { getEpisodeStillPath: StillLookup }
        ).getEpisodeStillPath.bind(provider);
    }

    it("resolves by the episode's uuid", async () => {
        const id = await seedEpisode();
        expect(await lookup()(id)).toBe('/stored-still.jpg');
    });

    it('resolves by the TMDB episode id (a non-uuid key)', async () => {
        await seedEpisode();
        expect(await lookup()('990602')).toBe('/stored-still.jpg');
    });

    it('returns null for an unknown key of either shape', async () => {
        await seedEpisode();
        expect(await lookup()('123456789')).toBeNull();
        expect(await lookup()('00000000-0000-4000-8000-000000000000')).toBeNull();
    });
});
