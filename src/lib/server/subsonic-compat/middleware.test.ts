// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the Subsonic compat brute-force rate limiter
 * (recordSubsonicAuthFailure). checkRateLimit + getClientIp are mocked; the
 * real subsonicError / ApiResponses serializers run so we assert on the actual
 * Response status and body shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckRateLimit = vi.fn();

vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));
vi.mock('$lib/server/utils/client-ip', () => ({
    // The failed-auth bucket keys on the STRICT getter — the lenient one honors
    // X-Forwarded-For from any peer when TRUSTED_PROXY_IPS is unset, which lets
    // an attacker mint a fresh bucket per request. rate-limit-strict-ip.test.ts
    // pins that distinction against the real module; this stub only needs to
    // supply a stable address.
    getClientIpStrict: () => '203.0.113.7',
}));
// Avoid pulling the DB-backed credential validator into the unit test graph.
vi.mock('./auth', () => ({
    validateCredentials: vi.fn(),
}));

import { recordSubsonicAuthFailure } from './middleware';

const fakeEvent = {} as RequestEvent;

describe('recordSubsonicAuthFailure', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the standard code-40 error (HTTP 200) when under the limit', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });

        const res = await recordSubsonicAuthFailure(fakeEvent, 'json');

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            'subsonic-response': { status: string; error: { code: number } };
        };
        expect(body['subsonic-response'].status).toBe('failed');
        expect(body['subsonic-response'].error.code).toBe(40);
    });

    it('keys the counter per client IP (60/60s, mirrors Jellyfin compat)', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });

        await recordSubsonicAuthFailure(fakeEvent, 'json');

        expect(mockCheckRateLimit).toHaveBeenCalledWith('subsonic:auth_fail:203.0.113.7', 60, 60);
    });

    it('returns HTTP 429 lockout when the per-IP failure limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: 9999 });

        const res = await recordSubsonicAuthFailure(fakeEvent, 'json');

        expect(res.status).toBe(429);
    });
});
