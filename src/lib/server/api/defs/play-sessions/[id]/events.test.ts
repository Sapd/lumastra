// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C11 (2026-09-16 fix plan): `GET /play-sessions/{id}/events` (both mounts)
 * had no per-user or process-wide SSE connection ceiling —
 * `sessionControllers` (play-session-events.service.ts) had no size bound
 * anywhere, unlike `watch-together`'s registry, which the 2026-09-13 fix
 * plan's P1 already covers.
 *
 * Drives the def's real GET handler (the seam) the same way
 * `watch-together/[code]/events.test.ts` exercises its own handler: open CAP
 * connections for one user, assert the CAP+1th is refused, assert the
 * process-wide cap independently refuses a brand-new user, and assert a
 * throw during stream setup releases the slot instead of leaking it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
}));

// Small, deterministic ceilings so this test doesn't need real connections.
vi.mock('$lib/server/config.js', () => ({
    config: {
        SSE_MAX_CONNECTIONS_PER_USER: 3,
        SSE_MAX_CONNECTIONS: 1000,
    },
}));

// No Valkey in this test — acquireUserConnectionSlot() falls back to its
// in-process Map path.
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return {
        ...actual,
        getCoordinationClient: vi.fn(() => null),
    };
});

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

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({})) },
}));

const mockGetSessionById = vi.fn();
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
}));

const mockGetActivePlaySessionSSECount = vi.fn(() => 0);
const mockDeliverMaintenanceOnConnect = vi.fn(async () => {});
vi.mock('$lib/server/services/play-session-events.service.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/services/play-session-events.service.js')
        >();
    return {
        ...actual,
        // The REAL sessionControllers Map is kept (imported by BOTH this test
        // and the real events.ts module) so registration/removal is genuinely
        // exercised. Only the process-wide counter and the best-effort
        // maintenance replay are overridden so this suite controls them
        // precisely.
        getActivePlaySessionSSECount: () => mockGetActivePlaySessionSSECount(),
        deliverMaintenanceOnConnect: () => mockDeliverMaintenanceOnConnect(),
    };
});

import { def } from './events.js';
import type { ApiContext } from '$lib/server/api/define.js';

const SESSION_ID = 'session-1';

function buildEvent(userId: string): RequestEvent {
    const url = `http://localhost/play-sessions/${SESSION_ID}/events`;
    return {
        url: new URL(url),
        request: new Request(url, { headers: {} }),
        locals: { user: { userId } },
        params: { id: SESSION_ID },
    } as unknown as RequestEvent;
}

function buildCtx(): ApiContext {
    return {
        surface: 'v1' as const,
        input: { params: { id: SESSION_ID }, query: undefined, body: undefined },
    } as unknown as ApiContext;
}

const callGet = def.handlers.GET as unknown as (
    event: RequestEvent,
    ctx: ApiContext,
) => Promise<Response>;

async function openConnection(userId: string): Promise<Response> {
    return callGet(buildEvent(userId), buildCtx());
}

async function closeConnection(res: Response): Promise<void> {
    await res.body?.cancel();
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: 'alice' });
    mockGetActivePlaySessionSSECount.mockReturnValue(0);
    mockDeliverMaintenanceOnConnect.mockResolvedValue(undefined);
});

describe('GET /play-sessions/{id}/events — connection ceilings (C11, 2026-09-16 fix plan)', () => {
    it('refuses the CAP+1th connection for one user (429), releasing frees a slot for the next connect', async () => {
        const CAP = 3; // mocked config.SSE_MAX_CONNECTIONS_PER_USER

        const opened: Response[] = [];
        for (let i = 0; i < CAP; i++) {
            opened.push(await openConnection('alice'));
        }
        for (const res of opened) expect(res.status).toBe(200);

        // CAP+1th connection for the SAME user → 429.
        const overCapacity = await openConnection('alice');
        expect(overCapacity.status).toBe(429);

        // Releasing one of alice's connections (via real stream cancellation —
        // the same path a client disconnect takes) frees exactly one slot.
        await closeConnection(opened[0]);
        const reconnected = await openConnection('alice');
        expect(reconnected.status).toBe(200);
    });

    it('a different user is unaffected by another user’s per-user ceiling', async () => {
        mockGetSessionById.mockImplementation(async (_sql: unknown, id: string) => ({
            id,
            user_id: 'bob',
        }));
        const res = await openConnection('bob');
        expect(res.status).toBe(200);
        await closeConnection(res);
    });

    it('refuses a new connection process-wide once SSE_MAX_CONNECTIONS is reached, independent of per-user budget', async () => {
        mockGetActivePlaySessionSSECount.mockReturnValue(1000); // mocked ceiling

        const res = await openConnection('alice'); // nowhere near their own per-user cap
        expect(res.status).toBe(503);
    });

    it('a throw during stream setup releases the slot instead of leaking it', async () => {
        const CAP = 3;
        mockGetSessionById.mockImplementation(async (_sql: unknown, id: string) => ({
            id,
            user_id: 'carol',
        }));
        // Force the keepalive wiring (the last step of stream setup) to throw
        // synchronously — the known prior defect this fix guards against is a
        // slot leaking when setup throws between registration and the stream
        // being handed back to the client.
        mockStartSseKeepalive.mockImplementationOnce(() => {
            throw new Error('keepalive wiring exploded');
        });

        await expect(openConnection('carol')).rejects.toThrow('keepalive wiring exploded');

        // The slot from the failed attempt must have been released — carol can
        // still open CAP fresh connections afterward.
        for (let i = 0; i < CAP; i++) {
            const res = await openConnection('carol');
            expect(res.status).toBe(200);
        }
    });
});
