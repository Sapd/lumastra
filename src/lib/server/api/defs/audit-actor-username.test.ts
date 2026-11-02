// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security fix C24 (2026-09-16): thirteen task/queue/run audit call sites
 * built their own `{ username: principal.userId, ... }` object instead of
 * calling `auditActor(event)` — `principal.userId` is the `users.id` UUID,
 * not the username, so `audit_log.actor` held a UUID for these action
 * types. Two consequences: the Admin Audit feed's actor filter/chip shows an
 * opaque UUID, and `gdpr-erasure.queries.ts`'s tombstone predicate
 * (`LOWER(actor) = <username>`) can never match those rows.
 *
 * None of these 13 defs asserted the actor before this fix —
 * `runs/cancel-gate.test.ts:16` mocks `auditLog` away entirely and only
 * tests the request-gate contract. This file asserts AT THE SEAM: it uses
 * the REAL `auditActor()` (not mocked) and captures what each def actually
 * passes to `auditLog()`, with a Principal whose `userId` (UUID) and
 * `username` deliberately differ — so a regression back to the hand-built
 * `{ username: principal.userId }` shape turns every case below red.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USERNAME = 'alice-admin';

// ---------------------------------------------------------------------------
// Shared mocks — every def under test imports a subset of these. auditLog is
// the ONLY thing mocked from audit-log.js; auditActor is the real function.
// ---------------------------------------------------------------------------

const auditLogMock = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: (...a: unknown[]) => auditLogMock(...a) };
});
vi.mock('$lib/server/api/delegate.js', () => ({
    principalBeforeDelegation: () => undefined,
}));

const registryGetTaskMock = vi.fn();
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getTask: (...a: unknown[]) => registryGetTaskMock(...a),
        // FEATURE_PER_TASK_QUEUES defaults to true (config.ts) — pause/resume's
        // targetQueues() filters getAllTasks() by resourceClass, so this needs
        // at least one matching task for those two defs to reach a real queue.
        getAllTasks: () => [{ id: 'metadata-sync', resourceClass: 'cpu' }],
    },
}));

const orchestratorMock = {
    getRun: vi.fn(),
    cancelRun: vi.fn(),
    nuclearStop: vi.fn(),
    startRun: vi.fn(),
};
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: orchestratorMock }));

const getDbMock = vi.fn();
const getTaskDbMock = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => getDbMock(),
    getTaskDb: () => getTaskDbMock(),
}));

vi.mock('$lib/server/config/index.js', async (importOriginal) => {
    // work-profile.ts's resolveProfile() needs the REAL configSchema (it
    // looks up each scaled setting's min/max) — only saveConfig is mocked to
    // avoid an actual disk write.
    const actual = await importOriginal<typeof import('$lib/server/config/index.js')>();
    return { ...actual, saveConfig: vi.fn(async () => {}) };
});

const queuePauseMock = vi.fn();
const queueResumeMock = vi.fn();
const queueIsPausedMock = vi.fn();
const queueCloseMock = vi.fn();
vi.mock('bullmq', () => ({
    Queue: class {
        pause = queuePauseMock;
        resume = queueResumeMock;
        isPaused = queueIsPausedMock;
        close = queueCloseMock;
    },
}));
vi.mock('$lib/server/tasks/connection.js', () => ({
    getQueueConnectionOptions: () => ({ host: 'localhost', port: 6379 }),
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => null,
    getValkeyClient: () => null,
}));

const withAdvisoryLockMock = vi.fn();
vi.mock('$lib/server/database/with-advisory-lock.js', () => ({
    withAdvisoryLock: (...a: unknown[]) => withAdvisoryLockMock(...a),
}));
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    buildPluginContext: () => ({}),
    buildAdminContextStub: () => ({}),
}));
vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    findLatestFailureEventId: vi.fn(async () => 'evt-1'),
    markFailureEventsResolved: vi.fn(async () => {}),
}));
vi.mock('$lib/server/database/queries/task-settings.queries.js', () => ({
    upsertTaskSettings: vi.fn(async () => {}),
}));

