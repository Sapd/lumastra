// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerTimer - Web Worker-based interval timer
 *
 * Uses a Web Worker to run setInterval, avoiding browser throttling
 * of background tabs (especially Safari which aggressively throttles
 * timers in inactive tabs).
 *
 * Usage:
 *   const timer = new WorkerTimer();
 *   timer.start('heartbeat', () => sendHeartbeat(), 5000);
 *   timer.start('driftCheck', () => checkDrift(), 2000);
 *   timer.stop('heartbeat');
 *   timer.dispose(); // Clean up when done
 */

import { browser } from '$app/environment';

type TimerCallback = () => void;

interface WorkerMessage {
    type: 'tick';
    id: string;
}

export class WorkerTimer {
    private worker: Worker | null = null;
    private workerBlobUrl: string | null = null;
    private readonly callbacks = new Map<string, TimerCallback>();
    private readonly fallbackTimers = new Map<string, ReturnType<typeof setInterval>>();
    private useWorker = true;

    constructor() {
        if (!browser) return;

        try {
            // Create worker from the interval worker module
            // Using inline worker creation to avoid build issues
            const workerCode = `
				const timers = new Map();
				self.onmessage = (event) => {
					const { type, id, interval } = event.data;
					switch (type) {
						case 'start':
							if (timers.has(id)) clearInterval(timers.get(id));
							const timerId = setInterval(() => {
								self.postMessage({ type: 'tick', id });
							}, interval);
							timers.set(id, timerId);
							break;
						case 'stop':
							if (timers.has(id)) {
								clearInterval(timers.get(id));
								timers.delete(id);
							}
							break;
						case 'stopAll':
							timers.forEach((t) => clearInterval(t));
							timers.clear();
							break;
					}
				};
			`;

            const blob = new Blob([workerCode], {
                type: 'application/javascript',
            });
            this.workerBlobUrl = URL.createObjectURL(blob);
            this.worker = new Worker(this.workerBlobUrl);

            this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
                const { type, id } = event.data;
                if (type === 'tick') {
                    const callback = this.callbacks.get(id);
                    if (callback) {
                        try {
                            callback();
                        } catch (e) {
                            console.error(`[WorkerTimer] Error in callback '${id}':`, e);
                        }
                    }
                }
            };

            this.worker.onerror = (error) => {
                console.warn('[WorkerTimer] Worker error, falling back to setInterval:', error);
                this.useWorker = false;
                this.migrateToFallback();
            };
        } catch (e) {
            console.warn('[WorkerTimer] Failed to create worker, using fallback:', e);
            this.useWorker = false;
        }
    }

    /**
     * Start a named timer
     * @param id - Unique identifier for this timer
     * @param callback - Function to call on each tick
     * @param interval - Interval in milliseconds
     */
    start(id: string, callback: TimerCallback, interval: number): void {
        if (!browser) return;

        // Store callback
        this.callbacks.set(id, callback);

        if (this.useWorker && this.worker) {
            this.worker.postMessage({ type: 'start', id, interval });
        } else {
            // Fallback to regular setInterval
            this.fallbackTimers.set(
                id,
                setInterval(() => {
                    const cb = this.callbacks.get(id);
                    if (cb) {
                        try {
                            cb();
                        } catch (e) {
                            console.error(`[WorkerTimer] Error in fallback callback '${id}':`, e);
                        }
                    }
                }, interval),
            );
        }
    }

    /**
     * Stop a specific timer
     * @param id - Timer identifier to stop
     */
    stop(id: string): void {
        if (!browser) return;

        this.callbacks.delete(id);

        if (this.useWorker && this.worker) {
            this.worker.postMessage({ type: 'stop', id });
        }

        // Also clear fallback if exists
        if (this.fallbackTimers.has(id)) {
            const timerId = this.fallbackTimers.get(id);
            if (timerId !== undefined) {
                clearInterval(timerId);
            }
            this.fallbackTimers.delete(id);
        }
    }

    /**
     * Stop all timers
     */
    stopAll(): void {
        if (!browser) return;

        this.callbacks.clear();

        if (this.useWorker && this.worker) {
            this.worker.postMessage({ type: 'stopAll' });
        }

        // Clear all fallback timers
        this.fallbackTimers.forEach((timerId) => clearInterval(timerId));
        this.fallbackTimers.clear();
    }

    /**
     * Check if a timer is running
     */
    isRunning(id: string): boolean {
        return this.callbacks.has(id);
    }

    /**
     * Dispose the worker and all timers
     */
    dispose(): void {
        this.stopAll();

        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        if (this.workerBlobUrl) {
            URL.revokeObjectURL(this.workerBlobUrl);
            this.workerBlobUrl = null;
        }
    }

    /**
     * Migrate existing timers to fallback mode (if worker fails)
     */
    private migrateToFallback(): void {
        // We need to recreate timers using the fallback
        // But we don't have the intervals stored, so just stop everything
        // The calling code should handle worker errors gracefully
        if (this.worker) {
            this.worker.postMessage({ type: 'stopAll' });
        }
    }
}

/**
 * Create a new WorkerTimer instance
 */
export function createWorkerTimer(): WorkerTimer {
    return new WorkerTimer();
}
