// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    createAndInsertTestMusicHierarchy,
    ensureTestUser,
    generateTestUserId,
} from '../../../../tests/integration/fixtures/index.js';
import * as queries from '../database/queries/play-sessions.queries.js';
import { getHotThisWeek } from '../database/queries/music-quick-picks.queries.js';
import { getWatchHistoryStats } from '../database/queries/integration-watch-history.queries.js';
import { getMusicState } from '../database/queries/music-tracking.queries.js';
import { PlaySessionLifecycleService } from './play-session-lifecycle.service.js';
import { musicInteractionManager } from './music-interaction-manager.service.js';
import { aiDbService } from './database.service.js';

describe('music first positive heard time', () => {
    let sql: postgres.Sql;
    let trackId: string;
    const userId = generateTestUserId();
    let service: PlaySessionLifecycleService;
    beforeAll(async () => {
        sql = getTestDb();
        await ensureTestUser(sql, userId);
        ({
            trackIds: [trackId],
        } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 }));
        vi.spyOn(aiDbService, 'getSql').mockResolvedValue(sql);
        service = new PlaySessionLifecycleService({
            queries,
            getSql: () => sql,
            watchManager: { reportProgress: vi.fn(), markWatched: vi.fn() },
            watchHistoryService: { recordCompletedSession: vi.fn() },
            getMediaMetadata: async () => null,
        });
    });
    beforeEach(async () => {
        await sql`DELETE FROM user_music_state WHERE user_id = ${userId}`;
        await sql`DELETE FROM music_listen_events WHERE user_id = ${userId}`;
    });
    afterAll(async () => {
        vi.restoreAllMocks();
        await closeTestDb();
    });
    const allocate = () =>
        queries.createPlaySession(sql, {
            user_id: userId,
            media_id: trackId,
            device_id: randomUUID(),
            position_ms: 0,
            surface: 'web',
            ip_address: '127.0.0.1',
            play_method: 'direct',
            runtime_ms: 200000,
        });
    const report = (
        id: string,
        seq: number,
        heard: number,
        status: 'ACTIVE' | 'COMPLETED' = 'ACTIVE',
    ) =>
        service.update(id, {
            position_ms: 190000,
            status,
            event_seq: seq,
            session_elapsed_ms: heard,
            listened_ms: heard,
            end_reason: status === 'COMPLETED' ? 'completion' : undefined,
        });
    it('allocation, prefetch abandonment and completion before hearing count zero', async () => {
        const session = await allocate();
        expect(await getMusicState(sql, userId, trackId)).toBeNull();
        await report(session.id, 1, 0);
        await report(session.id, 2, 0, 'COMPLETED');
        expect((await getMusicState(sql, userId, trackId))?.play_count ?? 0).toBe(0);
    });
    it('first positive live report counts once across live, completion and replay retries', async () => {
        const session = await allocate();
        await report(session.id, 1, 0);
        await report(session.id, 2, 1);
        await report(session.id, 2, 1);
        expect((await getMusicState(sql, userId, trackId))?.play_count).toBe(1);
        await report(session.id, 3, 2000);
        await report(session.id, 4, 3000, 'COMPLETED');
        await report(session.id, 4, 3000, 'COMPLETED');
        const replay = await musicInteractionManager.reportPlayEnd(
            userId,
            trackId,
            3000,
            session.started_at,
            200000,
            false,
            undefined,
            session.id,
            true,
            sql,
        );
        expect(replay.duplicate).toBe(true);
        const state = await getMusicState(sql, userId, trackId);
        expect(state?.play_count).toBe(1);
        expect(Number(state?.total_listen_ms)).toBe(3000);
    });
    it('a first positive completion or offline replay counts once', async () => {
        const session = await allocate();
        await report(session.id, 1, 2000, 'COMPLETED');
        const id = randomUUID();
        for (let retry = 0; retry < 2; retry++) {
            await musicInteractionManager.reportPlayEnd(
                userId,
                trackId,
                1000,
                new Date(),
                200000,
                false,
                undefined,
                id,
                true,
                sql,
            );
        }
        const state = await getMusicState(sql, userId, trackId);
        expect(state?.play_count).toBe(2);
        expect(Number(state?.total_listen_ms)).toBe(3000);
    });
    it('server-side completion preserves the reported heard total, never the seeked position', async () => {
        const session = await allocate();
        await report(session.id, 1, 2000);
        await service.update(session.id, {
            position_ms: 190000,
            status: 'COMPLETED',
            event_seq: 2,
            session_elapsed_ms: 0,
            end_reason: 'completion',
        });
        const state = await getMusicState(sql, userId, trackId);
        expect(state?.play_count).toBe(1);
        expect(Number(state?.total_listen_ms)).toBe(2000);
    });
    it('zero-heard offline replay never creates a play', async () => {
        await musicInteractionManager.reportPlayEnd(
            userId,
            trackId,
            0,
            new Date(),
            200000,
            false,
            undefined,
            randomUUID(),
            true,
            sql,
        );
        expect((await getMusicState(sql, userId, trackId))?.play_count ?? 0).toBe(0);
    });
    const replayItem = (
        session: { id: string; started_at: Date | string },
        claim?: { id?: string; skipIfStartNear?: boolean },
    ) =>
        musicInteractionManager.reportPlayEnd(
            userId,
            trackId,
            3000,
            session.started_at,
            200000,
            false,
            undefined,
            randomUUID(),
            true,
            sql,
            claim,
        );
    it('a replay with its own eventId and the live playbackSessionId does not count twice', async () => {
        const session = await allocate();
        await report(session.id, 1, 2000);
        expect((await getMusicState(sql, userId, trackId))?.play_count).toBe(1);
        await replayItem(session, { id: session.id, skipIfStartNear: true });
        expect((await getMusicState(sql, userId, trackId))?.play_count).toBe(1);
    });
    it('without a playbackSessionId a reported start near startedAt also blocks a second count', async () => {
        const session = await allocate();
        await report(session.id, 1, 2000);
        await replayItem(session, { skipIfStartNear: true });
        expect((await getMusicState(sql, userId, trackId))?.play_count).toBe(1);
        // Control: no live start reported -> the replay counts.
        await sql`DELETE FROM music_play_starts WHERE user_id = ${userId}`;
        await sql`DELETE FROM user_music_state WHERE user_id = ${userId}`;
        await replayItem(session, { skipIfStartNear: true });
        expect((await getMusicState(sql, userId, trackId))?.play_count).toBe(1);
    });
    it('zero-heard prefetch cancelled leaves no quick pick, no window count and no play_count', async () => {
        const session = await allocate();
        await report(session.id, 1, 0, 'COMPLETED');
        await musicInteractionManager.reportPlayEnd(
            userId,
            trackId,
            0,
            new Date(),
            200000,
            false,
            undefined,
            randomUUID(),
            false,
            sql,
        );
        expect((await getMusicState(sql, userId, trackId))?.play_count ?? 0).toBe(0);
        expect((await getHotThisWeek(sql, userId, 7, 40)).some((r) => r.id === trackId)).toBe(
            false,
        );
        const stats = await getWatchHistoryStats(
            sql,
            userId,
            { deniedGroupIds: null, ageRating: null },
            7,
        );
        expect(stats.tracks_played_in_window).toBe(0);
    });
    it('control: a positive listen does count in the window', async () => {
        const session = await allocate();
        await report(session.id, 1, 3000, 'COMPLETED');
        const stats = await getWatchHistoryStats(
            sql,
            userId,
            { deniedGroupIds: null, ageRating: null },
            7,
        );
        expect(stats.tracks_played_in_window).toBe(1);
        expect((await getHotThisWeek(sql, userId, 7, 40)).some((r) => r.id === trackId)).toBe(true);
    });
});
