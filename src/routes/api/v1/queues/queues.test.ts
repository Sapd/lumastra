// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for POST /api/v1/queues/{queue}/pause and resume
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const mockQueuePause = vi.fn();
const mockQueueResume = vi.fn();
const mockQueueIsPaused = vi.fn();
const mockQueueClose = vi.fn();

vi.mock('bullmq', () => {
    function MockQueue(this: {
        pause: typeof mockQueuePause;
        resume: typeof mockQueueResume;
        isPaused: typeof mockQueueIsPaused;
        close: typeof mockQueueClose;
    }) {
        this.pause = mockQueuePause;
        this.resume = mockQueueResume;
        this.isPaused = mockQueueIsPaused;
        this.close = mockQueueClose;
    }
    return { Queue: MockQueue };
});

const mockGetQueueConnectionOptions = vi.fn();
vi.mock('$lib/server/queue/connection.js', () => ({
    getQueueConnectionOptions: mockGetQueueConnectionOptions,
}));
vi.mock('$lib/server/tasks/connection.js', () => ({
    getQueueConnectionOptions: mockGetQueueConnectionOptions,
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

const mockGetValkeyClient = vi.fn();
vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: mockGetValkeyClient,
    getCoordinationClient: mockGetValkeyClient,
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => () => {}),
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
        badRequest: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
    },
}));

vi.mock('$lib/utils/data-extraction.js', () => ({
    extractBody: async (req: Request) => {
        try {
            return await req.json();
        } catch {
            return {};
        }
    },
}));

// Per-task-queue fan-out: pause/resume enumerate `registry.getAllTasks()` and
// build one queue per task in the class when FEATURE_PER_TASK_QUEUES is on.
// Default the registry to a deterministic two-`io`-task set and let each test
// flip the flag. With the flag OFF the route uses a single per-class queue.
const mockGetAllTasks = vi.fn();
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getAllTasks: () => mockGetAllTasks() },
}));

const mockPerTaskQueues = vi.fn();
vi.mock('$lib/server/config.js', () => ({
    get FEATURE_PER_TASK_QUEUES() {
        return mockPerTaskQueues();
    },
}));

