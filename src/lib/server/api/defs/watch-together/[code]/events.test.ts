// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fix round 1, finding 2: the watch-together SSE path (`registerSSEConnection`
 * in watch-together.service.ts) had no per-user or process-wide connection
 * ceiling — the brief's P1 fix text explicitly named this path, but Task 6's
 * first pass only covered the `createSseReplayHub`-backed endpoints.
 *
 * Drives `GET {code}/events`'s real handler (the seam) the same way the hub's
 * own test suite exercises `streamResponse()`: open CAP connections for one
 * user, assert the CAP+1th is refused, assert a released slot lets the next
 * connection through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type * as WatchTogetherService from '$lib/server/services/watch-together.service.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
}));

const mockGetDb = vi.fn((): unknown => null);
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => mockGetDb() }));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));
vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: { resolveAnyMediaId: vi.fn(async (id: string) => ({ internalId: id })) },
}));

// Small, deterministic ceilings so this test doesn't need real connections.
vi.mock('$lib/server/config.js', () => ({
    config: {
        SSE_MAX_CONNECTIONS_PER_USER: 3,
        SSE_MAX_CONNECTIONS: 1000,
    },
    features: {},
    FEATURE_PER_TASK_QUEUES: false,
}));

// No Valkey in this test — acquireUserConnectionSlot() falls back to its
// in-process Map path, and checkRateLimit() falls back to its memory store.
// Partial mock (importOriginal): events.ts's module graph pulls in
// task-system modules that call OTHER cache/valkey.js exports (e.g.
// subscribeToChannel) at import time, so a hand-written replacement module
// would need to keep growing to match — override only what this suite needs
// to control and keep everything else real (real subscribeToChannel/etc.
// already degrade gracefully with no Valkey connected, same as production
// when the dependency is down).
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return {
        ...actual,
        getCoordinationClient: vi.fn(() => null),
        isCoordinationValkeyReady: vi.fn(() => false),
        connectValkey: vi.fn(async () => {}),
        lRange: vi.fn(async (): Promise<string[]> => []),
        cacheGet: vi.fn(async (_key: string): Promise<string | null> => null),
    };
});

// No real timers — the keepalive interval is irrelevant to connection-slot
// accounting and would otherwise leak intervals across tests. Captures the
// `opts` each call was invoked with so a test can fire `onTick` manually
// (final fix wave, 2026-09-13: onTick must also refresh the connection
// slot's TTL, not just touchSSEConnection).
const mockStartSseKeepalive = vi.fn((_controller: unknown, opts: { onTick?: () => void }) => {
    lastKeepaliveOpts = opts;
    return () => {};
});
let lastKeepaliveOpts: { onTick?: () => void } | undefined;
vi.mock('$lib/server/utils/sse.js', () => ({
    SSE_KEEPALIVE_MS: 10_000,
    startSseKeepalive: (...args: [unknown, { onTick?: () => void }]) =>
        mockStartSseKeepalive(...args),
}));

const mockGetSession = vi.fn();
const mockRegisterSSEConnection = vi.fn();

vi.mock('$lib/server/services/watch-together.service.js', () => ({
    getSession: (...args: Parameters<typeof WatchTogetherService.getSession>) =>
        mockGetSession(...args),
    getSessionWithParticipant: vi.fn(),
    isHostClient: vi.fn(),
    findParticipant: (
        session: { participants: { userId: string; clientId: string }[] },
        userId: string,
        clientId?: string,
    ) =>
        session.participants.find(
            (p) =>
                p.userId.toLowerCase() === userId.toLowerCase() &&
                (clientId === undefined || p.clientId === clientId),
        ),
    joinSession: vi.fn(),
    leaveSession: vi.fn(),
    disbandSession: vi.fn(),
    transferHost: vi.fn(),
    setSessionVisibility: vi.fn(),
    broadcastSeek: vi.fn(),
    updatePlaybackState: vi.fn(),
    reportPosition: vi.fn(),
    broadcastReaction: vi.fn(),
    broadcastScreenEffect: vi.fn(),
    navigateParty: vi.fn(),
    broadcastVersionChange: vi.fn(),
    broadcastHostActivity: vi.fn(),
    updateSessionPosition: vi.fn(),
    signalReady: vi.fn(),
    registerSSEConnection: (
        ...args: Parameters<typeof WatchTogetherService.registerSSEConnection>
    ) => mockRegisterSSEConnection(...args),
    touchSSEConnection: vi.fn(async () => {}),
    reportClientStall: vi.fn(),
    reportClientStallReady: vi.fn(),
    getPendingBufferCheckSnapshot: (
        ...args: Parameters<typeof WatchTogetherService.getPendingBufferCheckSnapshot>
    ) => mockGetPendingBufferCheckSnapshot(...args),
    // The REAL implementation (summing sseConnections) is exactly what fix
    // round 1 finding 2 added — exercised directly by its own unit test in
    // watch-together.service.test.ts (if present) / indirectly via mount()'s
    // real service in integration tests. Here it is mocked so this suite
    // controls the process-wide count precisely.
    getActiveSSEConnectionCount: () => mockGetActiveSSEConnectionCount(),
}));

