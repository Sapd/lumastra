// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * batchGetWatchedState — the watched flag + series progress behind
 * GET /api/v1/watchlist.
 *
 * The cases that matter are the ones where the movie answer and the series
 * answer diverge: a series has no user_media_state row of its own until
 * something explicitly marks it, so the naive "read is_watched" reports every
 * partially-watched series as unwatched, and the naive "count episodes"
 * reports an explicitly-marked series as unwatched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { closeTestDb, getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestSeries,
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';
import { batchGetWatchedState } from './watch-state.queries.js';

describe('batchGetWatchedState', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_flags',
            'user_media_events',
            'user_media_state',
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
            'provider_metadata',
            'library_availability',
        ]);
    });

    /** Mark one media id watched for a user. */
    async function markWatched(userId: string, mediaId: string): Promise<void> {
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched)
            VALUES (${userId}, ${mediaId}, true)
            ON CONFLICT (user_id, media_id) DO UPDATE SET is_watched = true
        `;
    }

    /** Every episode id of a fixture series, flattened across seasons. */
    async function episodeIds(seriesId: string): Promise<string[]> {
        const rows = await sql<{ id: string }[]>`
            SELECT ep.id::text AS id
            FROM media_items season
            JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode'
            WHERE season.parent_id = ${seriesId} AND season.media_type = 'season'
        `;
        return rows.map((r) => r.id);
    }

    it('returns an empty map for an empty id list without hitting the database', async () => {
        const result = await batchGetWatchedState(sql, generateTestUserId('empty'), []);
        expect(result.size).toBe(0);
    });

    it('reports a movie by its own watch flag, and omits episode progress', async () => {
        const userId = generateTestUserId('movie');
        await ensureTestUser(sql, userId);
        const watchedMovie = await createAndInsertTestMovie(sql, { title: 'Seen It' });
        const unwatchedMovie = await createAndInsertTestMovie(sql, { title: 'Not Seen' });
        await markWatched(userId, watchedMovie.id);

        const result = await batchGetWatchedState(sql, userId, [
            watchedMovie.id,
            unwatchedMovie.id,
        ]);

        expect(result.get(watchedMovie.id)).toEqual({
            mediaId: watchedMovie.id,
            watched: true,
            totalEpisodes: null,
            watchedEpisodes: null,
        });
        expect(result.get(unwatchedMovie.id)?.watched).toBe(false);
        // Movies must not carry progress — the client renders a boolean for them.
        expect(result.get(unwatchedMovie.id)?.totalEpisodes).toBeNull();
    });

    it('counts episodes for a partially-watched series and does NOT call it watched', async () => {
        const userId = generateTestUserId('partial');
        await ensureTestUser(sql, userId);
        const series = await createAndInsertTestSeries(sql, {
            title: 'Half Done',
            seasonCount: 1,
            episodesPerSeason: 4,
        });
        const eps = await episodeIds(series.seriesId);
        expect(eps).toHaveLength(4);
        await markWatched(userId, eps[0]);
        await markWatched(userId, eps[1]);

        const result = await batchGetWatchedState(sql, userId, [series.seriesId]);

        expect(result.get(series.seriesId)).toEqual({
            mediaId: series.seriesId,
            watched: false,
            totalEpisodes: 4,
            watchedEpisodes: 2,
        });
    });

    it('calls a series watched once every episode is watched, with no series-level row', async () => {
        const userId = generateTestUserId('allEps');
        await ensureTestUser(sql, userId);
        const series = await createAndInsertTestSeries(sql, {
            title: 'Finished',
            seasonCount: 2,
            episodesPerSeason: 3,
        });
        const eps = await episodeIds(series.seriesId);
        for (const ep of eps) await markWatched(userId, ep);

        const result = await batchGetWatchedState(sql, userId, [series.seriesId]);

        expect(result.get(series.seriesId)).toEqual({
            mediaId: series.seriesId,
            watched: true,
            totalEpisodes: 6,
            watchedEpisodes: 6,
        });
    });

    it('honours an explicit series-level watch flag even when episodes lag behind', async () => {
        // Regression guard for the prod case that drove this logic: a series
        // flagged watched (by "mark watched" or Jellyfin sync) whose episode
        // rollup reads 24/50. Reporting it unwatched would contradict the
        // detail modal, which reads the same series-level flag.
        const userId = generateTestUserId('flagged');
        await ensureTestUser(sql, userId);
        const series = await createAndInsertTestSeries(sql, {
            title: 'Marked Watched',
            seasonCount: 1,
            episodesPerSeason: 5,
        });
        const eps = await episodeIds(series.seriesId);
        await markWatched(userId, eps[0]);
        await markWatched(userId, series.seriesId);

        const result = await batchGetWatchedState(sql, userId, [series.seriesId]);

        expect(result.get(series.seriesId)).toEqual({
            mediaId: series.seriesId,
            watched: true,
            // Progress still reports the true rollup so the client can show detail.
            totalEpisodes: 5,
            watchedEpisodes: 1,
        });
    });

    it('never reports a series with zero ingested episodes as watched', async () => {
        const userId = generateTestUserId('noEps');
        await ensureTestUser(sql, userId);
        const series = await createAndInsertTestSeries(sql, {
            title: 'Nothing Ingested',
            seasonCount: 1,
            episodesPerSeason: 0,
        });

        const result = await batchGetWatchedState(sql, userId, [series.seriesId]);

        // 0/0 must not read as complete.
        expect(result.get(series.seriesId)).toEqual({
            mediaId: series.seriesId,
            watched: false,
            totalEpisodes: 0,
            watchedEpisodes: 0,
        });
    });

    it("does not leak another user's watch state", async () => {
        const mine = generateTestUserId('mine');
        const theirs = generateTestUserId('theirs');
        await ensureTestUser(sql, mine);
        await ensureTestUser(sql, theirs);
        const movie = await createAndInsertTestMovie(sql, { title: 'Theirs Only' });
        const series = await createAndInsertTestSeries(sql, {
            title: 'Theirs Series',
            seasonCount: 1,
            episodesPerSeason: 2,
        });
        const eps = await episodeIds(series.seriesId);
        await markWatched(theirs, movie.id);
        for (const ep of eps) await markWatched(theirs, ep);

        const result = await batchGetWatchedState(sql, mine, [movie.id, series.seriesId]);

        expect(result.get(movie.id)?.watched).toBe(false);
        expect(result.get(series.seriesId)?.watched).toBe(false);
        expect(result.get(series.seriesId)?.watchedEpisodes).toBe(0);
        expect(result.get(series.seriesId)?.totalEpisodes).toBe(2);
    });

    it('omits ids that do not resolve to an active media item', async () => {
        const userId = generateTestUserId('missing');
        await ensureTestUser(sql, userId);
        const movie = await createAndInsertTestMovie(sql, { title: 'Real' });
        const ghost = crypto.randomUUID();

        const result = await batchGetWatchedState(sql, userId, [movie.id, ghost]);

        expect(result.has(movie.id)).toBe(true);
        expect(result.has(ghost)).toBe(false);
    });
});
