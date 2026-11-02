// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Subsonic failed-auth bucket must key on the STRICT (non-spoofable) client
 * IP, mirroring what forward-auth.ts already does for `apiv1:auth_fail`.
 *
 * Why it matters here specifically: the Subsonic compat surface bypasses the
 * central auth gate (see docs/architecture/jellyfin-compat-security.md), so this
 * counter is the entire brute-force defence for it. Keyed on `getClientIp`, an
 * attacker rotates `X-Forwarded-For` per request and receives a fresh bucket
 * every time — the limit exists but never trips.
 *
 * Deliberately does NOT mock `$lib/server/utils/client-ip` — the real module is
 * exercised so the strict-vs-spoofable distinction is genuine rather than
 * asserted against a double. Relies on TRUSTED_PROXY_IPS being unset, which is
 * the configuration in which the two getters actually differ.
 *
 * Run: npx vitest run src/lib/server/subsonic-compat/rate-limit-strict-ip.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const PEER = '203.0.113.7';

// ── Module mocks — everything except client-ip ───────────────────────────────

const rateLimitKeys: string[] = [];

vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    checkRateLimit: vi.fn(async (key: string) => {
        rateLimitKeys.push(key);
        return { allowed: true, resetAt: 0 };
    }),
}));

vi.mock('./auth', () => ({ validateCredentials: vi.fn(async () => null) }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('./serializers/response', () => ({
    subsonicError: vi.fn(() => new Response('err', { status: 200 })),
}));

vi.mock('$lib/server/utils/api-responses', () => ({
    ApiResponses: { rateLimited: vi.fn(() => new Response('limited', { status: 429 })) },
}));

vi.mock('$lib/server/utils/display-name.js', () => ({
    sanitizeDisplayName: (s: string) => s,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** One request from PEER carrying an attacker-chosen X-Forwarded-For. */
function makeEvent(forwardedFor: string): RequestEvent {
    return {
        url: new URL('http://localhost/subsonic/rest/ping.view'),
        request: new Request('http://localhost/subsonic/rest/ping.view', {
            headers: { 'x-forwarded-for': forwardedFor },
        }),
        getClientAddress: () => PEER,
        locals: {},
    } as unknown as RequestEvent;
}

beforeEach(() => {
    rateLimitKeys.length = 0;
    delete process.env.TRUSTED_PROXY_IPS;
    vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('recordSubsonicAuthFailure — bucket key is not attacker-controlled', () => {
    it('collapses rotated X-Forwarded-For values from one peer into ONE bucket', async () => {
        const { recordSubsonicAuthFailure } = await import('./middleware.js');

        await recordSubsonicAuthFailure(makeEvent('1.1.1.1'), 'json');
        await recordSubsonicAuthFailure(makeEvent('2.2.2.2'), 'json');
        await recordSubsonicAuthFailure(makeEvent('3.3.3.3'), 'json');

        // The load-bearing assertion: with the lenient getter these are three
        // distinct keys and the throttle never accumulates.
        expect(new Set(rateLimitKeys).size).toBe(1);
        expect(rateLimitKeys[0]).toBe(`subsonic:auth_fail:${PEER}`);
    });

    it('keys on the TCP peer, never on a forwarded header value', async () => {
        const { recordSubsonicAuthFailure } = await import('./middleware.js');

        await recordSubsonicAuthFailure(makeEvent('9.9.9.9'), 'xml');

        expect(rateLimitKeys[0]).toContain(PEER);
        expect(rateLimitKeys[0]).not.toContain('9.9.9.9');
    });
});
