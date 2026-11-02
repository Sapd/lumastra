// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for GET /api/v1/tasks, GET /api/v1/tasks/{taskId}, and
 * GET/PATCH /api/v1/tasks/{taskId}/state.
 *
 * All external dependencies are mocked — no live infrastructure required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockValidatePat = vi.fn();
const mockValidateSvc = vi.fn();

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
    getServiceTokenService: () => ({ validate: mockValidateSvc }),
}));

const mockGetTask = vi.fn();
const mockGetAllTasks = vi.fn();

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getTask: mockGetTask,
        getAllTasks: mockGetAllTasks,
    },
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

vi.mock('$lib/server/utils/api-responses.js', () => ({
    ApiResponses: {
        unauthorized: (msg: string) =>
            new Response(JSON.stringify({ error: msg }), { status: 401 }),
        forbidden: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 403 }),
        notFound: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 404 }),
        badRequest: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
    },
}));

// Mocks for tasks/{taskId}/state endpoint
const mockGetSchedulerState = vi.fn();
const mockPauseTask = vi.fn();
const mockResumeTask = vi.fn();

const mockListAllScheduledTasks = vi.fn();

// Lane metrics stay "unavailable" (the null-DB answer) in every test, so a test
// that hands `getTaskDb` a stand-in handle for the scheduler-state read does not
// also drive the lane SQL through it.
vi.mock('$lib/server/tasks/lane-data.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/tasks/lane-data.js')>()),
    getTaskLaneData: vi.fn(async () => null),
}));

// Loading every builtin task module just to read registration errors made the
// cold import of the list route take ~29 s — right at the 30 s test timeout.
vi.mock('$lib/server/tasks/builtin/index.js', () => ({
    getBuiltinRegistrationErrors: () => [],
}));

vi.mock('$lib/server/tasks/scheduler-state.js', () => ({
    getSchedulerState: (...args: unknown[]) => mockGetSchedulerState(...args),
    listAllScheduledTasks: (...args: unknown[]) => mockListAllScheduledTasks(...args),
    pauseTask: (...args: unknown[]) => mockPauseTask(...args),
    resumeTask: (...args: unknown[]) => mockResumeTask(...args),
    // No operator triggers in these tests: every task runs on its default schedule.
    listTaskTriggers: vi.fn(async () => null),
    listAllTaskTriggers: vi.fn(async () => new Map()),
    setNextFireAt: vi.fn(async () => undefined),
}));

const mockCbCheck = vi.fn();
const mockCbForceEnable = vi.fn();

vi.mock('$lib/server/tasks/circuit-breaker.js', () => ({
    CircuitBreaker: class MockCircuitBreaker {
        check(...args: unknown[]) {
            return mockCbCheck(...args);
        }
        // Status reads use peek() (no probe slot taken, 994039e21b); same stub decision.
        peek(...args: unknown[]) {
            return mockCbCheck(...args);
        }
        forceEnable(...args: unknown[]) {
            return mockCbForceEnable(...args);
        }
    },
}));

// Return null by default so existing list/detail tests don't try to run
// DB queries. State tests that need a DB connection can set up their own
// mock overrides via vi.spyOn or vi.mocked.
const mockGetTaskDb = vi.fn(() => null as unknown);
const mockGetDb = vi.fn(() => null as unknown);
vi.mock('$lib/server/database/connection.js', () => ({
    getTaskDb: (...args: []) => mockGetTaskDb(...args),
    getDb: (...args: []) => mockGetDb(...args),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: () => null,
    getCoordinationClient: () => null,
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => () => {}),
}));

vi.mock('$lib/server/config.js', () => ({
    config: { FEATURE_DEVICE_AUTH: false },
    LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS: 3_600_000,
}));

vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    // The defs call auditActor(event) to resolve the actor's USERNAME (security
    // fix C24). Without it the factory mock is incomplete, vitest throws on the
    // missing export INSIDE the handler, and mount's catch turns that into a
    // problem+json 500 — so assertions saw 500 instead of their real status.
    auditActor: vi.fn(() => ({ username: 'admin' })),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
    opts: {
        headers?: Record<string, string>;
        params?: Record<string, string>;
        url?: URL;
        body?: unknown;
    } = {},
) {
    // Serialize body once so both text() and json() return consistent data.
    const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : '';
    // mount() reads the body as a BOUNDED STREAM — bounded-body-reader's
    // readBoundedBodyChunks() does `request.body?.getReader()`, so a fake
    // request exposing only text()/json() makes mount hand the handler `{}`
    // (the streamed byte cap, C26 2026-09-16). Only define the stream when
    // there IS a body; a body-less request must not carry the key at all.
    const bodyStream =
        bodyText === ''
            ? {}
            : {
                  body: new ReadableStream<Uint8Array>({
                      start(controller) {
                          controller.enqueue(new TextEncoder().encode(bodyText));
                          controller.close();
                      },
                  }),
              };
    return {
        request: {
            ...bodyStream,
            headers: new Headers(opts.headers ?? {}),
            // Use the route's actual method so mount() validates the PATCH body.
            method: opts.body === undefined ? 'GET' : 'PATCH',
            json: async () => opts.body ?? {},
            // Kept for the handlers that bypass mount() and read the body directly.
            text: async () => bodyText,
        },
        params: opts.params ?? {},
        url: opts.url ?? new URL('http://localhost/api/v1/tasks'),
        // authenticate() reads event.locals.user for the admin-cookie fast
        // path; empty locals lets the bearer-only path execute.
        locals: {},
    };
}

