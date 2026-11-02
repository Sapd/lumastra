// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One playback session completes an item once.
 *
 * The player keeps sending heartbeats after the completion threshold (credits,
 * a paused end screen, a tab left open), and `reportProgress` used to append a
 * `completed` for every one of them — each a +1 on watch_count. Prod
 * 2026-09-30: 17,683 of 19,126 player completions were such repeats; one
 * session wrote 1,657. A new session is a real rewatch and still counts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import * as eventQueries from '../database/queries/user-media-events.queries.js';
import { randomUUID } from 'node:crypto';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { watchManager } from './watch-manager.service.js';
import { appendEventAndRebuild } from './watch-state-rebuilder.service.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

const RUNTIME_MS = 5_400_000;

describe.skipIf(SKIP_TESTS)('watchManager.reportProgress — completion once per session', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_events',
            'user_media_state',
            'user_media_flags',
            'media_items',
            'external_ids',
            'user_profiles',
        ]);
    });

    it('counts a session that keeps beating through the credits once, and a new session again', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { id: mediaId } = await createAndInsertTestMovie(sql, { title: 'Long Credits' });

        const play = async (sessionId: string, beats: number): Promise<void> => {
            for (let i = 0; i < beats; i++) {
                await watchManager.reportProgress(
                    {
                        userId,
                        mediaId,
                        positionMs: RUNTIME_MS - 300_000 + i * 30_000,
                        runtimeMs: RUNTIME_MS,
                        sessionId,
                        eventSeq: i + 1,
                        mediaType: 'movie',
                    },
                    sql,
                );
            }
        };

        const completions = async (): Promise<number> => {
            const [{ n }] = await sql<Array<{ n: number }>>`
                SELECT count(*)::int AS n FROM user_media_events
                WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
                  AND event_type = 'completed'
            `;
            return n;
        };
        const watchCount = async (): Promise<number> => {
            const [row] = await sql<Array<{ watch_count: number }>>`
                SELECT watch_count FROM user_media_state
                WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
            `;
            return row.watch_count;
        };

        await play(randomUUID(), 8);
        expect(await completions()).toBe(1);
        expect(await watchCount()).toBe(1);

        await play(randomUUID(), 3);
        expect(await completions()).toBe(2);
        expect(await watchCount()).toBe(2);
    });

    it.each([false, true])(
        'collapses overlapping threshold reports (progress keys: %s)',
        async (keyedProgress) => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                title: 'Concurrent Completion',
            });
            const sessionId = randomUUID();
            const connections = [0, 1].map(() =>
                postgres(process.env.TEST_DATABASE_URL!, { max: 1 }),
            );
            // Both progress guards must read before either inserts, so connection
            // scheduling cannot turn one report into stale_seq and strand the
            // completion barrier below.
            const originalLatest = eventQueries.getLatestLumastraSessionInfo.one;
            let progressArrivals = 0;
            let releaseProgress!: () => void;
            const progressBarrier = new Promise<void>((resolve) => {
                releaseProgress = resolve;
            });
            const progressSpy = vi
                .spyOn(eventQueries.getLatestLumastraSessionInfo, 'one')
                .mockImplementation(async (db, params) => {
                    const current = await originalLatest(db, params);
                    if (++progressArrivals === 2) releaseProgress();
                    await progressBarrier;
                    return current;
                });
            const original = eventQueries.hasSessionCompletion;
            let arrivals = 0;
            let release!: () => void;
            const barrier = new Promise<void>((resolve) => {
                release = resolve;
            });
            const spy = vi
                .spyOn(eventQueries, 'hasSessionCompletion')
                .mockImplementation(async (db, params) => {
                    const found = await original(db, params);
                    if (++arrivals === 2) release();
                    await barrier;
                    return found;
                });
            try {
                await Promise.all(
                    connections.map((db, i) =>
                        watchManager.reportProgress(
                            {
                                userId,
                                mediaId,
                                sessionId,
                                eventSeq: i + 1,
                                sourceEventId: keyedProgress ? `progress:${i}` : undefined,
                                positionMs: RUNTIME_MS - 60_000,
                                runtimeMs: RUNTIME_MS,
                                mediaType: 'movie',
                            },
                            db,
                        ),
                    ),
                );
                expect(arrivals).toBe(2);
                const [{ n }] = await sql<{ n: number }[]>`
                SELECT count(*)::int n FROM user_media_events
                WHERE media_id = ${mediaId} AND event_type = 'completed'
            `;
                expect(n).toBe(1);
                const [state] = await sql<{ watch_count: number }[]>`
                SELECT watch_count FROM user_media_state WHERE user_id = ${userId} AND media_id = ${mediaId}
            `;
                expect(state.watch_count).toBe(1);
            } finally {
                progressSpy.mockRestore();
                spy.mockRestore();
                await Promise.all(connections.map((db) => db.end()));
            }
        },
    );

    it.each(['season', 'series'] as const)(
        'bulk %s marks preserve already watched episodes',
        async (kind) => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const seriesId = randomUUID();
            const seasonId = randomUUID();
            const episodeIds = [randomUUID(), randomUUID()];
            await sql`INSERT INTO media_items (id, title, media_type, status) VALUES (${seriesId}, 'Series', 'tv', 'active')`;
            await sql`INSERT INTO media_items (id, title, media_type, status, parent_id, season_number)
            VALUES (${seasonId}, 'Season', 'season', 'active', ${seriesId}, 1)`;
            for (const [i, id] of episodeIds.entries()) {
                await sql`INSERT INTO media_items (id, title, media_type, status, parent_id, season_number, episode_number)
                VALUES (${id}, 'Episode', 'episode', 'active', ${seasonId}, 1, ${i + 1})`;
            }
            const watchedAt = '2026-01-01T12:00:00.000Z';
            await appendEventAndRebuild(sql, {
                user_id: userId,
                media_id: episodeIds[0],
                event_type: 'mark_watched',
                source: 'lumastra-user-mark',
                position_ms: null,
                runtime_ms: null,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: watchedAt,
            });
            if (kind === 'series') await watchManager.markSeriesWatched({ userId, seriesId }, sql);
            else
                await watchManager.markSeasonWatched(
                    { userId, seriesId, seasonNumber: 1, seasonMediaId: seasonId },
                    sql,
                );
            const states = await sql<
                { media_id: string; watch_count: number; last_watched_at: Date }[]
            >`
            SELECT media_id, watch_count, last_watched_at FROM user_media_state
            WHERE user_id = ${userId} AND media_id = ANY(${episodeIds})
        `;
            expect(states).toHaveLength(2);
            expect(states.every((state) => state.watch_count === 1)).toBe(true);
            expect(
                states
                    .find((state) => state.media_id === episodeIds[0])
                    ?.last_watched_at.toISOString(),
            ).toBe(watchedAt);
        },
    );

    it('a player rewatch after the user marked it unwatched marks it watched again', async () => {
        // CI 2026-10-02: the older lumastra-user-mark mark_unwatched (priority
        // 100) outranked the newer lumastra-player completion (90), so a full
        // rewatch in the player left the item unwatched.
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const { id: mediaId } = await createAndInsertTestMovie(sql, { title: 'Rewatch' });

        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'mark_unwatched',
            source: 'lumastra-user-mark',
            position_ms: null,
            runtime_ms: null,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date(Date.now() - 5_000).toISOString(),
        });
        await watchManager.reportProgress(
            {
                userId,
                mediaId,
                positionMs: RUNTIME_MS - 60_000,
                runtimeMs: RUNTIME_MS,
                sessionId: randomUUID(),
                eventSeq: 1,
                mediaType: 'movie',
            },
            sql,
        );

        const [row] = await sql<
            Array<{
                is_watched: boolean;
                watch_count: number;
                resume_position_ms: number;
                last_watched_at: Date | null;
            }>
        >`
            SELECT is_watched, watch_count, resume_position_ms, last_watched_at
            FROM user_media_state
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
        `;
        expect(row.is_watched).toBe(true);
        expect(row.watch_count).toBe(1);
        // Not the Continue Watching flood shape (watched + resume + no last_watched_at).
        expect(row.last_watched_at).not.toBeNull();
    });
});