const mockGetActiveSSEConnectionCount = vi.fn(() => 0);
const mockGetPendingBufferCheckSnapshot = vi.fn(async (_code: string) => null);

import { def } from './events.js';
import { isHostClient, navigateParty } from '$lib/server/services/watch-together.service.js';
import { EventAcceptedResponseSchema } from '$lib/schemas/watch-together.js';
import { cacheGet, isCoordinationValkeyReady, lRange } from '$lib/server/cache/valkey.js';
import { watchTogetherEventInputSchema } from '$lib/schemas/watch-together.js';
import type { ApiContext } from '$lib/server/api/define.js';

const USER_IDS: Record<string, string> = {
    'replay-gap': 'd692c7f9-e2f3-5ebe-b209-fb0b7f1d459f',
    'replay-ahead': 'ed570dd1-4815-5aa0-aaa2-141eab132976',
    'replay-empty': 'e158f2c6-9045-5d97-861f-e1b14dffb0dd',
    'replay-boundary': 'f645c7d4-b28a-5522-b27e-6f1e39bab7c8',
    alice: 'c9ece8b0-555a-5dcc-957d-ecafc7bf9c1f',
    bob: '36783d59-df31-55eb-8c63-8ab7869a529a',
    carol: 'ce0d8a04-0221-524a-ab57-c8a007c59839',
    zed: 'dffad242-fdf2-593e-8481-780b945222cc',
    dave: 'c941a1d4-e3f2-5d21-8c1a-82cc2993ef98',
    'binding-user': 'cc204f78-6814-5e74-814e-f88412cdee0b',
};
const SESSION = {
    code: 'ABCD',
    participants: Object.entries(USER_IDS).map(([displayName, userId]) => ({
        userId,
        displayName,
        clientId: 'client-1',
        joinedAt: 1,
    })),
} as unknown;

function buildEvent(username: string, clientId = 'client-1'): RequestEvent {
    const url = `http://localhost/watch-together/ABCD/events?clientId=${clientId}`;
    return {
        url: new URL(url),
        request: new Request(url, { headers: {} }),
        locals: { user: { username, userId: USER_IDS[username] } },
        params: { code: 'ABCD' },
    } as unknown as RequestEvent;
}

function buildCtx(
    clientId = 'client-1',
    lastEventId?: string,
    body?: ReturnType<typeof watchTogetherEventInputSchema.parse>,
): ApiContext {
    return {
        surface: 'v1' as const,
        input: {
            params: { code: 'ABCD' },
            query: { clientId, lastEventId },
            body,
        },
    } as unknown as ApiContext;
}

/**
 * `def.handlers.GET` is typed via `EventsRequestSchemas` (a discriminated
 * union `body` schema), which a hand-built test `ApiContext` can't satisfy
 * structurally without re-deriving that whole Zod shape. Cast once here,
 * matching how mount() actually calls handlers at runtime (untyped past the
 * def boundary).
 */
const callGet = def.handlers.GET as unknown as (
    event: RequestEvent,
    ctx: ApiContext,
) => Promise<Response>;

/**
 * Open one SSE connection and return the Response. Teardown ("release a
 * slot") is done by cancelling the response's stream — `cancel()` is exactly
 * what the runtime calls on a real client disconnect, and it is what invokes
 * the handler's real `cleanup()` (which releases the connection slot).
 * Calling the mock's returned "unregister" function directly would NOT
 * exercise that path — `cleanup()` is only reachable via stream cancellation
 * or the keepalive's `onDead` callback in the real handler.
 */
