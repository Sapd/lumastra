// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for POST /api/v1/libraries/ingest (canonical path; relocated from the
 * now-deleted legacy /api/v1/library/ingest route, which mounted this same def).
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

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: mockValidateSvc }),
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

const mockStartRun = vi.fn();

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: mockStartRun,
    },
}));

const mockEnqueueDeltaPayload = vi.fn();

vi.mock('$lib/server/tasks/builtin/native/file-delta-ingest-queue.js', () => ({
    enqueueDeltaPayload: (...args: unknown[]) => mockEnqueueDeltaPayload(...args),
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
        badRequest: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
        aiDatabaseUnavailable: (endpoint?: string) =>
            new Response(JSON.stringify({ error: 'AI database unavailable', endpoint }), {
                status: 503,
            }),
    },
}));

const mockGetEnabledLibraryPaths = vi.fn();

vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: (...args: unknown[]) => mockGetEnabledLibraryPaths(...args),
}));

const mockGetSql = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => mockGetSql() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
    opts: {
        headers?: Record<string, string>;
        body?: unknown;
        locals?: { user?: unknown };
    } = {},
) {
    // A real Request (not a stubbed `{headers, json}` object): the handler now
    // reads the body via the shared bounded-body-reader.ts (C15 fix, deferred
    // item 6), which streams `request.body`'s real reader rather than calling
    // `request.json()` — a fake object with no `.body` stream would silently
    // read as empty and break every test below the declared-length check.
    const request = new Request('http://localhost/api/v1/libraries/ingest', {
        method: 'POST',
        headers: new Headers(opts.headers ?? {}),
        body: JSON.stringify(opts.body ?? {}),
    });
    return {
        request,
        url: new URL('http://localhost/api/v1/libraries/ingest'),
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

const LIB_UUID = '12345678-1234-4234-a234-123456789abc';

const libraryPaths = [{ id: LIB_UUID, source_prefix: 's3://bucket/movies/', enabled: true }];

// ── POST /api/v1/libraries/ingest ───────────────────────────────────────────────

describe('POST /api/v1/libraries/ingest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
        mockGetSql.mockResolvedValue({});
        mockGetEnabledLibraryPaths.mockResolvedValue(libraryPaths);
        mockStartRun.mockResolvedValue({ runId: 'run_INGEST01', deduped: false });
        mockEnqueueDeltaPayload.mockResolvedValue(undefined);
    });

    it('returns 400 for empty changes array', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: { libraryPathId: LIB_UUID, changes: [] },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(422);
    });

    // C15: this def has no declarative `request.body` (body validation stays
    // in-handler by design), so it needs its own size guard — see
    // MAX_INGEST_BODY_BYTES in defs/library/ingest.ts.
    it('returns 413 for a declared-oversized body, and never calls startRun (C15)', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc', 'content-length': '3000000' },
            body: { libraryPathId: LIB_UUID, changes: [] },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(413);
        const out = (await resp.json()) as { code: string };
        expect(out.code).toBe('payload_too_large');
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    // Deferred item 6 (2026-09-13 security review): the previous guard only
    // ever checked the DECLARED Content-Length header — a client that lies
    // about it (or omits it) could still stream an oversized body straight
    // through to LibraryIngestRequestSchema.safeParse(), never buffered-but-
    // bounded. Drives a genuinely STREAMED body (not a pre-buffered string)
    // whose Content-Length header UNDERSTATES the real size, so only the
    // byte-counting streamed reader (bounded-body-reader.ts) — not the cheap
    // declared-length pre-check above — can catch it.
    it('returns 413 for a genuinely streamed oversized body even when Content-Length LIES (understates it)', async () => {
        const { POST } = await import('./+server.js');

        const encoder = new TextEncoder();
        const hugePath = 'x'.repeat(2_500_000); // over MAX_INGEST_BODY_BYTES (2_000_000)
        const realBodyText = JSON.stringify({
            libraryPathId: LIB_UUID,
            changes: [{ path: hugePath, op: 'upsert' }],
        });
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const chunkSize = 65536;
                for (let i = 0; i < realBodyText.length; i += chunkSize) {
                    controller.enqueue(encoder.encode(realBodyText.slice(i, i + chunkSize)));
                }
                controller.close();
            },
        });

        const request = new Request('http://localhost/api/v1/libraries/ingest', {
            method: 'POST',
            headers: {
                authorization: 'Bearer pat_abc',
                'content-type': 'application/json',
                // LIES: claims 10 bytes for a ~2.5MB body — the cheap
                // declared-length pre-check alone would wave this through.
                'content-length': '10',
            },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });

        const resp = await POST!({
            request,
            url: new URL('http://localhost/api/v1/libraries/ingest'),
            locals: {},
        } as Parameters<NonNullable<typeof POST>>[0]);

        expect(resp.status).toBe(413);
        const out = (await resp.json()) as { code: string };
        expect(out.code).toBe('payload_too_large');
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('returns 400 when same path appears in both upsert and remove', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {
                libraryPathId: LIB_UUID,
                changes: [
                    { path: 'movie.mkv', op: 'upsert' },
                    { path: 'movie.mkv', op: 'remove' },
                ],
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as { error: string };
        expect(body.error).toMatch(/both upsert and remove/);
    });

    it('returns 202 with accepted counts and statusUrl for valid path body', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {
                libraryPathId: LIB_UUID,
                changes: [
                    { path: 'a.mkv', op: 'upsert' },
                    { path: 'b.mkv', op: 'upsert' },
                    { path: 'old.mkv', op: 'remove' },
                ],
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(202);
        const body = (await resp.json()) as {
            runId: string;
            deduped: boolean;
            statusUrl: string;
            accepted: { upsert: number; remove: number };
        };
        expect(body.runId).toBe('run_INGEST01');
        expect(body.statusUrl).toBe('/api/v1/runs/run_INGEST01');
        expect(body.accepted).toEqual({ upsert: 2, remove: 1 });
    });

    it('pushes the payload to the delta queue BEFORE startRun, and startRun input carries no payload', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {
                libraryPathId: LIB_UUID,
                changes: [
                    { path: 'a.mkv', op: 'upsert' },
                    { path: 'old.mkv', op: 'remove' },
                ],
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(202);

        // Payload lives out-of-band — a deduped startRun below must not be
        // able to drop it. See file-delta-ingest-queue.ts.
        expect(mockEnqueueDeltaPayload).toHaveBeenCalledWith(LIB_UUID, {
            upsert: ['a.mkv'],
            remove: ['old.mkv'],
            eventId: undefined,
        });
        expect(mockStartRun).toHaveBeenCalledWith(
            'file-delta-ingest',
            { libraryPathId: LIB_UUID, eventId: undefined },
            expect.anything(),
        );

        // Ordering: the queue push must happen before startRun so a deduped
        // run can still observe the payload.
        const enqueueOrder = mockEnqueueDeltaPayload.mock.invocationCallOrder[0];
        const startRunOrder = mockStartRun.mock.invocationCallOrder[0];
        expect(enqueueOrder).toBeLessThan(startRunOrder);
    });

    it('returns 200 when run is deduped, without accepted counts', async () => {
        mockStartRun.mockResolvedValue({ runId: 'run_OLD01', deduped: true });
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {
                libraryPathId: LIB_UUID,
                changes: [{ path: 'a.mkv', op: 'upsert' }],
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.deduped).toBe(true);
        expect(body.runId).toBe('run_OLD01');
        expect(body.statusUrl).toBe('/api/v1/runs/run_OLD01');
        expect('accepted' in body).toBe(false);
    });

    it('returns 400 when libraryPathId is not in enabled library paths', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {
                libraryPathId: '00000000-0000-0000-0000-000000000000',
                changes: [{ path: 'a.mkv', op: 'upsert' }],
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as { error: string };
        expect(body.error).toMatch(/libraryPathId not found or disabled/);
    });

    it('returns 403 with self-documenting message when tasks:run scope missing', async () => {
        mockValidatePat.mockResolvedValue({ ...adminPat, scopes: ['write'] });
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {
                libraryPathId: LIB_UUID,
                changes: [{ path: 'a.mkv', op: 'upsert' }],
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(403);
        const body = (await resp.json()) as { error: string };
        expect(body.error).toMatch(/tasks:run/);
        expect(body.error).toMatch(/admin PAT or service token/);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            body: { libraryPathId: LIB_UUID, changes: [{ path: 'a.mkv', op: 'upsert' }] },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(401);
    });

    it('forwards X-Event-Id header into task input as eventId', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc', 'x-event-id': 'evt-abc123' },
            body: {
                libraryPathId: LIB_UUID,
                changes: [{ path: 'a.mkv', op: 'upsert' }],
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(202);
        expect(mockStartRun).toHaveBeenCalledWith(
            'file-delta-ingest',
            expect.objectContaining({ eventId: 'evt-abc123' }),
            expect.anything(),
        );
    });

    it('returns 503 with Retry-After when BackpressureError', async () => {
        const { BackpressureError } = await import('$lib/server/tasks/backpressure.js');
        mockStartRun.mockRejectedValue(new BackpressureError(30_000));
        const { POST } = await import('./+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {
                libraryPathId: LIB_UUID,
                changes: [{ path: 'a.mkv', op: 'upsert' }],
            },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(503);
        expect(resp.headers.get('retry-after')).toBe('30');
    });
});
