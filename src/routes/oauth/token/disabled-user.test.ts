// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-13, C2: a disabled account must not be able to
 * complete the device-code grant (even with an already-approved code) or the
 * refresh-token grant (even with a still-valid, unrotated refresh token) —
 * `disabled_at` must be honoured by every token→user resolution path, not
 * just the forward-auth cookie path.
 *
 * Drives the actual POST handler (the seam), mirroring
 * `oauth-repro.test.ts`'s mocking approach for this same route file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from './$types';

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
}));

// ---------------------------------------------------------------------------
// oauth module mock — device code service + refresh token service
// ---------------------------------------------------------------------------
const mockRefreshTokenService = vi.hoisted(() => ({
    validate: vi.fn(),
    rotate: vi.fn(),
}));
const mockDeviceCodeService = vi.hoisted(() => ({
    isPollTooFast: vi.fn().mockResolvedValue(false),
    recordPoll: vi.fn().mockResolvedValue(undefined),
    getByDeviceCode: vi.fn(),
    exchangeAuthorized: vi.fn(
        async (
            _code: string,
            _clientId: string,
            issue: (record: unknown, sql: unknown) => Promise<Response>,
        ) => issue(await mockDeviceCodeService.getByDeviceCode(), mockSqlFn),
    ),
}));

vi.mock('$lib/server/oauth', () => ({
    getDeviceCodeService: () => mockDeviceCodeService,
    getRefreshTokenService: () => mockRefreshTokenService,
    generateAccessToken: vi.fn().mockResolvedValue('access-token-stub'),
    isDeviceAuthEnabled: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// DB mock — controllable per test via mockDbRows
// ---------------------------------------------------------------------------
const mockDbRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
const mockSqlFn = vi.hoisted(() => vi.fn(async () => mockDbRows.rows));
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockSqlFn,
}));

// ---------------------------------------------------------------------------
// Rate limit mock (passthrough)
// ---------------------------------------------------------------------------
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn().mockResolvedValue({
        allowed: true,
        remaining: 29,
        resetAt: Math.floor(Date.now() / 1000) + 60,
        total: 30,
    }),
}));

vi.mock('$lib/server/config.js', () => ({
    config: {},
    features: { deviceAuth: true },
}));

vi.mock('$lib/server/utils/client-ip.js', () => ({
    getClientIpStrictFromRequest: vi.fn().mockReturnValue('127.0.0.1'),
    getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('$lib/server/services/user-devices.service.js', () => ({
    reportDeviceName: vi.fn().mockResolvedValue(undefined),
    resolveExistingDeviceSession: vi.fn().mockResolvedValue(null),
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

function makeEvent(body: Record<string, string>): RequestEvent {
    return {
        // parseOAuthBody() streams the body through the bounded reader, so this
        // has to be a real Request.
        request: new Request('http://localhost/oauth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
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

beforeEach(() => {
    vi.clearAllMocks();
    mockDeviceCodeService.isPollTooFast.mockResolvedValue(false);
    mockDeviceCodeService.recordPoll.mockResolvedValue(undefined);
    mockDbRows.rows = [];
    mockSqlFn.mockImplementation(async () => mockDbRows.rows);
});

describe('POST /oauth/token — device_code grant rejects a disabled account (C2)', () => {
    it('returns access_denied account_disabled when the authorized code belongs to a now-disabled user', async () => {
        mockDeviceCodeService.getByDeviceCode.mockResolvedValue({
            id: 1,
            device_code: 'devcode123',
            user_code: 'ABCD-1234',
            client_id: 'tv-client',
            device_name: null,
            scope: null,
            user_id: '11111111-1111-1111-1111-111111111111',
            status: 'authorized',
            verification_uri: null,
            verification_uri_complete: null,
            last_poll_at: null,
            created_at: new Date(),
            expires_at: new Date(Date.now() + 60_000),
            device_session_id: 'dev-sess-1',
        });
        mockDbRows.rows = [{ username: 'disableduser', groups: [], disabled_at: new Date() }];

        const { POST } = await import('./+server.js');
        const response = await POST(
            makeEvent({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: 'devcode123',
                client_id: 'tv-client',
            }),
        );

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body).toMatchObject({
            error: 'access_denied',
            error_description: 'account_disabled',
        });
        expect(response.headers.get('cache-control')).toBe('no-store');
    });
});

describe('device flow preserves other polling errors', () => {
    it.each([
        [null, 'invalid_grant', 'Invalid device code'],
        ['authorized', 'invalid_grant', 'Invalid device code'],
        ['pending', 'authorization_pending', 'Authorization pending'],
        ['denied', 'access_denied', 'User denied authorization'],
        ['expired', 'expired_token', 'Device code has expired'],
        ['wrong-client', 'invalid_grant', 'Client ID mismatch'],
        ['too-fast', 'slow_down', 'Polling too frequently'],
    ])('%s remains %s', async (status, expected, description) => {
        mockDeviceCodeService.isPollTooFast.mockResolvedValue(status === 'too-fast');
        mockDeviceCodeService.getByDeviceCode.mockResolvedValue(
            status === null
                ? null
                : {
                      client_id: status === 'wrong-client' ? 'another-client' : 'tv-client',
                      status,
                      user_id: '11111111-1111-1111-1111-111111111111',
                  },
        );
        const { POST } = await import('./+server.js');
        const response = await POST(
            makeEvent({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: 'devcode123',
                client_id: 'tv-client',
            }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            error: expected,
            error_description: description,
        });
    });
});

describe('POST /oauth/token — refresh_token grant rejects a disabled account (C2)', () => {
    it('returns invalid_grant when the refresh token belongs to a now-disabled user', async () => {
        mockRefreshTokenService.validate.mockResolvedValue({
            id: 1,
            token_hash: 'hash',
            user_id: '22222222-2222-2222-2222-222222222222',
            client_id: 'tv-client',
            scope: null,
            device_name: null,
            user_groups: [],
            provider_user_id: null,
            created_at: new Date(),
            expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
            revoked_at: null,
            last_used_at: null,
            device_session_id: 'dev-sess-2',
        });
        mockDbRows.rows = [{ username: 'disableduser', disabled_at: new Date() }];

        const { POST } = await import('./+server.js');
        const response = await POST(
            makeEvent({
                grant_type: 'refresh_token',
                refresh_token: 'refresh-token-value',
            }),
        );

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toBe('invalid_grant');
    });

    it('succeeds for an active user (control case)', async () => {
        mockRefreshTokenService.validate.mockResolvedValue({
            id: 2,
            token_hash: 'hash2',
            user_id: '33333333-3333-3333-3333-333333333333',
            client_id: 'tv-client',
            scope: null,
            device_name: null,
            user_groups: [],
            provider_user_id: null,
            created_at: new Date(),
            expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
            revoked_at: null,
            last_used_at: null,
            device_session_id: 'dev-sess-3',
        });
        mockRefreshTokenService.rotate.mockResolvedValue({
            ok: true,
            token: 'new-refresh-token',
            replayed: false,
        });
        mockDbRows.rows = [{ username: 'activeuser', disabled_at: null }];

        const { POST } = await import('./+server.js');
        const response = await POST(
            makeEvent({
                grant_type: 'refresh_token',
                refresh_token: 'refresh-token-value',
            }),
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.access_token).toBe('access-token-stub');
    });
});
