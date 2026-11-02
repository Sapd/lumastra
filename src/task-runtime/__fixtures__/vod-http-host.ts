// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Two independent web processes around real native session/HLS handlers.
 * Only framework RequestEvent/HTTP and fixture setup are adapted. No auth,
 * lifecycle, transcode, reaper, timestamp, or media implementation is mocked.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { def as startDef } from '$lib/server/api/defs/play-sessions/index.js';
import { def as progressDef } from '$lib/server/api/defs/play-sessions/[id].js';
import { def as logoutDef } from '$lib/server/api/defs/auth/logout.js';
import { GET as media } from '../../routes/api/v1/playback/[id]/hls/[...path]/+server.js';
import { getDb, closeDb } from '$lib/server/database/connection.js';
import { syncUserGroups } from '$lib/server/services/user-groups.service.js';
import { getRefreshTokenService } from '$lib/server/oauth/refresh-token.service.js';
import { generateAccessToken } from '$lib/server/oauth/jwt.js';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service.js';
import { config } from '$lib/server/config.js';
import {
    connectValkey,
    disconnectValkey,
    closeAllSubscriptions,
    cacheDel,
    isValkeyHealthy,
    isCoordinationValkeyHealthy,
} from '$lib/server/cache/valkey.js';
import { stopAuthCacheInvalidationSubscriber } from '$lib/server/cache/auth-cache-bus.js';
import { toUserId } from '$lib/shared/user-id.js';

interface Input {
    id: string;
    role: 'owner' | 'receiver';
    mediaId: string;
    port: number;
    mediaFile: string;
}
const input = JSON.parse(process.argv[2]) as Input;
assert.equal(process.env.WORKER_MODE, 'disabled');
const sql = getDb();
assert(sql, 'VOD SQL unavailable');
const db = sql;
const users: Array<{ username: string; id: string }> = [];
const deviceIds: string[] = [];
// The real start chooses the playback session id; the test hands it to both
// pods afterwards, so snapshots, the encode and cleanup all use that one id.
let sessionId: string | undefined;
let fileId: string | undefined;
const service = getFFmpegTranscodeService();
let web: http.Server | undefined;
let shutdown: Promise<void> | undefined;
const start = mount(startDef, { surface: 'v1' }).POST!;
const progress = mount(progressDef, { surface: 'v1' }).PUT!;
const logout = mount(logoutDef, { surface: 'v1' }).POST!;

function send(message: object): void {
    if (process.connected) process.send?.(message);
}

function eventFor(
    url: URL,
    method: string,
    headers: Headers,
    params: Record<string, string>,
    route: string,
    body?: Buffer,
): RequestEvent {
    return {
        url,
        request: new Request(url, {
            method,
            headers,
            body: body?.length ? new Uint8Array(body) : undefined,
        }),
        params,
        route: { id: route },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => undefined,
            delete: () => undefined,
            serialize: () => '',
        },
        fetch,
        getClientAddress: () => '127.0.0.1',
        setHeaders: () => undefined,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
    } as unknown as RequestEvent;
}

