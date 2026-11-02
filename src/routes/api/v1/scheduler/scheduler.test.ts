// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for GET /api/v1/scheduler
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockValidatePat = vi.fn();

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: mockValidatePat }),
}));

// fix-plan-5 Task 3: authenticate()'s pat_ branch now resolves identity via
// resolveTokenUserAccess() (Formula A) instead of trusting the raw
// validate() row directly. This suite is about the route's own business
// logic, not identity-resolution correctness (that has its own coverage in
// resolve-token-user-access.test.ts / tasks/api-auth.test.ts), so derive the
// mock's answer from whatever mockValidatePat is configured with per test,
// rather than hitting a real (unconfigured here) Postgres connection.
vi.mock('$lib/server/auth/resolve-token-user-access.js', () => ({
    resolveTokenUserAccess: async (username: string) => {
        const validated = await mockValidatePat();
        if (!validated || validated.username !== username) return null;
        return {
            userGroups: validated.groups ?? [],
            disabled: false,
            deleted: false,
            permissions: {
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: false,
                hasReviewPermission: false,
                hasMediaAnnotationPermission: false,
                ownerIsAdmin: (validated.scopes ?? []).includes('admin'),
                maxAgeRating: null,
                isAgeRestricted: false,
                isModerator: false,
                liveTvPriority: 'low',
            },
        };
    },
    computeOwnerMaxAge: () => null,
    mergeMaxAge: (a: number | null, b: number | null) =>
        a === null ? b : b === null ? a : Math.min(a, b),
    MOST_RESTRICTIVE_AGE_RATING: 0,
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn() }),
}));

const mockGetTask = vi.fn();

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getTask: mockGetTask },
}));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: mockGetDb,
}));

const mockGetValkeyClient = vi.fn();
vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: mockGetValkeyClient,
    getCoordinationClient: mockGetValkeyClient,
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => () => {}),
}));

