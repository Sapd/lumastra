// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro tests for:
 *   F10 — OAuth partial secret prefixes logged
 *   F12 — Host-header injection in device verification URI
 *
 * F10 Fix: Refresh tokens and device codes are now logged with an opaque
 * SHA-256-derived prefix instead of the raw 12-character plaintext prefix.
 *
 * F10 Citations: src/routes/oauth/token/+server.ts:393,413,142,
 *                src/lib/server/oauth/refresh-token.service.ts:141
 *
 * F12 Fix: oauth/device/+server.ts now uses DEVICE_VERIFICATION_BASE_URL from
 * config (when set) to build verification URIs, ignoring the raw request Host.
 *
 * F12 Citation: src/routes/oauth/device/+server.ts:90
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent as TokenRequestEvent } from './token/$types';
import type { RequestEvent as DeviceRequestEvent } from './device/$types';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Logger mock (shared)
// ---------------------------------------------------------------------------
const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: vi.fn(() => mockLogger) },
}));

// ---------------------------------------------------------------------------
// F10: Refresh token service mock
// ---------------------------------------------------------------------------
const mockRefreshTokenService = vi.hoisted(() => ({
    validate: vi.fn(),
    rotate: vi.fn(),
}));

vi.mock('$lib/server/oauth/refresh-token.service.js', () => ({
    getRefreshTokenService: () => mockRefreshTokenService,
}));

// ---------------------------------------------------------------------------
// F10: JWT + oauth module mock
// ---------------------------------------------------------------------------
const mockJwt = vi.hoisted(() => ({
    verifyToken: vi.fn(),
    createAccessToken: vi.fn().mockReturnValue('access-token-stub'),
}));

vi.mock('$lib/server/oauth/jwt.js', () => mockJwt);

vi.mock('$lib/server/oauth', () => ({
    getDeviceCodeService: vi.fn(() => ({
        isPollTooFast: vi.fn().mockResolvedValue(false),
        recordPoll: vi.fn().mockResolvedValue(undefined),
        getByDeviceCode: vi.fn().mockResolvedValue(null),
        countPendingForClient: vi.fn().mockResolvedValue(0),
        createDeviceCode: vi.fn().mockResolvedValue({
            device_code: 'device-code-stub',
            user_code: 'ABCD-1234',
            verification_uri: 'https://lumastra.trusted.example.com/device',
            verification_uri_complete: 'https://lumastra.trusted.example.com/device?code=ABCD-1234',
            expires_in: 600,
            interval: 5,
        }),
    })),
    getRefreshTokenService: () => mockRefreshTokenService,
    generateAccessToken: vi.fn().mockResolvedValue('access-token-stub'),
    isDeviceAuthEnabled: vi.fn().mockReturnValue(true),
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

// ---------------------------------------------------------------------------
// Config mock — provide a DEVICE_VERIFICATION_BASE_URL that tests can mutate
// ---------------------------------------------------------------------------
const configState = vi.hoisted(() => ({
    DEVICE_VERIFICATION_BASE_URL: 'https://lumastra.trusted.example.com',
}));

vi.mock('$lib/server/config.js', () => ({
    config: configState,
    features: { deviceAuth: true },
    FEATURE_PER_TASK_QUEUES: false,
}));

// ---------------------------------------------------------------------------
// Schemas mock (deviceCodeRequestSchema) — minimal passthrough
// ---------------------------------------------------------------------------
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
        deviceCodeRequestSchema: z.object({
            client_id: z.string(),
            scope: z.string().optional(),
            device_name: z.string().optional(),
            device_id: z.string().optional(),
        }),
    };
});

// ---------------------------------------------------------------------------
// client-ip mock (passthrough)
// ---------------------------------------------------------------------------
vi.mock('$lib/server/utils/client-ip.js', () => ({
    getClientIpStrictFromRequest: vi.fn().mockReturnValue('127.0.0.1'),
    getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
    isForwardedHeaderPeerTrusted: () => true,
}));

// ============================================================================
// F10 — OAuth partial secret prefixes logged
// ============================================================================

describe('F10 — OAuth partial secret prefixes logged', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRefreshTokenService.validate.mockReset();
        mockRefreshTokenService.rotate.mockReset();
    });

    it('logs an opaque SHA-256 prefix (not the raw plaintext) for a rejected refresh token', async () => {
        mockRefreshTokenService.validate.mockResolvedValue(null);

        const { POST } = await import('./token/+server.js');

        const refreshToken = 'super_secret_refresh_token_value_12345';

        await POST({
            url: new URL('http://localhost/oauth/token'),
            // parseOAuthBody() streams the body through the bounded reader.
            request: new Request('http://localhost/oauth/token', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
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
            depends: () => undefined,
            untrack: <T>(fn: () => T) => fn(),
        } as unknown as TokenRequestEvent);

        const warnCalls = mockLogger.warn.mock.calls;
        const relevantCall = warnCalls.find(
            (call) => typeof call[0] === 'string' && call[0].includes('REFRESH TOKEN REJECTED'),
        );

        expect(relevantCall).toBeDefined();
        const meta = relevantCall![1] as Record<string, unknown>;

        // FIX: The token prefix must NOT expose the raw plaintext prefix.
        expect(meta.tokenPrefix).not.toBe(refreshToken.substring(0, 12) + '...');

        // FIX: The prefix must be an opaque SHA-256-derived string (8 hex chars + '...').
        const expectedOpaquePrefix =
            createHash('sha256').update(refreshToken).digest('hex').slice(0, 8) + '...';
        expect(meta.tokenPrefix).toBe(expectedOpaquePrefix);
    });
});

