// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestDb } from './setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
    createAndInsertTestMusicHierarchy,
} from './fixtures/index.js';
import { truncateTables, TEST_TABLES } from './helpers/cleanup.js';
import { musicInteractionManager } from '$lib/server/services/music-interaction-manager.service.js';
import {
    recordTrackLike,
    recordTrackDislike,
    getTrackFeedback,
    recordTrackSkip,
    recordTrackComplete,
    clearTrackFeedback,
} from '$lib/server/database/queries/music-interactions.queries.js';

import { upsertUserRating } from '$lib/server/database/queries/user-ratings.queries.js';
import { pruneOldListenEvents } from '$lib/server/database/queries/music-tracking.queries.js';
import { PlaySessionLifecycleService } from '$lib/server/services/play-session-lifecycle.service.js';
import * as sessionQueries from '$lib/server/database/queries/play-sessions.queries.js';
import { def as feedbackDef } from '$lib/server/api/defs/user/music/tracks/[id]/feedback.js';
import { def as reportDef } from '$lib/server/api/defs/play-sessions/[id].js';
import { def as beaconDef } from '$lib/server/api/defs/play-sessions/[id]/beacon.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { reapStaleSessions } from '$lib/server/services/play-sessions.service.js';
const lifecycle = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('$lib/server/services/play-session-lifecycle.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/play-session-lifecycle.service.js')>()),
    getPlaySessionLifecycleService: lifecycle.get,
}));

// The database writes are real; cache invalidation is outside this contract.
vi.mock('$lib/server/cache', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/cache')>()),
    cacheInvalidation: { onRatingCacheChanged: vi.fn() },
}));

const sql = getTestDb();
const userId = generateTestUserId();
beforeEach(async () => {
    await truncateTables(sql, [
        ...TEST_TABLES.userData,
        'music_play_starts',
        'music_listen_events',
        'user_music_state',
        'play_sessions',
        ...TEST_TABLES.mediaFiles,
        ...TEST_TABLES.media,
    ]);
    await ensureTestUser(sql, userId);
});