async function openConnection(username: string, clientId = 'client-1'): Promise<Response> {
    return callGet(buildEvent(username, clientId), buildCtx(clientId));
}

/** Release a connection's slot the way a real client disconnect would. */
async function closeConnection(res: Response): Promise<void> {
    await res.body?.cancel();
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isCoordinationValkeyReady).mockReturnValue(false);
    vi.mocked(cacheGet).mockResolvedValue(null);
    vi.mocked(lRange).mockResolvedValue([]);
    mockGetSession.mockResolvedValue(SESSION);
    mockGetActiveSSEConnectionCount.mockReturnValue(0);
    mockRegisterSSEConnection.mockImplementation(async () => () => {});
    mockGetPendingBufferCheckSnapshot.mockResolvedValue(null);
});

describe('GET /watch-together/{code}/events — connection ceilings (fix round 1, finding 2)', () => {
    it('refuses the CAP+1th connection for one user (429), releasing frees a slot for the next connect', async () => {
        const CAP = 3; // mocked config.SSE_MAX_CONNECTIONS_PER_USER

        const opened: Response[] = [];
        for (let i = 0; i < CAP; i++) {
            opened.push(await openConnection('alice'));
        }
        for (const res of opened) expect(res.status).toBe(200);
        expect(mockRegisterSSEConnection).toHaveBeenCalledTimes(CAP);

        // CAP+1th connection for the SAME user → 429, registerSSEConnection
        // never called for the refused attempt.
        mockRegisterSSEConnection.mockClear();
        const overCapacity = await openConnection('alice');
        expect(overCapacity.status).toBe(429);
        expect(mockRegisterSSEConnection).not.toHaveBeenCalled();

        // A different user is unaffected by alice's per-user ceiling.
        const bob = await openConnection('bob');
        expect(bob.status).toBe(200);
        await closeConnection(bob);

        // Releasing one of alice's connections (via real stream cancellation —
        // the same path a client disconnect takes) frees exactly one slot.
        await closeConnection(opened[0]);
        mockRegisterSSEConnection.mockClear();
        const reconnected = await openConnection('alice');
        expect(reconnected.status).toBe(200);
        expect(mockRegisterSSEConnection).toHaveBeenCalledTimes(1);
    });

    it('refuses a new connection process-wide once SSE_MAX_CONNECTIONS is reached, independent of per-user budget', async () => {
        mockGetActiveSSEConnectionCount.mockReturnValue(1000); // mocked ceiling

        const res = await openConnection('zed'); // brand-new user, nowhere near their own cap
        expect(res.status).toBe(503);
        expect(mockRegisterSSEConnection).not.toHaveBeenCalled();
    });

    it('a connection registration failure releases the slot instead of leaking it', async () => {
        const CAP = 3;
        mockRegisterSSEConnection.mockRejectedValueOnce(new Error('valkey down'));

        const failed = await openConnection('carol');
        expect(failed.status).toBe(503);

        // The slot from the failed attempt must have been released — carol can
        // still open CAP fresh connections afterward.
        for (let i = 0; i < CAP; i++) {
            const res = await openConnection('carol');
            expect(res.status).toBe(200);
        }
    });

    // Deferred item 5 (2026-09-13 security review): registerSSEConnection
    // succeeds and reserves the slot, but the startup reads that run right
    // after it (getReplayEvents / getPendingBufferCheckSnapshot) were NOT
    // wrapped in the try/catch that releases that slot — a failure there
    // leaked one slot per occurrence, and enough of them permanently locked
    // users out (the connection ceiling never comes back down).
    //
    // getReplayEvents itself is a module-private function in events.ts (not
    // imported, so not independently mockable) whose own try/catch already
    // swallows every error it can hit today — it can never actually throw to
    // its caller. getPendingBufferCheckSnapshot is the one startup dependency
    // reachable through the service-module seam this suite already mocks, so
    // it's the vehicle for exercising "one of the two startup reads throws"
    // — the fix wraps BOTH calls in one try/catch, so proving the wrap
    // releases the slot here pins the whole block regardless of which call
    // is the one that throws.
    it('a startup-read failure AFTER registration (getReplayEvents/getPendingBufferCheckSnapshot) releases the slot instead of leaking it', async () => {
        const CAP = 3;
        mockGetPendingBufferCheckSnapshot.mockRejectedValueOnce(new Error('valkey down mid-read'));

        const failed = await openConnection('dave');
        expect(failed.status).toBe(503);
        // registerSSEConnection DID succeed for this attempt (unlike the
        // registration-failure test above) — the seam under test is the
        // release path for a slot that was already reserved.
        expect(mockRegisterSSEConnection).toHaveBeenCalledTimes(1);

        // The slot reserved by that successful registerSSEConnection call
        // must have been released — dave can still open CAP fresh
        // connections afterward, proving the per-user ceiling count actually
        // returned to its prior value rather than staying pinned.
        for (let i = 0; i < CAP; i++) {
            const res = await openConnection('dave');
            expect(res.status).toBe(200);
        }
    });

    // Final fix wave (2026-09-13): a long-lived watch party can outlive the
    // connection slot's Valkey TTL (1h) — the keepalive tick must refresh it
    // (connectionSlot.refresh()) alongside touchSSEConnection(), not just the
    // liveness marker. This suite runs with no Valkey (in-process fallback,
    // where refresh() is a documented no-op), so the assertion is that the
    // wiring exists and never throws — the Valkey-path refresh() behavior
    // itself is covered by sse-connection-ceiling.test.ts.
    it('the keepalive onTick refreshes the connection slot alongside touchSSEConnection', async () => {
        // Clear the mock rather than resetting lastKeepaliveOpts: assigning
        // `undefined` here narrows the variable to `undefined` for the rest of
        // the test, because TS can't see that the reassignment happens inside
        // the mock's own callback — the optional chain below then reads as
        // `never`. Same freshness guarantee, matching the mockClear() usage
        // elsewhere in this file.
        mockStartSseKeepalive.mockClear();
        const res = await openConnection('zed');
        expect(res.status).toBe(200);

        expect(mockStartSseKeepalive).toHaveBeenCalled();
        expect(lastKeepaliveOpts?.onTick).toBeTypeOf('function');
        expect(() => lastKeepaliveOpts?.onTick?.()).not.toThrow();

        await closeConnection(res);
    });
});

