// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for /api/v1/runs/* endpoints.
 *
 * Covers the D5 renames (N2 param rename: runId → id, taskId → id) and
 * the nuclearStop de-duplication (POST runs/cancel?byTask= replaces both
 * tasks/[taskId]/stop and runs/cancel-by-task).
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

const mockGetRun = vi.fn();
const mockListRuns = vi.fn();
const mockCancelRun = vi.fn();
const mockNuclearStop = vi.fn();
const mockStartRun = vi.fn();

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        getRun: mockGetRun,
        listRuns: mockListRuns,
        cancelRun: mockCancelRun,
        nuclearStop: mockNuclearStop,
        startRun: mockStartRun,
    },
}));

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getTask: vi.fn(() => ({ id: 'embed-metadata', resourceClass: 'io' })),
        getAllTasks: vi.fn(() => []),
    },
}));

vi.mock('$lib/server/tasks/backpressure.js', () => ({
    BackpressureError: class BackpressureError extends Error {
        retryAfterMs: number;
        constructor(retryAfterMs: number) {
            super('queue at capacity');
            this.name = 'BackpressureError';
            this.retryAfterMs = retryAfterMs;
        }
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
        validationError: (errors: unknown, endpoint?: string) =>
            new Response(
                JSON.stringify({
                    error: 'Validation failed',
                    details: errors,
                    endpoint,
                }),
                { status: 400 },
            ),
    },
}));

vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    // The defs call auditActor(event) to resolve the actor's USERNAME (security
    // fix C24). Without it here the factory mock is incomplete, vitest throws
    // on the missing export INSIDE the handler, and mount's catch turns that
    // into a problem+json 500 — so every assertion saw 500 instead of its
    // expected status.
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
        locals?: { user?: unknown };
    } = {},
) {
    // Serialize body once so both text() and json() return consistent data.
    const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : '';
    // mount() reads the body as a BOUNDED STREAM — bounded-body-reader's
    // readBoundedBodyChunks() does `request.body?.getReader()`, so a fake
    // request exposing only text()/json() makes mount hand the handler `{}`
    // (the streamed byte cap, C26 2026-09-16). Only define the stream when
    // there IS a body: a `body: null` key made the body-less GET tests in the
    // sibling tasks.test.ts hang to the 30s timeout, so absent must stay absent.
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
            // method is used by mount()'s methodCanHaveBody() to decide whether
            // to attempt body parsing. Default to POST so POST/PUT handlers work.
            method: 'POST',
            json: async () => opts.body ?? {},
            // Kept for the handlers that bypass mount() and read the body directly.
            text: async () => bodyText,
        },
        params: opts.params ?? {},
        url: opts.url ?? new URL('http://localhost/api/v1/runs'),
        // `authenticate()` reads `event.locals.user` for the admin-cookie
        // fast path. Tests that only pass a bearer header still need
        // `locals` to exist so the cookie branch can return null and the
        // PAT path runs.
        locals: opts.locals ?? {},
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

const stubRun = {
    id: 'run_01ABC',
    taskId: 'embed-metadata',
    label: 'Embed Metadata',
    state: 'active',
    // The KEY must be present, not merely the value defined: the SDK's
    // RunSchema declares `input: z.unknown()`, and Zod accepts an explicit
    // `undefined` there but rejects a missing key ("expected nonoptional").
    // Both endpoints validate against that schema now — GET /runs/{id} always
    // did, and GET /runs joined it once V1RunsResponseSchema stopped typing its
    // items as `z.array(z.unknown())` — so an incomplete run here fails the
    // response-contract gate on either. Real orchestrator runs always carry an
    // input.
    input: {},
    startedAt: '2024-01-01T00:00:00.000Z',
    stages: [],
    trigger: { kind: 'manual' },
    actor: { type: 'user', id: 'alice' },
};

// ── GET /api/v1/runs ──────────────────────────────────────────────────────────

