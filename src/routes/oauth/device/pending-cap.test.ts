// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    counts: new Map<string, number>(),
    pending: vi.fn(async () => 10),
    create: vi.fn(async () => ({})),
}));
vi.mock('$lib/server/oauth', () => ({
    isDeviceAuthEnabled: () => true,
    getDeviceCodeService: () => ({ countPendingForClient: h.pending, createDeviceCode: h.create }),
}));
vi.mock('$lib/server/config', () => ({
    config: { DEVICE_CODE_TTL_SECONDS: 600, DEVICE_VERIFICATION_BASE_URL: '' },
}));
vi.mock('$lib/server/oauth/jwt.js', () => ({ verifyAccessToken: vi.fn() }));
vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    checkRateLimit: vi.fn(async (key: string, max: number) => {
        const n = (h.counts.get(key) ?? 0) + 1;
        h.counts.set(key, n);
        return {
            allowed: !key.startsWith('oauth:device:pending:') || n <= max,
            resetAt: Math.floor(Date.now() / 1000) + 600,
        };
    }),
}));
import { POST } from './+server';
function event(ip: string, client = 'lumastra-tvos'): Parameters<typeof POST>[0] {
    const url = new URL('http://localhost/oauth/device');
    return {
        url,
        locals: {},
        getClientAddress: () => ip,
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_id: client }),
        }),
    } as unknown as Parameters<typeof POST>[0];
}
beforeEach(() => {
    h.counts.clear();
    vi.clearAllMocks();
    h.pending.mockResolvedValue(10);
});
it('allows a household several TVs without letting one IP exhaust the public client budget', async () => {
    for (let i = 0; i < 12; i++) expect((await POST(event('192.0.2.1'))).status).toBe(200);
    const blocked = await POST(event('192.0.2.1'));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: 'slow_down' });
    expect(blocked.headers.has('Retry-After')).toBe(true);
    expect(h.pending).toHaveBeenCalledTimes(12);
    expect((await POST(event('192.0.2.2'))).status).toBe(200);
    expect((await POST(event('192.0.2.1', 'other-client'))).status).toBe(200);
});
it('retains a few-hundred per-client table-flood backstop', async () => {
    h.pending.mockResolvedValue(300);
    expect((await POST(event('192.0.2.3'))).status).toBe(429);
    expect(h.create).not.toHaveBeenCalled();
});

it('shares an IPv6 /64 pending budget across privacy addresses, retaining separate subnets', async () => {
    for (let i = 1; i <= 12; i++)
        expect((await POST(event(`2001:db8:abcd:12::${i.toString(16)}`))).status).toBe(200);
    const blocked = await POST(event('2001:0DB8:ABCD:0012:ffff:ffff:ffff:ffff'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.has('Retry-After')).toBe(true);
    expect((await POST(event('2001:db8:abcd:13::1'))).status).toBe(200);
    expect((await POST(event('2001:db8:abcd:12::f', 'other-client'))).status).toBe(200);
});
