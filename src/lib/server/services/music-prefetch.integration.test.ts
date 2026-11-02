// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { MusicTranscodeService } from './music-transcode/service.js';
import type { MusicTranscodeCache } from './music-transcode/cache.js';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId } from '$lib/shared/user-id.js';
import * as queries from '../database/queries/play-sessions.queries.js';
import { getActiveStreams } from '../database/queries/streaming-summary.queries.js';
import {
    createPlaybackSessionRow,
    enforceStreamPolicy,
    reapStaleSessions,
    endPlaySession,
} from './play-sessions.service.js';
import { PlaySessionLifecycleService } from './play-session-lifecycle.service.js';
import { mintPlaybackGrant, getPlaybackGrant, renewPlaybackGrant, validatePlaybackGrant } from './playback-grant.js';
import { withTx } from '../database/with-tx.js';

const cleanup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const cancelMusic = vi.hoisted(() => vi.fn().mockReturnValue(true));
const notifyTerminated = vi.hoisted(() => vi.fn());
vi.mock('./play-session-events.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./play-session-events.service.js')>()),
    // Simulate a broadcast that cannot reach the local transcode subscriber.
    notifySessionTerminated: notifyTerminated,
}));
vi.mock('$lib/server/services/music-transcode/index.js', () => ({
    getMusicTranscodeService: () => ({ cancel: cancelMusic }),
}));
vi.mock('./play-session-transcode-cleanup.js', () => ({ stopSessionTranscode: cleanup }));
// Telemetry flushes run in the background and can race the next test's fixture cleanup.
vi.mock('./playback-telemetry.service.js', () => ({
    playbackTelemetryService: {
        record: vi.fn().mockResolvedValue(undefined),
        computeSessionQualityOnStop: vi.fn(),
    },
}));
vi.mock('$lib/server/plugins/runtime/playback-authorization.js', () => ({
    authorizePlaybackViaPlugins: vi.fn().mockResolvedValue({ allow: true }),
}));

const userId = toUserId(randomUUID());
const mediaId = randomUUID();
const previousMediaId = randomUUID();
const username = derivedUsername(userId);
const deviceId = 'prefetch-device';

