// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const { rateLimit, clientIp } = vi.hoisted(() => ({ rateLimit: vi.fn(), clientIp: vi.fn() }));
vi.mock('./valkey-rate-limit.js', () => ({ checkRateLimit: rateLimit }));
vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIpStrict: clientIp }));
import { resolveOptionalServerCredential } from './server-bootstrap-auth.js';

function event(authorization?: string): RequestEvent {
    const url = new URL('http://localhost/api/v1/server?stream_token=ignored&api_key=ignored');
    return {
        request: new Request(url, { headers: authorization ? { authorization } : {} }),
        locals: {}, url,
    } as RequestEvent;
}
beforeEach(() => {
    rateLimit.mockReset().mockResolvedValue({ allowed: true, resetAt: 0 });
    clientIp.mockReturnValue('127.0.0.1');
});
describe('optional discovery credential', () => {
    it.each([undefined, 'Basic ignored'])('%s never calls the bearer validator', async (auth) => {
        const request = event(auth);
        const bearer = vi.fn();
        request.request.headers.set('cookie', 'session=valid');
        request.request.headers.set('x-forwarded-user', 'attacker');
        expect(await resolveOptionalServerCredential(request, { bearer })).toBeUndefined();
        expect(bearer).not.toHaveBeenCalled();
        expect(request.locals.principal).toBeUndefined();
    });
    it('clears rejected credentials', async () => {
        const request = event('Bearer invalid');
        expect(await resolveOptionalServerCredential(request, {
            bearer: async () => new Response(null, { status: 401 }),
        })).toBeUndefined();
        expect(request.locals.principal).toBeUndefined();
    });
    it.each(['Bearer valid', 'bEaReR valid'])('passes the original event for %s', async (auth) => {
        const request = event(auth);
        const principal = { kind: 'pat', userId: 'verified' } as NonNullable<App.Locals['principal']>;
        await resolveOptionalServerCredential(request, {
            bearer: async (e) => {
                expect(e).toBe(request);
                e.locals.principal = principal;
                return undefined;
            },
        });
        expect(request.locals.principal).toBe(principal);
    });
    it('uses an unknown bucket when no strict IP is available', async () => {
        clientIp.mockReturnValue(null);
        await resolveOptionalServerCredential(event(), { bearer: vi.fn() });
        expect(rateLimit).toHaveBeenCalledWith('public-api:server:unknown', 120, 60);
    });
    it('fails open when the limiter throws', async () => {
        rateLimit.mockRejectedValueOnce(new Error('offline'));
        const request = event();
        expect(await resolveOptionalServerCredential(request, { bearer: vi.fn() })).toBeUndefined();
        expect(request.locals.principal).toBeUndefined();
    });
    it('keeps explicit rate-limit denials', async () => {
        rateLimit.mockResolvedValueOnce({ allowed: false, resetAt: Date.now() / 1000 + 60 });
        const response = await resolveOptionalServerCredential(event(), { bearer: vi.fn() });
        expect(response?.status).toBe(429);
        expect(response?.headers.get('retry-after')).toBeTruthy();
    });
});