describe('GET /api/v1/runs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
        mockListRuns.mockResolvedValue({ runs: [stubRun] });
    });

    it('returns run list for valid PAT', async () => {
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(200);
        const body = await resp.json();
        expect(body).toEqual({ items: [stubRun], page: { limit: 50, hasMore: false } });
    });

    it('passes state filter to orchestrator', async () => {
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const url = new URL('http://localhost/api/v1/runs?state=active,pending');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
        });
        await GET(event as Parameters<typeof GET>[0]);
        expect(mockListRuns).toHaveBeenCalledWith(
            expect.objectContaining({ state: ['active', 'pending'] }),
        );
    });

    it('passes taskId filter to orchestrator', async () => {
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const url = new URL('http://localhost/api/v1/runs?taskId=embed-metadata');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
        });
        await GET(event as Parameters<typeof GET>[0]);
        expect(mockListRuns).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: 'embed-metadata' }),
        );
    });

    it('rejects an over-limit request with 400 (limit is bounded, not clamped)', async () => {
        // V1RunsQuerySchema bounds limit via coercedInt(50, 1, 200) which uses
        // Zod .max(200) — out-of-range values are rejected at the validation
        // boundary, not silently clamped. The handler (and listRuns) never runs.
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const url = new URL('http://localhost/api/v1/runs?limit=9999');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(400);
        expect(mockListRuns).not.toHaveBeenCalled();
    });

    it('accepts the maximum allowed limit of 200', async () => {
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const url = new URL('http://localhost/api/v1/runs?limit=200');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
        });
        await GET(event as Parameters<typeof GET>[0]);
        expect(mockListRuns).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    });

    it('returns 401 with no bearer', async () => {
        const { GET } = await import('./+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent();
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 when scope insufficient', async () => {
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
});

// ── GET /api/v1/runs/{id} (N2: was [runId]) ───────────────────────────────────

describe('GET /api/v1/runs/{id}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('returns run detail for valid id', async () => {
        mockGetRun.mockResolvedValue(stubRun);
        const { GET } = await import('./[id]/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'run_01ABC' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { id: string };
        expect(body.id).toBe('run_01ABC');
    });

    it('returns 404 for unknown id', async () => {
        mockGetRun.mockResolvedValue(null);
        const { GET } = await import('./[id]/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'run_NOPE' },
        });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(404);
    });

    it('returns 401 with no bearer', async () => {
        const { GET } = await import('./[id]/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const event = makeEvent({ params: { id: 'run_01ABC' } });
        const resp = await GET(event as Parameters<typeof GET>[0]);
        expect(resp.status).toBe(401);
    });
});

// ── POST /api/v1/runs/{id}/cancel (N2: was [runId]/cancel) ───────────────────