const pauseTaskMock = vi.fn(async (..._args: unknown[]) => {});
const resumeTaskMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('$lib/server/tasks/scheduler-state.js', () => ({
    getSchedulerState: vi.fn(async () => ({ paused: false })),
    pauseTask: (...a: unknown[]) => pauseTaskMock(...a),
    resumeTask: (...a: unknown[]) => resumeTaskMock(...a),
    listTaskTriggers: vi.fn(async () => null),
}));
const saveTaskTriggersMock = vi.fn(async (..._args: unknown[]) => {});
const resetTaskTriggersMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('$lib/server/tasks/trigger-service.js', () => ({
    taskSchedulability: () => ({ schedulable: true }),
    activeEnvEvery: () => undefined,
    saveTaskTriggers: (...a: unknown[]) => saveTaskTriggersMock(...a),
    resetTaskTriggers: (...a: unknown[]) => resetTaskTriggersMock(...a),
    rescheduleAfterResume: vi.fn(async () => {}),
    readTaskTriggers: vi.fn(async () => ({
        schedulable: true,
        isDefault: false,
        triggers: [],
        timeZone: 'UTC',
        paused: false,
    })),
}));
vi.mock('$lib/server/tasks/scheduler.js', () => ({
    parseDurationMs: () => 3_600_000,
}));

const circuitBreakerForceEnableMock = vi.fn(async () => {});
vi.mock('$lib/server/tasks/circuit-breaker.js', () => ({
    CircuitBreaker: class {
        forceEnable = circuitBreakerForceEnableMock;
        check = vi.fn(async () => ({ allowed: true }));
        peek = vi.fn(async () => ({ allowed: true, state: 'closed' }));
    },
}));

/** A minimal, real (not-mocked) fake sql tag: callable + .begin(). */
function fakeSql() {
    const tag = (async () => []) as unknown as {
        (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]>;
        begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    tag.begin = async (cb) => cb(tag);
    return tag;
}

function makeEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
    return {
        params: {},
        url: new URL('https://app.example/api/v1/x'),
        request: new Request('https://app.example/api/v1/x', { method: 'POST' }),
        locals: {
            principal: {
                kind: 'session',
                userId: TEST_USER_ID,
                username: TEST_USERNAME,
                credentialId: undefined,
            },
            user: { userId: TEST_USER_ID, username: TEST_USERNAME },
        },
        ...overrides,
    } as unknown as RequestEvent;
}

/** The actor auditLog was actually called with, on its most recent call. */
function capturedActor(): { username: string | null } {
    const call = auditLogMock.mock.calls.at(-1);
    return call?.[2] as { username: string | null };
}

beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockReturnValue(fakeSql());
    getTaskDbMock.mockReturnValue(fakeSql());
    queueIsPausedMock.mockResolvedValue(false);
    queuePauseMock.mockResolvedValue(undefined);
    queueResumeMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.resetModules();
});

