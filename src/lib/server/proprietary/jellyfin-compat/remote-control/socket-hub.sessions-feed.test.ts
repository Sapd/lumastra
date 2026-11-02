// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The socket's `Sessions` feed over a real WebSocket: a client repeating
 * `SessionsStart` must not make the server rebuild the session list once per
 * frame, and a slow build must not let builds pile up.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const h = vi.hoisted(() => ({
    build: vi.fn(),
}));

vi.mock('../auth', () => ({
    validateSession: vi.fn(async () => ({
        userId: '00000000-0000-4000-8000-000000000001',
        username: 'feeduser',
        isAdmin: false,
        groups: [],
        displayName: null,
        deviceId: 'dev-1',
        deviceName: 'TV',
        clientName: 'Jellyfin Android TV',
        clientVersion: '0.18.0',
        createdAt: new Date().toISOString(),
    })),
}));
vi.mock('$lib/server/auth/resolve-token-user-access', () => ({
    resolveTokenUserAccess: vi.fn(async () => ({
        disabled: false,
        deleted: false,
        userGroups: [],
        permissions: { isAdmin: false },
    })),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('./device-registry', () => ({
    clearPresence: vi.fn(async () => undefined),
    refreshPresence: vi.fn(async () => undefined),
    touchDevices: vi.fn(async () => undefined),
    upsertDevice: vi.fn(async () => undefined),
    remoteSessionId: (a: string, b: string) => `${a}:${b}`,
}));
vi.mock('./fanout', () => ({ ensureFanoutSubscription: vi.fn(async () => true) }));
vi.mock('./sessions-list', () => ({ buildSessionList: h.build }));

const { handleJellyfinSocketUpgrade, closeAllSockets, SESSIONS_FEED_MIN_INTERVAL_MS } =
    await import('./socket-hub');

let server: Server;
let port: number;

beforeEach(async () => {
    h.build.mockReset();
    h.build.mockResolvedValue([]);
    server = createServer();
    server.on('upgrade', handleJellyfinSocketUpgrade);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
    closeAllSockets();
    await new Promise<void>((r) => server.close(() => r()));
});

/** Open a socket and wait for the server's greeting (registration done). */
async function connect(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/j/socket?api_key=tok`);
    await new Promise<void>((resolve, reject) => {
        ws.once('error', reject);
        ws.on('message', (raw) => {
            const msg = JSON.parse(String(raw)) as { MessageType: string };
            if (msg.MessageType === 'ForceKeepAlive') resolve();
        });
    });
    return ws;
}

const sessionsStart = JSON.stringify({ MessageType: 'SessionsStart', Data: '0,1500' });

/** Round-trip a KeepAlive so every frame sent before it has been handled. */
async function flush(ws: WebSocket): Promise<void> {
    await new Promise<void>((resolve) => {
        const onMsg = (raw: unknown): void => {
            if ((JSON.parse(String(raw)) as { MessageType: string }).MessageType === 'KeepAlive') {
                ws.off('message', onMsg);
                resolve();
            }
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ MessageType: 'KeepAlive' }));
    });
}

describe('socket-hub Sessions feed', () => {
    it('100 SessionsStart frames cause one immediate build and one deferred build', async () => {
        const ws = await connect();
        for (let i = 0; i < 100; i++) ws.send(sessionsStart);
        await flush(ws);
        expect(h.build).toHaveBeenCalledTimes(1);

        // The deferred first push of the last SessionsStart fires once the
        // minimum interval since the first build has passed.
        await new Promise((r) => setTimeout(r, SESSIONS_FEED_MIN_INTERVAL_MS + 300));
        expect(h.build).toHaveBeenCalledTimes(2);
        ws.close();
    });

    it('never runs two builds at once for one socket', async () => {
        let release: () => void = () => undefined;
        h.build.mockImplementation(() => new Promise((r) => (release = () => r([]))));
        const ws = await connect();
        ws.send(sessionsStart);
        await flush(ws);
        expect(h.build).toHaveBeenCalledTimes(1);

        // The interval tick (and a deferred kick) arrive while the build hangs.
        await new Promise((r) => setTimeout(r, SESSIONS_FEED_MIN_INTERVAL_MS + 300));
        expect(h.build).toHaveBeenCalledTimes(1);

        release();
        await new Promise((r) => setTimeout(r, SESSIONS_FEED_MIN_INTERVAL_MS + 300));
        expect(h.build).toHaveBeenCalledTimes(2);
        ws.close();
    });

    it('SessionsStop cancels a deferred push', async () => {
        const ws = await connect();
        ws.send(sessionsStart);
        ws.send(sessionsStart);
        ws.send(JSON.stringify({ MessageType: 'SessionsStop' }));
        await flush(ws);
        await new Promise((r) => setTimeout(r, SESSIONS_FEED_MIN_INTERVAL_MS + 300));
        expect(h.build).toHaveBeenCalledTimes(1);
        ws.close();
    });
});
