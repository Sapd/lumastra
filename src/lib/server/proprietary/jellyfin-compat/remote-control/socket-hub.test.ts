// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterAll, describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
    // client-ip builds its proxy allowlist at module load.
    const savedTrustedProxies = process.env.TRUSTED_PROXY_IPS;
    process.env.TRUSTED_PROXY_IPS = '10.0.0.1';
    return { compat: true, validateSession: vi.fn(), savedTrustedProxies };
});
vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get: (target, prop, receiver) =>
                prop === 'FEATURE_JELLYFIN_COMPAT' ? h.compat : Reflect.get(target, prop, receiver),
        }),
    };
});
vi.mock('../auth', () => ({ validateSession: h.validateSession }));
vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

const { extractSocketToken, handleJellyfinSocketUpgrade, isJellyfinSocketPath, socketClientIp } =
    await import('./socket-hub');
const { checkRateLimit } = await import('$lib/server/middleware/valkey-rate-limit');

afterAll(() => {
    if (h.savedTrustedProxies === undefined) delete process.env.TRUSTED_PROXY_IPS;
    else process.env.TRUSTED_PROXY_IPS = h.savedTrustedProxies;
});

function req(
    url: string,
    headers: Record<string, string> = {},
    remoteAddress = '10.0.0.1',
): IncomingMessage {
    return { url, headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

/** Collect what the handler writes to the raw socket before it ends. */
function capture(): { socket: PassThrough; written: Promise<string> } {
    const socket = new PassThrough();
    let out = '';
    socket.on('data', (c) => (out += c));
    const written = new Promise<string>((r) => socket.on('finish', () => r(out)));
    return { socket, written };
}

beforeEach(() => {
    h.compat = true;
    h.validateSession.mockReset();
});

describe('socket-hub', () => {
    it('claims /j/socket in any case, nothing else', () => {
        expect(isJellyfinSocketPath('/j/socket')).toBe(true);
        expect(isJellyfinSocketPath('/j/Socket/')).toBe(true);
        expect(isJellyfinSocketPath('/j/embywebsocket')).toBe(true);
        expect(isJellyfinSocketPath('/socket')).toBe(false);
        expect(isJellyfinSocketPath('/j/socket/x')).toBe(false);
    });

    it('reads the token from the query or the MediaBrowser headers', () => {
        expect(extractSocketToken(req('/j/socket?api_key=q1&deviceId=d'))).toBe('q1');
        expect(extractSocketToken(req('/j/socket?ApiKey=q2'))).toBe('q2');
        expect(
            extractSocketToken(
                req('/j/socket', { 'x-emby-authorization': 'MediaBrowser Client="x", Token="h1"' }),
            ),
        ).toBe('h1');
        expect(extractSocketToken(req('/j/socket', { 'x-emby-token': 'h2' }))).toBe('h2');
        expect(extractSocketToken(req('/j/socket'))).toBe('');
    });

    it('answers 404 without touching auth when Jellyfin compat is disabled', async () => {
        h.compat = false;
        const { socket, written } = capture();
        handleJellyfinSocketUpgrade(req('/j/socket?api_key=t'), socket, Buffer.alloc(0));
        expect(await written).toMatch(/^HTTP\/1\.1 404 /);
        expect(h.validateSession).not.toHaveBeenCalled();
    });

    it('answers 401 for an unknown token', async () => {
        h.validateSession.mockResolvedValue(null);
        const { socket, written } = capture();
        handleJellyfinSocketUpgrade(req('/j/socket?api_key=bogus'), socket, Buffer.alloc(0));
        expect(await written).toMatch(/^HTTP\/1\.1 401 /);
        expect(h.validateSession).toHaveBeenCalledWith('bogus', '/j/socket');
    });

    it('keys the auth-failure throttle on the client behind a trusted proxy, not the proxy', async () => {
        h.validateSession.mockResolvedValue(null);
        vi.mocked(checkRateLimit).mockClear();
        const { socket, written } = capture();
        handleJellyfinSocketUpgrade(
            req('/j/socket?api_key=stale', { 'x-forwarded-for': '203.0.113.7' }),
            socket,
            Buffer.alloc(0),
        );
        expect(await written).toMatch(/^HTTP\/1\.1 401 /);
        expect(checkRateLimit).toHaveBeenCalledWith('jfcompat:auth_fail:203.0.113.7', 60, 60);
    });

    it('ignores X-Forwarded-For from a peer that is not a trusted proxy', () => {
        const headers = { 'x-forwarded-for': '203.0.113.7' };
        expect(socketClientIp(req('/j/socket', headers, '10.0.0.1'))).toBe('203.0.113.7');
        expect(socketClientIp(req('/j/socket', headers, '198.51.100.9'))).toBe('198.51.100.9');
        expect(socketClientIp(req('/j/socket', {}, '10.0.0.1'))).toBe('10.0.0.1');
    });
});
