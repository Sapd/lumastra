// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    hasImageWorkBudget,
    imageWorkSignal,
    ImageEncodeQueueFullError,
    recordImageEncodeQueueFull,
    requireImageEncodeBudget,
} from './work-budget';

interface Waiter {
    signal?: AbortSignal;
    abort: () => void;
    resolve: () => void;
    reject: (error: unknown) => void;
}

class EncodePool {
    private active = 0;
    private readonly waiters: Waiter[] = [];

    constructor(
        private readonly capacity: number,
        private readonly maxWaiters: number,
    ) {}

    async acquire(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (this.active < this.capacity) {
            this.active++;
            return;
        }
        if (this.waiters.length >= this.maxWaiters) throw new ImageEncodeQueueFullError();
        await new Promise<void>((resolve, reject) => {
            const waiter: Waiter = {
                signal,
                resolve,
                reject,
                abort: () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) this.waiters.splice(index, 1);
                    signal?.removeEventListener('abort', waiter.abort);
                    reject(signal?.reason);
                },
            };
            this.waiters.push(waiter);
            signal?.addEventListener('abort', waiter.abort, { once: true });
        });
    }

    release(): void {
        let next: Waiter | undefined;
        while ((next = this.waiters.shift())) {
            next.signal?.removeEventListener('abort', next.abort);
            if (next.signal?.aborted) {
                next.reject(next.signal.reason);
                continue;
            }
            next.resolve(); // Transfer the permit without letting new arrivals jump the FIFO.
            return;
        }
        this.active--;
    }
}

const requestPool = new EncodePool(4, 256);
const backgroundPool = new EncodePool(2, 64);

/** Keep background warmups out of the bounded, abortable request FIFO. */
export async function runImageEncode<T>(encode: () => Promise<T>): Promise<T> {
    const pool = hasImageWorkBudget() ? requestPool : backgroundPool;
    const signal = imageWorkSignal();
    signal?.throwIfAborted();
    await requireImageEncodeBudget();
    try {
        await pool.acquire(signal);
    } catch (error) {
        if (error instanceof ImageEncodeQueueFullError) recordImageEncodeQueueFull();
        throw error;
    }
    try {
        signal?.throwIfAborted();
        return await encode();
    } finally {
        // An active libvips job retains its permit until it completes, even after an abort.
        pool.release();
    }
}
