// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fix plan 6, ruling T9-demo-invariant: a `demo: true` task must be reachable
 * ONLY through an explicit manual start (the two gated trigger defs —
 * `tasks/[taskId]/run.ts`, `admin/plugins/[pluginId]/index.ts`). Before this,
 * nothing stopped a demo task from also declaring `schedule`,
 * `dynamicSchedule`, `failures.retry`, or an enqueueable `coversStages`
 * entry — each of those fires a run with no trigger-def gate at all, and
 * `classifyTriggers()` resolves `demo` FIRST, so such a task would also be
 * silently exempted from the trigger-orphan boot audit. `registerTask()` now
 * throws on the conflicting declaration instead (`validateDemoInvariant()`),
 * making the state unregistrable rather than adding a guard at every extra
 * call site.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import { registry } from './registry.js';
import { loadBuiltins, _resetLoadedForTests } from './builtin/index.js';

function makeTask(id: string, overrides: Record<string, unknown> = {}) {
    return defineTask({
        id,
        name: `Task ${id}`,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.object({}),
        identityFor: () => 'global',
        async execute() {
            return { success: true };
        },
        ...overrides,
    });
}

describe('TaskRegistry demo-task invariant (T9-demo-invariant)', () => {
    it('throws when a demo task declares a schedule', () => {
        const reg = new TaskRegistry();
        const task = makeTask('demo-scheduled', {
            demo: true,
            schedule: { every: '1h' },
        });

        let caught: unknown;
        try {
            reg.registerTask(task);
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(Error);
        const msg = (caught as Error).message;
        expect(msg).toMatch(/demo: true task declares an automatic trigger/);
        expect(msg).toMatch(/schedule/);
        expect(reg.getTask('demo-scheduled')).toBeUndefined();
    });

    it('throws when a demo task declares failures.retry', () => {
        const reg = new TaskRegistry();
        const task = makeTask('demo-retry', {
            demo: true,
            failures: {
                list: async () => ({ items: [], total: 0 }),
                retry: async () => {},
            },
        });

        let caught: unknown;
        try {
            reg.registerTask(task);
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(Error);
        const msg = (caught as Error).message;
        expect(msg).toMatch(/demo: true task declares an automatic trigger/);
        expect(msg).toMatch(/failures\.retry/);
        expect(reg.getTask('demo-retry')).toBeUndefined();
    });

    it('throws when a demo task declares an enqueueable coversStages entry', () => {
        const reg = new TaskRegistry();
        const task = makeTask('demo-enqueueable', {
            demo: true,
            coversStages: [
                {
                    id: 'demo-enqueueable-stage',
                    appliesTo: ['movie'],
                    enqueueable: true,
                    terminalDisposition: {
                        kind: 'self-terminal',
                        ruleId: 'demo-enqueueable-self-terminal',
                    },
                },
            ],
        });

        let caught: unknown;
        try {
            reg.registerTask(task);
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(Error);
        const msg = (caught as Error).message;
        expect(msg).toMatch(/demo: true task declares an automatic trigger/);
        expect(msg).toMatch(/enqueueable/);
    });

    it('control: a non-demo scheduled task registers fine', () => {
        const reg = new TaskRegistry();
        const task = makeTask('real-scheduled', { schedule: { every: '1h' } });

        expect(() => reg.registerTask(task)).not.toThrow();
        expect(reg.getTask('real-scheduled')).toBe(task);
    });

    it('control: a plain demo task with no automatic trigger registers fine', () => {
        const reg = new TaskRegistry();
        const task = makeTask('demo-plain', { demo: true });

        expect(() => reg.registerTask(task)).not.toThrow();
        expect(reg.getTask('demo-plain')).toBe(task);
    });

    it('control: every currently registered task (the real builtin registry) still registers', async () => {
        _resetLoadedForTests();
        await expect(loadBuiltins()).resolves.not.toThrow();
        expect(registry.getAllTasks().length).toBeGreaterThan(0);
    }, 60_000);

    it('no currently registered demo task has any automatic trigger', async () => {
        _resetLoadedForTests();
        await loadBuiltins();

        const demoTasks = registry.getAllTasks().filter((t) => t.demo);
        // Guards against this test going vacuously green if every demo task
        // were ever removed from the builtins.
        expect(demoTasks.length).toBeGreaterThan(0);

        for (const t of demoTasks) {
            expect(t.schedule, `${t.id} declares schedule`).toBeUndefined();
            expect(t.dynamicSchedule, `${t.id} declares dynamicSchedule`).toBeUndefined();
            expect(t.failures?.retry, `${t.id} declares failures.retry`).toBeUndefined();
            const enqueueable = (t.coversStages ?? []).filter((s) => s.enqueueable === true);
            expect(enqueueable, `${t.id} declares an enqueueable coversStages entry`).toEqual([]);
        }
    }, 60_000);
});
