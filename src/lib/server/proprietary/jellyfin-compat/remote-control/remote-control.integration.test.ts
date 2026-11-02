// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * End-to-end remote control over real PG + Valkey: a real HTTP server with the
 * upgrade dispatcher, a "TV" and a "phone" connected to /j/socket with real /j
 * session tokens, and the real route handlers driving commands between them.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import WebSocket from 'ws';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../../tests/integration/fixtures/user.fixtures.js';
import { jfEvent, mintJfSession } from '../../../../../../tests/jellyfin-contract/harness';
import {
    cacheDel,
    connectValkey,
    disconnectValkey,
    publishMessage,
} from '$lib/server/cache/valkey.js';
import { attachUpgradeDispatch } from '$lib/server/utils/http-upgrade';
import { getContractDigest } from '../contract/digest';
import { validateAgainstSchema, validateJellyfinResponse } from '../contract/validate';
import { invalidateUserAdminCache } from '$lib/server/cache/user-admin-cache';
import { createSession, revokeSession } from '../auth';
import { DEVICE_KEYS, remoteSessionId } from './device-registry';
import { DELIVER_CHANNEL } from './fanout';
import { registerJellyfinRemoteControl } from './register';
import { closeAllSockets, openSocketCount, sweepSockets } from './socket-hub';
import { POST as viewingPost } from '../../../../../routes/(proprietary)/j/Sessions/Viewing/+server';
import { GET as sessionsGet } from '../../../../../routes/(proprietary)/j/Sessions/+server';
import { POST as capabilitiesFullPost } from '../../../../../routes/(proprietary)/j/Sessions/Capabilities/Full/+server';
import { POST as playstatePost } from '../../../../../routes/(proprietary)/j/Sessions/[sessionId]/Playing/[command]/+server';
import { POST as messagePost } from '../../../../../routes/(proprietary)/j/Sessions/[sessionId]/Message/+server';
import type { JellyfinSessionInfo } from '../types';

const OWNER = '00000000-0000-4000-8000-00000000ac01';
const OTHER = '00000000-0000-4000-8000-00000000ac02';

type Handler = (e: never) => Promise<Response>;
const call = (h: unknown, e: unknown): Promise<Response> => (h as Handler)(e as never);

let sql: postgres.Sql;
let server: Server;
let port: number;
let ownerName: string;
let otherName: string;
const open: WebSocket[] = [];

interface Frame {
    MessageType: string;
    MessageId?: string;
    Data?: unknown;
}

/** Connected client that buffers frames so none is missed between awaits. */
class TestSocket {
    readonly frames: Frame[] = [];
    private waiters: { type: string; resolve: (f: Frame) => void }[] = [];
    closeCode: number | null = null;
    readonly closed: Promise<number>;

    constructor(readonly ws: WebSocket) {
        ws.on('message', (raw) => {
            const frame = JSON.parse(String(raw)) as Frame;
            const i = this.waiters.findIndex((w) => w.type === frame.MessageType);
            if (i !== -1) this.waiters.splice(i, 1)[0].resolve(frame);
            else this.frames.push(frame);
        });
        this.closed = new Promise((r) =>
            ws.on('close', (code) => {
                this.closeCode = code;
                r(code);
            }),
        );
    }

    next(type: string, timeoutMs = 3000): Promise<Frame> {
        const i = this.frames.findIndex((f) => f.MessageType === type);
        if (i !== -1) return Promise.resolve(this.frames.splice(i, 1)[0]);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`no ${type} frame within ${timeoutMs} ms`)),
                timeoutMs,
            );
            this.waiters.push({
                type,
                resolve: (f) => {
                    clearTimeout(timer);
                    resolve(f);
                },
            });
        });
    }

    send(obj: unknown): void {
        this.ws.send(JSON.stringify(obj));
    }
}

