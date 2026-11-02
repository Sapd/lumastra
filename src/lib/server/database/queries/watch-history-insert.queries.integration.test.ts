// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Watch History Insert Query Module
 *
 * Tests session-to-history writes and media metadata resolution.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestSeries,
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    insertWatchHistoryFromSession,
    getMediaMetadataForHistory,
} from './watch-history-insert.queries.js';

describe('Watch History Insert Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'watch_history',
            'play_sessions',
            'media_items',
            'external_ids',
        ]);
    });

    async function createPlaySession(
        sessionId: string,
        userId: string,
        mediaId: string,
    ): Promise<void> {
        await sql`
            INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (
                ${sessionId}::uuid,
                ${mediaId}::uuid,
                ${userId},
                'test-device',
                '0.0.0.0'::inet,
                'direct'
            )
        `;
    }

    // ========================================================================
    // insertWatchHistoryFromSession
    // ========================================================================

    describe('insertWatchHistoryFromSession', () => {
        it('inserts a watch history row', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const sessionId = crypto.randomUUID();
            const startTime = new Date();
            const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);

            await createPlaySession(sessionId, userId, mediaId);
            await insertWatchHistoryFromSession(sql, {
                userId,
                mediaId,
                mediaType: 'movie',
                title: 'Test Movie',
                sessionStartTime: startTime,
                sessionEndTime: endTime,
                actualWatchTimeSeconds: 1800,
                maxPositionSeconds: 5400,
                totalRuntimeSeconds: 7200,
                completionPercentage: 75,
                isCompleted: false,
                sourcePlaySessionId: sessionId,
            });

            const rows = await sql<{ id: number }[]>`
                SELECT id FROM watch_history WHERE source_play_session_id = ${sessionId}
            `;
            expect(rows.length).toBe(1);
        });

        it('sets status to completed when isCompleted is true', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const sessionId = crypto.randomUUID();

            await createPlaySession(sessionId, userId, mediaId);
            await insertWatchHistoryFromSession(sql, {
                userId,
                mediaId,
                mediaType: 'movie',
                title: 'Completed Movie',
                sessionStartTime: new Date(),
                sessionEndTime: new Date(),
                actualWatchTimeSeconds: 7200,
                maxPositionSeconds: 7200,
                completionPercentage: 100,
                isCompleted: true,
                sourcePlaySessionId: sessionId,
            });

            const rows = await sql<{ status: string }[]>`
                SELECT status FROM watch_history WHERE source_play_session_id = ${sessionId}
            `;
            expect(rows[0].status).toBe('completed');
        });

        it('sets status to abandoned when isCompleted is false', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const sessionId = crypto.randomUUID();

            await createPlaySession(sessionId, userId, mediaId);
            await insertWatchHistoryFromSession(sql, {
                userId,
                mediaId,
                mediaType: 'movie',
                title: 'Abandoned Movie',
                sessionStartTime: new Date(),
                sessionEndTime: new Date(),
                actualWatchTimeSeconds: 300,
                maxPositionSeconds: 600,
                completionPercentage: 8,
                isCompleted: false,
                sourcePlaySessionId: sessionId,
            });

            const rows = await sql<{ status: string }[]>`
                SELECT status FROM watch_history WHERE source_play_session_id = ${sessionId}
            `;
            expect(rows[0].status).toBe('abandoned');
        });

        it('is idempotent when the same source_play_session_id is reused', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const sessionId = crypto.randomUUID();

            await createPlaySession(sessionId, userId, mediaId);
            await insertWatchHistoryFromSession(sql, {
                userId,
                mediaId,
                mediaType: 'movie',
                title: 'First',
                sessionStartTime: new Date(),
                sessionEndTime: new Date(),
                actualWatchTimeSeconds: 100,
                maxPositionSeconds: 200,
                completionPercentage: 10,
                isCompleted: false,
                sourcePlaySessionId: sessionId,
            });

            await insertWatchHistoryFromSession(sql, {
                userId,
                mediaId,
                mediaType: 'movie',
                title: 'Second',
                sessionStartTime: new Date(),
                sessionEndTime: new Date(),
                actualWatchTimeSeconds: 300,
                maxPositionSeconds: 400,
                completionPercentage: 30,
                isCompleted: false,
                sourcePlaySessionId: sessionId,
            });

            const rows = await sql<{ title: string }[]>`
                SELECT title FROM watch_history WHERE source_play_session_id = ${sessionId}
            `;
            expect(rows.length).toBe(1);
            expect(rows[0].title).toBe('First');
        });
    });

    // ========================================================================
    // getMediaMetadataForHistory
    // ========================================================================

    describe('getMediaMetadataForHistory', () => {
        it('returns metadata for a movie', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 800001,
            });

            const result = await getMediaMetadataForHistory(sql, mediaId);

            expect(result).not.toBeNull();
            expect(result!.media_type).toBe('movie');
            expect(result!.title).toBeTruthy();
            expect(result!.season_number).toBeNull();
            expect(result!.episode_number).toBeNull();
        });

        it('returns metadata for an episode', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [episodeRow] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id IN (
                    SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid
                )
                AND media_type = 'episode'
                LIMIT 1
            `;

            const result = await getMediaMetadataForHistory(sql, episodeRow.id);

            expect(result).not.toBeNull();
            expect(result!.media_type).toBe('episode');
            expect(result!.season_number).not.toBeNull();
            expect(result!.episode_number).not.toBeNull();
            expect(result!.series_name).not.toBeNull();
        });

        it('resolves series_name to the SERIES title, not the season title', async () => {
            // The TV hierarchy is series → season → episode, so an episode's
            // parent is a season ("Season 1"). series_name must walk up to the
            // grandparent series title, not store the season title — otherwise
            // /my-stats shows "Staffel 1" instead of the show name.
            const seriesTitle = `Resolve Series ${crypto.randomUUID().slice(0, 8)}`;
            const series = await createAndInsertTestSeries(sql, {
                title: seriesTitle,
                seasonCount: 1,
                episodesPerSeason: 1,
            });

            // Confirm the fixture really nests the episode under a 'season' row,
            // so the single-join bug would have stored that season's title.
            const [episodeRow] = await sql<{ id: string; season_title: string }[]>`
                SELECT ep.id, season.title AS season_title
                FROM media_items ep
                JOIN media_items season ON season.id = ep.parent_id
                WHERE season.parent_id = ${series.seriesId}::uuid
                    AND ep.media_type = 'episode'
                    AND season.media_type = 'season'
                LIMIT 1
            `;

            const result = await getMediaMetadataForHistory(sql, episodeRow.id);

            expect(result).not.toBeNull();
            expect(result!.series_name).toBe(seriesTitle);
            expect(result!.series_name).not.toBe(episodeRow.season_title);
        });

        it('returns null for non-existent media', async () => {
            const result = await getMediaMetadataForHistory(
                sql,
                '00000000-0000-0000-0000-000000000000',
            );
            expect(result).toBeNull();
        });
    });
});