describe('SSE identity binding', () => {
    it('refuses an unregistered ID before registration or capacity reservation', async () => {
        const refused = await openConnection('binding-user', 'unregistered');
        expect(refused.status).toBe(403);
        expect(mockRegisterSSEConnection).not.toHaveBeenCalled();
        for (let i = 0; i < 3; i++) {
            const honest = await openConnection('binding-user');
            expect(honest.status).toBe(200);
            await closeConnection(honest);
        }
    });
});

describe('Watch Together SSE replay contract', () => {
    it('documents the same 17-variant request union used by mount', () => {
        expect(def.docs?.POST?.body).toBe(watchTogetherEventInputSchema);
        expect(watchTogetherEventInputSchema.options).toHaveLength(17);
    });

    it.each([
        { cursor: 1, reason: 'gap', username: 'replay-gap' },
        { cursor: 101, reason: 'ahead', username: 'replay-ahead' },
    ])(
        'sends connected then resync for $reason, with no replay',
        async ({ cursor, reason, username }) => {
            vi.mocked(isCoordinationValkeyReady).mockReturnValue(true);
            vi.mocked(cacheGet).mockResolvedValue('100');
            vi.mocked(lRange).mockResolvedValue([
                JSON.stringify({ seq: 100, event: { type: 'resume' } }),
                JSON.stringify({ seq: 51, event: { type: 'resume' } }),
            ]);
            const event = buildEvent(username);
            event.request.headers.set('Last-Event-ID', String(cursor));
            const response = await callGet(event, buildCtx());
            expect(response.status).toBe(200);
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            const connected = decoder.decode((await reader.read()).value);
            expect(connected).not.toContain('id:');
            expect(JSON.parse(connected.slice(6))).toMatchObject({
                type: 'connected',
                lastEventId: 100,
            });
            const resync = decoder.decode((await reader.read()).value);
            expect(resync).not.toContain('id:');
            expect(JSON.parse(resync.slice(6))).toEqual({
                type: 'resync',
                reason,
                lastEventId: 100,
            });
            let extraFrame = false;
            const pending = reader.read().then(({ done }) => {
                extraFrame = !done;
            });
            await reader.cancel();
            await pending;
            expect(extraFrame).toBe(false);
        },
    );

    it.each(
        [
            { cursor: '', ready: true, counter: '100', ring: true, resync: true },
            { cursor: '-1', ready: true, counter: '100', ring: true, resync: true },
            { cursor: 'abc', ready: true, counter: '100', ring: true, resync: true },
            { cursor: '1234567890123456', ready: true, counter: '100', ring: true, resync: true },
            { cursor: '100', ready: true, counter: '100', ring: true, resync: false },
            { cursor: '99', ready: true, counter: '100', ring: false, resync: true },
            { cursor: '1', ready: false, counter: '0', ring: false, resync: true },
        ].flatMap((entry) => ['header', 'query'].map((source) => ({ ...entry, source }))),
    )(
        'handles $source cursor "$cursor" with ready=$ready and ring=$ring',
        async ({ cursor, ready, counter, ring, resync, source }) => {
            vi.mocked(isCoordinationValkeyReady).mockReturnValue(ready);
            vi.mocked(cacheGet).mockResolvedValue(counter);
            vi.mocked(lRange).mockResolvedValue(
                ring ? [JSON.stringify({ seq: 100, event: { type: 'resume' } })] : [],
            );
            const event = buildEvent('replay-gap');
            const ctx = buildCtx('client-1', source === 'query' ? cursor : undefined);
            if (source === 'header') event.request.headers.set('Last-Event-ID', cursor);
            const response = await callGet(event, ctx);
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            expect(decoder.decode((await reader.read()).value)).toContain('"type":"connected"');
            if (resync) {
                expect(JSON.parse(decoder.decode((await reader.read()).value).slice(6))).toEqual({
                    type: 'resync',
                    reason: 'gap',
                    lastEventId: Number(counter),
                });
            }
            let extraFrame = false;
            const pending = reader.read().then(({ done }) => {
                extraFrame = !done;
            });
            await reader.cancel();
            await pending;
            expect(extraFrame).toBe(false);
        },
    );

    it('bootstraps with cursor zero when no business frame has been emitted', async () => {
        const response = await openConnection('replay-empty');
        const reader = response.body!.getReader();
        const connected = new TextDecoder().decode((await reader.read()).value);
        expect(JSON.parse(connected.slice(6))).toMatchObject({ type: 'connected', lastEventId: 0 });
        await reader.cancel();
    });

    it('replays from the immediately preceding cursor and preserves sender exclusions', async () => {
        vi.mocked(isCoordinationValkeyReady).mockReturnValue(true);
        vi.mocked(cacheGet).mockResolvedValue('52');
        vi.mocked(lRange).mockResolvedValue([
            JSON.stringify({ seq: 52, event: { type: 'resume' }, excludeClientId: 'client-1' }),
            JSON.stringify({ seq: 51, event: { type: 'resume' } }),
        ]);
        const event = buildEvent('replay-boundary');
        event.request.headers.set('Last-Event-ID', '50');
        const response = await callGet(event, buildCtx());
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        await reader.read();
        expect(decoder.decode((await reader.read()).value)).toBe(
            'id: 51\ndata: {"type":"resume"}\n\n',
        );
        expect(decoder.decode((await reader.read()).value)).toBe('id: 52\n\n');
        await reader.cancel();
    });
});

