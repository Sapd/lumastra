// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Behaviour of BullMQ objects while the task Valkey is down or restarting
// (`docker compose restart`, a Valkey upgrade, a node reboot).
//
// 1. Error noise. Every BullMQ Queue / QueueEvents / FlowProducer owns its own
//    ioredis connection and emits an `error` per reconnect attempt. A worker has
//    ~100 of them, so one restart produced hundreds of lines. A Queue or
//    FlowProducer without an `error` listener is worse: BullMQ then dumps the
//    raw error object with console.error. `logQueueConnectionErrors` attaches a
//    listener that logs ONE warning per outage (an outage ends once no error
//    arrived for QUIET_MS).
// 2. Hung close. `QueueEvents.close()` never settles while its connection is in
//    ioredis' reconnect wait: BullMQ calls `client.disconnect()` and waits for an
//    `end` event that a socket-less client never emits, so the worker's graceful
//    shutdown sat there until its 60 s deadline killed it ("cleanup outcome
//    UNKNOWN"). `closeQueueEventsBounded` bounds that wait.

import { Logger } from '../utils/logger.js';

const log = Logger.for('TaskQueueConnection');

/** No error for this long ends an outage; the next error starts a new one. */
export const OUTAGE_QUIET_MS = 15_000;

export interface OutageGate {
    /**
     * Record an error. `first` is true for the first error of an outage;
     * `suppressed` is how many errors the previous outage swallowed (only
     * meaningful when `first`).
     */
    note(now?: number): { first: boolean; suppressed: number };
}

export function createOutageGate(quietMs: number = OUTAGE_QUIET_MS): OutageGate {
    let lastAt = Number.NEGATIVE_INFINITY;
    let suppressed = 0;
    return {
        note(now = Date.now()) {
            const first = now - lastAt > quietMs;
            const previouslySuppressed = suppressed;
            lastAt = now;
            if (first) {
                suppressed = 0;
                return { first: true, suppressed: previouslySuppressed };
            }
            suppressed++;
            return { first: false, suppressed: 0 };
        },
    };
}

const processGate = createOutageGate();

interface ErrorEmitter {
    on(event: 'error', listener: (err: Error) => void): unknown;
}

function isErrorEmitter(target: unknown): target is ErrorEmitter {
    return typeof (target as ErrorEmitter | null)?.on === 'function';
}

/**
 * Attach the outage-aware `error` listener to a BullMQ Queue, QueueEvents or
 * FlowProducer. No-op for test doubles without `.on`.
 */
export function logQueueConnectionErrors(target: unknown, scope: string): void {
    if (!isErrorEmitter(target)) return;
    target.on('error', (err: Error) => {
        const outage = processGate.note();
        if (!outage.first) return;
        log.warn(
            'Task Valkey connection error; BullMQ reconnects on its own. Further errors of this outage are not logged',
            {
                scope,
                err: err?.message ?? String(err),
                ...(outage.suppressed > 0 ? { suppressedInPreviousOutage: outage.suppressed } : {}),
            },
        );
    });
}

/** Test hook: forget the process-wide outage state. */
export function resetQueueOutageGateForTests(): void {
    processGate.note(Number.NEGATIVE_INFINITY);
}

interface ClosableQueueEvents {
    close(): Promise<void>;
    client?: Promise<{ disconnect(): void }>;
}

/**
 * Close a QueueEvents without waiting forever on a connection that is
 * reconnecting. On timeout the client is told to stop reconnecting (so the
 * orphaned connection retries no more) and the close counts as done: a
 * QueueEvents only reads the event stream, it holds no lock, lease or write
 * that a successor could collide with. Rejects only when close() itself fails.
 *
 * @returns `true` when close() settled by itself, `false` when it was forced.
 */
export async function closeQueueEventsBounded(
    qe: ClosableQueueEvents,
    timeoutMs: number,
): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closing = qe.close();
    // The abandoned close must not surface as an unhandled rejection later.
    closing.catch(() => undefined);
    const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
        const outcome = await Promise.race([closing.then(() => 'closed' as const), timedOut]);
        if (outcome === 'closed') return true;
    } finally {
        clearTimeout(timer);
    }
    try {
        // Stops ioredis' reconnect timer; BullMQ's own close never gets that far.
        (await qe.client)?.disconnect();
    } catch {
        // The connection is already unusable; nothing left to stop.
    }
    return false;
}
