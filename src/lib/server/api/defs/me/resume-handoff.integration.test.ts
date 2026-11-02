// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /me/resume-handoff against a real PostgreSQL database.
 *
 * Sessions start through the real `startPlaySession` (so `entry` → linearity
 * is the production path), heartbeats go through the real play-session
 * lifecycle, and the endpoint def answers. Only ffprobe and the path resolver
 * are stubbed. The TV is simply a second device id of the same user.
 *
 * Run: npm run test:integration -- src/lib/server/api/defs/me/resume-handoff.integration.test.ts
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type postgres from 'postgres';

vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn(async (path: string) => ({ isAccessible: true, containerPath: path })),
}));
vi.mock('$lib/server/utils/ffprobe.js', () => ({
    containerFromExtension: () => 'mp4',
    probeMediaFile: vi.fn(async () => ({
        success: true,
        duration: 2400,
        formatBitrate: 4_000_000,
        video: {
            codec: 'h264',
            width: 1920,
            height: 1080,
            bitrate: 4_000_000,
            hdr: 'sdr',
            pixelFormat: 'yuv420p',
            profile: 'High',
            level: 41,
        },
        audioStreams: [
            {
                audioRelativeIndex: 0,
                absoluteIndex: 1,
                codec: 'aac',
                channels: 2,
                language: 'eng',
                title: null,
                isDefault: true,
            },
        ],
        subtitleStreams: [],
    })),
}));

import { getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../tests/integration/fixtures/user.fixtures.js';
import { PlaybackStartRequestSchema } from '$lib/schemas/playback-start.js';
import { ResumeHandoffQuerySchema } from '$lib/schemas/resume-handoff.js';
import { startPlaySession, isPolicyError } from '$lib/server/services/play-sessions.service.js';
import { connectValkey } from '$lib/server/cache/valkey.js';
import * as playSessionsQueries from '$lib/server/database/queries/play-sessions.queries.js';
import { getMediaMetadataForHistory } from '$lib/server/database/queries/watch-history-insert.queries.js';
import {
    appendEventAndRebuild,
    appendEventAndRebuildWithOutcome,
} from '$lib/server/services/watch-state-rebuilder.service.js';
import { watchHistoryService } from '$lib/server/services/watch-history.service.js';
import { playbackTelemetryService } from '$lib/server/services/playback-telemetry.service.js';
import {
    PlaySessionLifecycleService,
    type WatchManagerLike,
} from '$lib/server/services/play-session-lifecycle.service.js';
import { MIN_ENGAGEMENT_MS } from '$lib/server/utils/watch-constants.js';
import * as mediaAccess from '$lib/server/middleware/media-access.js';
import { def } from './resume-handoff.js';

const SERIES_ID = randomUUID();
const SEASON_ID = randomUUID();
const EP_A = randomUUID();
const EP_B = randomUUID();
const EP_C = randomUUID();
const RUNTIME_MS = 40 * 60_000;
const TAB = `dashboard-${randomUUID()}`;
const TV = `appletv-${randomUUID()}`;

type Entry = 'continue' | 'next_up' | 'autoplay' | 'resume' | 'explicit';

describe('GET /me/resume-handoff (integration)', () => {
    let sql: postgres.Sql;
    let lifecycle: PlaySessionLifecycleService;
    const userId = generateTestUserId();
    const otherUserId = generateTestUserId();
    const seqs = new Map<string, number>();

    function watchManager(): WatchManagerLike {
        return {
            async reportProgress(params, txSql?) {
                return appendEventAndRebuildWithOutcome(txSql ?? sql, {
                    user_id: params.userId,
                    media_id: params.mediaId,
                    event_type: 'progress',
                    source: 'lumastra-player',
                    position_ms: params.positionMs,
                    runtime_ms: params.runtimeMs ?? null,
                    source_event_id: null,
                    session_id: params.sessionId,
                    event_seq: params.eventSeq,
                    session_elapsed_ms: params.sessionElapsedMs ?? null,
                    occurred_at: new Date().toISOString(),
                    session_started_at: params.sessionStartedAt?.toISOString() ?? null,
                });
            },
            async markWatched(params, txSql) {
                await appendEventAndRebuild(txSql ?? sql, {
                    user_id: params.userId,
                    media_id: params.mediaId,
                    event_type: 'mark_watched',
                    source: 'lumastra-user-mark',
                    position_ms: null,
                    runtime_ms: null,
                    source_event_id: null,
                    session_id: null,
                    event_seq: null,
                    occurred_at: new Date().toISOString(),
                });
            },
        };
    }

    beforeAll(async () => {
        sql = getTestDb();
        expect(await connectValkey()).toBe(true);
        await ensureTestUser(sql, userId);
        await ensureTestUser(sql, otherUserId);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${SERIES_ID}::uuid, 'Harbour Lights', 'tv', 'active', true)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, season_number, has_files)
            VALUES (${SEASON_ID}::uuid, 'Season 1', 'season', 'active', ${SERIES_ID}::uuid, 1, true)
        `;
        for (const [id, n] of [
            [EP_A, 1],
            [EP_B, 2],
            [EP_C, 3],
        ] as const) {
            await sql`
                INSERT INTO media_items
                    (id, title, media_type, status, parent_id, season_number, episode_number,
                     runtime_seconds, has_files)
                VALUES (${id}::uuid, ${`Tide ${n}`}, 'episode', 'active', ${SEASON_ID}::uuid, 1, ${n},
                        ${RUNTIME_MS / 1000}, true)
            `;
            const fileId = randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, duration_seconds, file_size_bytes)
                VALUES (${fileId}::uuid, ${`/fixture/handoff/e${n}.mp4`}, ${RUNTIME_MS / 1000}, 1000)
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${fileId}::uuid, ${id}::uuid, true, 0)
            `;
        }
        lifecycle = new PlaySessionLifecycleService({
            watchManager: watchManager(),
            watchHistoryService,
            queries: playSessionsQueries,
            getMediaMetadata: getMediaMetadataForHistory,
            getSql: () => sql,
        });
    });

    afterEach(async () => {
        // Superseding/stopping starts delayed quality work that must finish
        // before the next test (or afterAll) deletes its sessions.
        await playbackTelemetryService.settleBackgroundWork();
        await playbackTelemetryService.flush();
    });

    beforeEach(async () => {
        await sql`DELETE FROM hls_playback_tokens WHERE user_id IN (${userId}::uuid, ${otherUserId}::uuid)`;
        await sql`DELETE FROM play_sessions WHERE user_id IN (${userId}::uuid, ${otherUserId}::uuid)`;
        await sql`DELETE FROM user_media_events WHERE user_id = ${userId}::uuid`;
        await sql`DELETE FROM user_media_state WHERE user_id = ${userId}::uuid`;
        await sql`DELETE FROM watch_history WHERE user_id = ${userId}::uuid`;
        seqs.clear();
    });

    afterAll(async () => {
        const items = [EP_A, EP_B, EP_C, SEASON_ID, SERIES_ID];
        for (const u of [userId, otherUserId]) {
            await sql`DELETE FROM hls_playback_tokens WHERE user_id = ${u}::uuid`;
            await sql`DELETE FROM play_sessions WHERE user_id = ${u}::uuid`;
            await sql`DELETE FROM user_media_events WHERE user_id = ${u}::uuid`;
            await sql`DELETE FROM user_media_state WHERE user_id = ${u}::uuid`;
            await sql`DELETE FROM watch_history WHERE user_id = ${u}::uuid`;
        }
        await sql`
            DELETE FROM media_files WHERE id IN (
                SELECT file_id FROM media_file_items WHERE media_item_id IN ${sql(items)}
            )
        `;
        await sql`DELETE FROM media_items WHERE id IN ${sql(items)}`;
        for (const u of [userId, otherUserId]) {
            await sql`DELETE FROM user_profiles WHERE user_id = ${u}::uuid`;
            await sql`DELETE FROM users WHERE id = ${u}::uuid`;
        }
    });

    async function start(
        mediaId: string,
        deviceId: string,
        entry?: Entry,
        opts: { who?: string; startPositionMs?: number } = {},
    ): Promise<string> {
        const started = await startPlaySession(
            sql,
            (opts.who ?? userId) as typeof userId,
            'handoff-user',
            '127.0.0.1',
            PlaybackStartRequestSchema.parse({
                mediaId,
                deviceId,
                clientInfo: { name: deviceId === TV ? 'Living room' : 'Browser' },
                capabilities: {
                    containers: ['mp4', 'ts'],
                    videoCodecs: ['h264'],
                    audioCodecs: ['aac'],
                    subtitleFormats: ['vtt'],
                },
                ...(entry ? { entry } : {}),
                ...(opts.startPositionMs !== undefined
                    ? { startPositionMs: opts.startPositionMs }
                    : {}),
            }),
            'native_app',
            { surface: 'v1' },
        );
        if (isPolicyError(started) || 'status' in started) {
            throw new Error(`start failed: ${JSON.stringify(started)}`);
        }
        // Keep each session start in its own millisecond window.
        await new Promise((r) => setTimeout(r, 15));
        return started.playbackSessionId;
    }

    async function beat(sessionId: string, status: 'ACTIVE' | 'PAUSED', positionMs: number) {
        const seq = (seqs.get(sessionId) ?? 0) + 1;
        seqs.set(sessionId, seq);
        await lifecycle.update(sessionId, {
            status,
            position_ms: positionMs,
            event_seq: seq,
            session_elapsed_ms: MIN_ENGAGEMENT_MS + seq * 1000,
        });
        await new Promise((r) => setTimeout(r, 15));
    }

    async function stop(sessionId: string, positionMs: number) {
        const seq = (seqs.get(sessionId) ?? 0) + 1;
        seqs.set(sessionId, seq);
        await lifecycle.update(sessionId, {
            status: 'COMPLETED',
            position_ms: positionMs,
            event_seq: seq,
            session_elapsed_ms: MIN_ENGAGEMENT_MS + 60_000,
        });
        await new Promise((r) => setTimeout(r, 15));
    }

    /** The tab asks: it shows `mediaId` at `positionMs`, last acted at `lastActionAt`. */
    async function handoff(
        mediaId: string,
        positionMs: number,
        lastActionAt: number,
        who = userId,
    ) {
        const event = {
            locals: { user: { userId: who, username: 'handoff-user', userGroups: [] } },
        } as never;
        const ctx = {
            surface: 'v1',
            input: {
                query: ResumeHandoffQuerySchema.parse({
                    mediaId,
                    positionMs: String(positionMs),
                    deviceId: TAB,
                    idleMs: String(Date.now() - lastActionAt),
                }),
            },
        } as never;
        const res = await def.handlers.GET!(event, ctx);
        expect(res.status).toBe(200);
        return (await res.json()) as { handoff?: Record<string, unknown> };
    }

    /** Tab: episode A from Continue Watching, watched to 10:00, paused. Returns the pause time. */
    async function pausedTab(): Promise<number> {
        const tab = await start(EP_A, TAB, 'continue');
        await beat(tab, 'ACTIVE', 10 * 60_000);
        await beat(tab, 'PAUSED', 10 * 60_000);
        const pausedAt = Date.now();
        await new Promise((r) => setTimeout(r, 15));
        return pausedAt;
    }

    /** TV: resumes A where the tab stood (no start position = durable resume), plays on. */
    async function tvResumesA(toMs: number, entry: Entry = 'continue'): Promise<string> {
        const tv = await start(EP_A, TV, entry);
        await beat(tv, 'ACTIVE', toMs);
        await beat(tv, 'PAUSED', toMs);
        return tv;
    }

    it('records entry, start position and furthest position', async () => {
        const s = await start(EP_A, TAB, 'next_up', { startPositionMs: 90_000 });
        const explicit = await start(EP_B, TV, 'explicit');
        await beat(s, 'ACTIVE', 300_000);
        await beat(s, 'ACTIVE', 200_000);
        const rows = await sql<
            {
                id: string;
                entry_mode: string | null;
                start_position_ms: string;
                high_water_ms: string;
            }[]
        >`
            SELECT id::text, entry_mode, start_position_ms, high_water_ms FROM play_sessions
            WHERE id IN (${s}::uuid, ${explicit}::uuid)
        `;
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(s)).toMatchObject({ entry_mode: 'next_up' });
        expect(Number(byId.get(s)!.start_position_ms)).toBe(90_000);
        expect(Number(byId.get(s)!.high_water_ms)).toBe(300_000);
        expect(byId.get(explicit)).toMatchObject({ entry_mode: 'explicit' });
    });

    it('same episode: the paused tab catches up to where the TV paused', async () => {
        const pausedAt = await pausedTab();
        await tvResumesA(25 * 60_000);

        const body = await handoff(EP_A, 10 * 60_000, pausedAt);
        expect(body.handoff).toMatchObject({
            mediaId: EP_A,
            positionMs: 25 * 60_000,
            relation: 'same_media',
            sameFileAsFrom: false,
            deviceName: 'Living room',
        });
        expect(typeof body.handoff!.chainId).toBe('string');
    });

    it('same episode: slow access queries do not move the last-action cutoff', async () => {
        const pausedAt = await pausedTab();
        await tvResumesA(25 * 60_000);
        const checkMediaAccess = mediaAccess.checkMediaAccess;
        const access = vi.spyOn(mediaAccess, 'checkMediaAccess');
        // Advance just the wall clock after the real access query finishes.
        // This models a loaded DB without sleeping or changing its result.
        vi.useFakeTimers({ toFake: ['Date'] });
        access.mockImplementationOnce(async (...args) => {
            const allowed = await checkMediaAccess(...args);
            vi.setSystemTime(Date.now() + 60_000);
            return allowed;
        });
        try {
            expect((await handoff(EP_A, 10 * 60_000, pausedAt)).handoff).toMatchObject({
                mediaId: EP_A,
                positionMs: 25 * 60_000,
                relation: 'same_media',
                deviceName: 'Living room',
            });
        } finally {
            access.mockRestore();
            vi.useRealTimers();
        }
    });

    it('autoplay into the next episode: the tab goes to episode B at its position', async () => {
        const pausedAt = await pausedTab();
        const tvA = await tvResumesA(RUNTIME_MS - 20_000);
        await stop(tvA, RUNTIME_MS - 20_000);
        const tvB = await start(EP_B, TV, 'autoplay');
        await beat(tvB, 'ACTIVE', 7 * 60_000);
        await beat(tvB, 'PAUSED', 7 * 60_000);

        expect((await handoff(EP_A, 10 * 60_000, pausedAt)).handoff).toMatchObject({
            mediaId: EP_B,
            positionMs: 7 * 60_000,
            relation: 'later_episode',
            seasonNumber: 1,
            episodeNumber: 2,
            chainId: tvA,
        });
    });

    it('TV finished episode A and stopped: the tab goes to episode B at 0', async () => {
        const pausedAt = await pausedTab();
        const tvA = await tvResumesA(RUNTIME_MS - 20_000);
        await stop(tvA, RUNTIME_MS - 20_000);

        expect((await handoff(EP_A, 10 * 60_000, pausedAt)).handoff).toMatchObject({
            mediaId: EP_B,
            positionMs: 0,
            relation: 'later_episode',
        });
    });

    it('two weeks later, three episodes on: the forgotten tab still follows', async () => {
        const pausedAt = await pausedTab();
        const tvA = await tvResumesA(RUNTIME_MS - 20_000);
        await stop(tvA, RUNTIME_MS - 20_000);
        const tvB = await start(EP_B, TV, 'autoplay');
        await beat(tvB, 'ACTIVE', RUNTIME_MS - 20_000);
        await stop(tvB, RUNTIME_MS - 20_000);
        const tvC = await start(EP_C, TV, 'autoplay');
        await beat(tvC, 'ACTIVE', 12 * 60_000);
        await beat(tvC, 'PAUSED', 12 * 60_000);
        // Everything happened two weeks ago.
        const shift = '14 days';
        await sql`
            UPDATE play_sessions SET started_at = started_at - ${shift}::interval
            WHERE user_id = ${userId}::uuid
        `;
        await sql`
            UPDATE user_media_events SET occurred_at = occurred_at - ${shift}::interval
            WHERE user_id = ${userId}::uuid
        `;

        expect(
            (await handoff(EP_A, 10 * 60_000, pausedAt - 14 * 24 * 60 * 60_000)).handoff,
        ).toMatchObject({ mediaId: EP_C, positionMs: 12 * 60_000, relation: 'later_episode' });
    });

    it('an explicit TV session (an episode pick) never hands off', async () => {
        const pausedAt = await pausedTab();
        await tvResumesA(25 * 60_000, 'explicit');

        expect((await handoff(EP_A, 10 * 60_000, pausedAt)).handoff).toBeUndefined();
    });

    it('a TV session without an entry (a client that names none) never hands off', async () => {
        const pausedAt = await pausedTab();
        const tv = await start(EP_A, TV);
        await beat(tv, 'ACTIVE', 25 * 60_000);

        expect((await handoff(EP_A, 10 * 60_000, pausedAt)).handoff).toBeUndefined();
    });

    it('a TV that started somewhere else in the episode is not a continuation', async () => {
        const pausedAt = await pausedTab();
        const tv = await start(EP_A, TV, 'continue', { startPositionMs: 30 * 60_000 });
        await beat(tv, 'ACTIVE', 33 * 60_000);

        expect((await handoff(EP_A, 10 * 60_000, pausedAt)).handoff).toBeUndefined();
    });

    it('the TV picking a later episode while A is unfinished does not move the tab', async () => {
        const pausedAt = await pausedTab();
        const tv = await start(EP_C, TV, 'next_up');
        await beat(tv, 'ACTIVE', 5 * 60_000);

        expect((await handoff(EP_A, 10 * 60_000, pausedAt)).handoff).toBeUndefined();
    });

    it('a TV rewound below its furthest point is not followed until it passes it again', async () => {
        const pausedAt = await pausedTab();
        const tv = await tvResumesA(25 * 60_000);
        await beat(tv, 'ACTIVE', 20 * 60_000);
        await beat(tv, 'PAUSED', 20 * 60_000);
        expect((await handoff(EP_A, 10 * 60_000, pausedAt)).handoff).toBeUndefined();

        await beat(tv, 'ACTIVE', 26 * 60_000);
        await beat(tv, 'PAUSED', 26 * 60_000);
        expect((await handoff(EP_A, 10 * 60_000, pausedAt)).handoff).toMatchObject({
            positionMs: 26 * 60_000,
        });
    });

    it('the tab acted after the TV started: no handoff', async () => {
        await pausedTab();
        await tvResumesA(25 * 60_000);

        expect((await handoff(EP_A, 10 * 60_000, Date.now())).handoff).toBeUndefined();
    });

    it("another user's sessions never count", async () => {
        const pausedAt = await pausedTab();
        const other = await start(EP_A, TV, 'continue', {
            who: otherUserId,
            startPositionMs: 10 * 60_000,
        });
        await lifecycle.update(other, {
            status: 'ACTIVE',
            position_ms: 25 * 60_000,
            event_seq: 1,
            session_elapsed_ms: MIN_ENGAGEMENT_MS + 1000,
        });

        expect((await handoff(EP_A, 10 * 60_000, pausedAt)).handoff).toBeUndefined();
    });

    it('the superseded heartbeat names the device that took over', async () => {
        const tab = await start(EP_A, TAB, 'continue');
        await beat(tab, 'ACTIVE', 10 * 60_000);
        await tvResumesA(25 * 60_000);
        const { getTakeoverDeviceName } =
            await import('$lib/server/database/queries/resume-handoff.queries.js');
        expect(await getTakeoverDeviceName(sql, userId, EP_A, tab)).toBe('Living room');
    });
});