const mockListAllScheduledTasks = vi.fn();
vi.mock('$lib/server/tasks/scheduler-state.js', () => ({
    listAllScheduledTasks: mockListAllScheduledTasks,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (evt: unknown) => Promise<Response>) => async (evt: unknown) => {
        try {
            return await fn(evt);
        } catch (err) {
            if (err && typeof err === 'object' && 'statusCode' in err) {
                const e = err as { statusCode: number; message: string };
                return new Response(JSON.stringify({ error: e.message }), {
                    status: e.statusCode,
                });
            }
            throw err;
        }
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(opts: { headers?: Record<string, string> } = {}) {
    return {
        request: { headers: new Headers(opts.headers ?? {}) },
        params: {},
        url: new URL('http://localhost/api/v1/scheduler'),
        locals: {},
    };
}

const adminPat = {
    id: 1,
    userId: '11111111-1111-4111-8111-111111111111',
    username: 'alice',
    name: 'test',
    scopes: ['admin'],
    groups: [],
    jellyfinUserId: null,
    tokenPrefix: 'pat_aaa',
};

const stubSchedulerState = {
    taskId: 'embed-metadata',
    lastFiredAt: new Date('2026-01-01T00:00:00Z'),
    nextFireAt: new Date('2026-01-01T01:00:00Z'),
    paused: false,
    pausedBy: null,
    pausedAt: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/scheduler', () => {
    // The first import of the route transforms mount() and every def it pulls
    // in (~26 s on the CI runner), which used to land inside the first test's
    // 30 s timeout. Pay it once here; resetModules() below keeps the transform
    // cache, so each test's own import stays fast.
    beforeAll(async () => {
        await import('./+server.js');
    }, 120_000);

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        mockValidatePat.mockResolvedValue(adminPat);
        mockGetValkeyClient.mockReturnValue({ get: async () => null });
    });

    it('publishes the scheduler as internal/beta without changing its scope', async () => {
        const { def } = await import('$lib/server/api/defs/scheduler/index.js');
        expect(def.docs?.visibility).toBe('internal');
        expect(def.docs?.GET?.stability).toBe('beta');
        expect(def.auth).toEqual({ kind: 'scope', anyOf: ['tasks:read'] });
    });

    it('still accepts a tasks:read bearer without admin scope', async () => {
        mockValidatePat.mockResolvedValue({ ...adminPat, scopes: ['tasks:read'] });
        mockGetDb.mockReturnValue(null);
        const { GET } = await import('./+server.js');
        const resp = await GET!(
            makeEvent({ headers: { authorization: 'Bearer pat_abc' } }) as Parameters<
                NonNullable<typeof GET>
            >[0],
        );
        expect(resp.status).toBe(200);
    });

    it('keeps the cookie mount available to an admin session', async () => {
        mockGetDb.mockReturnValue(null);
        const { GET } = await import('../../scheduler/+server.js');
        const event = {
            ...makeEvent(),
            url: new URL('http://localhost/api/scheduler'),
            locals: {
                user: { username: 'alice', ownerIsAdmin: true },
                principal: { username: 'alice', isAdmin: true, scopes: ['admin'] },
            },
        };
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(200);
        expect(await resp.json()).toMatchObject({ tasks: [], queuesPaused: { cpu: false } });
    });

    it('does not grant the cookie mount to a read-only session', async () => {
        mockGetDb.mockReturnValue(null);
        const { GET } = await import('../../scheduler/+server.js');
        const event = {
            ...makeEvent(),
            url: new URL('http://localhost/api/scheduler'),
            locals: {
                principal: { username: 'bob', isAdmin: false, scopes: ['read'] },
            },
        };
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(403);
        expect(mockGetDb).not.toHaveBeenCalled();
    });

    it('returns 401 with no bearer token', async () => {
        mockGetDb.mockReturnValue({});
        mockListAllScheduledTasks.mockResolvedValue([]);
        const { GET } = (await import('./+server.js'))!;
        const resp = await GET!(makeEvent() as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 for insufficient scope', async () => {
        mockValidatePat.mockResolvedValue({
            id: 2,
            userId: '22222222-2222-4222-8222-222222222222',
            username: 'bob',
            scopes: ['jellyfin_compat'],
            groups: [],
        });
        mockGetDb.mockReturnValue({});
        mockListAllScheduledTasks.mockResolvedValue([]);
        const { GET } = (await import('./+server.js'))!;
        const resp = await GET!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
            }) as Parameters<NonNullable<typeof GET>>[0],
        );
        expect(resp.status).toBe(403);
    });

    it('returns empty lists when DB is unavailable', async () => {
        mockGetDb.mockReturnValue(null);
        const { GET } = (await import('./+server.js'))!;
        const resp = await GET!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
            }) as Parameters<NonNullable<typeof GET>>[0],
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            tasks: unknown[];
            queuesPaused: Record<string, boolean>;
        };
        expect(body.tasks).toHaveLength(0);
        expect(body.queuesPaused.cpu).toBe(false);
    });

    it('returns scheduled task list with queue pause flags', async () => {
        mockGetDb.mockReturnValue({});
        mockListAllScheduledTasks.mockResolvedValue([stubSchedulerState]);
        mockGetTask.mockReturnValue({
            id: 'embed-metadata',
            schedule: { every: '1h', runOnStartup: false },
        });
        mockGetValkeyClient.mockReturnValue({
            get: async (key: string) => (key.includes('cpu') ? '1' : null),
        });

        const { GET } = await import('./+server.js');
        const resp = await GET!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
            }) as Parameters<NonNullable<typeof GET>>[0],
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            tasks: Array<{ taskId: string; paused: boolean }>;
            queuesPaused: Record<string, boolean>;
            queueStates: Record<string, { paused: boolean; reachable: boolean }>;
        };
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].taskId).toBe('embed-metadata');
        expect(body.queuesPaused.cpu).toBe(true);
        expect(body.queuesPaused.io).toBe(false);
    });

    it('exposes top-level queueStates with paused/reachable per queue', async () => {
        mockGetDb.mockReturnValue({});
        mockListAllScheduledTasks.mockResolvedValue([]);
        mockGetValkeyClient.mockReturnValue({
            get: async (key: string) => (key.includes('io') ? '1' : null),
        });

        const { GET } = await import('./+server.js');
        const resp = await GET!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
            }) as Parameters<NonNullable<typeof GET>>[0],
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            queueStates: Record<string, { paused: boolean; reachable: boolean }>;
        };
        expect(body.queueStates).toBeDefined();
        expect(body.queueStates.io.paused).toBe(true);
        expect(body.queueStates.cpu.paused).toBe(false);
        // reachable mirrors whether the depth snapshot resolved
        expect(typeof body.queueStates.cpu.reachable).toBe('boolean');
    });
});