describe('POST navigation acknowledgement', () => {
    it('serializes the canonical nonzero episode entry in the actual HTTP response', async () => {
        mockGetDb.mockReturnValueOnce({});
        vi.mocked(isHostClient).mockReturnValueOnce(true);
        vi.mocked(navigateParty).mockResolvedValueOnce({ ok: true, currentTime: 72.546 });
        const input = watchTogetherEventInputSchema.parse({
            clientId: 'client-1',
            type: 'navigate',
            payload: {
                itemId: '11111111-1111-4111-8111-111111111111',
                title: 'Part two',
                mediaType: 'episode',
                timelineId: '22222222-2222-4222-8222-222222222222',
                expectedTimelineId: '33333333-3333-4333-8333-333333333333',
            },
        });
        const callPost = def.handlers.POST as unknown as (
            event: RequestEvent,
            ctx: ApiContext,
        ) => Promise<Response>;
        const response = await callPost(
            buildEvent('alice'),
            buildCtx('client-1', undefined, input),
        );
        expect(response.status).toBe(202);
        const body: unknown = await response.json();
        expect(body).toEqual({ accepted: true, currentTime: 72.546 });
        expect(EventAcceptedResponseSchema.parse(body).currentTime).toBe(72.546);
        expect(navigateParty).toHaveBeenCalledOnce();
    });
});