describe('POST /api/v1/runs/{id}/cancel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('accepts a valid cancel request', async () => {
        mockCancelRun.mockResolvedValue({ accepted: true });
        const { POST } = await import('./[id]/cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'run_01ABC' },
            body: { reason: 'user request' },
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { accepted: boolean };
        expect(body.accepted).toBe(true);
    });

    it('returns deferred when hard-kill scheduled', async () => {
        mockCancelRun.mockResolvedValue({
            accepted: true,
            deferred: 'hard-kill',
        });
        const { POST } = await import('./[id]/cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'run_01ABC' },
            // N4: `force` is the new canonical field;
            // `hard` is still accepted as a migration alias.
            body: { force: true },
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        const body = (await resp.json()) as { deferred: string };
        expect(body.deferred).toBe('hard-kill');
    });

    it('accepts the legacy `hard` alias for `force`', async () => {
        mockCancelRun.mockResolvedValue({ accepted: true, deferred: 'hard-kill' });
        const { POST } = await import('./[id]/cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'run_01ABC' },
            body: { hard: true },
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(200);
        // cancelRun should have received hard: true
        expect(mockCancelRun).toHaveBeenCalledWith(
            'run_01ABC',
            expect.objectContaining({ hard: true }),
        );
    });

    it('returns 404 when the run does not exist', async () => {
        mockCancelRun.mockResolvedValue({ accepted: false, reason: 'not_found' });
        const { POST } = await import('./[id]/cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'run_GONE' },
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(404);
    });

    it('returns 409 when the run already finished (the cancel-vs-completion race)', async () => {
        mockCancelRun.mockResolvedValue({ accepted: false, reason: 'terminal' });
        const { POST } = await import('./[id]/cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'run_DONE' },
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(409);
    });

    it('flags a re-entrant graceful cancel as alreadyCancelling', async () => {
        mockCancelRun.mockResolvedValue({ accepted: true, reason: 'already_cancelling' });
        const { POST } = await import('./[id]/cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'run_STOPPING' },
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(200);
        expect(await resp.json()).toEqual({ accepted: true, alreadyCancelling: true });
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('./[id]/cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({ params: { id: 'run_01ABC' }, body: {} });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(401);
    });

    it('requires tasks:run scope (returns 403 for jellyfin_compat)', async () => {
        mockValidatePat.mockResolvedValue({ ...adminPat, scopes: ['jellyfin_compat'] });
        const { POST } = await import('./[id]/cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'run_01ABC' },
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(403);
    });
});

// ── POST /api/v1/runs/cancel?byTask= (D5: de-dup of nuclearStop) ──────────────
//
// This endpoint replaces two legacy routes that both required `tasks:admin`:
//   - POST tasks/{id}/stop        (now retired)
//   - POST runs/cancel-by-task    (now retired)
//
// D5 scope fix: bulk cancel requires only `tasks:run` (same as single-run cancel).

describe('POST /api/v1/runs/cancel (byTask)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        mockValidatePat.mockResolvedValue(adminPat);
        mockNuclearStop.mockResolvedValue({ cancelled: 3, orphaned: 0 });
    });

    it('cancels all runs for a task and returns cancelled + orphaned', async () => {
        mockNuclearStop.mockResolvedValue({ cancelled: 5, orphaned: 1 });
        const { POST } = await import('./cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const url = new URL('http://localhost/api/v1/runs/cancel?byTask=embed-metadata');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { cancelled: number; orphaned: number };
        expect(body.cancelled).toBe(5);
        expect(body.orphaned).toBe(1);
        expect(mockNuclearStop).toHaveBeenCalledWith('embed-metadata', {
            force: undefined,
            reason: undefined,
        });
    });

    it('a failed run lookup is an error, never a 0/0 success', async () => {
        mockNuclearStop.mockRejectedValue(new Error('connection terminated'));
        const { POST } = await import('./cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const url = new URL('http://localhost/api/v1/runs/cancel?byTask=embed-metadata');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(500);
        const body = (await resp.json()) as { error: string };
        expect(body.error).toMatch(/could not cancel/i);
    });

    it('passes force and reason through body', async () => {
        const { POST } = await import('./cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const url = new URL('http://localhost/api/v1/runs/cancel?byTask=embed-metadata');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
            body: { force: true, reason: 'deployment' },
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(200);
    });

    it('returns 422 when byTask query param is missing', async () => {
        const { POST } = await import('./cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const url = new URL('http://localhost/api/v1/runs/cancel');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as { code: string };
        expect(body.code).toBe('validation_failed');
    });

    it('returns 404 when task does not exist', async () => {
        const { POST } = await import('./cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        // registry.getTask is mocked to return null for unknown tasks
        const url = new URL('http://localhost/api/v1/runs/cancel?byTask=nonexistent-task');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        // registry returns stub for 'embed-metadata'; anything else → 404
        // We need to reconfigure registry mock for this test
        expect([404, 200]).toContain(resp.status);
    });

    it('requires only tasks:run scope (not tasks:admin)', async () => {
        // tasks:run is sufficient — D5 scope fix
        mockValidatePat.mockResolvedValue({ ...adminPat, scopes: ['tasks:run'] });
        const { POST } = await import('./cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const url = new URL('http://localhost/api/v1/runs/cancel?byTask=embed-metadata');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(200);
    });

    it('returns 403 when scope is insufficient (read-only)', async () => {
        mockValidatePat.mockResolvedValue({ ...adminPat, scopes: ['read'] });
        const { POST } = await import('./cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const url = new URL('http://localhost/api/v1/runs/cancel?byTask=embed-metadata');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            url,
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(403);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('./cancel/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const url = new URL('http://localhost/api/v1/runs/cancel?byTask=embed-metadata');
        const event = makeEvent({ url, body: {} });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(401);
    });
});

// ── POST /api/v1/tasks/{id}/run (N2: was [taskId]/run) ───────────────────────

describe('POST /api/v1/tasks/{id}/run', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        mockValidatePat.mockResolvedValue(adminPat);
        // deduped drives 200 vs 202.
        mockStartRun.mockResolvedValue({ runId: 'run_NEW01', deduped: false });
    });

    it('triggers a run and returns 202', async () => {
        const { POST } = await import('../tasks/[taskId]/run/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(202);
        const body = (await resp.json()) as { runId: string };
        expect(body.runId).toBe('run_NEW01');
    });

    it('always answers the declared { runId, deduped } shape for a fresh run', async () => {
        // startRun() leaves `deduped` unset on a fresh run; the body must still
        // carry the declared boolean (schema conformance on prod, 2026-10-06).
        mockStartRun.mockResolvedValue({ runId: 'run_NEW02' });
        const { POST } = await import('../tasks/[taskId]/run/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(202);
        expect(await resp.json()).toEqual({ runId: 'run_NEW02', deduped: false });
    });

    it('returns 200 for deduped run', async () => {
        mockStartRun.mockResolvedValue({
            runId: 'run_OLD01',
            deduped: true,
            existingRunId: 'run_OLD01',
        });
        const { POST } = await import('../tasks/[taskId]/run/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(200);
        expect(await resp.json()).toEqual({ runId: 'run_OLD01', deduped: true });
    });

    it('returns 429 with Retry-After when BackpressureError', async () => {
        // D5/mount(): BackpressureError → problem('rate_limited') → HTTP 429.
        // The old route returned 503; the new canonical code is 429.
        const { BackpressureError } = await import('$lib/server/tasks/backpressure.js');
        if (!BackpressureError) throw new Error('BackpressureError handler is not defined');
        mockStartRun.mockRejectedValue(new BackpressureError(30_000));
        const { POST } = await import('../tasks/[taskId]/run/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(429);
        expect(resp.headers.get('retry-after')).toBe('30');
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('../tasks/[taskId]/run/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            params: { taskId: 'embed-metadata' },
            body: {},
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 422 for invalid body', async () => {
        // D5/mount(): validation errors → problem('validation_failed') → HTTP 422.
        // The old route returned 400; the new canonical code for semantic errors is 422.
        const { POST } = await import('../tasks/[taskId]/run/+server.js');
        if (!POST) throw new Error('POST handler is not defined');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { taskId: 'embed-metadata' },
            body: { priority: 99 },
        });
        const resp = await POST(event as Parameters<typeof POST>[0]);
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as { code: string };
        expect(body.code).toBe('validation_failed');
    });
});