const stubTask = {
    id: 'embed-metadata',
    name: 'Embed Metadata',
    version: '1.0.0',
    processingVersion: 1,
    resourceClass: 'io',
    capabilities: { database: true, http: true },
    execute: () => Promise.resolve({ success: true }),
    inputSchema: { parse: () => ({}) },
    identityFor: () => 'key',
};

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

// ── GET /api/v1/tasks ─────────────────────────────────────────────────────────

describe('GET /api/v1/tasks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetAllTasks.mockReturnValue([stubTask]);
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('returns task list for valid PAT', async () => {
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { items: unknown[]; page: unknown };
        expect(body.page).toEqual({ limit: 1, offset: 0, hasMore: false });
        expect(body.items).toHaveLength(1);
        expect((body.items[0] as Record<string, string>).id).toBe('embed-metadata');
        // Undeclared visibility reads as a user task — plugins keep being listed.
        expect((body.items[0] as Record<string, string>).visibility).toBe('user');
    });

    it.each([
        ['cookie', 'exponential'],
        ['cookie', [100, 500, 1000]],
        ['token', 'exponential'],
        ['token', [100, 500, 1000]],
    ])('preserves SDK retry backoff on the %s surface: %j', async (surface, backoff) => {
        const task = {
            ...stubTask,
            retry: { attempts: 3, backoff },
            pipeline: { of: 'scan', after: ['discover'], when: () => true },
        };
        mockGetAllTasks.mockReturnValue([task]);
        mockGetTask.mockReturnValue(task);
        const list = surface === 'cookie'
            ? await import('../../tasks/+server.js')
            : await import('./+server.js');
        const detail = surface === 'cookie'
            ? await import('../../tasks/[taskId]/+server.js')
            : await import('./[taskId]/+server.js');
        const event = makeEvent({
            headers: surface === 'token' ? { authorization: 'Bearer pat_abc' } : {},
            params: { taskId: task.id },
        });
        if (surface === 'cookie') {
            Object.assign(event.locals, {
                principal: {
                    kind: 'session', userId: adminPat.userId, username: 'admin',
                    userGroups: [], scopes: ['tasks:read'], isAdmin: true,
                },
            });
        }
        const listResponse = await list.GET!(event as Parameters<NonNullable<typeof list.GET>>[0]);
        expect(listResponse.status).toBe(200);
        const body = await listResponse.json();
        expect(body.page).toEqual({ limit: 1, offset: 0, hasMore: false });
        expect(body.items[0].retry).toEqual(task.retry);
        expect(body.items[0].pipeline).toEqual({
            of: 'scan', after: ['discover'], hasWhen: true,
        });
        const detailResponse = await detail.GET!(event as Parameters<NonNullable<typeof detail.GET>>[0]);
        expect(detailResponse.status).toBe(200);
        const detailBody = await detailResponse.json();
        expect(detailBody.retry).toEqual(task.retry);
        expect(detailBody.pipeline).toEqual(body.items[0].pipeline);
        expect(detailBody).not.toHaveProperty('pluginId');
        expect(detailBody).not.toHaveProperty('lane');
    });

    it('reports a task declared as system machinery', async () => {
        mockGetAllTasks.mockReturnValue([{ ...stubTask, visibility: 'system' }]);
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const resp = await GET(
            makeEvent({ headers: { authorization: 'Bearer pat_abc' } }) as Parameters<
                typeof GET
            >[0],
        );
        const body = (await resp.json()) as { items: Array<Record<string, unknown>> };
        expect(body.items[0].visibility).toBe('system');
    });

    it('returns 401 when no bearer token', async () => {
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent();
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 401 for invalid PAT', async () => {
        mockValidatePat.mockResolvedValue(null);
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_bad' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 when PAT lacks required scope', async () => {
        mockValidatePat.mockResolvedValue({
            ...adminPat,
            scopes: ['jellyfin_compat'],
        });
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(403);
    });

    it('does not expose secret field defaults', async () => {
        const taskWithSecret = {
            ...stubTask,
            settings: {
                canToggle: false,
                fields: [
                    {
                        key: 'api_key',
                        label: 'API Key',
                        type: 'secret' as const,
                        default: 'supersecret',
                    },
                ],
            },
        };
        mockGetAllTasks.mockReturnValue([taskWithSecret]);
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        const body = (await resp.json()) as {
            items: Array<{
                settings: { fields: Array<{ default?: unknown }> };
            }>;
        };
        expect(body.items[0].settings.fields[0].default).toBeUndefined();
    });

    it('reports the next scheduled start, and none while the schedule is paused', async () => {
        mockGetTaskDb.mockReturnValue({} as never);
        try {
            const next = new Date('2026-09-27T10:00:00.000Z');
            mockListAllScheduledTasks.mockResolvedValue([
                {
                    taskId: 'embed-metadata',
                    lastFiredAt: null,
                    nextFireAt: next,
                    paused: false,
                    pausedBy: null,
                    pausedAt: null,
                },
            ]);
            const { GET } = await import('./+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const read = async (): Promise<Record<string, unknown>> => {
                const resp = await GET(
                    makeEvent({ headers: { authorization: 'Bearer pat_abc' } }) as Parameters<
                        typeof GET
                    >[0],
                );
                const body = (await resp.json()) as { items: Array<Record<string, unknown>> };
                return body.items[0];
            };
            expect((await read()).nextRunAt).toBe(next.toISOString());

            mockListAllScheduledTasks.mockResolvedValue([
                {
                    taskId: 'embed-metadata',
                    lastFiredAt: null,
                    nextFireAt: next,
                    paused: true,
                    pausedBy: 'alice',
                    pausedAt: new Date('2026-09-26T00:00:00.000Z'),
                },
            ]);
            expect((await read()).nextRunAt).toBeNull();
        } finally {
            // clearAllMocks keeps implementations — hand the next test the
            // unreachable-DB default back.
            mockGetTaskDb.mockReturnValue(null);
        }
    });
});