describe('music reporting durable writes', () => {
    it('counts one start per playback session and one terminal report per eventId', async () => {
        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        const track = trackIds[0];
        const eventId = randomUUID();
        await musicInteractionManager.reportSessionStart(sql, userId, track, eventId);
        await musicInteractionManager.reportSessionStart(sql, userId, track, eventId);
        expect(
            await musicInteractionManager.reportPlayEnd(
                userId,
                track,
                1000,
                new Date(),
                200000,
                true,
                undefined,
                eventId,
                false,
                sql,
            ),
        ).toEqual({ duplicate: false });
        expect(
            await musicInteractionManager.reportPlayEnd(
                userId,
                track,
                1000,
                new Date(),
                200000,
                true,
                undefined,
                eventId,
                false,
                sql,
            ),
        ).toEqual({ duplicate: true });
        const [state] =
            await sql`SELECT play_count, skip_count, total_listen_ms FROM user_music_state WHERE user_id = ${userId} AND track_id = ${track}`;
        expect(Number(state.play_count)).toBe(1);
        expect(Number(state.skip_count)).toBe(1);
        expect(Number(state.total_listen_ms)).toBe(1000);
        const events =
            await sql`SELECT event_id FROM music_listen_events WHERE user_id = ${userId} AND event_id = ${eventId}`;
        expect(events).toHaveLength(1);
    });

    it.each(['start-first', 'replay-first'])(
        'deduplicates starts across online/replay paths: %s',
        async (order) => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            const track = trackIds[0];
            const eventId = randomUUID();
            if (order === 'start-first')
                await musicInteractionManager.reportSessionStart(sql, userId, track, eventId);
            await musicInteractionManager.reportPlayEnd(
                userId,
                track,
                1000,
                new Date(),
                200000,
                false,
                undefined,
                eventId,
                true,
                sql,
            );
            if (order === 'replay-first')
                await musicInteractionManager.reportSessionStart(sql, userId, track, eventId);
            const [state] =
                await sql`SELECT play_count FROM user_music_state WHERE user_id = ${userId} AND track_id = ${track}`;
            expect(Number(state.play_count)).toBe(1);
        },
    );

    it('eventId remains idempotent if a retry changes the media id', async () => {
        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
        const eventId = randomUUID();
        expect(
            await musicInteractionManager.reportPlayEnd(
                userId,
                trackIds[0],
                1000,
                new Date(),
                200000,
                false,
                undefined,
                eventId,
                true,
                sql,
            ),
        ).toEqual({ duplicate: false });
        expect(
            await musicInteractionManager.reportPlayEnd(
                userId,
                trackIds[1],
                1000,
                new Date(),
                200000,
                false,
                undefined,
                eventId,
                true,
                sql,
            ),
        ).toEqual({ duplicate: true });
        const states = await sql`SELECT track_id FROM user_music_state WHERE user_id = ${userId}`;
        expect(states).toHaveLength(1);
    });

    it.each(['liked', 'disliked'] as const)(
        'never changes explicit %s on an inferred terminal report',
        async (feedback) => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            const track = trackIds[0];
            await (feedback === 'liked' ? recordTrackLike : recordTrackDislike)(sql, userId, track);
            await musicInteractionManager.reportPlayEnd(
                userId,
                track,
                feedback === 'liked' ? 1000 : 200000,
                new Date(),
                200000,
                feedback === 'liked',
                undefined,
                randomUUID(),
                true,
                sql,
            );
            expect(await getTrackFeedback(sql, userId, track)).toBe(feedback);
            const [row] =
                await sql`SELECT rating, skipped, is_explicit FROM user_ratings WHERE user_id = ${userId} AND media_id = ${track}`;
            expect(row).toMatchObject({
                rating: feedback === 'liked' ? 9 : 2,
                skipped: false,
                is_explicit: true,
            });
        },
    );
    it.each([9, 2])('explicit rating %s replaces an inferred row, survives skip/complete, and can be cleared', async (rating) => {
        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        const track = trackIds[0];
        await recordTrackSkip(sql, userId, track);
        await upsertUserRating.execute(sql, { userId, mediaId: track, rating });
        await recordTrackSkip(sql, userId, track);
        await recordTrackComplete(sql, userId, track);
        const [row] = await sql`SELECT rating, is_explicit FROM user_ratings WHERE user_id = ${userId} AND media_id = ${track}`;
        expect(row).toMatchObject({ rating, is_explicit: true });
        expect(await getTrackFeedback(sql, userId, track)).toBe(rating === 9 ? 'liked' : 'disliked');
        await clearTrackFeedback(sql, userId, track);
        expect(await sql`SELECT 1 FROM user_ratings WHERE user_id = ${userId} AND media_id = ${track}`).toHaveLength(0);
    });
    it.each(['liked', 'disliked'] as const)('explicit feedback PUT %s replaces an inferred row', async (feedback) => {
        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        const track = trackIds[0];
        await recordTrackSkip(sql, userId, track);
        const dbSpy = vi.spyOn(aiDbService, 'getSql').mockResolvedValue(sql);
        try {
            const response = await feedbackDef.handlers.PUT!({
                locals: { user: { userId, username: 'listener', isAgeRestricted: false, userGroups: [] } },
            } as never, { input: { params: { id: track }, body: { feedback } } } as never);
            expect(response.status).toBe(204);
            const [row] = await sql`SELECT rating, is_explicit FROM user_ratings WHERE user_id = ${userId} AND media_id = ${track}`;
            expect(row).toMatchObject({ rating: feedback === 'liked' ? 9 : 2, is_explicit: true });
        } finally { dbSpy.mockRestore(); }
    });

    it('prunes expired start claims with listens, keeping recent claims', async () => {
        const old = randomUUID(), recent = randomUUID();
        await sql`INSERT INTO music_play_starts (user_id, event_id, created_at)
            VALUES (${userId}, ${old}, NOW() - INTERVAL '91 days'), (${userId}, ${recent}, NOW())`;
        await pruneOldListenEvents(sql, 90, 1);
        const rows = await sql`SELECT event_id FROM music_play_starts WHERE user_id = ${userId}`;
        expect(rows).toEqual([{ event_id: recent }]);
    });
    it.each(['PUT', 'beacon'])('real DB: COMPLETED then higher-sequence %s records exactly one listen and play', async (second) => {
        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        const session = await sessionQueries.createPlaySession(sql, {
            surface: 'web', user_id: userId, media_id: trackIds[0], device_id: 'music-report-test',
            ip_address: '127.0.0.1', play_method: 'direct', position_ms: 0, runtime_ms: 200000,
        });
        const service = new PlaySessionLifecycleService({
            getSql: () => sql, queries: sessionQueries,
            watchManager: { reportProgress: vi.fn(), markWatched: vi.fn() },
            watchHistoryService: { recordCompletedSession: vi.fn() },
            getMediaMetadata: vi.fn(),
        });
        vi.spyOn(service as unknown as { cleanupAfterStop(): Promise<void> }, 'cleanupAfterStop').mockResolvedValue();
        lifecycle.get.mockReturnValue(service);
        const dbSpy = vi.spyOn(aiDbService, 'getSql').mockResolvedValue(sql);
        const event = { locals: { user: { userId, username: 'listener' } } } as never;
        const context = (seq: number) => ({ input: { params: { id: session.id }, body: {
            positionMs: 200000, listenedMs: 200000, status: 'COMPLETED', eventSeq: seq, endReason: 'completion',
        } } }) as never;
        try {
            expect((await reportDef.handlers.PUT!(event, context(1))).status).toBe(204);
            const response = second === 'PUT'
                ? await reportDef.handlers.PUT!(event, context(2))
                : await beaconDef.handlers.POST!(event, context(2));
            expect(response.status).toBe(204);
            expect(await sql`SELECT 1 FROM music_listen_events WHERE user_id = ${userId} AND event_id = ${session.id}`).toHaveLength(1);
            const [state] = await sql`SELECT play_count FROM user_music_state WHERE user_id = ${userId} AND track_id = ${trackIds[0]}`;
            expect(Number(state.play_count)).toBe(1);
        } finally { dbSpy.mockRestore(); }
    });

    it('a skip near the end is skipped, never completed', async () => {
        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        const id = randomUUID();
        await musicInteractionManager.reportPlayEnd(userId, trackIds[0], 200000, new Date(), 200000, true, undefined, id, true, sql);
        const [event] = await sql`SELECT was_completed, was_skipped FROM music_listen_events WHERE user_id = ${userId} AND event_id = ${id}`;
        expect(event).toMatchObject({ was_completed: false, was_skipped: true });
        const [state] = await sql`SELECT complete_count, skip_count FROM user_music_state WHERE user_id = ${userId} AND track_id = ${trackIds[0]}`;
        expect(Number(state.complete_count)).toBe(0);
        expect(Number(state.skip_count)).toBe(1);
    });
    it('filters active sessions by owner and media inside the SQL query', async () => {
        const other = generateTestUserId();
        await ensureTestUser(sql, other);
        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
        for (const [owner, track] of [[userId, trackIds[0]], [userId, trackIds[1]], [other, trackIds[0]]] as const) {
            await sessionQueries.createPlaySession(sql, {
                surface: 'web', user_id: owner, media_id: track,
                device_id: randomUUID(), ip_address: '127.0.0.1', play_method: 'direct', position_ms: 0,
            });
        }
        const rows = await sessionQueries.getAllActiveSessionsWithMedia(sql, { userId, itemId: trackIds[0] });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ user_id: userId, media_id: trackIds[0] });
    });
    it('a crashed music session reaped past the completion bar still records the listen and the completion', async () => {
        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        const session = await sessionQueries.createPlaySession(sql, {
            surface: 'web', user_id: userId, media_id: trackIds[0], device_id: 'music-reap-test',
            ip_address: '127.0.0.1', play_method: 'direct', position_ms: 0, runtime_ms: 200000,
        });
        await musicInteractionManager.reportSessionStart(sql, userId, trackIds[0], session.id);
        await sql`UPDATE play_sessions SET position_ms = 190000, last_heartbeat_at = NOW() - INTERVAL '3 hours',
            last_seen_at = NOW() - INTERVAL '3 hours' WHERE id = ${session.id}`;
        const service = new PlaySessionLifecycleService({
            getSql: () => sql, queries: sessionQueries,
            watchManager: { reportProgress: vi.fn(), markWatched: vi.fn() },
            watchHistoryService: { recordCompletedSession: vi.fn() },
            getMediaMetadata: vi.fn(),
        });
        vi.spyOn(service as unknown as { cleanupAfterStop(): Promise<void> }, 'cleanupAfterStop').mockResolvedValue();
        lifecycle.get.mockReturnValue(service);
        expect(await reapStaleSessions(sql)).toMatchObject({ completed: 1 });
        const [event] = await sql`SELECT duration_ms, was_completed FROM music_listen_events WHERE user_id = ${userId} AND event_id = ${session.id}`;
        expect(event).toMatchObject({ duration_ms: 190000, was_completed: true });
        const [state] = await sql`SELECT complete_count, total_listen_ms FROM user_music_state WHERE user_id = ${userId} AND track_id = ${trackIds[0]}`;
        expect(Number(state.complete_count)).toBe(1);
        expect(Number(state.total_listen_ms)).toBe(190000);
    });

});
