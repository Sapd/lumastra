// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C15: the OAuth token endpoint bypasses mount()'s auth chokepoint entirely
 * (RFC 6749 public grant exchange) and previously buffered any body size via
 * `request.json()` with no cap. Drives the real POST handler with a genuine
 * `Request` (not a stubbed `.json()`) so the actual body-reading path is
 * exercised, matching the brief's requirement: a 1 MB JSON body must be
 * rejected 413, not treated as an unsupported-grant 400 or a parse-error 500.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from './$types';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
}));

vi.mock('$lib/server/oauth', () => ({
    getDeviceCodeService: () => ({}),
    getRefreshTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
    generateAccessToken: vi.fn(),
    isDeviceAuthEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn().mockResolvedValue({
        allowed: true,
        remaining: 29,
        resetAt: Math.floor(Date.now() / 1000) + 60,
        total: 30,
    }),
}));

vi.mock('$lib/server/utils/client-ip.js', () => ({
    getClientIpStrictFromRequest: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('$lib/server/services/user-devices.service.js', () => ({
    reportDeviceName: vi.fn(),
    resolveExistingDeviceSession: vi.fn(),
}));

vi.mock('$lib/schemas/oauth.js', async () => {
    const { z } = await import('zod');
    return {
        tokenDeviceCodeGrantSchema: z.object({
            grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
            device_code: z.string(),
            client_id: z.string(),
        }),
        tokenRefreshGrantSchema: z.object({
            grant_type: z.literal('refresh_token'),
            refresh_token: z.string(),
            client_id: z.string().optional(),
        }),
    };
});

function makeRealEvent(body: string, contentType = 'application/json'): RequestEvent {
    const url = 'http://localhost/oauth/token';
    const request = new Request(url, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
    });
    return {
        request,
        locals: {},
        params: {},
        route: { id: null as unknown as never },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
}

describe('POST /oauth/token — body size cap (C15)', () => {
    it('rejects a ~1MB JSON body with 413, not the 400 unsupported-grant path', async () => {
        const { POST } = await import('./+server');
        const hugeBody = JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: 'x'.repeat(1_000_000),
        });
        const res = await POST!(makeRealEvent(hugeBody));

        expect(res.status).toBe(413);
        const out = (await res.json()) as { error: string; code?: string };
        expect(out.error).toBe('invalid_request');
        expect(out.code).toBe('payload_too_large');
    });

    it('rejects an honest-but-still-over-cap body even without a lying Content-Length', async () => {
        const { POST } = await import('./+server');
        // fetch's Request auto-computes Content-Length from a string body, so this
        // also exercises the declared-size pre-check path.
        const hugeBody = JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: 'y'.repeat(2_000_000),
        });
        const res = await POST!(makeRealEvent(hugeBody));
        expect(res.status).toBe(413);
    });

    it('a normal small refresh_token body is NOT rejected as too large', async () => {
        const { POST } = await import('./+server');
        const smallBody = JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: 'short-token',
        });
        const res = await POST!(makeRealEvent(smallBody));
        // Invalid token → invalid_grant 400, but crucially NOT 413.
        expect(res.status).not.toBe(413);
    });
});