describe('music prefetch sessions', () => {
    let sql: postgres.Sql;
    let lifecycle: PlaySessionLifecycleService;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        cleanup.mockClear();
        cancelMusic.mockClear();
        notifyTerminated.mockClear();
        await truncateTables(sql, ['play_sessions', 'users', 'user_profiles', 'media_items']);
        await ensureTestUser(sql, userId);
        await sql`INSERT INTO media_items (id, title, media_type, status, runtime_seconds)
            VALUES (${mediaId}, 'Next track', 'track', 'active', 180),
                   (${previousMediaId}, 'Current track', 'track', 'active', 180)`;
        await queries.upsertStreamPolicy(sql, username, { max_concurrent_streams: 3 }, 'system');
        lifecycle = makeLifecycle(sql);
    });

    function makeLifecycle(connection: postgres.Sql, overrides: Partial<typeof queries> = {}) {
        return new PlaySessionLifecycleService({
            getSql: () => connection,
            queries: { ...queries, ...overrides },
            getMediaMetadata: vi.fn().mockResolvedValue(null),
            watchManager: { reportProgress: vi.fn(), markWatched: vi.fn() },
            watchHistoryService: { recordCompletedSession: vi.fn() },
        });
    }

    async function allocate(purpose: 'play' | 'prefetch', media = mediaId, device = deviceId) {
        let parentId: string | undefined;
        if (purpose === 'prefetch') {
            const [parent] = await sql<{ id: string }[]>`SELECT id FROM play_sessions
                WHERE user_id = ${userId} AND device_id = ${device} AND purpose = 'play'
                  AND status IN ('ACTIVE', 'PAUSED') LIMIT 1`;
            parentId = parent?.id ?? (await allocate('play', previousMediaId, device)).id;
        }
        const row = await queries.createPlaySession(sql, {
            surface: 'native_app',
            user_id: userId,
            media_id: media,
            device_id: device,
            ip_address: '192.0.2.1',
            play_method: 'direct',
            position_ms: 0,
            purpose,
            client_name: 'Lumastra Music',
            runtime_ms: 180000,
        });
        if (parentId) await sql`UPDATE play_sessions SET external_payload =
            jsonb_build_object('__lumastra_prefetch_parent', ${parentId}::text) WHERE id = ${row.id}`;
        return (await queries.getSessionById(sql, row.id))!;
    }
    async function start(purpose: 'play' | 'prefetch') {
        return createPlaybackSessionRow(
            sql,
            userId,
            username,
            '192.0.2.1',
            {
                media_id: mediaId,
                device_id: deviceId,
                requested: { play_method: 'direct' },
            },
            'native_app',
            { purpose },
        );
    }
    const report = (event_seq = 1, status: 'ACTIVE' | 'PAUSED' = 'ACTIVE', position_ms = 0) => ({
        status,
        position_ms,
        event_seq,
        session_elapsed_ms: 0,
    });

    it('requires admitted playback on the same user and device, including for a paused deck', async () => {
        expect(await start('prefetch')).toEqual({ kind: 'prefetch_requires_current_session' });
        const otherUser = toUserId(randomUUID());
        await ensureTestUser(sql, otherUser);
        await queries.createPlaySession(sql, {
            surface: 'native_app', user_id: otherUser, media_id: previousMediaId,
            device_id: deviceId, ip_address: '192.0.2.1', play_method: 'direct', position_ms: 0,
        });
        expect(await start('prefetch')).toEqual({ kind: 'prefetch_requires_current_session' });
        await allocate('play', previousMediaId, 'different-device');
        expect(await start('prefetch')).toEqual({ kind: 'prefetch_requires_current_session' });
        const current = await allocate('play', previousMediaId);
        await lifecycle.update(current.id, report(1, 'PAUSED'));
        expect(await start('prefetch')).toHaveProperty('session_id');
    });

    it('replaces the one prepared deck on the device across different media', async () => {
        await allocate('play', previousMediaId);
        const old = await allocate('prefetch', previousMediaId);
        const grant = await mintPlaybackGrant({ userId, mediaId: previousMediaId,
            playbackSessionId: old.id, kind: 'music', clientIp: '192.0.2.1' });
        const next = await start('prefetch');
        expect(next).toHaveProperty('session_id');
        expect((await queries.getSessionById(sql, old.id))?.status).toBe('KILLED');
        expect(await getPlaybackGrant(grant.id, userId)).toBeNull();
        expect(await sql`SELECT id FROM play_sessions WHERE purpose = 'prefetch'
            AND user_id = ${userId} AND device_id = ${deviceId} AND status IN ('ACTIVE', 'PAUSED')`).toHaveLength(1);
        expect(cleanup).toHaveBeenCalledWith(old.id, 'superseded');
        expect(cancelMusic).toHaveBeenCalledWith(old.id);
        expect(notifyTerminated).toHaveBeenCalledWith(old.id, 'superseded');
    });

    it('refuses delivery and renewal immediately if the admitted deck ended elsewhere', async () => {
        const current = await allocate('play', previousMediaId);
        const next = await allocate('prefetch');
        const grant = await mintPlaybackGrant({ userId, mediaId, playbackSessionId: next.id,
            kind: 'music', clientIp: '192.0.2.1' });
        expect(await getPlaybackGrant(grant.id, userId)).not.toBeNull();
        // Simulate a replica's terminal commit before its cleanup worker runs.
        await sql`UPDATE play_sessions SET status = 'COMPLETED', stopped_at = now()
            WHERE id = ${current.id}`;
        expect((await queries.getSessionById(sql, next.id))?.status).toBe('ACTIVE');
        expect(await getPlaybackGrant(grant.id, userId)).toBeNull();
        expect(await renewPlaybackGrant(grant.id, userId)).toBeNull();
        expect(await validatePlaybackGrant(grant.token, {
            clientIp: '192.0.2.1', route: { kind: 'music', mediaId },
        })).toMatchObject({ reason: 'session_ended' });
        await reapStaleSessions(sql);
        expect((await queries.getSessionById(sql, next.id))?.status).toBe('CRASHED');
        expect(cancelMusic).toHaveBeenCalledWith(next.id);
    });

    it('serializes concurrent replacements for the same device on independent connections', async () => {
        await allocate('play', previousMediaId);
        const connections = [
            postgres(getTestDatabaseUrl(), { max: 1 }),
            postgres(getTestDatabaseUrl(), { max: 1 }),
        ];
        try {
            const results = await Promise.all(connections.map((connection, index) =>
                createPlaybackSessionRow(connection, userId, username, '192.0.2.1', {
                    media_id: index === 0 ? mediaId : previousMediaId,
                    device_id: deviceId,
                    requested: { play_method: 'direct' },
                }, 'native_app', { purpose: 'prefetch' }),
            ));
            expect(results.every((result) => 'session_id' in result)).toBe(true);
            expect(await sql`SELECT id FROM play_sessions WHERE purpose = 'prefetch'
                AND user_id = ${userId} AND device_id = ${deviceId}
                AND status IN ('ACTIVE', 'PAUSED')`).toHaveLength(1);
        } finally {
            await Promise.all(connections.map((connection) => connection.end()));
        }
    });

    function barrier() {
        let open!: () => void;
        const reached = new Promise<void>((resolve) => { open = resolve; });
        return { reached, open };
    }

    it('serializes video-parent completion before row locks against prefetch promotion', async () => {
        const current = await allocate('play', previousMediaId);
        await sql`UPDATE media_items SET media_type = 'movie' WHERE id = ${previousMediaId}`;
        const next = await allocate('prefetch');
        const connections = [
            postgres(getTestDatabaseUrl(), { max: 1 }),
            postgres(getTestDatabaseUrl(), { max: 1 }),
        ];
        const childLocked = barrier();
        const continueAdmission = barrier();
        let promotion: Promise<unknown> | undefined;
        let completion: Promise<unknown> | undefined;
        try {
            const [{ pid }] = await connections[1]<{ pid: number }[]>`
                SELECT pg_backend_pid() AS pid`;
            promotion = withTx(connections[0], async (tx) => {
                // Match promotion's prefix, pausing after the child lock and before
                // admission locks the still-playing video parent to count streams.
                await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;
                await tx`SELECT id FROM play_sessions WHERE id = ${next.id} FOR UPDATE`;
                childLocked.open();
                await continueAdmission.reached;
                expect(
                    await enforceStreamPolicy(tx, userId, username, '192.0.2.1', 'direct', {
                        session_id: next.id,
                    }),
                ).toBeNull();
                await tx`UPDATE play_sessions SET purpose = 'play' WHERE id = ${next.id}`;
            });
            await childLocked.reached;
            // Video completion already runs in a transaction in the lifecycle service.
            completion = withTx(connections[1], (tx) =>
                queries.stopSession(tx, current.id, 180000, 'completion'),
            );
            await vi.waitFor(async () => {
                const [activity] = await sql`
                    SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = ${pid}`;
                expect(activity?.wait_event_type).toBe('Lock');
                expect(activity?.wait_event).toBe('advisory');
            });
            continueAdmission.open();
            await Promise.all([promotion, completion]);
            expect(await queries.getSessionById(sql, current.id)).toMatchObject({
                status: 'COMPLETED',
            });
            expect(await queries.getSessionById(sql, next.id)).toMatchObject({
                purpose: 'play',
                status: 'ACTIVE',
            });
        } finally {
            continueAdmission.open();
            await Promise.allSettled([promotion, completion]);
            await Promise.all(connections.map((connection) => connection.end()));
        }
    });

    it.each(['ACTIVE', 'PAUSED'] as const)(
        'atomically promotes a six-minute-old deck to %s against delayed discard and reap',
        async (status) => {
            const next = await allocate('prefetch');
            const grant = await mintPlaybackGrant({ userId, mediaId,
                playbackSessionId: next.id, kind: 'music', clientIp: '192.0.2.1' });
            await sql`UPDATE play_sessions SET started_at = now() - INTERVAL '6 minutes',
                last_heartbeat_at = now() - INTERVAL '6 minutes' WHERE id = ${next.id}`;
            await sql`UPDATE hls_playback_tokens SET last_used_at = now() - INTERVAL '6 minutes'
                WHERE id = ${grant.id}`;
            const connections = Array.from({ length: 3 }, () => postgres(getTestDatabaseUrl(), { max: 1 }));
            const atHeartbeat = barrier();
            const finishReport = barrier();
            const discardLoaded = barrier();
            let promotion: Promise<unknown> | undefined;
            let discard: Promise<unknown> | undefined;
            try {
                const promoting = makeLifecycle(connections[0], {
                    updateHeartbeat: async (...args) => {
                        // Purpose has changed, but the report has not refreshed the heartbeat yet.
                        atHeartbeat.open();
                        await finishReport.reached;
                        return queries.updateHeartbeat(...args);
                    },
                });
                const delayed = makeLifecycle(connections[1], {
                    getSessionById: async (...args) => {
                        const row = await queries.getSessionById(...args);
                        discardLoaded.open();
                        return row;
                    },
                });
                const [{ pid }] = await connections[1]<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                promotion = promoting.update(next.id, { ...report(2, status, 10), listened_ms: 100 });
                await atHeartbeat.reached;
                discard = delayed.update(next.id, { ...report(1), status: 'COMPLETED' });
                await discardLoaded.reached;
                await vi.waitFor(async () => {
                    const [activity] = await sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
                    expect(activity?.wait_event_type).toBe('Lock');
                });
                expect((await queries.getSessionById(sql, next.id))?.purpose).toBe('prefetch');
                expect(await reapStaleSessions(connections[2])).toEqual({ crashed: 0, completed: 0 });
                expect(await getPlaybackGrant(grant.id, userId)).not.toBeNull();
                finishReport.open();
                await Promise.all([promotion, discard]);
                const current = await queries.getSessionById(sql, next.id);
                expect(current).toMatchObject({ purpose: 'play', status, last_event_seq: 2 });
                expect(new Date(current!.last_heartbeat_at).getTime()).toBeGreaterThan(Date.now() - 30000);
                expect(Boolean(current?.paused_at)).toBe(status === 'PAUSED');
                expect(await getPlaybackGrant(grant.id, userId)).not.toBeNull();
                expect(await reapStaleSessions(connections[2])).toEqual({ crashed: 0, completed: 0 });
                expect(cancelMusic).not.toHaveBeenCalledWith(next.id);
                expect(Number((await sql`SELECT play_count FROM user_music_state
                    WHERE user_id = ${userId} AND track_id = ${mediaId}`)[0]?.play_count)).toBe(1);
            } finally {
                finishReport.open();
                await Promise.allSettled([promotion, discard]);
                await Promise.all(connections.map((connection) => connection.end()));
            }
        },
    );

    it.each(['discard', 'expiry'] as const)('keeps %s terminal when promotion arrives on another connection', async (winner) => {
        const next = await allocate('prefetch');
        const grant = await mintPlaybackGrant({ userId, mediaId, playbackSessionId: next.id,
            kind: 'music', clientIp: '192.0.2.1' });
        const connections = [postgres(getTestDatabaseUrl(), { max: 1 }), postgres(getTestDatabaseUrl(), { max: 1 })];
        const terminalWritten = barrier();
        const finishTerminal = barrier();
        const promotionLoaded = barrier();
        let terminal: Promise<unknown> | undefined;
        let promotion: Promise<unknown> | undefined;
        try {
            if (winner === 'expiry') {
                await sql`UPDATE play_sessions SET started_at = now() - INTERVAL '11 minutes' WHERE id = ${next.id}`;
                terminal = connections[0].begin(async (tx) => {
                    await reapStaleSessions(tx);
                    terminalWritten.open();
                    await finishTerminal.reached;
                });
            } else {
                terminal = makeLifecycle(connections[0], {
                    stopSession: async (...args) => {
                        const row = await queries.stopSession(...args);
                        terminalWritten.open();
                        await finishTerminal.reached;
                        return row;
                    },
                }).update(next.id, { ...report(1), status: 'COMPLETED' });
            }
            await terminalWritten.reached;
            promotion = makeLifecycle(connections[1], {
                getSessionById: async (...args) => {
                    const row = await queries.getSessionById(...args);
                    promotionLoaded.open();
                    return row;
                },
            }).update(next.id, { ...report(2), listened_ms: 100 });
            await promotionLoaded.reached;
            finishTerminal.open();
            await terminal;
            expect(await promotion).toMatchObject({ action: 'kill' });
            expect((await queries.getSessionById(sql, next.id))?.status).toBe(winner === 'expiry' ? 'CRASHED' : 'COMPLETED');
            expect(await getPlaybackGrant(grant.id, userId)).toBeNull();
            expect(cancelMusic).toHaveBeenCalledWith(next.id);
            expect(await sql`SELECT * FROM user_music_state WHERE user_id = ${userId}`).toHaveLength(0);
        } finally {
            finishTerminal.open();
            await Promise.allSettled([terminal, promotion]);
            await Promise.all(connections.map((connection) => connection.end()));
        }
    });

    it('expires the prepared deck and its grant when its current deck is reaped', async () => {
        const current = await allocate('play', previousMediaId);
        const next = await allocate('prefetch');
        const grant = await mintPlaybackGrant({ userId, mediaId, playbackSessionId: next.id,
            kind: 'music', clientIp: '192.0.2.1' });
        await sql`UPDATE play_sessions SET last_heartbeat_at = now() - INTERVAL '6 minutes'
            WHERE id = ${current.id}`;
        await reapStaleSessions(sql);
        expect((await queries.getSessionById(sql, next.id))?.status).toBe('CRASHED');
        expect(await getPlaybackGrant(grant.id, userId)).toBeNull();
        expect(cancelMusic).toHaveBeenCalledWith(next.id);
        expect(await start('prefetch')).toEqual({ kind: 'prefetch_requires_current_session' });
    });

    it.each([true, false])('expires real queued delivery with cancellation received=%s', async (receiveCancellation) => {
        const next = await allocate('prefetch');
        const grant = await mintPlaybackGrant({ userId, mediaId, playbackSessionId: next.id,
            kind: 'music', clientIp: '192.0.2.1' });
        const connections = [postgres(getTestDatabaseUrl(), { max: 1 }), postgres(getTestDatabaseUrl(), { max: 1 })];
        const acquiring = barrier();
        const slotAvailable = barrier();
        const release = vi.fn().mockResolvedValue(undefined);
        const cache: MusicTranscodeCache = {
            getCachedFinalPath: vi.fn().mockResolvedValue(null), beginWrite: vi.fn(),
            peekInFlight: () => false, waitForKey: async () => {}, reapToCap: async () => {},
        };
        const service = new MusicTranscodeService({ sql: connections[0], cache });
        const slots = service as unknown as { acquireBothSlots: () => Promise<() => Promise<void>> };
        vi.spyOn(slots, 'acquireBothSlots').mockImplementation(async () => {
            acquiring.open();
            await slotAvailable.reached;
            return release;
        });
        const cancellations: boolean[] = [];
        if (receiveCancellation) cancelMusic.mockImplementation((id) => {
            const cancelled = service.cancel(id);
            cancellations.push(cancelled);
            return cancelled;
        });
        const request = service.streamFor({ trackUuid: mediaId,
            sourcePath: fileURLToPath(new URL('../../../../tests/fixtures/music/sample.flac', import.meta.url)),
            sourceMtimeMs: 1, codec: 'mp3', bitrateKbps: 128, timeOffset: 0,
            session: { sessionId: next.id, userId, deviceId, source: 'api' } });
        // Attach before opening any barrier so a fast rejection is always observed.
        const rejected = expect(request).rejects.toMatchObject({ status: 410 });
        try {
            await acquiring.reached;
            await connections[1]`UPDATE play_sessions SET started_at = now() - INTERVAL '11 minutes'
                WHERE id = ${next.id}`;
            expect(await reapStaleSessions(connections[1])).toEqual({ crashed: 1, completed: 0 });
            expect(await getPlaybackGrant(grant.id, userId)).toBeNull();
            expect((await queries.getSessionById(sql, next.id))?.status).toBe('CRASHED');
            slotAvailable.open();
            await rejected;
            if (receiveCancellation) expect(cancellations).toContain(true);
            expect(release).toHaveBeenCalledOnce();
            expect(cache.getCachedFinalPath).not.toHaveBeenCalled();
            expect(service.cancel(next.id)).toBe(false);
        } finally {
            slotAvailable.open();
            await request.catch(() => {});
            cancelMusic.mockReset().mockReturnValue(true);
            await Promise.all(connections.map((connection) => connection.end()));
        }
    });

    it('allocates at capacity without displacing current playback and hides every list', async () => {
        await queries.upsertStreamPolicy(sql, username, { max_concurrent_streams: 1 }, 'system');
        const current = await allocate('play', previousMediaId);
        const next = await start('prefetch');
        expect(next).toHaveProperty('session_id');
        expect((await queries.getSessionById(sql, current.id))?.status).toBe('ACTIVE');
        expect((await queries.getActiveSessionsForUser(sql, userId)).map((r) => r.id)).toEqual([
            current.id,
        ]);
        expect((await queries.getAllActiveSessions(sql)).map((r) => r.id)).toEqual([current.id]);
        expect((await queries.getAllActiveSessionsWithMedia(sql)).map((r) => r.id)).toEqual([
            current.id,
        ]);
        expect((await queries.getActiveSessionsView(sql, { userId })).map((r) => r.id)).toEqual([
            current.id,
        ]);
        expect(
            (await queries.getActiveSessionsView(sql, { userId, includeStale: true })).map(
                (r) => r.id,
            ),
        ).toEqual([current.id]);
        expect(await getActiveStreams(sql)).toHaveLength(1);
        expect(await queries.getMusicSessionsForUser(sql, userId)).toHaveLength(1);
    });

    it('does not count prefetch rows during ordinary admission or IP restriction checks', async () => {
        await allocate('prefetch');
        await sql`UPDATE play_sessions SET ip_address = '192.0.2.99' WHERE user_id = ${userId} AND purpose = 'prefetch'`;
        await queries.upsertStreamPolicy(sql, username, { require_single_ip: true }, 'system');
        expect(
            await withTx(sql, (tx) =>
                enforceStreamPolicy(tx, userId, username, '192.0.2.1', 'direct'),
            ),
        ).toBeNull();
    });

    it.each([
        ['ACTIVE', 0],
        ['PAUSED', 10],
    ] as const)(
        'promotes the first real %s report at position %s, without inventing a listen',
        async (status, position) => {
            const next = await allocate('prefetch');
            await lifecycle.update(next.id, report(1, status, position));
            expect((await queries.getSessionById(sql, next.id))?.purpose).toBe('play');
            expect(await queries.getActiveSessionsForUser(sql, userId)).toHaveLength(1);
            expect(
                await sql`SELECT * FROM user_music_state WHERE user_id = ${userId}`,
            ).toHaveLength(0);
            expect(
                await sql`SELECT * FROM music_listen_events WHERE user_id = ${userId} AND track_id = ${mediaId}`,
            ).toHaveLength(0);
            // Heard-time accounting remains the single play-count trigger.
            await lifecycle.update(next.id, { ...report(2), listened_ms: 100 });
            const [state] =
                await sql`SELECT play_count FROM user_music_state WHERE user_id = ${userId} AND track_id = ${mediaId}`;
            expect(Number(state?.play_count)).toBe(1);
        },
    );

    it('refuses promotion at capacity and expires prefetch when current playback ends', async () => {
        await queries.upsertStreamPolicy(sql, username, { max_concurrent_streams: 1 }, 'system');
        const current = await allocate('play', previousMediaId);
        const next = await allocate('prefetch');
        const denied = await lifecycle.update(next.id, report());
        expect(denied).toMatchObject({
            policyError: { kind: 'stream_limit_exceeded', active: 1, limit: 1 },
        });
        expect((await queries.getSessionById(sql, next.id))?.purpose).toBe('prefetch');
        expect((await queries.getSessionById(sql, current.id))?.status).toBe('ACTIVE');
        await lifecycle.update(current.id, { ...report(), status: 'COMPLETED' });
        expect(await lifecycle.update(next.id, report())).toMatchObject({ action: 'kill' });
        expect((await queries.getSessionById(sql, next.id))?.status).toBe('CRASHED');
    });

    it('adopts the prepared row on a same-device normal start and closes only that device’s old deck', async () => {
        await queries.upsertStreamPolicy(sql, username, { max_concurrent_streams: 3 }, 'system');
        const current = await allocate('play', previousMediaId);
        const other = await allocate('play', previousMediaId, 'other-device');
        const next = await allocate('prefetch');
        await lifecycle.update(next.id, report(5, 'PAUSED'));
        expect(await start('play')).toMatchObject({ session_id: next.id });
        await lifecycle.update(next.id, { ...report(4), status: 'COMPLETED' });
        expect((await queries.getSessionById(sql, next.id))?.last_event_seq).toBe(5);
        expect((await queries.getSessionById(sql, next.id))?.status).toBe('ACTIVE');
        expect((await queries.getSessionById(sql, next.id))?.purpose).toBe('play');
        expect((await queries.getSessionById(sql, current.id))?.status).toBe('COMPLETED');
        expect((await queries.getSessionById(sql, other.id))?.status).toBe('ACTIVE');
        expect(cleanup).toHaveBeenCalledWith(current.id, 'track_change');
    });

    it('normal-start promotion respects the cap, then uses a fresh row after the parent ends', async () => {
        await queries.upsertStreamPolicy(sql, username, { max_concurrent_streams: 1 }, 'system');
        const current = await allocate('play', previousMediaId);
        const next = await allocate('prefetch');
        expect(await start('play')).toMatchObject({ kind: 'stream_limit_exceeded' });
        expect((await queries.getSessionById(sql, current.id))?.status).toBe('ACTIVE');
        expect((await queries.getSessionById(sql, next.id))?.purpose).toBe('prefetch');
        await endPlaySession(sql, current.id, 0, 'user', username);
        expect(await start('play')).not.toMatchObject({ session_id: next.id });
        expect((await queries.getSessionById(sql, next.id))?.status).toBe('CRASHED');
    });

    it('stale reports cannot promote, and expired sessions cannot be revived by progress', async () => {
        const next = await allocate('prefetch');
        await lifecycle.update(next.id, report(5, 'PAUSED'));
        await lifecycle.update(next.id, report(4));
        await lifecycle.update(next.id, { ...report(4), status: 'COMPLETED' });
        expect((await queries.getSessionById(sql, next.id))?.status).toBe('PAUSED');
        expect((await queries.getSessionById(sql, next.id))?.purpose).toBe('prefetch');
        await sql`UPDATE play_sessions SET started_at = now() - INTERVAL '11 minutes' WHERE id = ${next.id}`;
        expect(await lifecycle.update(next.id, report(6))).toMatchObject({ action: 'kill' });
        await reapStaleSessions(sql);
        expect(await lifecycle.update(next.id, report(7))).toMatchObject({ action: 'kill' });
        expect((await queries.getSessionById(sql, next.id))?.purpose).toBe('prefetch');
    });

    it('an idle paused report and discard never promote or write listening history', async () => {
        const next = await allocate('prefetch');
        await lifecycle.update(next.id, report(1, 'PAUSED'));
        expect((await queries.getSessionById(sql, next.id))?.purpose).toBe('prefetch');
        await lifecycle.update(next.id, { ...report(2), status: 'COMPLETED' });
        expect(await sql`SELECT * FROM user_music_state WHERE user_id = ${userId}`).toHaveLength(0);
        expect(await sql`SELECT * FROM music_listen_events WHERE user_id = ${userId}`).toHaveLength(
            0,
        );
    });

    it('reaps at ten minutes despite idle heartbeats and recent delivery, releasing grants/transcodes', async () => {
        const next = await allocate('prefetch');
        const grant = await mintPlaybackGrant({
            userId,
            mediaId,
            playbackSessionId: next.id,
            kind: 'music',
            clientIp: '192.0.2.1',
        });
        await sql`UPDATE play_sessions SET started_at = now() - INTERVAL '9 minutes', last_heartbeat_at = now() - INTERVAL '6 minutes' WHERE id = ${next.id}`;
        expect(await reapStaleSessions(sql)).toEqual({ crashed: 0, completed: 0 });
        await sql`UPDATE play_sessions SET started_at = now() - INTERVAL '11 minutes', last_heartbeat_at = now(), position_ms = 180000 WHERE id = ${next.id}`;
        await sql`UPDATE hls_playback_tokens SET last_used_at = now() WHERE id = ${grant.id}`;
        expect(await reapStaleSessions(sql)).toEqual({ crashed: 1, completed: 0 });
        expect((await queries.getSessionById(sql, next.id))?.status).toBe('CRASHED');
        const [token] = await sql`SELECT is_active FROM hls_playback_tokens WHERE id = ${grant.id}`;
        expect(token?.is_active).toBe(false);
        expect(cleanup).toHaveBeenCalledWith(next.id, expect.any(String));
        expect(cancelMusic).toHaveBeenCalledWith(next.id);
        expect(await sql`SELECT * FROM user_music_state WHERE user_id = ${userId}`).toHaveLength(0);
    });
});