// queue-naming pulls in plugin SDK constants transitively elsewhere; stub the
// two helpers the routes use so the test stays focused on pause/resume logic.
vi.mock('$lib/server/tasks/queue-naming.js', () => ({
    QUEUE_PREFIX: 'bull:task',
    PER_TASK_QUEUE_PREFIX: 'bull:task:t',
    taskQueueName: (cls: string) => cls,
    perTaskQueueName: (id: string) => id,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
    opts: {
        headers?: Record<string, string>;
        params?: Record<string, string>;
        body?: unknown;
    } = {},
) {
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    return {
        request: new Request('http://localhost/', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...opts.headers },
            body,
        }),
        params: opts.params ?? {},
        url: new URL('http://localhost/'),
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
const readPat = {
    id: 2,
    userId: '22222222-2222-4222-8222-222222222222',
    username: 'bob',
    scopes: ['read'],
    groups: [],
};

// ── Pause tests ───────────────────────────────────────────────────────────────

describe('POST /api/v1/queues/{queue}/pause', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        mockValidatePat.mockResolvedValue(adminPat);
        mockQueuePause.mockResolvedValue(undefined);
        mockQueueIsPaused.mockResolvedValue(true);
        mockQueueClose.mockResolvedValue(undefined);
        mockGetQueueConnectionOptions.mockReturnValue({
            host: 'localhost',
            port: 6379,
            db: 1,
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            lazyConnect: false,
        });
        mockGetValkeyClient.mockReturnValue({
            set: vi.fn().mockResolvedValue('OK'),
        });
        // Default to the legacy per-class single-queue path; per-task fan-out
        // is exercised explicitly below.
        mockPerTaskQueues.mockReturnValue(false);
        mockGetAllTasks.mockReturnValue([
            { id: 'file-scan', resourceClass: 'io' },
            { id: 'image-sync', resourceClass: 'io' },
        ]);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = (await import('./[queue]/pause/+server.js'))!;
        const resp = await POST!(
            makeEvent({ params: { queue: 'cpu' } }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(401);
    });

    it('returns 403 for read scope', async () => {
        mockValidatePat.mockResolvedValue(readPat);
        const { POST } = (await import('./[queue]/pause/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'cpu' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(403);
    });

    it('returns 422 for unknown queue class', async () => {
        // unknown queue → problem('validation_failed') → HTTP 422
        const { POST } = (await import('./[queue]/pause/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'unknown' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as { code: string };
        expect(body.code).toBe('validation_failed');
    });

    it('pauses the queue on happy path', async () => {
        const { POST } = (await import('./[queue]/pause/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'io' },
                body: { reason: 'maintenance' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(200);
        // Legacy `ok`/`class` fields removed — canonical response is schema-aligned.
        const body = (await resp.json()) as {
            paused: boolean;
            queueName: string;
            message: string;
        };
        expect(body.paused).toBe(true);
        expect(body.queueName).toBe('io');
        expect(body.message).toContain('paused');
        expect(body.message).toContain('maintenance');
        expect(mockQueuePause).toHaveBeenCalledOnce();
        expect(mockQueueIsPaused).toHaveBeenCalledOnce();
    });

    it('returns 503 when verification round-trip reports isPaused=false', async () => {
        mockQueueIsPaused.mockResolvedValue(false);
        const { POST } = (await import('./[queue]/pause/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'cpu' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(503);
        const body = (await resp.json()) as {
            paused: boolean;
            queueName: string;
            message: string;
        };
        expect(body.paused).toBe(false);
        expect(body.queueName).toBe('cpu');
        expect(body.message).toMatch(/did not transition/);
    });

    it('returns 503 with surfaced error message when queue.pause() throws', async () => {
        // Edge-case finding #6: a thrown pause() error must not be
        // misreported as "Valkey may have rejected the SET". The 503
        // message includes the underlying cause so operators can act on it.
        mockQueuePause.mockRejectedValue(new Error('BullMQ script load failed'));
        const { POST } = (await import('./[queue]/pause/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'cpu' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(503);
        const body = (await resp.json()) as {
            paused: boolean;
            message: string;
        };
        expect(body.paused).toBe(false);
        expect(body.message).toMatch(/pause threw/);
        expect(body.message).toMatch(/BullMQ script load failed/);
    });

    it('fans out to every per-task queue in the class when FEATURE_PER_TASK_QUEUES is on', async () => {
        // TASK-H32: under per-task queues the runner consumes from one queue per
        // task, so pausing only the per-class queue would be a silent no-op.
        // The route must pause each per-task queue belonging to the class.
        mockPerTaskQueues.mockReturnValue(true);
        const { POST } = (await import('./[queue]/pause/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'io' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(200);
        // Two `io` tasks registered → two queues paused + verified.
        expect(mockQueuePause).toHaveBeenCalledTimes(2);
        expect(mockQueueIsPaused).toHaveBeenCalledTimes(2);
    });

    it('503 if any per-task queue in the class fails to pause', async () => {
        mockPerTaskQueues.mockReturnValue(true);
        // First queue pauses; second reports not-paused on verification.
        mockQueueIsPaused.mockReset();
        mockQueueIsPaused.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const { POST } = (await import('./[queue]/pause/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'io' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(503);
        const body = (await resp.json()) as {
            paused: boolean;
            message: string;
        };
        expect(body.paused).toBe(false);
        expect(body.message).toMatch(/did not transition/);
    });
});

// ── Resume tests ──────────────────────────────────────────────────────────────

describe('POST /api/v1/queues/{queue}/resume', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        mockValidatePat.mockResolvedValue(adminPat);
        mockQueueResume.mockResolvedValue(undefined);
        // Default: queue was paused, resume succeeds, post-state is unpaused.
        mockQueueIsPaused.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        mockQueueClose.mockResolvedValue(undefined);
        mockGetQueueConnectionOptions.mockReturnValue({
            host: 'localhost',
            port: 6379,
            db: 1,
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            lazyConnect: false,
        });
        mockGetValkeyClient.mockReturnValue({
            del: vi.fn().mockResolvedValue(1),
        });
        // Default to the legacy per-class single-queue path; per-task fan-out
        // is exercised explicitly below.
        mockPerTaskQueues.mockReturnValue(false);
        mockGetAllTasks.mockReturnValue([
            { id: 'file-scan', resourceClass: 'io' },
            { id: 'image-sync', resourceClass: 'io' },
        ]);
    });

    it('returns 422 for unknown queue class', async () => {
        // unknown queue → problem('validation_failed') → HTTP 422
        const { POST } = (await import('./[queue]/resume/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'bogus' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as { code: string };
        expect(body.code).toBe('validation_failed');
    });

    it('resumes the queue on happy path', async () => {
        const { POST } = (await import('./[queue]/resume/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'embedding' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(200);
        // Legacy `ok`/`class` fields removed — canonical response is schema-aligned.
        const body = (await resp.json()) as {
            paused: boolean;
            queueName: string;
            wasAlreadyResumed?: boolean;
        };
        expect(body.paused).toBe(false);
        expect(body.queueName).toBe('embedding');
        expect(body.wasAlreadyResumed).toBeUndefined();
        expect(mockQueueResume).toHaveBeenCalledOnce();
    });

    it('returns wasAlreadyResumed=true when queue was not paused', async () => {
        mockQueueIsPaused.mockReset();
        // Pre-check returns false (already unpaused); post-check also false.
        mockQueueIsPaused.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
        const { POST } = (await import('./[queue]/resume/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'embedding' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            paused: boolean;
            wasAlreadyResumed: boolean;
            message: string;
        };
        expect(body.paused).toBe(false);
        expect(body.wasAlreadyResumed).toBe(true);
        expect(body.message).toMatch(/already resumed/);
        // resume() should be skipped when already unpaused
        expect(mockQueueResume).not.toHaveBeenCalled();
    });

    it('returns 503 when verification round-trip reports still-paused', async () => {
        mockQueueIsPaused.mockReset();
        // Pre-check paused, resume "succeeds", but post-check still paused.
        mockQueueIsPaused.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
        const { POST } = (await import('./[queue]/resume/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'embedding' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(503);
        const body = (await resp.json()) as {
            paused: boolean;
            message: string;
        };
        expect(body.paused).toBe(true);
        expect(body.message).toMatch(/did not transition/);
    });

    it('returns 503 with surfaced error message when queue.resume() throws', async () => {
        // Edge-case finding #7: a thrown resume() error surfaces in the
        // 503 message instead of the misleading "Valkey rejected DEL"
        // default. `verifiedPaused` stays at its initial `true`, triggering
        // the 503 branch with the captured cause.
        mockQueueIsPaused.mockReset();
        // Pre-check throws, never reaches resume()/post-check.
        mockQueueIsPaused.mockRejectedValueOnce(new Error('valkey connection drop'));
        const { POST } = (await import('./[queue]/resume/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'embedding' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(503);
        const body = (await resp.json()) as {
            paused: boolean;
            message: string;
        };
        expect(body.paused).toBe(true);
        expect(body.message).toMatch(/resume threw/);
        expect(body.message).toMatch(/valkey connection drop/);
    });

    it('fans out resume to every per-task queue in the class when FEATURE_PER_TASK_QUEUES is on', async () => {
        // TASK-H32: resume must un-pause each per-task queue, not just the
        // legacy per-class queue the workers no longer consume from.
        mockPerTaskQueues.mockReturnValue(true);
        mockQueueIsPaused.mockReset();
        // Two queues, each: pre-check paused (true) then post-check unpaused
        // (false).
        mockQueueIsPaused
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const { POST } = (await import('./[queue]/resume/+server.js'))!;
        const resp = await POST!(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                params: { queue: 'io' },
            }) as Parameters<NonNullable<typeof POST>>[0],
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            paused: boolean;
            wasAlreadyResumed?: boolean;
        };
        expect(body.paused).toBe(false);
        expect(mockQueueResume).toHaveBeenCalledTimes(2);
    });
});
