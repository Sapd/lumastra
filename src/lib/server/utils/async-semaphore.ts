// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Async Semaphore
 *
 * Limits concurrent execution of async operations.
 * Used to prevent resource exhaustion when many requests come in simultaneously.
 */

export class AsyncSemaphore {
    private permits: number;
    private queue: (() => void)[] = [];

    constructor(permits: number) {
        this.permits = permits;
    }

    /**
     * Acquire a permit. Resolves when a permit is available.
     */
    async acquire(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (this.permits > 0) {
            this.permits--;
            return;
        }

        // Wait for a permit to become available
        return new Promise<void>((resolve, reject) => {
            const grant = (): void => {
                signal?.removeEventListener('abort', abort);
                resolve();
            };
            const abort = (): void => {
                const index = this.queue.indexOf(grant);
                if (index < 0) return; // already owns the permit
                this.queue.splice(index, 1);
                reject(signal?.reason);
            };
            this.queue.push(grant);
            signal?.addEventListener('abort', abort, { once: true });
        });
    }

    /**
     * Release a permit.
     */
    release(): void {
        const next = this.queue.shift();
        if (next) {
            // Give permit to next waiter
            next();
        } else {
            // No waiters, return permit to pool
            this.permits++;
        }
    }

    /**
     * Execute a function with a permit.
     * Automatically acquires and releases the permit.
     */
    async withPermit<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        await this.acquire(signal);
        try {
            signal?.throwIfAborted();
            return await fn();
        } finally {
            this.release();
        }
    }

    /**
     * Get current number of available permits.
     */
    get available(): number {
        return this.permits;
    }

    /**
     * Get number of waiters in queue.
     */
    get waiting(): number {
        return this.queue.length;
    }
}