function connect(query: string, headers: Record<string, string> = {}): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/j/socket${query}`, { headers });
        open.push(ws);
        const sock = new TestSocket(ws);
        ws.once('open', () => resolve(sock));
        ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        ws.once('error', reject);
    });
}

function sdkErrors(schema: string, body: unknown): string[] {
    return validateAgainstSchema(getContractDigest(), schema, body, {
        clientName: 'Jellyfin Android TV',
    })
        .filter((v) => v.severity === 'error')
        .map((v) => `${v.pointer} ${v.property} ${v.kind}`);
}

async function listSessions(token: string, query = ''): Promise<JellyfinSessionInfo[]> {
    const event = jfEvent({ method: 'GET', path: `/j/Sessions${query}`, token, params: {} });
    const res = await call(sessionsGet, event);
    expect(res.status).toBe(200);
    const body = (await res.json()) as JellyfinSessionInfo[];
    const contract = validateJellyfinResponse('GET', '/j/Sessions', body, {
        clientName: 'Jellyfin Android TV',
    });
    expect(contract.unmatched).toBe(false);
    expect(contract.violations.filter((v) => v.severity === 'error')).toEqual([]);
    return body;
}

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
    server = createServer((_req, res) => res.end('plain'));
    attachUpgradeDispatch(server);
    registerJellyfinRemoteControl();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    closeAllSockets();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await disconnectValkey();
    await closeTestDb();
});

beforeEach(async () => {
    await cacheDel(DEVICE_KEYS);
    await ensureTestUser(sql, OWNER);
    await ensureTestUser(sql, OTHER);
    [{ username: ownerName }] = await sql<{ username: string }[]>`
        SELECT username FROM users WHERE id = ${OWNER}`;
    [{ username: otherName }] = await sql<{ username: string }[]>`
        SELECT username FROM users WHERE id = ${OTHER}`;
});

afterEach(async () => {
    for (const ws of open.splice(0)) ws.terminate();
    closeAllSockets();
});

describe('/j/socket remote control', () => {
    it('rejects an upgrade without a valid token', async () => {
        await expect(connect('?api_key=nope')).rejects.toThrow('HTTP 401');
        await expect(connect('')).rejects.toThrow('HTTP 401');
    });

    it('greets with ForceKeepAlive and echoes KeepAlive (header auth works too)', async () => {
        const token = await mintJfSession(sql, {
            userId: OWNER,
            username: ownerName,
            deviceId: 'tv-1',
        });
        const tv = await connect('', {
            'X-Emby-Authorization': `MediaBrowser Client="Jellyfin Android TV", Token="${token}"`,
        });
        const hello = await tv.next('ForceKeepAlive');
        expect(hello.Data).toBe(60);
        expect(sdkErrors('ForceKeepAliveMessage', hello)).toEqual([]);
        tv.send({ MessageType: 'KeepAlive' });
        expect(sdkErrors('OutboundKeepAliveMessage', await tv.next('KeepAlive'))).toEqual([]);
    });

    it('delivers a Playstate command from the phone to the TV and lists the TV as controllable', async () => {
        const tvToken = await mintJfSession(sql, {
            userId: OWNER,
            username: ownerName,
            deviceId: 'tv-1',
        });
        const phoneToken = await mintJfSession(sql, {
            userId: OWNER,
            username: ownerName,
            deviceId: 'phone-1',
            client: 'Jellyfin Android',
        });

        // The TV reports capabilities, then opens its socket.
        const caps = await call(
            capabilitiesFullPost,
            jfEvent({
                method: 'POST',
                path: '/j/Sessions/Capabilities/Full',
                token: tvToken,
                deviceId: 'tv-1',
                params: {},
                body: {
                    PlayableMediaTypes: ['Video', 'Audio'],
                    SupportedCommands: ['DisplayMessage', 'SetVolume', 'NotACommand'],
                    SupportsMediaControl: true,
                },
            }),
        );
        expect(caps.status).toBe(204);
        const tv = await connect(`?api_key=${tvToken}&deviceId=tv-1`);
        await tv.next('ForceKeepAlive');

        // The phone (controller) also holds a socket and watches the session list.
        const phone = await connect(`?api_key=${phoneToken}&deviceId=phone-1`);
        await phone.next('ForceKeepAlive');
        phone.send({ MessageType: 'SessionsStart', Data: '0,2000' });
        const feed = await phone.next('Sessions');
        expect(sdkErrors('SessionsMessage', feed)).toEqual([]);

        const tvId = remoteSessionId(OWNER, 'tv-1');
        const fromFeed = (feed.Data as JellyfinSessionInfo[]).find((s) => s.Id === tvId);
        expect(fromFeed).toMatchObject({
            DeviceId: 'tv-1',
            SupportsRemoteControl: true,
            SupportsMediaControl: true,
            PlayableMediaTypes: ['Video', 'Audio'],
            SupportedCommands: ['DisplayMessage', 'SetVolume'],
        });

        const controllable = await listSessions(
            phoneToken,
            `?controllableByUserId=${OWNER.replace(/-/g, '')}`,
        );
        expect(controllable.map((s) => s.Id)).toEqual([tvId]);

        const res = await call(
            playstatePost,
            jfEvent({
                method: 'POST',
                path: `/j/Sessions/${tvId}/Playing/Seek?seekPositionTicks=1200000000`,
                token: phoneToken,
                deviceId: 'phone-1',
                params: { sessionId: tvId, command: 'Seek' },
            }),
        );
        expect(res.status).toBe(204);
        const playstate = await tv.next('Playstate');
        expect(playstate.Data).toEqual({
            Command: 'Seek',
            SeekPositionTicks: 1200000000,
            ControllingUserId: OWNER.replace(/-/g, ''),
        });
        expect(sdkErrors('PlaystateMessage', playstate)).toEqual([]);
        // The controller's own socket did not get the TV's command.
        expect(phone.frames.some((f) => f.MessageType === 'Playstate')).toBe(false);
    });

    it('delivers a command published by another replica through Valkey', async () => {
        const tvToken = await mintJfSession(sql, {
            userId: OWNER,
            username: ownerName,
            deviceId: 'tv-2',
        });
        const tv = await connect(`?api_key=${tvToken}`);
        await tv.next('ForceKeepAlive');
        const tvId = remoteSessionId(OWNER, 'tv-2');
        const payload = JSON.stringify({
            MessageType: 'GeneralCommand',
            MessageId: 'ffffffffffffffffffffffffffffffff',
            Data: { Name: 'GoHome', ControllingUserId: OWNER.replace(/-/g, ''), Arguments: {} },
        });
        await publishMessage(
            DELIVER_CHANNEL,
            JSON.stringify({ origin: 'another-replica', sessionId: tvId, payload }),
        );
        const cmd = await tv.next('GeneralCommand');
        expect((cmd.Data as { Name: string }).Name).toBe('GoHome');
    });

    it('does not let another user control the TV (404, nothing delivered)', async () => {
        const tvToken = await mintJfSession(sql, {
            userId: OWNER,
            username: ownerName,
            deviceId: 'tv-3',
        });
        const strangerToken = await mintJfSession(sql, {
            userId: OTHER,
            username: otherName,
            deviceId: 'stranger-phone',
        });
        const tv = await connect(`?api_key=${tvToken}`);
        await tv.next('ForceKeepAlive');
        const tvId = remoteSessionId(OWNER, 'tv-3');

        const res = await call(
            messagePost,
            jfEvent({
                method: 'POST',
                path: `/j/Sessions/${tvId}/Message`,
                token: strangerToken,
                deviceId: 'stranger-phone',
                params: { sessionId: tvId },
                body: { Text: 'hello' },
            }),
        );
        expect(res.status).toBe(404);
        expect((await listSessions(strangerToken)).some((s) => s.Id === tvId)).toBe(false);
        await new Promise((r) => setTimeout(r, 150));
        expect(tv.frames.some((f) => f.MessageType === 'GeneralCommand')).toBe(false);
    });

    it('closes the socket once its token is revoked and stops listing it as controllable', async () => {
        const tvToken = await mintJfSession(sql, {
            userId: OWNER,
            username: ownerName,
            deviceId: 'tv-4',
        });
        await call(
            capabilitiesFullPost,
            jfEvent({
                method: 'POST',
                path: '/j/Sessions/Capabilities/Full',
                token: tvToken,
                deviceId: 'tv-4',
                params: {},
                body: { SupportsMediaControl: true },
            }),
        );
        const tv = await connect(`?api_key=${tvToken}`);
        await tv.next('ForceKeepAlive');
        expect(openSocketCount()).toBe(1);
        const tvId = remoteSessionId(OWNER, 'tv-4');

        const adminView = await listSessions(tvToken);
        expect(adminView.find((s) => s.Id === tvId)?.SupportsRemoteControl).toBe(true);

        await revokeSession(tvToken);
        await sweepSockets();
        expect(await tv.closed).toBe(1008);
        expect(openSocketCount()).toBe(0);

        const phoneToken = await mintJfSession(sql, {
            userId: OWNER,
            username: ownerName,
            deviceId: 'phone-4',
        });
        const after = await listSessions(phoneToken);
        expect(after.find((s) => s.Id === tvId)?.SupportsRemoteControl).toBe(false);
    });
});

describe('admin-owned Quick Connect remote-control authority', () => {
    it.each(['http', 'socket'] as const)(
        'cannot list another owner through %s',
        async (surface) => {
            await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${OTHER}::uuid`;
            invalidateUserAdminCache(otherName);
            try {
                const foreign = await mintJfSession(sql, {
                    userId: OWNER,
                    username: ownerName,
                    deviceId: 'foreign-qc-tv',
                });
                const target = await connect(`?api_key=${foreign}`);
                await target.next('ForceKeepAlive');
                const targetId = remoteSessionId(OWNER, 'foreign-qc-tv');
                const qc = (await createSession({
                    userId: OTHER,
                    username: otherName,
                    origin: 'quick_connect',
                    isAdmin: true,
                    groups: [],
                    displayName: null,
                    deviceId: 'admin-qc-controller',
                    deviceName: 'TV',
                    clientName: 'Jellyfin',
                    clientVersion: '1',
                    createdAt: new Date().toISOString(),
                }))!;
                expect(qc).not.toBeNull();
                if (surface === 'socket') {
                    const controller = await connect(`?api_key=${qc}`);
                    await controller.next('ForceKeepAlive');
                    controller.send({ MessageType: 'SessionsStart', Data: '0,2000' });
                    const list = (await controller.next('Sessions')).Data as JellyfinSessionInfo[];
                    expect(list.some((s) => s.Id === targetId)).toBe(false);
                } else {
                    const e = jfEvent({
                        method: 'GET',
                        path: '/j/Sessions',
                        token: qc,
                        params: {},
                    });
                    const response = await call(sessionsGet, e);
                    expect(e.locals.user.ownerIsAdmin).toBe(true);
                    const list = (await response.json()) as JellyfinSessionInfo[];
                    expect(list.some((s) => s.Id === targetId)).toBe(false);
                    for (const [handler, path, body] of [
                        [messagePost, `/j/Sessions/${targetId}/Message`, { Text: 'foreign' }],
                        [
                            capabilitiesFullPost,
                            `/j/Sessions/Capabilities/Full?id=${targetId}`,
                            { SupportsMediaControl: true },
                        ],
                        [
                            viewingPost,
                            `/j/Sessions/Viewing?sessionId=${targetId}&itemId=abcdefab1234456789ababcdefabcdef`,
                            {},
                        ],
                    ] as const) {
                        expect(
                            (
                                await call(
                                    handler,
                                    jfEvent({
                                        method: 'POST',
                                        path,
                                        token: qc,
                                        params: { sessionId: targetId },
                                        body,
                                    }),
                                )
                            ).status,
                        ).toBe(404);
                    }
                    const own = remoteSessionId(OTHER, 'admin-qc-controller');
                    const ownSocket = await connect(`?api_key=${qc}`);
                    await ownSocket.next('ForceKeepAlive');
                    expect(
                        (
                            await call(
                                messagePost,
                                jfEvent({
                                    method: 'POST',
                                    path: `/j/Sessions/${own}/Message`,
                                    token: qc,
                                    params: { sessionId: own },
                                    body: { Text: 'own' },
                                }),
                            )
                        ).status,
                    ).toBe(204);
                }
            } finally {
                await sql`UPDATE users SET is_admin = false, admin_pinned = false WHERE id = ${OTHER}::uuid`;
                invalidateUserAdminCache(otherName);
            }
        },
    );
});

it('password-authenticated admins retain foreign-device control', async () => {
    await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${OTHER}::uuid`;
    invalidateUserAdminCache(otherName);
    try {
        const foreign = await mintJfSession(sql, {
            userId: OWNER,
            username: ownerName,
            deviceId: 'password-control-target',
        });
        const target = await connect(`?api_key=${foreign}`);
        await target.next('ForceKeepAlive');
        const id = remoteSessionId(OWNER, 'password-control-target');
        const admin = await mintJfSession(sql, {
            userId: OTHER,
            username: otherName,
            deviceId: 'admin-password-phone',
        });
        expect((await listSessions(admin)).some((s) => s.Id === id)).toBe(true);
        expect(
            (
                await call(
                    messagePost,
                    jfEvent({
                        method: 'POST',
                        path: `/j/Sessions/${id}/Message`,
                        token: admin,
                        params: { sessionId: id },
                        body: { Text: 'admin' },
                    }),
                )
            ).status,
        ).toBe(204);
    } finally {
        await sql`UPDATE users SET is_admin = false, admin_pinned = false WHERE id = ${OTHER}::uuid`;
        invalidateUserAdminCache(otherName);
    }
});
