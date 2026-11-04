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
//    listener that logs ONE warning per outage for connection-loss errors (an
//    outage ends once none arrived for OUTAGE_QUIET_MS) and always logs any
//    other error.
// 2. Hung close. `QueueEvents.close()` never settles while its connection is in
//    ioredis' reconnect wait: BullMQ calls `client.disconnect()` and waits for an
//    `end` event that a socket-less client never emits, so the worker's graceful
//    shutdown sat there until its 60 s deadline killed it ("cleanup outcome
//    UNKNOWN"). Queue, FlowProducer and Worker closes wait the same way.
//    `closeBullmqBounded` bounds that wait and stops the clients from
//    reconnecting.
// 3. Outage length. A `ready` (reconnect) marks when the Valkey was reachable
//    again; the recovery INFO reports first error -> first reconnect after the
//    last error. Reconnects never keep an outage open: BullMQ re-establishes
//    every Worker's and QueueEvents' blocking connection a few seconds AFTER
//    recovery, so counting those stretched a 4 s outage to 11 s and could hold
//    the INFO back for as long as reconnects kept coming.
// 4. Counting. The messages count the sources (scopes) that lost the
//    connection, not the errors: each of a worker's ~200 connections errors on
//    every reconnect attempt, so a 0.7 s restart counted 706 errors.

import { Logger } from '../utils/logger.js';

const log = Logger.for('TaskQueueConnection');

/**
 * No connection error for this long ends an outage. Above BullMQ's longest
 * reconnect delay (20 s), so one long outage is one outage, not several.
 */
export const OUTAGE_QUIET_MS = 30_000;

export interface OutageEnd {
    durationMs: number;
    /** Distinct errors: one ioredis error fanned out to N BullMQ listeners counts once. */
    errors: number;
    /** Distinct sources passed to `note` (calls without one count as one). */
    sources: number;
}

export interface OutageGate {
    /**
     * Record an error. `first` is true for the first error of an outage. Pass
     * the error object so that the same error delivered to several listeners (a
     * shared connection forwards its error to every Queue built on it) is
     * counted once, and `source` (the failing connection's scope) so that a
     * connection retrying many times counts as one source.
     */
    note(now?: number, err?: unknown, source?: string): { first: boolean };
    /**
     * Record that a connection became usable again. The first reconnect after
     * the latest error of a running outage marks its end for the reported
     * length (a client that fails in the first second and then waits out a long
     * retry delay stops erroring long before it is connected again). It never
     * extends the outage: only errors do. Ignored when no outage is running.
     */
    recovered(now?: number): void;
}

/** How often a warning repeats while one outage keeps going. */
export const OUTAGE_REMINDER_MS = 5 * 60_000;

/**
 * `onEnd` (optional) fires once no error arrived for `quietMs`.
 * `reminder` (optional) fires every `everyMs` while the outage is still going, so
 * a long one is not just a single line at its start.
 */
export function createOutageGate(
    quietMs: number = OUTAGE_QUIET_MS,
    onEnd?: (end: OutageEnd) => void,
    reminder?: { everyMs: number; onOngoing: (state: OutageEnd) => void },
): OutageGate {
    // Last error of the running outage; decides `first` and when it is over.
    let lastErrorAt = Number.NEGATIVE_INFINITY;
    // First reconnect after `lastErrorAt`, if one came yet.
    let recoveredAt: number | undefined;
    let startedAt = 0;
    let errors = 0;
    let sources = new Set<string>();
    let seen = new WeakSet<object>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reminderTimer: ReturnType<typeof setInterval> | undefined;
    const endedAt = (): number =>
        recoveredAt !== undefined && recoveredAt >= lastErrorAt ? recoveredAt : lastErrorAt;
    const stopReminder = (): void => {
        if (reminderTimer) clearInterval(reminderTimer);
        reminderTimer = undefined;
    };
    const arm = (delayMs: number): void => {
        timer = setTimeout(() => {
            timer = undefined;
            const idleMs = Date.now() - lastErrorAt;
            if (idleMs < quietMs) {
                arm(quietMs - idleMs);
                return;
            }
            stopReminder();
            onEnd?.({ durationMs: endedAt() - startedAt, errors, sources: sources.size });
        }, delayMs);
        timer.unref?.();
    };
    return {
        note(now = Date.now(), err?: unknown, source = '') {
            const first = now - lastErrorAt > quietMs;
            if (first) {
                seen = new WeakSet<object>();
                sources = new Set<string>();
            } else if (typeof err === 'object' && err !== null && seen.has(err))
                return { first: false };
            if (typeof err === 'object' && err !== null) seen.add(err);
            sources.add(source);
            lastErrorAt = now;
            if (first) {
                errors = 1;
                startedAt = now;
                recoveredAt = undefined;
                if (onEnd && !timer) arm(quietMs);
                if (reminder && !reminderTimer) {
                    reminderTimer = setInterval(() => {
                        if (Date.now() - lastErrorAt > quietMs) return stopReminder();
                        reminder.onOngoing({
                            durationMs: Date.now() - startedAt,
                            errors,
                            sources: sources.size,
                        });
                    }, reminder.everyMs);
                    reminderTimer.unref?.();
                }
                return { first: true };
            }
            errors++;
            return { first: false };
        },
        recovered(now = Date.now()) {
            if (now - lastErrorAt > quietMs || now < lastErrorAt) return;
            if (recoveredAt === undefined || recoveredAt < lastErrorAt) recoveredAt = now;
        },
    };
}

