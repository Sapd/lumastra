// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '$lib/server/config.js';
import { TaskRunner, type WorkerLike } from './runner.js';
import { TaskRegistry } from './registry.js';

// TaskRunner tests explicitly host the dedicated consumer role.
beforeEach(() => {
    vi.spyOn(config, 'WORKER_MODE', 'get').mockReturnValue('enabled');
    vi.spyOn(config, 'DEDICATED_WORKER', 'get').mockReturnValue(true);
});
afterEach(() => {
    vi.restoreAllMocks();
});

function worker(paused = false): WorkerLike & { running: boolean } {
    const value: WorkerLike & { running: boolean } = {
        running: false,
        close: vi.fn(async () => {}),
        pause: vi.fn(async () => {
            paused = true;
        }),
        resume: vi.fn(async () => {
            paused = false;
        }),
        isPaused: () => paused,
        isRunning: (): boolean => value.running,
        on: (): WorkerLike => value,
    };
    return value;
}
const runners: TaskRunner[] = [];
afterEach(async () => {
    for (const runner of runners.splice(0)) await runner.stop({ strict: true });
    vi.useRealTimers();
});

async function start(workers: WorkerLike[]): Promise<TaskRunner> {
    const runner = await TaskRunner.start(['io', 'cpu'], {
        registry: new TaskRegistry(),
        perTaskQueues: false,
        workerFactory: () => workers.shift()!,
    });
    runners.push(runner);
    return runner;
}

describe('reversible local worker upgrade preparation', () => {
    it('retains a prior local pause and restores only its own pauses', async () => {
        const active = worker();
        const adminPaused = worker(true);
        const runner = await start([active, adminPaused]);
        expect(await runner.prepareUpgrade({ deadlineMs: 100 })).toEqual({ prepared: true });
        expect(active.isPaused!()).toBe(true);
        await expect(runner.ensureWorkersForRegisteredTasks()).rejects.toThrow(
            'paused worker creation',
        );
        await runner.resumeAfterUpgrade();
        expect(active.resume).toHaveBeenCalledOnce();
        expect(adminPaused.pause).not.toHaveBeenCalled();
        expect(adminPaused.resume).not.toHaveBeenCalled();
        expect(adminPaused.isPaused!()).toBe(true);
        await runner.ensureWorkersForRegisteredTasks();
    });

    it('postpones when a loop or retained persistence obligation remains and restores dispatch', async () => {
        vi.useFakeTimers();
        const first = worker();
        const second = worker();
        const runner = await start([first, second]);
        first.running = true;
        const result = runner.prepareUpgrade({ deadlineMs: 50, settled: () => false });
        await vi.advanceTimersByTimeAsync(100);
        expect(await result).toEqual({ prepared: false });
        expect(first.isPaused!()).toBe(false);
        expect(second.isPaused!()).toBe(false);
        expect(runner.isStopped()).toBe(false);
    });

    it('restores a pause whose acknowledgement failed and never certifies a failed restoration', async () => {
        const first = worker();
        const second = worker();
        const originalPause = second.pause!;
        second.pause = async () => {
            await originalPause();
            throw new Error('lost pause ack');
        };
        first.resume = async () => {
            throw new Error('resume unavailable');
        };
        const runner = await start([first, second]);
        await expect(runner.prepareUpgrade({ deadlineMs: 10 })).rejects.toThrow(
            'restoration UNKNOWN',
        );
        expect(second.isPaused!()).toBe(false);
        await expect(runner.prepareUpgrade({ deadlineMs: 10 })).rejects.toThrow('remains UNKNOWN');
        second.pause = originalPause;
        first.resume = async () => {
            /* the real worker below now reports restored */
        };
        first.isPaused = () => false;
        await runner.resumeAfterUpgrade();
        expect(await runner.prepareUpgrade({ deadlineMs: 100 })).toEqual({ prepared: true });
    });
    it('bounds a stalled pause and retains its handle until late completion can be restored', async () => {
        vi.useFakeTimers();
        const first = worker();
        const second = worker();
        const originalPause = first.pause!;
        let releasePause: () => void = () => {};
        first.pause = async () => {
            await new Promise<void>((resolve) => {
                releasePause = resolve;
            });
            await originalPause();
        };
        const runner = await start([first, second]);
        const preparation = runner.prepareUpgrade({ deadlineMs: 50 });
        const rejected = expect(preparation).rejects.toThrow('restoration UNKNOWN');
        await vi.advanceTimersByTimeAsync(5050);
        await rejected;
        expect(first.resume).not.toHaveBeenCalled();
        await expect(runner.prepareUpgrade({ deadlineMs: 50 })).rejects.toThrow('remains UNKNOWN');
        releasePause();
        await Promise.resolve();
        await runner.resumeAfterUpgrade();
        expect(first.isPaused!()).toBe(false);
        expect(first.resume).toHaveBeenCalledOnce();
    });

    it('bounds restoration and keeps the original paused worker available for retry', async () => {
        vi.useFakeTimers();
        const first = worker();
        const second = worker();
        const originalResume = first.resume!;
        let releaseResume: () => void = () => {};
        first.running = true;
        first.resume = async () => {
            await new Promise<void>((resolve) => {
                releaseResume = resolve;
            });
            await originalResume();
        };
        const runner = await start([first, second]);
        const preparation = runner.prepareUpgrade({ deadlineMs: 50 });
        const rejected = expect(preparation).rejects.toThrow('restoration UNKNOWN');
        await vi.advanceTimersByTimeAsync(5050);
        await rejected;
        expect(first.isPaused!()).toBe(true);
        releaseResume();
        first.resume = originalResume;
        await runner.resumeAfterUpgrade();
        expect(first.isPaused!()).toBe(false);
        expect(second.isPaused!()).toBe(false);
    });
});
