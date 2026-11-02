// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Continue Watching and Next Up on a standalone install (no Jellyfin ids in
 * `external_ids`). For an episode the tmdb/imdb ids and `seriesId` of the
 * returned item come from the SERIES, never the episode; a movie carries its
 * own ids. Nothing in the mapped output may carry a `jellyfin` key.
 *
 * Tested at the query + row-mapper seam with real rows: `getContinueWatchingFromDb`
 * and `getNextUpFromDb` feed `rowToItem` (the /api/v1/continue-watching
 * mapper) and `nextUpRowToMediaItem` (next-up in the recommendations route,
 * cache warmer and hero).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestSeries,
    ensureTestUser,
    generateTestUserId,
    stripJellyfinIds,
} from '../../../../../../tests/integration/fixtures/index.js';
import {
    getContinueWatchingFromDb,
    getNextUpFromDb,
} from '$lib/server/database/queries/watch-state.queries.js';
import { nextUpRowToMediaItem } from '$lib/server/utils/next-up-media-item.js';
import { rowToItem } from './continue-watching.js';

const CW_PARAMS = {
    limit: 10,
    minMs: 30_000,
    minPercent: 10,
    maxAgeDays: 180,
    collapsePerSeries: true,
} as const;

describe('Continue Watching / Next Up without Jellyfin ids (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            ...TEST_TABLES.userData,
            'user_media_flags',
        ]);
    });

    async function episodeIds(seriesId: string): Promise<string[]> {
        const rows = await sql<{ id: string }[]>`
            SELECT ep.id
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            WHERE season.parent_id = ${seriesId}::uuid
            ORDER BY ep.season_number, ep.episode_number
        `;
        return rows.map((r) => r.id);
    }

    async function seedState(
        userId: string,
        mediaId: string,
        state: { watched: boolean; resumeMs: number },
    ): Promise<void> {
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                watch_count, last_watched_at, first_watched_at, last_event_at,
                last_event_source
            ) VALUES (
                ${userId}, ${mediaId}::uuid, ${state.watched}, ${state.resumeMs},
                ${45 * 60 * 1000}, ${state.watched ? 1 : 0},
                ${state.watched ? sql`NOW() - INTERVAL '1 day'` : null},
                ${state.watched ? sql`NOW() - INTERVAL '1 day'` : null},
                NOW() - INTERVAL '1 hour', 'lumastra-player'
            )
        `;
    }

    it('continue-watching episode carries the series ids and seriesId, no jellyfin key', async () => {
        const userId = generateTestUserId('cw_standalone_ep');
        await ensureTestUser(sql, userId);
        const series = await createAndInsertTestSeries(sql, {
            title: 'Standalone Series',
            tmdbId: 770001,
            seasonCount: 1,
            episodesPerSeason: 3,
        });
        const [ep1] = await episodeIds(series.seriesId);
        // Give the episode its own, different tmdb id: the output must still
        // show the series' id.
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${ep1}::uuid, 'tmdb', '999999', 'episode', true)
        `;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${ep1}::uuid`;
        await stripJellyfinIds(sql, series.seriesId);
        await seedState(userId, ep1, { watched: false, resumeMs: 15 * 60 * 1000 });

        const rows = await getContinueWatchingFromDb.all(sql, { userId, ...CW_PARAMS });
        expect(rows).toHaveLength(1);
        expect(rows[0].series_id).toBe(series.seriesId);
        expect(rows[0].tmdb_id).toBe('770001');
        expect(rows[0].imdb_id).toBe('tt770001');

        const item = rowToItem(rows[0], 'internal');
        expect(item).not.toBeNull();
        expect(item!.media.id).toBe(ep1);
        expect(item!.media.type).toBe('episode');
        expect(item!.media.seriesId).toBe(series.seriesId);
        expect(item!.media.ids.tmdb).toBe('770001');
        expect(item!.media.ids.internal).toBe(ep1);
        expect(item!.media.ids).not.toHaveProperty('jellyfin');
        expect(JSON.stringify(item)).not.toMatch(/jellyfin/i);
    });

    it('continue-watching movie carries its own ids, no jellyfin key', async () => {
        const userId = generateTestUserId('cw_standalone_movie');
        await ensureTestUser(sql, userId);
        const movie = await createAndInsertTestMovie(sql, {
            title: 'Standalone Movie',
            tmdbId: 770002,
            imdbId: 'tt7700022',
        });
        await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;
        await sql`DELETE FROM external_ids WHERE media_id = ${movie.id}::uuid AND provider = 'jellyfin'`;
        await seedState(userId, movie.id, { watched: false, resumeMs: 20 * 60 * 1000 });

        const rows = await getContinueWatchingFromDb.all(sql, { userId, ...CW_PARAMS });
        expect(rows).toHaveLength(1);
        expect(rows[0].series_id).toBeNull();
        expect(rows[0].tmdb_id).toBe('770002');
        expect(rows[0].imdb_id).toBe('tt7700022');

        const item = rowToItem(rows[0], 'internal');
        expect(item).not.toBeNull();
        expect(item!.media.id).toBe(movie.id);
        expect(item!.media.type).toBe('movie');
        expect(item!.media.ids.tmdb).toBe('770002');
        expect(item!.media.seriesId).toBeUndefined();
        expect(item!.media.ids).not.toHaveProperty('jellyfin');
        expect(JSON.stringify(item)).not.toMatch(/jellyfin/i);
    });

    it('next-up episode carries the series ids and seriesId, no jellyfin key', async () => {
        const userId = generateTestUserId('nu_standalone');
        await ensureTestUser(sql, userId);
        const series = await createAndInsertTestSeries(sql, {
            title: 'Standalone Next Up',
            tmdbId: 770003,
            seasonCount: 1,
            episodesPerSeason: 3,
        });
        const [ep1, ep2] = await episodeIds(series.seriesId);
        await sql`UPDATE media_items SET has_files = true WHERE id IN (${ep1}::uuid, ${ep2}::uuid)`;
        await stripJellyfinIds(sql, series.seriesId);
        await seedState(userId, ep1, { watched: true, resumeMs: 0 });

        const rows = await getNextUpFromDb.all(sql, { userId, limit: 10, maxAgeDays: 0 });
        expect(rows).toHaveLength(1);
        expect(rows[0].media_id).toBe(ep2);
        expect(rows[0].series_id).toBe(series.seriesId);
        expect(rows[0].series_tmdb_id).toBe('770003');
        expect(rows[0].series_imdb_id).toBe('tt770003');

        const item = nextUpRowToMediaItem(rows[0]);
        expect(item.id).toBe(ep2);
        expect(item.seriesId).toBe(series.seriesId);
        expect(item.externalIds).toMatchObject({ tmdb: '770003', internal: ep2 });
        expect(item.externalIds).not.toHaveProperty('jellyfin');
        expect(JSON.stringify(item)).not.toMatch(/jellyfin/i);
    });
});
