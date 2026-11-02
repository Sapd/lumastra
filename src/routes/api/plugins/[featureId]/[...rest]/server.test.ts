// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C26 (2026-09-16 fix plan): `/api/plugins/{featureId}/[...rest]` had no
 * rate limiter at all — a plugin feature's own limiter (e.g. shoutbox's
 * 6/min post cap) only bounds the DB cost of a request that has ALREADY
 * been parsed, and runs regardless of authentication. Pins that an
 * UNAUTHENTICATED flood is refused with 429 (not left to always answer 401
 * with no request budget at all).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getAllFeatures: vi.fn(() => []) },
}));

vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    buildRequestPluginContext: vi.fn(async () => ({})),
}));

// $lib/server/middleware/valkey-rate-limit.js is intentionally NOT mocked —
// checkRateLimit()'s real in-memory fallback (no Valkey configured in the
// test environment) is exercised directly, exactly like
// native/login/server.test.ts's H8 suite does for the same reason.

import { GET } from './+server.js';

function makeEvent(peer: string): RequestEvent {
    const url = new URL('http://localhost/api/plugins/shoutbox/messages');
    return {
        url,
        request: new Request(url, { method: 'GET' }),
        params: { featureId: 'shoutbox', rest: 'messages' },
        route: { id: '/api/plugins/[featureId]/[...rest]' as const },
        locals: {}, // no user — anonymous
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => peer,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TRUSTED_PROXY_IPS;
});

describe('C26 — /api/plugins/{featureId}/[...rest] has a shared rate limiter', () => {
    it('an unauthenticated flood of plugin feature requests is refused with 429, not left unbounded', async () => {
        const PEER = '203.0.113.50';
        const LIMIT = 60; // matches the route's own RATE_LIMIT

        const responses: Response[] = [];
        for (let i = 0; i < LIMIT + 1; i++) {
            responses.push(await GET(makeEvent(PEER) as Parameters<typeof GET>[0]));
        }

        // Every one of the first LIMIT requests reaches dispatchFeatureRequest
        // (which 401s them, since they're anonymous) — none is 429 yet.
        for (let i = 0; i < LIMIT; i++) {
            expect(responses[i].status).not.toBe(429);
        }
        // The (LIMIT+1)th is refused by the rate limiter BEFORE dispatch.
        expect(responses[LIMIT].status).toBe(429);
    });

    it('a different anonymous peer is unaffected by another peer’s budget', async () => {
        for (let i = 0; i < 60; i++) {
            await GET(makeEvent('203.0.113.51') as Parameters<typeof GET>[0]);
        }
        const res = await GET(makeEvent('203.0.113.52') as Parameters<typeof GET>[0]);
        expect(res.status).not.toBe(429);
    });
});
