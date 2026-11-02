// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The single most important property of the global-pause reconcile design:
 * the task that LIFTS an expired pause must never itself be a queue that
 * "pause everything" pauses, or the system deadlocks permanently (the one
 * thing that can resume it is stuck waiting on a resume only it can
 * trigger). See global-pause-reconcile.ts's module doc for the full design.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from './registry.js';
// Import for its self-registration side effect only — proves the exemption
// holds for the REAL registered task, not just a same-shaped stand-in.
import '../tasks/builtin/native/pause-reconcile.js';

// ── Audit-actor typing for the system-initiated auto-resume / quiet-hours
//    events (security review 2026-09-13, R5 follow-through). These fire from
//    a timer/reconcile path with NO request in flight — no human actor, no
//    credential — so `{ username: null }` (→ logged/stored as 'system') is
//    the CORRECT actor, typed as an `AuditActor` rather than a bare
//    'system:auto-resume'/'system:quiet-hours' string that `auditLog()`
//    would otherwise store verbatim as the actor name.
const mockAuditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

const store = new Map<string, string>();
const fakeCoordinationClient = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
    }),
    del: vi.fn(async (keys: string[]) => {
        for (const k of keys) store.delete(k);
    }),
};
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => fakeCoordinationClient,
}));

// Truthy connection so pauseClasses()/resumeClasses() don't short-circuit —
// but 'cpu'/'analysis' have no registered tasks in this test file, so
// `tasksForClass()` returns an empty queue list and no real BullMQ `Queue`
// is ever constructed (no network I/O).
vi.mock('./connection.js', () => ({
    getQueueConnectionOptions: () => ({ host: 'localhost', port: 6379, db: 0 }),
}));

const {
    tasksForClass,
    GLOBAL_PAUSE_RECONCILE_TASK_ID,
    reconcileAndReadStatus,
    GLOBAL_PAUSE_KEY,
    QUIET_HOURS_MARKER_KEY,
} = await import('./global-pause-reconcile.js');

function makeMaintenanceTask(id: string) {
    return defineTask({
        id,
        name: `Test task ${id}`,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'maintenance',
        inputSchema: z.object({}),
        identityFor: () => 'global',
        async execute() {
            return { success: true };
        },
    });
}

describe('global-pause-reconcile: pause-reconcile queue exemption', () => {
    it('excludes the pause-reconcile task from its own resource class', () => {
        // pause-reconcile.js's top-level import above already registered the
        // real task under GLOBAL_PAUSE_RECONCILE_TASK_ID.
        const maintenanceTasks = tasksForClass('maintenance');
        expect(maintenanceTasks.some((t) => t.id === GLOBAL_PAUSE_RECONCILE_TASK_ID)).toBe(false);
    });

    it('still includes other maintenance-class tasks — the exemption is scoped to one id', () => {
        const otherId = 'test-fixture-maintenance-task';
        if (!registry.getTask(otherId)) {
            registry.registerTask(makeMaintenanceTask(otherId));
        }
        const maintenanceTasks = tasksForClass('maintenance');
        expect(maintenanceTasks.some((t) => t.id === otherId)).toBe(true);
    });

    it('has no effect on an unrelated resource class', () => {
        // Sanity check that the filter is id-scoped, not accidentally
        // dropping the whole class.
        const cpuTasks = tasksForClass('cpu');
        expect(cpuTasks.every((t) => t.id !== GLOBAL_PAUSE_RECONCILE_TASK_ID)).toBe(true);
    });
});

describe('global-pause-reconcile: system-initiated audit actor (R5)', () => {
    beforeEach(() => {
        store.clear();
        mockAuditLog.mockClear();
        vi.useRealTimers();
    });

    it('auto-resume audits a typed system actor, not a bare "system:auto-resume" string', async () => {
        const expiredRecord = {
            resumeAt: new Date(Date.now() - 1000).toISOString(),
            classes: ['discovery'],
            reason: 'test',
            pausedBy: 'denis',
            pausedAt: new Date(Date.now() - 3600_000).toISOString(),
        };
        store.set(GLOBAL_PAUSE_KEY, JSON.stringify(expiredRecord));

        await reconcileAndReadStatus();

        const call = mockAuditLog.mock.calls.find((c) => c[0] === 'queue.pause.global.auto-resume');
        expect(call).toBeDefined();
        // The actor is a typed AuditActor object ({ username: null }) — NOT
        // the bare 'system:auto-resume' string the un-fixed call site passed
        // (which auditLog() would have logged/stored verbatim as the actor
        // name instead of normalizing to 'system').
        expect(call?.[2]).toEqual({ username: null });
    });

    it('quiet-hours pause audits a typed system actor', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
        process.env.LUMASTRA_QUIET_HOURS_ENABLED = 'true';
        process.env.LUMASTRA_QUIET_HOURS_START = '01:00';
        process.env.LUMASTRA_QUIET_HOURS_END = '23:00';
        process.env.DATE_TIMEZONE = 'UTC';

        try {
            await reconcileAndReadStatus();
        } finally {
            delete process.env.LUMASTRA_QUIET_HOURS_ENABLED;
            delete process.env.LUMASTRA_QUIET_HOURS_START;
            delete process.env.LUMASTRA_QUIET_HOURS_END;
            delete process.env.DATE_TIMEZONE;
        }

        const call = mockAuditLog.mock.calls.find((c) => c[0] === 'queue.pause.quiet-hours');
        expect(call).toBeDefined();
        expect(call?.[2]).toEqual({ username: null });
    });

    it('quiet-hours resume audits a typed system actor', async () => {
        store.set(QUIET_HOURS_MARKER_KEY, JSON.stringify({ classes: ['cpu', 'analysis'] }));
        process.env.LUMASTRA_QUIET_HOURS_ENABLED = 'false';

        try {
            await reconcileAndReadStatus();
        } finally {
            delete process.env.LUMASTRA_QUIET_HOURS_ENABLED;
        }

        const call = mockAuditLog.mock.calls.find((c) => c[0] === 'queue.resume.quiet-hours');
        expect(call).toBeDefined();
        expect(call?.[2]).toEqual({ username: null });
    });
});
