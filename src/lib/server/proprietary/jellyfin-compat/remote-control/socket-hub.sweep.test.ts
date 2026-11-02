// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The keep-alive / revocation sweep over a real WebSocket: overlapping sweeps
 * must not re-validate the same sockets twice.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const h = vi.hoisted(() => {
    const session = {
        userId: '00000000-0000-4000-8000-000000000001',
        username: 'sweepuser',
        isAdmin: false,
        groups: [],
        displayName: null,
        deviceId: 'dev-1',
        deviceName: 'TV',
        clientName: 'Jellyfin Android TV',
        clientVersion: '0.18.0',
        createdAt: new Date().toISOString(),
    };
    return { session, validateSession: vi.fn() };
});

vi.mock('../auth', () => ({ validateSession: h.validateSession }));
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
vi.mock('./sessions-list', () => ({ buildSessionList: vi.fn(async () => []) }));

const { handleJellyfinSocketUpgrade, closeAllSockets, sweepSockets } = await import('./socket-hub');

let server: Server;
let port: number;

beforeEach(async () => {
    h.validateSession.mockReset();
    h.validateSession.mockResolvedValue(h.session);
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

describe('socket-hub sweep', () => {
    it('rejects an upgrade with retryable 503 during an authentication dependency outage', async () => {
        const { AuthDependencyUnavailableError } =
            await import('$lib/server/auth/dependency-unavailable.js');
        h.validateSession.mockRejectedValue(new AuthDependencyUnavailableError());
        const ws = new WebSocket(`ws://127.0.0.1:${port}/j/socket?api_key=tok`);
        const response = await new Promise<{ status?: number; retryAfter?: string }>(
            (resolve, reject) => {
                ws.once('unexpected-response', (_req, res) => {
                    resolve({
                        status: res.statusCode,
                        retryAfter: String(res.headers['retry-after']),
                    });
                    res.resume();
                    ws.terminate();
                });
                ws.once('error', () => {});
                ws.once('open', () => {
                    ws.close();
                    reject(new Error('unexpectedly authenticated'));
                });
            },
        );
        expect(response).toEqual({ status: 503, retryAfter: '5' });
    });

    it('two concurrent sweeps re-validate each socket once', async () => {
        const a = await connect();
        const b = await connect();
        h.validateSession.mockClear();
        const pending: Array<() => void> = [];
        h.validateSession.mockImplementation(
            () => new Promise((r) => pending.push(() => r(h.session))),
        );

        const first = sweepSockets();
        const second = sweepSockets();
        // Release every validation the sweeps started, one at a time.
        while (true) {
            await new Promise((r) => setTimeout(r, 10));
            const next = pending.shift();
            if (!next) break;
            next();
        }
        await Promise.all([first, second]);

        expect(h.validateSession).toHaveBeenCalledTimes(2);
        a.close();
        b.close();
    });

    it('sends ForceKeepAlive to a socket silent for 41 s, before the 60 s drop', async () => {
        const ws = await connect();
        const received: string[] = [];
        ws.on('message', (raw) => {
            received.push((JSON.parse(String(raw)) as { MessageType: string }).MessageType);
        });

        await sweepSockets(Date.now() + 41_000);
        await new Promise((r) => setTimeout(r, 100));

        expect(received).toContain('ForceKeepAlive');
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
    });
});
