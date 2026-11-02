// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    __resetUpgradeRoutesForTests,
    attachUpgradeDispatch,
    registerUpgradeHandler,
    upgradePathname,
} from './http-upgrade';

let server: Server;
let port: number;

beforeEach(async () => {
    __resetUpgradeRoutesForTests();
    server = createServer((req, res) => res.end(`plain ${req.url}`));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
});

/** Send an Upgrade request; resolve with 'upgraded' or the plain status + body. */
function upgradeRequest(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = request({
            port,
            host: '127.0.0.1',
            path,
            headers: { Connection: 'Upgrade', Upgrade: 'h2c' },
        });
        req.on('upgrade', (_res, socket) => {
            socket.destroy();
            resolve('upgraded');
        });
        req.on('response', (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(`${res.statusCode} ${body}`));
        });
        req.on('error', reject);
        req.end();
    });
}

const answer101 = (_req: unknown, socket: import('node:stream').Duplex): void => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n');
};

describe('attachUpgradeDispatch', () => {
    it('claims a registered path', async () => {
        registerUpgradeHandler('t', (p) => p === '/j/socket', answer101);
        expect(attachUpgradeDispatch(server)).toBe(true);
        expect(await upgradeRequest('/j/socket?api_key=x')).toBe('upgraded');
    });

    it('leaves every other Upgrade request on the ordinary request path', async () => {
        registerUpgradeHandler('t', (p) => p === '/j/socket', answer101);
        attachUpgradeDispatch(server);
        // curl --http2 sends `Upgrade: h2c` on plain requests; it must still get its page.
        expect(await upgradeRequest('/api/health')).toBe('200 plain /api/health');
    });

    it('defers unmatched upgrades to another upgrade listener (Vite HMR in dev)', async () => {
        server.on('upgrade', (req, socket) => {
            if (req.url === '/hmr') answer101(req, socket);
        });
        registerUpgradeHandler('t', (p) => p === '/j/socket', answer101);
        attachUpgradeDispatch(server);
        expect(await upgradeRequest('/hmr')).toBe('upgraded');
    });

    it('stops claiming a path once unregistered', async () => {
        const off = registerUpgradeHandler('t', (p) => p === '/j/socket', answer101);
        attachUpgradeDispatch(server);
        off();
        expect(await upgradeRequest('/j/socket')).toBe('200 plain /j/socket');
    });

    it('is idempotent per server', () => {
        expect(attachUpgradeDispatch(server)).toBe(true);
        expect(attachUpgradeDispatch(server)).toBe(true);
        expect(server.listenerCount('upgrade')).toBe(1);
    });
});

describe('upgradePathname', () => {
    it('strips the query and the configured base path', () => {
        const prev = process.env.URL_BASE_PATH;
        process.env.URL_BASE_PATH = '/lumastra';
        try {
            expect(upgradePathname({ url: '/lumastra/j/socket?api_key=1' })).toBe('/j/socket');
            expect(upgradePathname({ url: '/j/socket' })).toBe('/j/socket');
        } finally {
            if (prev === undefined) delete process.env.URL_BASE_PATH;
            else process.env.URL_BASE_PATH = prev;
        }
    });
});