const CONNECTION_LOSS_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
]);
const CONNECTION_LOSS_MESSAGE =
    /connection is closed|connection closed|socket closed|client is closed|Unable to execute requests|getaddrinfo|^LOADING\b|^READONLY\b|^MASTERDOWN\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i;

/** True for errors that only say "the server is unreachable or restarting". */
export function isConnectionLossError(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && CONNECTION_LOSS_CODES.has(code)) return true;
    const message = err instanceof Error ? err.message : String(err);
    return CONNECTION_LOSS_MESSAGE.test(message);
}

/** Latest connection-loss error, named in the reminder so a source that keeps failing is visible. */
let lastLoss: { scope: string; err: string } | undefined;

function createProcessGate(): OutageGate {
    return createOutageGate(
        OUTAGE_QUIET_MS,
        ({ durationMs, sources }) => {
            log.info('Task Valkey connection errors stopped; assuming it is reachable again', {
                // Tenths: a `docker compose restart` of Valkey is often under a second.
                outageSeconds: Math.round(durationMs / 100) / 10,
                failedSources: sources,
            });
        },
        {
            everyMs: OUTAGE_REMINDER_MS,
            onOngoing: ({ durationMs, sources }) => {
                log.warn('Task Valkey is still unreachable', {
                    outageMinutes: Math.round(durationMs / 60_000),
                    failedSources: sources,
                    ...(lastLoss
                        ? { lastErrorScope: lastLoss.scope, lastError: lastLoss.err }
                        : {}),
                });
            },
        },
    );
}

let processGate = createProcessGate();

interface ErrorEmitter {
    on(event: 'error', listener: (err: Error) => void): unknown;
}

function isErrorEmitter(target: unknown): target is ErrorEmitter {
    return typeof (target as ErrorEmitter | null)?.on === 'function';
}

/**
 * Log a connection-loss error of the task Valkey once per outage per process,
 * whichever BullMQ object (Queue, QueueEvents, FlowProducer, Worker) it came
 * from. Returns `false` for any other error so the caller logs it as before.
 */
export function logTaskConnectionLoss(scope: string, err: unknown): boolean {
    if (!isConnectionLossError(err)) return false;
    const message = err instanceof Error ? err.message : String(err);
    const outage = processGate.note(Date.now(), err, scope);
    lastLoss = { scope, err: message };
    if (!outage.first) return true;
    log.warn(
        'Task Valkey connection error; BullMQ reconnects on its own. Further connection errors of this outage are not logged',
        { scope, err: message },
    );
    return true;
}

/** BullMQ 6: the backend re-emits `ready` whenever one of its connections is usable again. */
function watchRecovery(target: unknown): void {
    try {
        const backend = (target as { getBackend?: () => unknown }).getBackend?.();
        (backend as { on?: (event: 'ready', listener: () => void) => unknown } | undefined)?.on?.(
            'ready',
            () => processGate.recovered(),
        );
    } catch {
        // Test doubles and older BullMQ versions have no backend; the length then runs to the last error.
    }
}

