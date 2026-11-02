// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Qualification-only HTTP adapter. Auth, mounted handlers, stores and media are real.
 * This deliberately does not implement SvelteKit hooks/routing or a player UI.
 * Credentials leave this process only over its private parent IPC channel.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { def as keepaliveDef } from '$lib/server/api/defs/livetv/playback-sessions/[playbackSessionId]/keepalive.js';
import { def as leaveDef } from '$lib/server/api/defs/livetv/playback-sessions/[playbackSessionId]/leave.js';
import { def as mediaDef } from '$lib/server/api/defs/livetv/channels/[id]/stream/[segment].js';
import { def as logoutDef } from '$lib/server/api/defs/auth/logout.js';
import { getDb, closeDb } from '$lib/server/database/connection.js';
import { createChannelWithMediaItem } from '$lib/server/database/queries/livetv-channels.queries.js';
import { syncUserGroups } from '$lib/server/services/user-groups.service.js';
import { getRefreshTokenService } from '$lib/server/oauth/refresh-token.service.js';
import { generateAccessToken } from '$lib/server/oauth/jwt.js';
import { deriveLiveTvViewerKey } from '$lib/server/services/livetv/livetv-viewer-key.js';
import {
    getLiveTvSessionService,
    type LiveTvPlaybackSession,
} from '$lib/server/services/livetv/livetv-session.service.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import {
    connectValkey,
    disconnectValkey,
    closeAllSubscriptions,
    cacheDel,
    isValkeyHealthy,
    isCoordinationValkeyHealthy,
} from '$lib/server/cache/valkey.js';
import { stopAuthCacheInvalidationSubscriber } from '$lib/server/cache/auth-cache-bus.js';
import { requireClient } from '$lib/server/tasks/valkey-types.js';
import { toUserId } from '$lib/shared/user-id.js';
import { startNativeProxy, type NativeProxyFixture } from '../../../tests/helpers/native-proxy.js';
import { SegmentServer } from '../../../tests/helpers/segment-server.js';

interface Input {
    id: string;
    channelId: string;
    sourceId: string;
    port: number;
    proxyPort: number;
}
const input = JSON.parse(process.argv[2]) as Input;
assert(process.env.WORKER_MODE === 'disabled', 'Playback host must never run task workers');
const requiredSql = getDb();
assert(requiredSql, 'Playback SQL unavailable');
const sql = requiredSql;
const source = new SegmentServer();
const sessions = getLiveTvSessionService();
const users: string[] = [];
const deviceIds: string[] = [];
let playback: LiveTvPlaybackSession | undefined;
let proxy: NativeProxyFixture | undefined;
let web: http.Server | undefined;
let shutdown: Promise<void> | undefined;
let storeConnected = false;
let sourceCreated = false;
let channelCreated = false;

function send(message: object): void {
    if (process.connected) process.send?.(message);
}