// ── GET /api/v1/tasks/{taskId} ────────────────────────────────────────────────────

describe('GET /api/v1/tasks/{taskId}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('returns task detail for valid taskId', async () => {
        mockGetTask.mockReturnValue(stubTask);
        const { GET } = await import('./[taskId]/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { id: string };
        expect(body.id).toBe('embed-metadata');
    });

    it('returns 404 for unknown taskId', async () => {
        mockGetTask.mockReturnValue(undefined);
        const { GET } = await import('./[taskId]/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'nonexistent' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(404);
    });

    it('returns 401 with no bearer', async () => {
        const { GET } = await import('./[taskId]/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({ params: { taskId: 'embed-metadata' } });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(401);
    });
});

// ── GET /api/v1/tasks/{taskId}/state ──────────────────────────────────────────────

const stubSchedulerState = {
    paused: false,
    pausedBy: null,
    pausedAt: null,
};

const stubCbDecision = {
    state: 'closed' as const,
    allowed: true,
    nextProbeAt: null,
    reason: null,
};

describe('GET /api/v1/tasks/{taskId}/state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        mockValidatePat.mockResolvedValue(adminPat);
        mockGetTask.mockReturnValue(stubTask);
        mockGetSchedulerState.mockResolvedValue(stubSchedulerState);
        mockCbCheck.mockResolvedValue(stubCbDecision);
        // State endpoint needs non-null DB handles
        mockGetTaskDb.mockReturnValue({});
        mockGetDb.mockReturnValue({});
    });

    it('returns aggregate state for a known task', async () => {
        const { GET } = await import('./[taskId]/state/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            schedule: string;
            breaker: string;
            effective: string;
            blocked: boolean;
        };
        expect(body.schedule).toBe('active');
        expect(body.breaker).toBe('closed');
        expect(body.effective).toBe('active');
        expect(body.blocked).toBe(false);
    });

    it('returns paused schedule when scheduler state is paused', async () => {
        mockGetSchedulerState.mockResolvedValue({
            paused: true,
            pausedBy: 'alice',
            pausedAt: new Date('2025-01-01T00:00:00.000Z'),
        });
        const { GET } = await import('./[taskId]/state/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            schedule: string;
            effective: string;
            blocked: boolean;
            schedulePausedBy: string;
        };
        expect(body.schedule).toBe('paused');
        expect(body.effective).toBe('paused');
        expect(body.blocked).toBe(true);
        expect(body.schedulePausedBy).toBe('alice');
    });

    it('returns 404 for unknown task', async () => {
        mockGetTask.mockReturnValue(undefined);
        const { GET } = await import('./[taskId]/state/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'nonexistent' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(404);
    });

    it('returns 401 with no bearer', async () => {
        const { GET } = await import('./[taskId]/state/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({ params: { taskId: 'embed-metadata' } });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(401);
    });
});