// ============================================================================
// F12 — Host-header injection in device verification URI
// ============================================================================

describe('F12 — Host-header injection in device verification URI', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Restore canonical base for each test
        configState.DEVICE_VERIFICATION_BASE_URL = 'https://lumastra.trusted.example.com';
    });

    it('uses DEVICE_VERIFICATION_BASE_URL instead of attacker-controlled Host header', async () => {
        const { POST } = await import('./device/+server.js');

        const attackerHost = 'evil-phishing.example.com';

        const res = await POST({
            url: new URL(`http://${attackerHost}/oauth/device`),
            request: new Request('http://localhost/oauth/device', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ client_id: 'test-client', scope: 'read' }),
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
            depends: () => undefined,
            untrack: <T>(fn: () => T) => fn(),
        } as unknown as DeviceRequestEvent);

        expect(res.status).toBe(200);
        const json = (await res.json()) as {
            verification_uri?: string;
            verification_uri_complete?: string;
        };

        // FIX: The verification URI must use the canonical base URL, not the attacker's Host.
        expect(json.verification_uri).not.toContain(attackerHost);
        expect(json.verification_uri_complete).not.toContain(attackerHost);

        // FIX: The verification URI must use the configured canonical origin.
        expect(json.verification_uri).toContain('lumastra.trusted.example.com');
        expect(json.verification_uri_complete).toContain('lumastra.trusted.example.com');
    });
});

describe('device pairing trusted origin', () => {
    it.each([
        ['https://canonical.example', {}, 'https://canonical.example'],
        ['', { 'x-forwarded-proto': 'https' }, 'https://public.example'],
        ['', { 'x-scheme': 'https' }, 'https://public.example'],
    ])('honors ORIGIN %s and trusted protocol headers %j', async (origin, headers, expected) => {
        vi.stubEnv('ORIGIN', origin);
        vi.stubEnv('PROTOCOL_HEADER', 'x-scheme');
        configState.DEVICE_VERIFICATION_BASE_URL = '';
        try {
            const { POST } = await import('./device/+server.js');
            const { getDeviceCodeService } = await import('$lib/server/oauth');
            const service = getDeviceCodeService();
            vi.mocked(getDeviceCodeService).mockReturnValueOnce(service);
            const response = await POST({
                url: new URL('http://public.example/oauth/device'),
                request: new Request('http://public.example/oauth/device', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', ...headers },
                    body: JSON.stringify({ client_id: 'lumastra-ios' }),
                }),
                getClientAddress: () => '127.0.0.1',
            } as unknown as DeviceRequestEvent);
            expect(response.status).toBe(200);
            expect(service.createDeviceCode).toHaveBeenCalledWith(expect.any(Object), expected);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

describe('malformed configured verification URL', () => {
    it.each(['example.com/lumastra', 'https://', 'ftp://example.com/lumastra'])(
        'warns and falls back to the trusted request origin for %s',
        async (configured) => {
            vi.stubEnv('ORIGIN', '');
            vi.stubEnv('PROTOCOL_HEADER', '');
            configState.DEVICE_VERIFICATION_BASE_URL = configured;
            mockLogger.warn.mockClear();
            try {
                const { POST } = await import('./device/+server.js');
                const { getDeviceCodeService } = await import('$lib/server/oauth');
                const service = getDeviceCodeService();
                vi.mocked(service.createDeviceCode).mockImplementationOnce(
                    async (_request, baseUrl) => {
                        const verification_uri = new URL('/device', baseUrl).href;
                        return {
                            device_code: 'device',
                            user_code: 'ABCD-1234',
                            verification_uri,
                            verification_uri_complete: `${verification_uri}?code=ABCD-1234`,
                            expires_in: 600,
                            interval: 5,
                        };
                    },
                );
                vi.mocked(getDeviceCodeService).mockReturnValueOnce(service);
                const response = await POST({
                    url: new URL('http://public.example/oauth/device'),
                    request: new Request('http://public.example/oauth/device', {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            'x-forwarded-proto': 'https',
                        },
                        body: JSON.stringify({ client_id: 'lumastra-ios' }),
                    }),
                    getClientAddress: () => '127.0.0.1',
                } as unknown as DeviceRequestEvent);
                expect(response.status).toBe(200);
                expect(service.createDeviceCode).toHaveBeenCalledWith(
                    expect.any(Object),
                    'https://public.example',
                );
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('DEVICE_VERIFICATION_BASE_URL'),
                    expect.any(Object),
                );
            } finally {
                vi.unstubAllEnvs();
            }
        },
    );
});
