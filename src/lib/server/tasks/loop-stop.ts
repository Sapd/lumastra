// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Shared shutdown wait for the interval-driven background loops (reconciler,
// pending-write drain, webhook and push outboxes). Clearing an interval only
// stops FUTURE ticks; a tick already running keeps delivering or draining. The
// orchestrator must not release the coordinator lock while one is still in
// flight, or a successor instance overlaps it (duplicate delivery, two drains).

import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('TaskLoopStop');

/** Upper bound a loop's stop() waits for its in-flight tick. */
export const LOOP_STOP_TIMEOUT_MS = 30_000;

/**
 * Wait for `tick` (the loop's in-flight tick, or null when idle) to settle, at
 * most `timeoutMs`. Resolves true when nothing is left running, false when the
 * wait timed out (logged). Never rejects: a failing tick is the loop's own
 * concern and is already logged by it.
 */
export async function awaitInFlightTick(
    loop: string,
    tick: Promise<unknown> | null,
    timeoutMs: number = LOOP_STOP_TIMEOUT_MS,
): Promise<boolean> {
    if (!tick) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
        const settled = await Promise.race([
            tick.then(
                () => true as const,
                () => true as const,
            ),
            timedOut,
        ]);
        if (!settled)
            log.warn('Background loop tick still running after stop timeout', {
                loop,
                timeoutMs,
            });
        return settled;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Settle with `promise`, or reject with an `UNKNOWN: <label> timed out` error
 * after `timeoutMs`. For requests on a connection that may be hung: a server
 * statement timeout does not end a client wait on a dead socket. The original
 * promise keeps running; its outcome is unknown to the caller.
 */
export async function raceTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`UNKNOWN: ${label} timed out after ${timeoutMs} ms`)),
            timeoutMs,
        );
    });
    try {
        return await Promise.race([promise, timedOut]);
    } finally {
        clearTimeout(timer);
    }
}