/**
 * Attach the outage-aware `error` listener to a BullMQ Queue, QueueEvents or
 * FlowProducer. Connection-loss errors are logged once per outage; any other
 * error (NOAUTH, WRONGTYPE, OOM, script errors) is always logged. No-op for
 * test doubles without `.on`.
 */
export function logQueueConnectionErrors(target: unknown, scope: string): void {
    if (!isErrorEmitter(target)) return;
    target.on('error', (err: Error) => {
        if (logTaskConnectionLoss(scope, err)) return;
        log.warn('Task Valkey error', { scope, err: err?.message ?? String(err) });
    });
    watchRecovery(target);
}

/** A raw ioredis connection (the shared queue connection) is usable again. */
export function noteTaskConnectionRecovered(): void {
    processGate.recovered();
}

/**
 * For a BullMQ Worker: only follow its reconnects, so the outage length is real.
 * Its `error` events are handled by the runner, which routes connection-loss
 * errors through {@link logTaskConnectionLoss}.
 */
export function watchWorkerRecovery(worker: unknown): void {
    watchRecovery(worker);
}

/** Test hook: forget the process-wide outage state. */
export function resetQueueOutageGateForTests(): void {
    processGate = createProcessGate();
    lastLoss = undefined;
}

interface RawClient {
    disconnect(): void;
}

interface BackendInternals {
    client?: Promise<RawClient>;
    blockingClient?: Promise<RawClient> | undefined;
    /** BullMQ internals (RedisConnection); `_client` is the raw ioredis instance. */
    connection?: { _client?: RawClient };
    blockingConnection?: { _client?: RawClient };
}

interface ClosableBullmq {
    close(): Promise<void>;
    /** BullMQ 6: the datastore backend that owns the ioredis connections. */
    getBackend?(): unknown;
}

/** How long a forced close waits to obtain the raw client(s) of a stuck connection. */
const CLIENT_LOOKUP_TIMEOUT_MS = 500;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Close a BullMQ QueueEvents, Queue, FlowProducer or idle Worker without waiting
 * forever on a connection that is reconnecting. On timeout both of its ioredis
 * clients (command and blocking) are told to stop reconnecting, so the orphaned
 * connection neither retries nor keeps the event loop alive, and the close
 * counts as done. That is only right for objects that hold no lock, lease or
 * in-flight write a successor could collide with: a QueueEvents reads the event
 * stream, a Queue/FlowProducer owns no state outside Valkey, and a Worker with
 * no active job has nothing left to settle (the caller decides that). Its
 * `error` listeners stay attached on purpose; without one BullMQ would
 * console.error the next error. Rejects only when close() itself fails.
 *
 * @returns `true` when close() settled by itself, `false` when it was forced.
 */
export async function closeBullmqBounded(
    target: ClosableBullmq,
    timeoutMs: number,
    /**
     * Asked when the bound expires. Answer `false` while the object still has work
     * in flight (a Worker with a job running): its close is then awaited for as
     * long as it takes instead of being forced.
     */
    mayAbandon: () => boolean = () => true,
): Promise<boolean> {
    const qe = target;
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
    if (!mayAbandon()) {
        await closing;
        return true;
    }
    const backend = qe.getBackend?.() as BackendInternals | undefined;
    const targets: Array<[Promise<RawClient> | undefined, RawClient | undefined]> = [
        [backend?.client, backend?.connection?._client],
        [backend?.blockingClient, backend?.blockingConnection?._client],
    ];
    for (const [lookup, internal] of targets) {
        try {
            // The public promise settles only once the client is ready; a client that
            // never connected (Valkey down since start) falls back to BullMQ's own
            // handle on the raw ioredis instance. disconnect() without reconnect makes
            // ioredis clear its retry timer.
            const raw = lookup ? await withTimeout(lookup, CLIENT_LOOKUP_TIMEOUT_MS) : undefined;
            (raw ?? internal)?.disconnect();
        } catch {
            // The connection is already unusable; nothing left to stop.
        }
    }
    return false;
}

/** Former name, from when only QueueEvents needed it. */
export const closeQueueEventsBounded = closeBullmqBounded;
