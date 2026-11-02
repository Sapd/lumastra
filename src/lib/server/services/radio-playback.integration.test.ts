// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId } from '$lib/shared/user-id.js';
import { config } from '../config.js';
import { startPlaySession } from './play-sessions.service.js';
import { PlaySessionLifecycleService } from './play-session-lifecycle.service.js';
import * as queries from '../database/queries/play-sessions.queries.js';
import { getRadioStreamUrl } from '../database/queries/radio-stream.queries.js';
import {
    validatePlaybackGrant,
    renewPlaybackGrant,
    invalidatePlaybackGrantCache,
} from './playback-grant.js';
import { sessionCarPlayContext } from '../database/queries/play-session-client-context.queries.js';
import type { PlaybackStartResponse } from '$lib/schemas/playback-start.js';

const sql = getTestDb();
const userId = toUserId(randomUUID());
const stationId = randomUUID();
const username = derivedUsername(userId);
const ip = '192.0.2.8';
const source = 'https://radio.example/live';

async function start(
    deviceId = 'radio-phone',
    carPlay?: boolean,
): Promise<Awaited<ReturnType<typeof startPlaySession>>> {
    return startPlaySession(
        sql,
        userId,
        username,
        ip,
        {
            mediaId: stationId,
            deviceId,
            clientInfo: carPlay === undefined ? undefined : { carPlay },
        },
        'native_app',
    );
}

function requireStarted(result: Awaited<ReturnType<typeof start>>): PlaybackStartResponse {
    if (!('delivery' in result)) throw new Error(`Playback refused: ${JSON.stringify(result)}`);
    return result;
}

beforeEach(async () => {
    vi.spyOn(config, 'STREAM_LIMITS_ENFORCED', 'get').mockReturnValue(true);
    await ensureTestUser(sql, userId);
    await sql`INSERT INTO media_items (id, title, media_type, status, runtime_seconds, custom_metadata)
        VALUES (${stationId}, 'Example Radio', 'radio', 'active', 120,
            ${sql.json({ stream_url: source })})`;
    await queries.upsertStreamPolicy(sql, username, { max_concurrent_streams: 1 }, username);
    invalidatePlaybackGrantCache();
});

