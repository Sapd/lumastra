// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C18 (2026-09-16 fix plan): `GET /api/v1/runs/{id}/logs` had no `rateLimit`
 * and never called `acquireUserConnectionSlot` — `87261bed3` treated the
 * equally admin-only `defs/admin/ingest/stream/index.ts` as in scope and
 * gave it both the 30/60s connect limiter and the hub connection ceiling;
 * this sibling was read (its docstring cites the same C16 operational-reads
 * move) and not listed.
 *
 * Drives the def's real GET handler via `mount()`, the same way
 * `logs-auth-gate.test.ts` (the sibling auth-gate suite for this same file)
 * already does, and the same connection-ceiling shape
 * `watch-together/[code]/events.test.ts` and this batch's own
 * `play-sessions/[id]/events.test.ts` use.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockReadRecent = vi.fn().mockResolvedValue([]);
const mockSubscribe = vi.fn().mockResolvedValue(() => {});
vi.mock('$lib/server/tasks/log-buffer.js', () => ({
    logBuffer: {
        readRecent: (...args: unknown[]) => mockReadRecent(...args),
        subscribe: (...args: unknown[]) => mockSubscribe(...args),
    },
}));

// No real timers — the keepalive interval is irrelevant to connection-slot
// accounting and would otherwise leak intervals across tests.
const mockStartSseKeepalive = vi.fn((_controller: unknown, _opts: { onDead?: () => void }) => {
    return () => {};
});
vi.mock('$lib/server/utils/sse.js', () => ({
    SSE_KEEPALIVE_MS: 10_000,
    startSseKeepalive: (...args: [unknown, { onDead?: () => void; onTick?: () => void }]) =>
        mockStartSseKeepalive(...args),
}));

// Small, deterministic ceilings so this test doesn't need real connections.
// Mutable (vi.hoisted) so one test can drop the process-wide ceiling to 0
// without affecting the others.
const mockConfig = vi.hoisted(() => ({
    SSE_MAX_CONNECTIONS_PER_USER: 3,
    SSE_MAX_CONNECTIONS: 1000,
}));
vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: {},
    FEATURE_PER_TASK_QUEUES: false,
}));

// No Valkey in this test — acquireUserConnectionSlot() and checkRateLimit()
// both fall back to their in-process paths.
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return {
        ...actual,
        getCoordinationClient: vi.fn(() => null),
        getValkeyClient: vi.fn(() => null),
        isValkeyReady: vi.fn(() => false),
    };
});

const { def } = await import('./[id]/logs.js');
const { mount } = await import('$lib/server/api/mount.js');

const RUN_ID = '11111111-2222-3333-4444-555555555555';

function makeEvent(username: string): RequestEvent {
    const url = new URL(`http://localhost/api/runs/${RUN_ID}/logs`);
    const requestController = new AbortController();
    return {
        url,
        params: { id: RUN_ID },
        route: { id: '/api/runs/[id]/logs' as const },
        request: new Request(url.toString(), { signal: requestController.signal }),
        locals: {
            principal: {
                kind: 'session',
                userId: `usr_${username}`,
                username,
                userGroups: [],
                scopes: ['tasks:admin'],
                isAdmin: false,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

async function openConnection(username: string): Promise<Response> {
    const { GET } = mount(def, { surface: 'internal' });
    return GET!(makeEvent(username));
}

async function closeConnection(res: Response): Promise<void> {
    await res.body?.cancel();
}

beforeEach(() => {
    vi.clearAllMocks();
    mockReadRecent.mockResolvedValue([]);
    mockSubscribe.mockResolvedValue(() => {});
    mockConfig.SSE_MAX_CONNECTIONS_PER_USER = 3;
    mockConfig.SSE_MAX_CONNECTIONS = 1000;
});

describe('GET /api/v1/runs/{id}/logs — connection ceilings (C18, 2026-09-16 fix plan)', () => {
    it('declares a rateLimit field, matching the admin/ingest/stream sibling', () => {
        expect(def.rateLimit).toEqual(
            expect.objectContaining({ limit: expect.any(Number), windowSec: expect.any(Number) }),
        );
    });

    it('refuses a new connection process-wide once SSE_MAX_CONNECTIONS is reached, independent of per-user budget', async () => {
        // Drop the ceiling to 0 so even a brand-new user's FIRST connection
        // (0 active >= 0 max) is refused — deterministic without needing to
        // actually open a large number of connections to reach the ceiling.
        mockConfig.SSE_MAX_CONNECTIONS = 0;
        const res = await openConnection('zed');
        expect(res.status).toBe(503);
        expect(mockSubscribe).not.toHaveBeenCalled();
    });

    it('refuses the CAP+1th connection for one user (429), releasing frees a slot for the next connect', async () => {
        const CAP = 3; // mocked config.SSE_MAX_CONNECTIONS_PER_USER

        const opened: Response[] = [];
        for (let i = 0; i < CAP; i++) {
            opened.push(await openConnection('alice'));
        }
        for (const res of opened) expect(res.status).toBe(200);

        const overCapacity = await openConnection('alice');
        expect(overCapacity.status).toBe(429);

        await closeConnection(opened[0]);
        const reconnected = await openConnection('alice');
        expect(reconnected.status).toBe(200);

        // Clean up so the process-wide counter returns to baseline.
        await closeConnection(opened[1]);
        await closeConnection(opened[2]);
        await closeConnection(reconnected);
    });

    it('a different user is unaffected by another user’s per-user ceiling', async () => {
        const res = await openConnection('bob');
        expect(res.status).toBe(200);
        await closeConnection(res);
    });

    it('a throw during stream setup releases the slot instead of leaking it', async () => {
        const CAP = 3;
        mockSubscribe.mockRejectedValueOnce(new Error('log-buffer subscribe exploded'));

        const failed = await openConnection('carol');
        expect(failed.status).toBe(200);
        // The rejection happens inside the async start() — draining the (now
        // errored) stream lets it settle before the assertions below.
        await failed.body
            ?.getReader()
            .read()
            .catch(() => {});

        // The slot from the failed attempt must have been released — carol can
        // still open CAP fresh connections afterward.
        for (let i = 0; i < CAP; i++) {
            const res = await openConnection('carol');
            expect(res.status).toBe(200);
        }
    });
});