function eventFor(
    url: URL,
    method: string,
    headers: Headers,
    params: Record<string, string>,
    route: string,
): RequestEvent {
    // RequestEvent plumbing only: identity is always produced by resolveAuth.
    return {
        url,
        request: new Request(url, { method, headers }),
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

const keepalive = mount(keepaliveDef, { surface: 'v1' }).POST!;
const leave = mount(leaveDef, { surface: 'v1' }).POST!;
const media = mount(mediaDef, { surface: 'v1' }).GET!;
const logout = mount(logoutDef, { surface: 'v1' }).POST!;

async function serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${input.port}`);
    let handler: RequestHandler | undefined;
    let params: Record<string, string> = {};
    let route = '';
    const sessionMatch =
        /^\/api\/v1\/livetv\/playback-sessions\/([0-9a-f-]+)\/(keepalive|leave)$/.exec(
            url.pathname,
        );
    const mediaMatch = /^\/api\/v1\/livetv\/channels\/([0-9a-f-]+)\/stream\/([^/]+)$/.exec(
        url.pathname,
    );
    if (request.method === 'POST' && sessionMatch) {
        handler = sessionMatch[2] === 'keepalive' ? keepalive : leave;
        params = { playbackSessionId: sessionMatch[1] };
        route = `/api/v1/livetv/playback-sessions/[playbackSessionId]/${sessionMatch[2]}`;
    } else if (request.method === 'GET' && mediaMatch) {
        handler = media;
        params = { id: mediaMatch[1], path: mediaMatch[2] };
        route = '/api/v1/livetv/channels/[id]/stream/[...path]';
    } else if (request.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
        handler = logout;
        route = '/api/v1/auth/logout';
    }
    if (!handler) {
        response.writeHead(404).end();
        return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    }
    const event = eventFor(url, request.method!, headers, params, route);
    const denial = await resolveAuth(
        event,
        async () => {
            throw new Error('Unexpected migration');
        },
        true,
    );
    const result = denial ?? (await handler(event));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    // Bounded fixture segments only. Production auth, media handler and proxy HTTP
    // fetch above are unchanged; generic streaming/backpressure is outside this test.
    response.end(Buffer.from(await result.arrayBuffer()));
}

async function device(username: string): Promise<string> {
    const userId = users
        .find((value) => value.startsWith(`${username}:`))
        ?.slice(username.length + 1);
    assert(userId, 'Fixture user missing');
    const deviceSessionId = randomUUID();
    deviceIds.push(deviceSessionId);
    await getRefreshTokenService().create({
        userId: toUserId(userId),
        clientId: 'playback-continuity',
        groups: ['livetv'],
        deviceSessionId,
    });
    return generateAccessToken({
        username,
        clientId: 'playback-continuity',
        groups: ['livetv'],
        deviceSessionId,
    });
}

function reservationKeys(): string[] {
    if (!playback) return [];
    return [
        `livetv:v2:psess:${playback.sessionId}`,
        `livetv:v2:viewer-psess:${playback.viewerKey}`,
        `livetv:v2:session:${playback.viewerKey}`,
    ];
}

async function snapshot(): Promise<object> {
    assert(playback, 'Playback not established');
    const client = requireClient();
    const keys = reservationKeys();
    return {
        hostPid: process.pid,
        proxyPort: input.proxyPort,
        ingestPid: proxy!.ingestPid(),
        session: await sessions.getPlaybackSession(playback.sessionId),
        pointer: await client.customCommand(['GET', keys[1]]),
        viewer: await sessions.getSession(playback.viewerKey),
        members: await client.customCommand([
            'SMEMBERS',
            `livetv:v2:source:${input.sourceId}:sessions`,
        ]),
        ttlMs: await Promise.all(keys.map((key) => client.customCommand(['PTTL', key]))),
        proxyViewers: (await proxy!.status()).channels.find(
            (entry) => entry.channelId === input.channelId,
        )?.viewers,
    };
}

async function closeServer(server: http.Server | undefined): Promise<void> {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}

function close(): Promise<void> {
    shutdown ??= (async () => {
        const failures: unknown[] = [];
        const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
            try {
                await operation();
            } catch (error) {
                failures.push(error);
            }
        };
        await attempt(() => closeServer(web));
        if (playback) {
            await attempt(() =>
                getStreamProxyClient().leaveChannel(input.channelId, playback!.viewerKey),
            );
            await attempt(() => sessions.releasePlaybackSession(playback!));
            await attempt(() =>
                sessions.removeSessionIfChannel(
                    playback!.viewerKey,
                    input.sourceId,
                    input.channelId,
                ),
            );
        }
        await attempt(async () => {
            await proxy?.stop();
        });
        await attempt(() => source.stop());
        if (storeConnected) {
            const keys = [...reservationKeys(), `livetv:v2:source:${input.sourceId}:sessions`];
            if (playback)
                keys.push(
                    `livetv:v2:kicked:${playback.viewerKey}`,
                    `livetv:v2:psess-lock:${playback.viewerKey}`,
                );
            await attempt(() => requireClient().customCommand(['DEL', ...keys]));
            for (const id of deviceIds)
                await attempt(() => cacheDel(`device-session-revoked:v1:${id}`));
        }
        if (channelCreated)
            await attempt(() => sql`DELETE FROM media_items WHERE id = ${input.channelId}`);
        if (sourceCreated)
            await attempt(() => sql`DELETE FROM livetv_sources WHERE id = ${input.sourceId}`);
        for (const user of users)
            await attempt(
                () => sql`DELETE FROM users WHERE id = ${user.slice(user.indexOf(':') + 1)}`,
            );
        stopAuthCacheInvalidationSubscriber();
        await attempt(closeAllSubscriptions);
        await attempt(disconnectValkey);
        await attempt(closeDb);
        if (failures.length)
            throw new AggregateError(failures, 'Playback fixture cleanup incomplete');
        send({ type: 'cleaned' });
    })();
    return shutdown;
}

process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('operation' in message)) return;
    if (message.operation === 'snapshot' && 'id' in message) {
        void snapshot().then(
            (state) => send({ type: 'snapshot', id: message.id, state }),
            () => send({ type: 'failure', message: 'Snapshot failed' }),
        );
    } else if (message.operation === 'close') {
        void close().then(
            () => process.exit(0),
            () => process.exit(1),
        );
    }
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
        void close().then(
            () => process.exit(0),
            () => process.exit(1),
        );
    });
process.on('disconnect', () => {
    void close().then(
        () => process.exit(0),
        () => process.exit(1),
    );
});
const deadline = setTimeout(() => {
    void close().finally(() => process.exit(1));
}, 330_000);
deadline.unref();

try {
    assert(await connectValkey(), 'Fixture Valkey connection failed');
    storeConnected = true;
    assert(await isValkeyHealthy(), 'Application cache must be reachable');
    assert(await isCoordinationValkeyHealthy(), 'Coordination Valkey must be reachable');
    await source.start();
    await sql`INSERT INTO livetv_sources (id, name, source_type, max_streams) VALUES (${input.sourceId}, ${`Continuity ${input.id}`}, 'm3u', 1)`;
    sourceCreated = true;
    await createChannelWithMediaItem(sql, {
        id: input.channelId,
        name: `Continuity ${input.id}`,
        streamUrl: source.url,
        sourceId: input.sourceId,
    });
    channelCreated = true;
    const usernames = [`continuity_${input.id}_owner`, `continuity_${input.id}_foreign`];
    for (const username of usernames) {
        const [row] = await sql<
            { id: string }[]
        >`INSERT INTO users (username) VALUES (${username}) RETURNING id`;
        users.push(`${username}:${row.id}`);
        await syncUserGroups(sql, username, ['livetv']);
    }
    const ownerToken = await device(usernames[0]);
    const foreignToken = await device(usernames[1]);
    const revokedToken = await device(usernames[0]);
    proxy = await startNativeProxy(input.proxyPort);
    const setup = eventFor(
        new URL(
            `http://127.0.0.1:${input.port}/api/v1/livetv/playback-sessions/${randomUUID()}/keepalive`,
        ),
        'POST',
        new Headers({ authorization: `Bearer ${ownerToken}` }),
        {},
        '/api/v1/livetv/playback-sessions/[playbackSessionId]/keepalive',
    );
    assert.equal(
        await resolveAuth(
            setup,
            async () => {
                throw new Error('Unexpected migration');
            },
            true,
        ),
        undefined,
        'Actual owner authentication failed',
    );
    const viewerKey = deriveLiveTvViewerKey(setup);
    const joined = await getStreamProxyClient().joinChannel(input.channelId, {
        viewerId: viewerKey,
        streamUrls: [source.url],
        sourceId: input.sourceId,
        maxStreams: 1,
        channelName: 'Continuity',
        allowPrivateUrls: true,
    });
    assert('success' in joined && joined.success, 'Actual proxy join failed');
    await sessions.registerSession(viewerKey, usernames[0], input.channelId, input.sourceId, 'low');
    playback = await sessions.startPlaybackSession({
        viewerKey,
        username: usernames[0],
        stationId: input.channelId,
        feedId: input.channelId,
        sourceId: input.sourceId,
    });
    web = http.createServer((request, response) => {
        void serve(request, response).catch(() => {
            if (!response.headersSent) response.writeHead(500);
            response.end();
        });
    });
    await new Promise<void>((resolve, reject) => {
        web!.once('error', reject);
        web!.listen(input.port, '127.0.0.1', resolve);
    });
    const mediaDeadline = Date.now() + 30_000;
    while (
        !(await proxy!.status()).channels.some(
            (channel) => channel.channelId === input.channelId && (channel.segmentCount ?? 0) > 0,
        )
    ) {
        assert(Date.now() < mediaDeadline, 'Actual ingest produced no complete segment');
        // Establishment only. Once ready is sent, ONLY parent HTTP keepalives
        // maintain presence; there is no background fixture heartbeat or rejoin.
        const response: Response = await fetch(
            `http://127.0.0.1:${input.port}/api/v1/livetv/playback-sessions/${playback.sessionId}/keepalive`,
            {
                method: 'POST',
                headers: { authorization: `Bearer ${ownerToken}` },
                signal: AbortSignal.timeout(6000),
            },
        );
        assert.equal(response.status, 204, 'Establishment keepalive failed');
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    send({
        type: 'ready',
        ownerToken,
        foreignToken,
        revokedToken,
        sessionId: playback.sessionId,
        viewerKey,
        state: await snapshot(),
    });
} catch (error) {
    send({
        type: 'failure',
        message: error instanceof Error ? error.message : 'Actual playback fixture startup failed',
    });
    await close().catch(() => undefined);
    process.exit(1);
}
