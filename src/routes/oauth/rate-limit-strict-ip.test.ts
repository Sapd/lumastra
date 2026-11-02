// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('$lib/server/config', () => ({ config: {} }));
vi.mock('$lib/server/oauth', () => ({
    isDeviceAuthEnabled: () => true,
    getDeviceCodeService: vi.fn(),
    getRefreshTokenService: vi.fn(),
    generateAccessToken: vi.fn(),
}));
vi.mock('$lib/server/services/user-devices.service', () => ({
    reportDeviceName: vi.fn(),
    resolveExistingDeviceSession: vi.fn(),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    checkRateLimit: vi.fn(),
}));

import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit';

const peer = '203.0.113.7';

function event(endpoint: string, forwardedFor: string, clientId: string): RequestEvent {
    const url = new URL(`http://localhost/oauth/${endpoint}`);
    return {
        url,
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
            body: JSON.stringify({ client_id: clientId }),
        }),
        getClientAddress: () => peer,
        locals: {},
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('TRUSTED_PROXY_IPS', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe.each(['device', 'token'])('OAuth %s rate-limit identity', (endpoint) => {
    it('shares one bucket across rotated forwarded addresses and client IDs', async () => {
        const counts = new Map<string, number>();
        vi.mocked(checkRateLimit).mockImplementation(async (key, max) => {
            const count = (counts.get(key) ?? 0) + 1;
            counts.set(key, count);
            return {
                allowed: count <= max,
                remaining: Math.max(0, max - count),
                resetAt: 0,
                total: max,
            };
        });
        const { POST } =
            endpoint === 'device'
                ? await import('./device/+server')
                : await import('./token/+server');
        const limit = endpoint === 'device' ? 10 : 30;
        for (let i = 0; i < limit; i++) {
            await (POST as RequestHandler)(event(endpoint, `198.51.100.${i}`, `client-${i}`));
        }
        const response = await (POST as RequestHandler)(
            event(endpoint, '192.0.2.99', 'another-client'),
        );
        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBe('60');
        expect(
            [...counts.keys()].filter((key) => !key.startsWith('oauth:device:pending:')),
        ).toEqual([`oauth:${endpoint}:${peer}`]);
    });

    it('uses the actual socket when ADDRESS_HEADER resolves an attacker-selected IP', async () => {
        vi.stubEnv('ADDRESS_HEADER', 'x-forwarded-for');
        vi.stubEnv('XFF_DEPTH', '1');
        vi.mocked(checkRateLimit).mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: 0,
            total: 30,
        });
        const { POST } =
            endpoint === 'device'
                ? await import('./device/+server')
                : await import('./token/+server');
        for (const ip of ['192.0.2.1', '192.0.2.2']) {
            const requestEvent = event(endpoint, ip, 'client');
            requestEvent.getClientAddress = () => ip;
            requestEvent.platform = { req: { socket: { remoteAddress: peer } } };
            expect((await (POST as RequestHandler)(requestEvent)).status).toBe(429);
        }
        expect(checkRateLimit).toHaveBeenNthCalledWith(
            1,
            `oauth:${endpoint}:${peer}`,
            expect.any(Number),
            60,
        );
        expect(checkRateLimit).toHaveBeenNthCalledWith(
            2,
            `oauth:${endpoint}:${peer}`,
            expect.any(Number),
            60,
        );
    });

    it('honors forwarded client IPs only from explicitly trusted proxies', async () => {
        vi.stubEnv('TRUSTED_PROXY_IPS', peer);
        vi.mocked(checkRateLimit).mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: 0,
            total: 30,
        });
        const { POST } =
            endpoint === 'device'
                ? await import('./device/+server')
                : await import('./token/+server');
        await (POST as RequestHandler)(event(endpoint, '198.51.100.42', 'client'));
        expect(checkRateLimit).toHaveBeenCalledWith(
            `oauth:${endpoint}:198.51.100.42`,
            expect.any(Number),
            60,
        );
    });
});
