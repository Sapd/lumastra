// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C12 (2026-09-16 fix plan): `GET /api/plugins/{featureId}/realtime` had no
 * connect rate limit and no per-user/process-wide SSE connection ceiling —
 * no test of any kind existed for this route at HEAD.
 *
 * Drives the route's real GET handler the same shape
 * `watch-together/[code]/events.test.ts` and this batch's own
 * `play-sessions/[id]/events.test.ts` use: open CAP connections for one
 * user, assert the CAP+1th is refused, assert the process-wide cap
 * independently refuses a brand-new user, and assert a throw during stream
 * setup releases the slot instead of leaking it.
 *
 * The route's process-wide counter is a private module-level closure (there
 * is no `getActiveXSSECount()` export to mock, unlike the per-producer
 * registries elsewhere in this batch) — every test therefore closes every
 * connection it opens so the counter returns to its baseline before the
 * next test runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// Mutable so a single test can drop the process-wide ceiling to 0 without
// affecting the others — see the "process-wide" test below. Declared via
// vi.hoisted() so it exists before vi.mock's hoisted factory runs.
const mockConfig = vi.hoisted(() => ({
    SSE_MAX_CONNECTIONS_PER_USER: 3,
    SSE_MAX_CONNECTIONS: 1000,
}));
vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
}));

// No Valkey in this test — acquireUserConnectionSlot() and checkRateLimit()
// both fall back to their in-process paths.
const mockSubscribeToChannel = vi.fn(async (_channel: string, _cb: (raw: string) => void) => {
    return async () => {};
});
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return {
        ...actual,
        getCoordinationClient: vi.fn(() => null),
        getValkeyClient: vi.fn(() => null),
        isValkeyReady: vi.fn(() => false),
        subscribeToChannel: (...args: [string, (raw: string) => void]) =>
            mockSubscribeToChannel(...args),
    };
});

const FEATURE = { id: 'shoutbox' };
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getAllFeatures: vi.fn(() => [FEATURE]),
    },
}));

import { GET } from './+server.js';

/**
 * This route wires teardown through BOTH `request.signal`'s `abort` event
 * AND `ReadableStream.cancel()` (fix-round-1 review finding — it originally
 * had only the former). `buildEvent`/`abort()` exercises the request-abort
 * path; the "cancelling the response body" test below exercises `cancel()`
 * directly, without ever touching the request's `AbortController`.
 */
function buildEvent(
    username: string,
    featureId = 'shoutbox',
): { event: RequestEvent; abort: () => void } {
    const url = `http://localhost/api/plugins/${featureId}/realtime`;
    const controller = new AbortController();
    const event = {
        url: new URL(url),
        request: new Request(url, { signal: controller.signal }),
        locals: { user: { username, userId: username } },
        params: { featureId },
    } as unknown as RequestEvent;
    return { event, abort: () => controller.abort() };
}

interface OpenedConnection {
    response: Response;
    close: () => Promise<void>;
}

async function openConnection(username: string): Promise<OpenedConnection> {
    const { event, abort } = buildEvent(username);
    const response = await GET(event as Parameters<typeof GET>[0]);
    return {
        response,
        close: async () => {
            abort();
            // Let the abort listener's synchronous cleanup() run, and drain
            // the (now-closed) stream so nothing is left half-read.
            try {
                await response.body?.getReader().read();
            } catch {
                // Already closed — fine, this is best-effort teardown.
            }
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribeToChannel.mockResolvedValue(async () => {});
    mockConfig.SSE_MAX_CONNECTIONS_PER_USER = 3;
    mockConfig.SSE_MAX_CONNECTIONS = 1000;
});

describe('GET /api/plugins/{featureId}/realtime — connection ceilings (C12, 2026-09-16 fix plan)', () => {
    it('refuses a new connection process-wide once SSE_MAX_CONNECTIONS is reached, independent of per-user budget', async () => {
        // Drop the ceiling to 0 so even a brand-new user's FIRST connection
        // (0 active >= 0 max) is refused — deterministic without needing to
        // actually open hundreds of connections to reach a large ceiling.
        mockConfig.SSE_MAX_CONNECTIONS = 0;
        const { response } = await openConnection('zed');
        expect(response.status).toBe(503);
        expect(mockSubscribeToChannel).not.toHaveBeenCalled();
    });

    it('refuses the CAP+1th connection for one user (429), releasing frees a slot for the next connect', async () => {
        const CAP = 3; // mocked config.SSE_MAX_CONNECTIONS_PER_USER

        const opened: OpenedConnection[] = [];
        for (let i = 0; i < CAP; i++) {
            opened.push(await openConnection('alice'));
        }
        for (const { response } of opened) expect(response.status).toBe(200);

        const overCapacity = await openConnection('alice');
        expect(overCapacity.response.status).toBe(429);

        // Releasing one of alice's connections frees exactly one slot.
        await opened[0].close();
        const reconnected = await openConnection('alice');
        expect(reconnected.response.status).toBe(200);

        // Clean up so the process-wide counter returns to baseline.
        await opened[1].close();
        await opened[2].close();
        await reconnected.close();
    });

    it('a different user is unaffected by another user’s per-user ceiling', async () => {
        const conn = await openConnection('bob');
        expect(conn.response.status).toBe(200);
        await conn.close();
    });

    // Fix-round-1 review finding: this route wired teardown ONLY through
    // request.signal's abort listener — a client that cancels the response
    // BODY (a real, distinct browser/fetch behaviour) without also aborting
    // the request left cleanup() unrun, so the per-user/process-wide counters
    // could only drift upward. Proven here by cancelling the STREAM directly
    // (never touching the request's AbortController) and reopening CAP fresh
    // connections afterward.
    it('cancelling the response body (without aborting the request) still releases the slot', async () => {
        const CAP = 3;
        const opened: Response[] = [];
        for (let i = 0; i < CAP; i++) {
            const { event } = buildEvent('dave');
            opened.push(await GET(event as Parameters<typeof GET>[0]));
        }
        for (const res of opened) expect(res.status).toBe(200);

        // Cancel via the response body's own reader — NOT the request's
        // AbortController — the exact distinction the fix addresses.
        await opened[0].body?.cancel();

        const reconnected = await openConnection('dave');
        expect(reconnected.response.status).toBe(200);
        await reconnected.close();
        for (let i = 1; i < CAP; i++) await opened[i].body?.cancel();
    });

    it('a throw during stream setup releases the slot instead of leaking it', async () => {
        const CAP = 3;
        mockSubscribeToChannel.mockRejectedValueOnce(new Error('valkey subscribe exploded'));

        const failed = await openConnection('carol');
        // The route's ReadableStream.start() is async — a rejection inside it
        // does not propagate to the caller of `new ReadableStream()`; instead
        // the STREAM itself errors. The Response is still returned with a
        // (soon-to-error) body.
        expect(failed.response.status).toBe(200);
        // Draining the (errored) stream lets the async start() rejection settle.
        await failed.response.body
            ?.getReader()
            .read()
            .catch(() => {});

        // The slot from the failed attempt must have been released — carol can
        // still open CAP fresh connections afterward.
        const opened: OpenedConnection[] = [];
        for (let i = 0; i < CAP; i++) {
            const conn = await openConnection('carol');
            expect(conn.response.status).toBe(200);
            opened.push(conn);
        }
        for (const conn of opened) await conn.close();
    });
});