describe('audit_log.actor is the username, not the users.id UUID (C24)', () => {
    it('config.work-profile.set (admin/ops/work-profile.ts)', async () => {
        const { def } = await import('./admin/ops/work-profile.js');
        const event = makeEvent({
            request: new Request('https://app.example/x', {
                method: 'PUT',
                body: JSON.stringify({ profile: 'balanced' }),
            }),
        });
        await def.handlers.PUT!(event, {} as never);
        expect(auditLogMock).toHaveBeenCalledWith(
            'config.work-profile.set',
            expect.anything(),
            expect.objectContaining({ username: TEST_USERNAME }),
            expect.anything(),
        );
        expect(capturedActor().username).toBe(TEST_USERNAME);
        expect(capturedActor().username).not.toBe(TEST_USER_ID);
    });

    it('queue.pause (queues/[queue]/pause.ts)', async () => {
        // isPaused is checked AFTER queue.pause() to verify the transition —
        // must return true for the handler to treat the pause as verified.
        queueIsPausedMock.mockResolvedValueOnce(true);
        const { def } = await import('./queues/[queue]/pause.js');
        const event = makeEvent({ params: { queue: 'cpu' } });
        await def.handlers.POST!(event, { input: { body: {} } } as never);
        expect(capturedActor().username).toBe(TEST_USERNAME);
    });

    it('queue.resume (queues/[queue]/resume.ts)', async () => {
        // isPaused: true (before resume), false (after) → !wasAlreadyResumed
        // → the audited branch runs.
        queueIsPausedMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const { def } = await import('./queues/[queue]/resume.js');
        const event = makeEvent({ params: { queue: 'cpu' } });
        await def.handlers.POST!(event, { input: {} } as never);
        expect(capturedActor().username).toBe(TEST_USERNAME);
    });

    it('run.cancel (runs/[id]/cancel.ts)', async () => {
        // A nonadmin can cancel an ordinary broad run; the persisted identity
        // preflight must still run without entering the selected-file admin path.
        orchestratorMock.getRun.mockResolvedValue({
            id: 'run_1',
            taskId: 'media-probe',
            input: { libraryGroupId: 'group_1' },
        });
        orchestratorMock.cancelRun.mockResolvedValue({ accepted: true });
        const { def } = await import('./runs/[id]/cancel.js');
        const event = makeEvent({ params: { id: 'run_1' } });
        event.locals.principal!.isAdmin = false;
        const response = await def.handlers.POST!(event, { input: { body: {} } } as never);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ accepted: true });
        expect(orchestratorMock.getRun).toHaveBeenCalledWith('run_1');
        expect(orchestratorMock.cancelRun).toHaveBeenCalledWith('run_1', {
            hard: false,
            reason: undefined,
        });
        expect(capturedActor().username).toBe(TEST_USERNAME);
        expect(capturedActor().username).not.toBe(TEST_USER_ID);
    });

    it('run.cancel-by-task (runs/cancel.ts)', async () => {
        registryGetTaskMock.mockReturnValue({ id: 'metadata-sync' });
        orchestratorMock.nuclearStop.mockResolvedValue({ cancelled: 1, orphaned: 0 });
        const { def } = await import('./runs/cancel.js');
        const event = makeEvent();
        await def.handlers.POST!(event, {
            input: { body: {}, query: { byTask: 'metadata-sync' } },
        } as never);
        expect(capturedActor().username).toBe(TEST_USERNAME);
    });

    it('task.failure.retry (tasks/[taskId]/failures/[itemId]/retry.ts)', async () => {
        registryGetTaskMock.mockReturnValue({
            failures: { retry: vi.fn(async () => ({ success: true })) },
        });
        withAdvisoryLockMock.mockImplementation(async (_sql, _key, cb) => ({
            acquired: true,
            value: await cb({}),
        }));
        const { def } = await import('./tasks/[taskId]/failures/[itemId]/retry.js');
        const event = makeEvent({
            // Deliberately unrelated URL: named params, rather than pathname parsing, drive identity.
            url: new URL('https://app.example/unrelated'),
            params: { taskId: 'metadata-sync', itemId: 'item-1' },
        });
        await def.handlers.POST!(event, {} as never);
        expect(capturedActor().username).toBe(TEST_USERNAME);
        expect(registryGetTaskMock).toHaveBeenCalledWith('metadata-sync');
        expect(withAdvisoryLockMock).toHaveBeenCalledWith(
            expect.anything(), 'retry:metadata-sync:item-1', expect.any(Function),
        );
    });

    it('task.run (tasks/[taskId]/run.ts)', async () => {
        registryGetTaskMock.mockReturnValue({ id: 'metadata-sync' });
        orchestratorMock.startRun.mockResolvedValue({ runId: 'run_1', deduped: false });
        const { def } = await import('./tasks/[taskId]/run.js');
        const event = makeEvent({ params: { taskId: 'metadata-sync' } });
        await def.handlers.POST!(event, { input: { body: {} } } as never);
        expect(capturedActor().username).toBe(TEST_USERNAME);
        // `trigger.by` still correctly uses the UUID (a separate, non-audit field).
        expect(orchestratorMock.startRun).toHaveBeenCalledWith(
            'metadata-sync',
            {},
            expect.objectContaining({ trigger: { kind: 'manual', by: TEST_USER_ID } }),
        );
    });

    describe('tasks/[taskId]/triggers.ts', () => {
        async function putTriggers(body: Record<string, unknown>) {
            const { def } = await import('./tasks/[taskId]/triggers.js');
            const event = makeEvent({ params: { taskId: 'metadata-sync' } });
            return body.reset
                ? def.handlers.DELETE!(event, {} as never)
                : def.handlers.PUT!(event, { input: { body } } as never);
        }

        it('task.triggers.reset (declared default)', async () => {
            registryGetTaskMock.mockReturnValue({ id: 'metadata-sync', schedule: { every: '1h' } });
            await putTriggers({ reset: true });
            expect(resumeTaskMock).not.toHaveBeenCalled();
            expect(auditLogMock).toHaveBeenCalledWith(
                'task.triggers.reset',
                'metadata-sync',
                expect.objectContaining({ username: TEST_USERNAME }),
                expect.anything(),
            );
        });

        it('stores the preset as one interval trigger, attributed to the username', async () => {
            registryGetTaskMock.mockReturnValue({ id: 'metadata-sync', schedule: { every: '1h' } });
            await putTriggers({ triggers: [{ kind: 'interval', every: '1h' }] });
            expect(resumeTaskMock).not.toHaveBeenCalled();
            expect(saveTaskTriggersMock).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ id: 'metadata-sync' }),
                [{ kind: 'interval', every: '1h' }],
                TEST_USERNAME,
            );
        });

        it('task.triggers.set (hourly interval)', async () => {
            registryGetTaskMock.mockReturnValue({ id: 'metadata-sync', schedule: { every: '1h' } });
            await putTriggers({ triggers: [{ kind: 'interval', every: '1h' }] });
            expect(resumeTaskMock).not.toHaveBeenCalled();
            expect(auditLogMock).toHaveBeenCalledWith(
                'task.triggers.set',
                'metadata-sync',
                expect.objectContaining({ username: TEST_USERNAME }),
                expect.anything(),
            );
        });
    });

    describe('tasks/[taskId]/triggers.ts', () => {
        it('task.triggers.set', async () => {
            registryGetTaskMock.mockReturnValue({ id: 'metadata-sync', schedule: { every: '6h' } });
            const { def } = await import('./tasks/[taskId]/triggers.js');
            const event = makeEvent({ params: { taskId: 'metadata-sync' } });
            await def.handlers.PUT!(event, {
                input: { body: { triggers: [{ kind: 'daily', at: '03:00' }] } },
            } as never);
            expect(auditLogMock).toHaveBeenCalledWith(
                'task.triggers.set',
                'metadata-sync',
                expect.objectContaining({ username: TEST_USERNAME }),
                expect.anything(),
            );
        });

        it('task.triggers.reset', async () => {
            registryGetTaskMock.mockReturnValue({ id: 'metadata-sync', schedule: { every: '6h' } });
            const { def } = await import('./tasks/[taskId]/triggers.js');
            const event = makeEvent({ params: { taskId: 'metadata-sync' } });
            await def.handlers.DELETE!(event, {} as never);
            expect(auditLogMock).toHaveBeenCalledWith(
                'task.triggers.reset',
                'metadata-sync',
                expect.objectContaining({ username: TEST_USERNAME }),
                expect.anything(),
            );
        });
    });

    it('task.settings.update (tasks/[taskId]/settings.ts)', async () => {
        registryGetTaskMock.mockReturnValue({ id: 'metadata-sync', settings: { fields: [] } });
        const { def } = await import('./tasks/[taskId]/settings.js');
        const event = makeEvent({ params: { taskId: 'metadata-sync' } });
        await def.handlers.PUT!(event, { input: { body: {} } } as never);
        expect(capturedActor().username).toBe(TEST_USERNAME);
    });

    describe('tasks/[taskId]/state.ts', () => {
        it('task.pause (schedule: paused)', async () => {
            registryGetTaskMock.mockReturnValue({ id: 'metadata-sync' });
            const { def } = await import('./tasks/[taskId]/state.js');
            const event = makeEvent({ params: { taskId: 'metadata-sync' } });
            await def.handlers.PATCH!(event, { input: { body: { schedule: 'paused' } } } as never);
            expect(auditLogMock).toHaveBeenCalledWith(
                'task.pause',
                'metadata-sync',
                expect.objectContaining({ username: TEST_USERNAME }),
                expect.anything(),
            );
        });

        it('task.resume (schedule: active)', async () => {
            registryGetTaskMock.mockReturnValue({ id: 'metadata-sync' });
            const { def } = await import('./tasks/[taskId]/state.js');
            const event = makeEvent({ params: { taskId: 'metadata-sync' } });
            await def.handlers.PATCH!(event, { input: { body: { schedule: 'active' } } } as never);
            expect(auditLogMock).toHaveBeenCalledWith(
                'task.resume',
                'metadata-sync',
                expect.objectContaining({ username: TEST_USERNAME }),
                expect.anything(),
            );
        });

        it('task.circuit-breaker.force-enable (breaker: enable, force: true)', async () => {
            registryGetTaskMock.mockReturnValue({ id: 'metadata-sync' });
            const { def } = await import('./tasks/[taskId]/state.js');
            const event = makeEvent({ params: { taskId: 'metadata-sync' } });
            await def.handlers.PATCH!(event, {
                input: { body: { breaker: 'enable', force: true } },
            } as never);
            expect(auditLogMock).toHaveBeenCalledWith(
                'task.circuit-breaker.force-enable',
                'metadata-sync',
                expect.objectContaining({ username: TEST_USERNAME }),
                expect.anything(),
            );
        });

        it('task.circuit-breaker.reset (breaker: reset)', async () => {
            registryGetTaskMock.mockReturnValue({ id: 'metadata-sync' });
            const { def } = await import('./tasks/[taskId]/state.js');
            const event = makeEvent({ params: { taskId: 'metadata-sync' } });
            await def.handlers.PATCH!(event, { input: { body: { breaker: 'reset' } } } as never);
            expect(auditLogMock).toHaveBeenCalledWith(
                'task.circuit-breaker.reset',
                'metadata-sync',
                expect.objectContaining({ username: TEST_USERNAME }),
                expect.anything(),
            );
        });
    });
});
