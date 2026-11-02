// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security fix C7: POST /api/auth/native/logout must carry
 * `Clear-Site-Data: "cache"` so the browser wipes CacheStorage
 * (which could otherwise still hold the previous user's cached SSR HTML) as
 * part of the logout response itself — both when a session token is present
 * and revoked, and when the caller has no session cookie at all.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from './$types';

const revoke = vi.fn().mockResolvedValue(undefined);
const revokeByTokenHash = vi.fn().mockResolvedValue(false);
const warn = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => ({ warn }) } }));
vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ revoke, revokeByTokenHash }),
}));

const readSessionCookie = vi.fn();
const clearSessionCookie = vi.fn();
vi.mock('$lib/server/auth/native-session.js', () => ({
    readSessionCookie: (...args: unknown[]) => readSessionCookie(...args),
    clearSessionCookie: (...args: unknown[]) => clearSessionCookie(...args),
}));

const cookieJar = new Map<string, string>();
const cookieSet = vi.fn((key: string, value: string) => {
    cookieJar.set(key, value);
});
beforeEach(() => {
    vi.clearAllMocks();
    cookieJar.clear();
    readSessionCookie.mockReset().mockReturnValue(null);
    revoke.mockReset().mockResolvedValue(false);
    revokeByTokenHash.mockReset().mockResolvedValue(false);
});
async function post(): Promise<Response> {
    const { POST } = await import('./+server.js');
    return POST({
        cookies: {
            get: (key: string) => cookieJar.get(key),
            set: cookieSet,
            delete: (key: string) => cookieJar.delete(key),
        },
        url: new URL('http://localhost/api/auth/native/logout'),
        request: new Request('http://localhost/api/auth/native/logout', { method: 'POST' }),
        locals: {},
    } as unknown as RequestEvent);
}

describe('POST /api/auth/native/logout — Clear-Site-Data', () => {
    it('revokes the session token and still carries the header', async () => {
        readSessionCookie.mockReturnValueOnce('session-token-abc');
        const res = await post();
        expect(res.headers.get('Clear-Site-Data')).toBe('"cache"');
        expect(revoke).toHaveBeenCalledWith('session-token-abc');
        expect(clearSessionCookie).toHaveBeenCalled();
    });

    it('no session cookie present — still clears and still carries the header', async () => {
        readSessionCookie.mockReturnValueOnce(null);
        const res = await post();
        expect(res.headers.get('Clear-Site-Data')).toBe('"cache"');
        expect(revoke).not.toHaveBeenCalled();
        expect(clearSessionCookie).toHaveBeenCalled();
    });
});

it('warns and returns marked 503, clears the login cookie, and can retry revocation with no login cookie', async () => {
    const { createHash } = await import('node:crypto');
    const token = 'session-token-retry';
    const hash = createHash('sha256').update(token).digest('hex');
    const failure = Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    readSessionCookie.mockReturnValueOnce(token);
    revoke.mockRejectedValueOnce(failure);
    const response = await post();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(response.headers.get('X-Lumastra-Auth-Unavailable')).toBe('true');
    expect(response.headers.get('Clear-Site-Data')).toBe('"cache"');
    expect(clearSessionCookie).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(cookieSet).toHaveBeenCalledWith(
        'lumastra_logout_retry',
        hash,
        expect.objectContaining({ httpOnly: true, sameSite: 'strict' }),
    );
    readSessionCookie.mockReturnValueOnce(null);
    const retry = await post();
    expect(retry.status).toBe(200);
    expect(revokeByTokenHash).toHaveBeenCalledWith(hash);
    expect(cookieJar.has('lumastra_logout_retry')).toBe(false);
});
it('warns on non-dependency revoke errors and returns a server error with the cookie cleared', async () => {
    readSessionCookie.mockReturnValueOnce('session-token-bad');
    revoke.mockRejectedValueOnce(new TypeError('bad session row'));
    const response = await post();
    expect(response.status).toBe(500);
    expect(response.headers.has('X-Lumastra-Auth-Unavailable')).toBe(false);
    expect(clearSessionCookie).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
});

it('retains both pending revocations if a new session is signed out before an earlier retry finishes', async () => {
    const { createHash } = await import('node:crypto');
    const first = createHash('sha256').update('first').digest('hex');
    const second = createHash('sha256').update('second').digest('hex');
    const failure = Object.assign(new Error('down'), { code: '25006' });
    cookieJar.set('lumastra_logout_retry', first);
    readSessionCookie.mockReturnValueOnce('second');
    revoke.mockRejectedValueOnce(failure);
    revokeByTokenHash.mockRejectedValueOnce(failure);
    expect((await post()).status).toBe(503);
    expect(new Set(cookieJar.get('lumastra_logout_retry')?.split('.'))).toEqual(
        new Set([first, second]),
    );
    readSessionCookie.mockReturnValueOnce(null);
    revokeByTokenHash.mockClear();
    expect((await post()).status).toBe(200);
    expect(revokeByTokenHash).toHaveBeenCalledWith(first);
    expect(revokeByTokenHash).toHaveBeenCalledWith(second);
    expect(cookieJar.has('lumastra_logout_retry')).toBe(false);
});