// ── PATCH /api/v1/tasks/{taskId}/state ──────────────────────────────────────────────

describe('PATCH /api/v1/tasks/{taskId}/state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        mockValidatePat.mockResolvedValue(adminPat);
        mockGetTask.mockReturnValue(stubTask);
        mockGetSchedulerState.mockResolvedValue(stubSchedulerState);
        mockCbCheck.mockResolvedValue(stubCbDecision);
        mockPauseTask.mockResolvedValue(undefined);
        mockResumeTask.mockResolvedValue(undefined);
        mockCbForceEnable.mockResolvedValue(undefined);
        // State endpoint needs non-null DB handles
        mockGetTaskDb.mockReturnValue({});
        // getDb needs to be a tagged template literal for the audit INSERT.
        // Return a mock function with a sql-compatible tag.
        const mockSql = Object.assign(
            vi.fn(async () => []),
            { array: vi.fn(() => []) },
        );
        mockGetDb.mockReturnValue(mockSql);
    });

    it('pauses schedule when schedule=paused', async () => {
        const { PATCH } = await import('./[taskId]/state/+server.js');
        if (!PATCH) throw new Error('PATCH handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: { schedule: 'paused' },
        });
        const resp = await PATCH(event as Parameters<typeof PATCH>[0]);
        expect(resp.status).toBe(200);
        expect(mockPauseTask).toHaveBeenCalledOnce();
        expect(mockResumeTask).not.toHaveBeenCalled();
    });

    it('resumes schedule when schedule=active', async () => {
        const { PATCH } = await import('./[taskId]/state/+server.js');
        if (!PATCH) throw new Error('PATCH handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: { schedule: 'active' },
        });
        const resp = await PATCH(event as Parameters<typeof PATCH>[0]);
        expect(resp.status).toBe(200);
        expect(mockResumeTask).toHaveBeenCalledOnce();
        expect(mockPauseTask).not.toHaveBeenCalled();
    });

    it('force-enables circuit breaker when breaker=enable and force=true', async () => {
        const { PATCH } = await import('./[taskId]/state/+server.js');
        if (!PATCH) throw new Error('PATCH handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: { breaker: 'enable', force: true },
        });
        // The forceEnable path also calls sqlDb`` — stub it to avoid throw
        const resp = await PATCH(event as Parameters<typeof PATCH>[0]);
        expect(resp.status).toBe(200);
        expect(mockCbForceEnable).toHaveBeenCalledOnce();
    });

    it('returns 422 when breaker=enable without force and cooldown has not elapsed', async () => {
        // Simulate open breaker with cooldown not elapsed
        mockCbCheck.mockResolvedValue({
            state: 'open' as const,
            allowed: false,
            nextProbeAt: new Date(Date.now() + 60_000),
            reason: 'too many failures',
        });
        const { PATCH } = await import('./[taskId]/state/+server.js');
        if (!PATCH) throw new Error('PATCH handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: { breaker: 'enable' },
        });
        const resp = await PATCH(event as Parameters<typeof PATCH>[0]);
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as { code: string };
        expect(body.code).toBe('validation_failed');
    });

    it('returns 422 when neither schedule nor breaker provided', async () => {
        const { PATCH } = await import('./[taskId]/state/+server.js');
        if (!PATCH) throw new Error('PATCH handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: {},
        });
        const resp = await PATCH(event as Parameters<typeof PATCH>[0]);
        expect(resp.status).toBe(422);
    });

    it('returns 404 for unknown task', async () => {
        mockGetTask.mockReturnValue(undefined);
        const { PATCH } = await import('./[taskId]/state/+server.js');
        if (!PATCH) throw new Error('PATCH handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'nonexistent' },
            body: { schedule: 'paused' },
        });
        const resp = await PATCH(event as Parameters<typeof PATCH>[0]);
        expect(resp.status).toBe(404);
    });

    it('requires tasks:admin scope (returns 403 for tasks:read)', async () => {
        mockValidatePat.mockResolvedValue({ ...adminPat, scopes: ['tasks:read'] });
        const { PATCH } = await import('./[taskId]/state/+server.js');
        if (!PATCH) throw new Error('PATCH handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: { schedule: 'paused' },
        });
        const resp = await PATCH(event as Parameters<typeof PATCH>[0]);
        expect(resp.status).toBe(403);
    });

    it('returns 401 with no bearer', async () => {
        const { PATCH } = await import('./[taskId]/state/+server.js');
        if (!PATCH) throw new Error('PATCH handler is not defined');
        const event = makeEvent({
            params: { taskId: 'embed-metadata' },
            body: { schedule: 'paused' },
        });
        const resp = await PATCH(event as Parameters<typeof PATCH>[0]);
        expect(resp.status).toBe(401);
    });
});