async function serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${input.port}`);
    let handler: RequestHandler | undefined;
    let params: Record<string, string> = {};
    let route = '';
    const match = /^\/api\/v1\/play-sessions\/([0-9a-f-]+)$/.exec(url.pathname);
    const hls = /^\/api\/v1\/playback\/([0-9a-f-]+)\/hls\/(.+)$/.exec(url.pathname);
    if (request.method === 'POST' && url.pathname === '/api/v1/play-sessions') {
        handler = start;
        route = '/api/v1/play-sessions';
    } else if (request.method === 'PUT' && match) {
        handler = progress;
        params = { id: match[1] };
        route = '/api/v1/play-sessions/[id]';
    } else if (request.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
        handler = logout;
        route = '/api/v1/auth/logout';
    } else if (request.method === 'GET' && hls && input.role === 'owner') {
        handler = (event) => media(event as Parameters<typeof media>[0]);
        params = { id: hls[1], path: hls[2] };
        route = '/api/v1/playback/[id]/hls/[...path]';
    }
    if (!handler) {
        response.writeHead(404).end();
        return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        assert(size <= 16_384, 'Fixture request body too large');
        chunks.push(bytes);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    const event = eventFor(url, request.method!, headers, params, route, Buffer.concat(chunks));
    const denial = await resolveAuth(
        event,
        async () => {
            throw new Error('Unexpected migration');
        },
        true,
    );
    const result = denial ?? (await handler(event));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
}

async function device(username: string): Promise<string> {
    const user = users.find((value) => value.username === username);
    assert(user);
    const deviceSessionId = randomUUID();
    deviceIds.push(deviceSessionId);
    await getRefreshTokenService().create({
        userId: toUserId(user.id),
        clientId: 'lumastra-tvos',
        groups: ['media'],
        deviceSessionId,
    });
    return generateAccessToken({
        username,
        clientId: 'lumastra-tvos',
        groups: ['media'],
        deviceSessionId,
    });
}

async function snapshot(): Promise<object> {
    const job = sessionId ? service.getJobByPlaySession(sessionId) : undefined;
    const rows = sessionId
        ? await db`SELECT job_id, pod_name, status, last_accessed_at, last_progress_at, ffmpeg_pid, segments_ready FROM active_transcode_jobs WHERE play_session_id = ${sessionId}`
        : [];
    const sessions = sessionId
        ? await db`SELECT id, media_id, user_id, surface, status, position_ms, last_event_seq, last_heartbeat_at FROM play_sessions WHERE id = ${sessionId}`
        : [];
    const events = sessionId
        ? await db`SELECT event_type, position_ms, event_seq, session_elapsed_ms, occurred_at FROM user_media_events WHERE session_id = ${sessionId} ORDER BY event_seq DESC LIMIT 1`
        : [];
    return {
        pid: process.pid,
        pod: process.env.HOSTNAME,
        role: input.role,
        row: rows[0] ?? null,
        session: sessions[0] ?? null,
        durable: events[0] ?? null,
        local: job
            ? {
                  id: job.id,
                  status: job.status,
                  segmentsReady: job.segmentsReady,
                  segmentDurationSeconds: job.segmentDurationSeconds,
                  ffmpegPid: job.process?.pid ?? null,
                  lastAccessedAt: job.lastAccessedAt,
                  lastProgressAt: job.lastProgressAt,
                  lastClientHeartbeatAt: job.lastClientHeartbeatAt,
                  lastPersistedClientActivityAt: job.lastPersistedClientActivityAt ?? null,
              }
            : null,
        timeouts: {
            progress: config.FFMPEG_PROGRESS_TIMEOUT_SECONDS,
            inactivity: config.FFMPEG_INACTIVITY_TIMEOUT_SECONDS,
            clientGone: config.FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS,
        },
    };
}

function close(): Promise<void> {
    shutdown ??= (async () => {
        const failures: unknown[] = [];
        async function attempt(action: () => Promise<unknown>): Promise<void> {
            try {
                await action();
            } catch (error) {
                failures.push(error);
            }
        }
        if (web?.listening) {
            web.closeAllConnections();
            await attempt(
                () =>
                    new Promise<void>((resolve, reject) =>
                        web!.close((error) => (error ? reject(error) : resolve())),
                    ),
            );
        }
        await attempt(() => service.shutdown());
        if (input.role === 'owner') {
            // Every start on this media (owner's and the foreign denial start).
            await attempt(
                () =>
                    db`DELETE FROM active_transcode_jobs WHERE play_session_id IN (SELECT id FROM play_sessions WHERE media_id = ${input.mediaId})`,
            );
            await attempt(
                () =>
                    db`DELETE FROM user_media_events WHERE session_id IN (SELECT id::text FROM play_sessions WHERE media_id = ${input.mediaId})`,
            );
            await attempt(() => db`DELETE FROM play_sessions WHERE media_id = ${input.mediaId}`);
            await attempt(
                () => db`DELETE FROM media_file_items WHERE media_item_id = ${input.mediaId}`,
            );
            if (fileId) await attempt(() => db`DELETE FROM media_files WHERE id = ${fileId!}`);
            await attempt(() => db`DELETE FROM media_items WHERE id = ${input.mediaId}`);
            for (const user of users) {
                await attempt(() => db`DELETE FROM hls_playback_tokens WHERE user_id = ${user.id}`);
                await attempt(
                    () => db`DELETE FROM oauth_refresh_tokens WHERE user_id = ${user.id}`,
                );
                await attempt(() => db`DELETE FROM users WHERE id = ${user.id}`);
                await attempt(() => cacheDel(`auth:user:${user.username}`));
            }
            for (const id of deviceIds) await attempt(() => cacheDel(`auth:device-session:${id}`));
        }
        stopAuthCacheInvalidationSubscriber();
        await attempt(() => closeAllSubscriptions());
        await attempt(() => disconnectValkey());
        await attempt(() => closeDb());
        assert.deepEqual(failures, [], 'VOD fixture cleanup failed');
        send({ type: 'cleaned' });
    })();
    return shutdown;
}

process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('operation' in message)) return;
    if (message.operation === 'session' && 'sessionId' in message) {
        if (
            sessionId === undefined &&
            typeof message.sessionId === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(message.sessionId)
        ) {
            sessionId = message.sessionId;
            send({ type: 'session', sessionId });
        } else send({ type: 'failure', message: 'VOD session id rejected' });
    } else if (message.operation === 'snapshot' && 'id' in message) {
        void snapshot().then(
            (state) => send({ type: 'snapshot', id: message.id, state }),
            () => send({ type: 'failure', message: 'VOD snapshot failed' }),
        );
    } else if (message.operation === 'encode' && input.role === 'owner') {
        void (async () => {
            assert(sessionId, 'Encode needs the started playback session id');
            const job = await service.startJob(
                {
                    itemId: input.mediaId,
                    username: `vod_${input.id}_owner`,
                    deviceId: `vod-${input.id}`,
                    playSessionId: sessionId,
                    inputUrl: input.mediaFile,
                    localFilePath: input.mediaFile,
                    totalDurationSeconds: 600,
                    segmentDurationSeconds: 2,
                    audioTracks: [],
                    videoInfo: { codec: 'h264', width: 128, height: 72, frameRate: 24 },
                    mediaSourceInfo: {
                        id: input.mediaId,
                        path: input.mediaFile,
                        container: 'mp4',
                        streams: [
                            {
                                index: 0,
                                type: 'Video',
                                codec: 'h264',
                                width: 128,
                                height: 72,
                                pixelFormat: 'yuv420p',
                                bitDepth: 8,
                            },
                        ],
                    },
                    planHints: { targetVideoCodec: 'copy', targetAudioCodec: 'copy' },
                    hlsOutput: {
                        hlsContainer: 'fmp4',
                        hlsAudioMode: 'muxed',
                        hlsPlaylistType: 'vod',
                        hlsVersion: 7,
                    },
                },
                { requireSameOwner: true },
            );
            assert(
                job.transcodeDecisionResult?.videoAction === 'copy',
                'Fixture must use the real CPU remux decision',
            );
            send({ type: 'encoding', state: await snapshot() });
        })().catch(() => send({ type: 'failure', message: 'Actual VOD encode failed' }));
    } else if (message.operation === 'close') {
        void close().then(
            () => process.exit(0),
            () => process.exit(1),
        );
    }
});
process.on('disconnect', () => {
    void close().finally(() => process.exit(1));
});
process.on('SIGTERM', () => {
    void close().then(
        () => process.exit(0),
        () => process.exit(1),
    );
});
const deadline = setTimeout(() => {
    void close().finally(() => process.exit(1));
}, 550_000);
deadline.unref();

try {
    assert(await connectValkey());
    assert(await isValkeyHealthy());
    assert(await isCoordinationValkeyHealthy());
    let credentials: object = {};
    if (input.role === 'owner') {
        await db`INSERT INTO media_items (id, media_type, title, status, has_files, runtime_seconds) VALUES (${input.mediaId}, 'movie', ${`VOD continuity ${input.id}`}, 'active', true, 600)`;
        // The real start decides delivery from this linked file; the info
        // service probes the synthetic file itself (mp4, h264 128x72 24 fps
        // yuv420p 8-bit, no audio, 600 s).
        const [file] = await db<{ id: string }[]>`INSERT INTO media_files
            (file_path, container_format, duration_seconds, file_size_bytes, probed_at)
            VALUES (${input.mediaFile}, 'mp4', 600, ${(await stat(input.mediaFile)).size}, now())
            RETURNING id`;
        fileId = file.id;
        await db`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${fileId}, ${input.mediaId}, true)`;
        for (const suffix of ['owner', 'foreign']) {
            const username = `vod_${input.id}_${suffix}`;
            const [row] = await db<
                { id: string }[]
            >`INSERT INTO users (username) VALUES (${username}) RETURNING id`;
            users.push({ username, id: row.id });
            await syncUserGroups(db, username, ['media']);
        }
        credentials = {
            ownerToken: await device(users[0].username),
            foreignToken: await device(users[1].username),
            revokedToken: await device(users[0].username),
        };
    }
    web = http.createServer((request, response) => {
        void serve(request, response).catch(() => {
            response.writeHead(500).end();
        });
    });
    web.listen(input.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
        web!.once('listening', resolve);
        web!.once('error', reject);
    });
    send({ type: 'ready', ...credentials, fileId, state: await snapshot() });
} catch {
    send({ type: 'failure', message: 'VOD fixture startup failed' });
    await close().catch(() => undefined);
    process.exit(1);
}