afterEach(async () => {
    await queries.deleteStreamPolicy(sql, username);
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM media_items WHERE id = ${stationId}`;
    invalidatePlaybackGrantCache();
    vi.restoreAllMocks();
});

describe('session-backed radio against PostgreSQL', () => {
    it('starts, grants only its station/session, renews, reports and stops without durable media history', async () => {
        expect(await getRadioStreamUrl(sql, stationId)).toBe(source);
        expect(await getRadioStreamUrl(sql, randomUUID())).toBeNull();
        const result = requireStarted(await start('radio-phone', true));
        expect(result).toMatchObject({
            kind: 'music',
            delivery: { kind: 'file', live: true, durationMs: null, startPositionMs: 0 },
        });
        expect(
            sessionCarPlayContext(
                (await queries.getSessionById(sql, result.playbackSessionId))?.external_payload,
            ),
        ).toBe(true);
        const route = {
            mediaId: stationId,
            playbackSessionId: result.playbackSessionId,
            kind: 'music' as const,
        };
        expect(
            await validatePlaybackGrant(result.grant.token, { clientIp: ip, route }),
        ).toMatchObject({ playbackSessionId: result.playbackSessionId });
        expect(
            await validatePlaybackGrant(result.grant.token, {
                clientIp: ip,
                route: { ...route, mediaId: randomUUID() },
            }),
        ).toMatchObject({ reason: 'wrong_scope' });
        expect(
            await validatePlaybackGrant(result.grant.token, {
                clientIp: ip,
                route: { ...route, kind: 'video' },
            }),
        ).toMatchObject({ reason: 'wrong_scope' });
        expect(
            await validatePlaybackGrant(result.grant.token, {
                clientIp: ip,
                route: { ...route, playbackSessionId: randomUUID() },
            }),
        ).toMatchObject({ reason: 'wrong_scope' });
        expect(
            await renewPlaybackGrant(result.grant.id, userId, 'v1', result.grant.token),
        ).toMatchObject({ id: result.grant.id });
        const watchManager = { reportProgress: vi.fn(), markWatched: vi.fn() };
        const history = { recordCompletedSession: vi.fn() };
        const lifecycle = new PlaySessionLifecycleService({
            getSql: () => sql,
            queries,
            watchManager,
            watchHistoryService: history,
            getMediaMetadata: vi.fn(),
            resolveResumeAnchor: vi.fn(),
        });
        const report = { position_ms: 120_000, session_elapsed_ms: 120_000, event_seq: 1 };
        expect(
            await lifecycle.update(result.playbackSessionId, {
                ...report,
                status: 'ACTIVE',
                car_play: false,
            }),
        ).toEqual({ resume_anchor: null, wrote_to_durable: false });
        expect(
            sessionCarPlayContext(
                (await queries.getSessionById(sql, result.playbackSessionId))?.external_payload,
            ),
        ).toBe(false);
        await lifecycle.update(result.playbackSessionId, {
            ...report,
            event_seq: 0,
            status: 'ACTIVE',
            car_play: true,
        });
        expect(
            sessionCarPlayContext(
                (await queries.getSessionById(sql, result.playbackSessionId))?.external_payload,
            ),
        ).toBe(false);
        await lifecycle.update(result.playbackSessionId, {
            ...report,
            event_seq: 2,
            status: 'PAUSED',
        });
        expect(await queries.getSessionById(sql, result.playbackSessionId)).toMatchObject({
            status: 'PAUSED',
            position_ms: 0,
        });
        await lifecycle.update(result.playbackSessionId, {
            ...report,
            event_seq: 3,
            status: 'COMPLETED',
            end_reason: 'user',
        });
        expect(await queries.getSessionById(sql, result.playbackSessionId)).toMatchObject({
            status: 'COMPLETED',
            position_ms: 0,
        });
        expect(watchManager.reportProgress).not.toHaveBeenCalled();
        expect(watchManager.markWatched).not.toHaveBeenCalled();
        expect(history.recordCompletedSession).not.toHaveBeenCalled();
        expect(
            await validatePlaybackGrant(result.grant.token, { clientIp: ip, route }),
        ).toMatchObject({ reason: 'session_ended' });
        expect(
            await renewPlaybackGrant(result.grant.id, userId, 'v1', result.grant.token),
        ).toBeNull();
        const [counts] = await sql<{ tracks: number; history: number; resume: number }[]>`
            SELECT (SELECT count(*)::int FROM user_music_state WHERE user_id = ${userId}) AS tracks,
                (SELECT count(*)::int FROM watch_history WHERE user_id = ${userId}) AS history,
                (SELECT count(*)::int FROM user_media_state WHERE user_id = ${userId}) AS resume`;
        expect(counts).toEqual({ tracks: 0, history: 0, resume: 0 });
    });

    it('updates CarPlay connection context on an existing music session without changing its device', async () => {
        const started = requireStarted(await start());
        await sql`UPDATE media_items SET media_type = 'track' WHERE id = ${stationId}`;
        const lifecycle = new PlaySessionLifecycleService({
            getSql: () => sql,
            queries,
            watchManager: { reportProgress: vi.fn(), markWatched: vi.fn() },
            watchHistoryService: { recordCompletedSession: vi.fn() },
            getMediaMetadata: vi.fn(),
        });
        for (const [index, carPlay] of [true, false, true].entries()) {
            await lifecycle.update(started.playbackSessionId, {
                position_ms: 0,
                session_elapsed_ms: 0,
                event_seq: index + 1,
                status: 'ACTIVE',
                car_play: carPlay,
            });
            const row = await queries.getSessionById(sql, started.playbackSessionId);
            expect(row?.device_id).toBe('radio-phone');
            expect(row?.id).toBe(started.playbackSessionId);
            expect(sessionCarPlayContext(row?.external_payload)).toBe(carPlay);
        }
    });

    it('enforces the normal concurrent-stream cap before minting a second radio session', async () => {
        requireStarted(await start());
        expect(await start('radio-tablet')).toMatchObject({
            kind: 'stream_limit_exceeded',
            active: 1,
            limit: 1,
        });
        const [counts] = await sql<{ sessions: number; grants: number }[]>`
            SELECT (SELECT count(*)::int FROM play_sessions WHERE user_id = ${userId}) AS sessions,
                (SELECT count(*)::int FROM hls_playback_tokens WHERE user_id = ${userId}) AS grants`;
        expect(counts).toEqual({ sessions: 1, grants: 1 });
    });

    it('does not resolve deleted or non-radio rows as radio origins', async () => {
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${stationId}`;
        expect(await getRadioStreamUrl(sql, stationId)).toBeNull();
        await sql`UPDATE media_items SET status = 'active', media_type = 'track' WHERE id = ${stationId}`;
        expect(await getRadioStreamUrl(sql, stationId)).toBeNull();
    });
});
