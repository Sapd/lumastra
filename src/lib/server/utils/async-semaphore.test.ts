// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { AsyncSemaphore } from './async-semaphore';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AsyncSemaphore', () => {
    it('allows up to N concurrent operations', async () => {
        const sem = new AsyncSemaphore(2);
        let running = 0;
        let maxRunning = 0;

        const task = async (): Promise<void> => {
            await sem.acquire();
            running++;
            maxRunning = Math.max(maxRunning, running);
            await delay(20);
            running--;
            sem.release();
        };

        await Promise.all([task(), task(), task(), task()]);
        expect(maxRunning).toBe(2);
    });

    it('withPermit acquires and releases automatically', async () => {
        const sem = new AsyncSemaphore(1);
        const order: string[] = [];

        await Promise.all([
            sem.withPermit(async () => {
                order.push('a-start');
                await delay(20);
                order.push('a-end');
            }),
            sem.withPermit(async () => {
                order.push('b-start');
                await delay(5);
                order.push('b-end');
            }),
        ]);

        // b must start after a ends because concurrency is 1
        expect(order.indexOf('b-start')).toBeGreaterThan(order.indexOf('a-end'));
    });

    it('withPermit releases on error', async () => {
        const sem = new AsyncSemaphore(1);

        await expect(
            sem.withPermit(async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        // Permit was released — next operation should proceed immediately
        expect(sem.available).toBe(1);
    });

    it('reports available permits and queue length', async () => {
        const sem = new AsyncSemaphore(2);
        expect(sem.available).toBe(2);
        expect(sem.waiting).toBe(0);

        await sem.acquire();
        expect(sem.available).toBe(1);

        await sem.acquire();
        expect(sem.available).toBe(0);

        // Next acquire will queue
        const pending = sem.acquire();
        expect(sem.waiting).toBe(1);

        sem.release();
        await pending;
        expect(sem.waiting).toBe(0);

        // Clean up
        sem.release();
        sem.release();
    });

    it('preserves FIFO order for waiters', async () => {
        const sem = new AsyncSemaphore(1);
        const order: number[] = [];

        await sem.acquire(); // take the only permit

        // Queue three waiters
        const p1 = sem.withPermit(async () => {
            order.push(1);
        });
        const p2 = sem.withPermit(async () => {
            order.push(2);
        });
        const p3 = sem.withPermit(async () => {
            order.push(3);
        });

        sem.release(); // release initial permit — starts chain
        await Promise.all([p1, p2, p3]);

        expect(order).toEqual([1, 2, 3]);
    });
});

it('cancels a queued waiter promptly and preserves the permit for the next caller', async () => {
    const semaphore = new AsyncSemaphore(1);
    await semaphore.acquire();
    const controller = new AbortController();
    const cancelled = semaphore.withPermit(async () => {
        throw new Error('must never run');
    }, controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(semaphore.waiting).toBe(0);
    semaphore.release();
    expect(await semaphore.withPermit(async () => 'next')).toBe('next');
    expect(semaphore.available).toBe(1);
});
