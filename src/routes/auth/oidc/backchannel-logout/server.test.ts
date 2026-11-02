// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The back-channel logout receiver is unauthenticated: its body is read through
 * the bounded reader (a chunked body carries no Content-Length to precheck),
 * and only form-urlencoded is accepted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('$lib/server/services/oidc.service.js', () => ({ isOidcConfigured: () => true }));
vi.mock('$lib/server/services/oidc-logout-token.js', () => ({
    LogoutTokenError: class LogoutTokenError extends Error {},
    OidcBackchannelInfraError: class OidcBackchannelInfraError extends Error {},
}));
const processMock = vi.fn(async (_token: string) => ({ revoked: 1 }));
vi.mock('$lib/server/services/oidc-backchannel-logout.js', () => ({
    processBackchannelLogout: (token: string) => processMock(token),
}));

import { POST } from './+server.js';

function call(request: Request): Promise<Response> {
    return (POST as (e: unknown) => Promise<Response>)({ request });
}

const URL_BCL = 'http://localhost/auth/oidc/backchannel-logout';

beforeEach(() => processMock.mockClear());

describe('POST /auth/oidc/backchannel-logout', () => {
    it('accepts application/x-www-form-urlencoded; charset=UTF-8', async () => {
        const res = await call(
            new Request(URL_BCL, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: 'logout_token=abc.def.ghi',
            }),
        );
        expect(res.status).toBe(200);
        expect(processMock).toHaveBeenCalledWith('abc.def.ghi');
    });

    it('answers 413 for an over-cap body with a declared length', async () => {
        const res = await call(
            new Request(URL_BCL, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'logout_token=' + 'a'.repeat(32 * 1024),
            }),
        );
        expect(res.status).toBe(413);
        expect(processMock).not.toHaveBeenCalled();
    });

    it('answers 413 for an over-cap CHUNKED body (no Content-Length)', async () => {
        const chunk = new TextEncoder().encode('logout_token=' + 'a'.repeat(8 * 1024));
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                for (let i = 0; i < 4; i++) c.enqueue(chunk);
                c.close();
            },
        });
        const request = new Request(URL_BCL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: stream,
            // @ts-expect-error Node's fetch needs duplex for a streamed body
            duplex: 'half',
        });
        expect(request.headers.get('content-length')).toBeNull();
        const res = await call(request);
        expect(res.status).toBe(413);
        expect(processMock).not.toHaveBeenCalled();
    });

    it('answers 400 for a JSON body', async () => {
        const res = await call(
            new Request(URL_BCL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ logout_token: 'abc' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(processMock).not.toHaveBeenCalled();
    });

    it('answers 400 when logout_token is missing or repeated', async () => {
        for (const body of ['other=1', 'logout_token=a&logout_token=b']) {
            const res = await call(
                new Request(URL_BCL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body,
                }),
            );
            expect(res.status).toBe(400);
        }
    });
});
