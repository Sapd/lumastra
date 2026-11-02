// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTaskProcess, createTaskProcessLifecycle } from './process-lifecycle.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('standalone startup/shutdown coordination', () => {
    it('cancels startup immediately, waits for it and shares cleanup across repeated signals', async () => {
        const draining = deferred();
        const events: string[] = [];
        const lifecycle = createTaskProcessLifecycle({
            drain: () => {
                events.push('not-ready');
            },
            cleanup: async () => {
                events.push('cleanup');
                await draining.promise;
            },
            exit: (code) => {
                events.push(`exit-${code}`);
            },
            failed: () => {
                events.push('failure');
            },
        });
        const first = lifecycle.shutdown(0);
        expect(lifecycle.signal.aborted).toBe(true);
        expect(lifecycle.shutdown(0)).toBe(first);
        expect(events).toEqual(['not-ready']);
        lifecycle.startupFinished();
        await Promise.resolve();
        expect(events).toEqual(['not-ready', 'cleanup']);
        expect(lifecycle.shutdown(1)).toBe(first);
        draining.resolve();
        await first;
        expect(events).toEqual(['not-ready', 'cleanup', 'exit-1']);
    });

    it('reports a wedged startup as UNKNOWN and never as clean drain', async () => {
        vi.useFakeTimers();
        const exit = vi.fn();
        const failed = vi.fn();
        const cleanup = vi.fn(async () => {});
        const lifecycle = createTaskProcessLifecycle({ drain: () => {}, cleanup, exit, failed });
        void lifecycle.shutdown(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(cleanup).not.toHaveBeenCalled();
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(failed.mock.calls[0]?.[0]).toMatchObject({
            message: expect.stringContaining('UNKNOWN'),
        });
        // Resolve the fixture after the deadline; a real exit() never returns.
        lifecycle.startupFinished();
        await lifecycle.shutdown(1);
    });

    it('attempts later releases after failures and reports nonzero only after cleanup', async () => {
        const events: string[] = [];
        const lifecycle = createTaskProcessLifecycle({
            drain: () => {},
            cleanup: () =>
                cleanupTaskProcess([
                    async () => {
                        events.push('runner');
                        throw new Error('worker close failed');
                    },
                    async () => {
                        events.push('health');
                    },
                    async () => {
                        events.push('database');
                        throw new Error('database close failed');
                    },
                ]),
            exit: (code) => {
                events.push(`exit-${code}`);
            },
            failed: (error) => {
                expect(error).toBeInstanceOf(AggregateError);
                expect((error as AggregateError).errors).toHaveLength(2);
                events.push('failure');
            },
        });
        lifecycle.startupFinished();
        await lifecycle.shutdown(0);
        expect(events).toEqual(['runner', 'health', 'database', 'failure', 'exit-1']);
    });
});
