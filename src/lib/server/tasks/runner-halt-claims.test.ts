// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '$lib/server/config.js';
import { TaskRunner, type WorkerLike } from './runner.js';
import { TaskRegistry } from './registry.js';

beforeEach(() => {
    vi.spyOn(config, 'WORKER_MODE', 'get').mockReturnValue('enabled');
    vi.spyOn(config, 'DEDICATED_WORKER', 'get').mockReturnValue(true);
});
afterEach(() => {
    vi.restoreAllMocks();
});

function worker(): WorkerLike & { pauseArgs: (boolean | undefined)[] } {
    let paused = false;
    const value: WorkerLike & { pauseArgs: (boolean | undefined)[] } = {
        pauseArgs: [],
        close: vi.fn(async () => {}),
        pause: vi.fn((doNotWaitActive?: boolean) => {
            value.pauseArgs.push(doNotWaitActive);
            paused = true;
            // An active job never finishes during this test: a pause that waited
            // for it would never settle.
            return doNotWaitActive ? Promise.resolve() : new Promise<void>(() => {});
        }),
        resume: vi.fn(async () => {
            paused = false;
        }),
        isPaused: () => paused,
        isRunning: (): boolean => !paused,
        on: (): WorkerLike => value,
    };
    return value;
}

describe('TaskRunner.haltClaims (fencing loss)', () => {
    it('pauses every worker synchronously without waiting for active jobs and refuses new workers', async () => {
        const io = worker();
        const cpu = worker();
        const queue = [io, cpu];
        const runner = await TaskRunner.start(['io', 'cpu'], {
            registry: new TaskRegistry(),
            perTaskQueues: false,
            workerFactory: () => queue.shift()!,
        });
        try {
            runner.haltClaims();
            // Issued before any await: claiming stops in the same tick.
            expect(io.pauseArgs).toEqual([true]);
            expect(cpu.pauseArgs).toEqual([true]);
            expect(io.isPaused!()).toBe(true);
            expect(cpu.isPaused!()).toBe(true);
            await expect(runner.ensureWorkersForRegisteredTasks()).rejects.toThrow(
                'claims are halted',
            );
        } finally {
            await runner.stop({ strict: false });
        }
    });
});
