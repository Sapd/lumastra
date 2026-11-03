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
//    UNKNOWN"). `closeQueueEventsBounded` bounds that wait and stops the clients
//    from reconnecting.

import { Logger } from '../utils/logger.js';

const log = Logger.for('TaskQueueConnection');

/**
 * No connection error for this long ends an outage. Above BullMQ's longest
 * reconnect delay (20 s), so one long outage is one outage, not several.
 */
export const OUTAGE_QUIET_MS = 30_000;

export interface OutageEnd {
    durationMs: number;
    errors: number;
}

export interface OutageGate {
    /**
     * Record an error. `first` is true for the first error of an outage;
     * `suppressed` is how many errors the previous outage swallowed (only
     * meaningful when `first`).
     */
    note(now?: number): { first: boolean; suppressed: number };
}

/** `onEnd` (optional) fires once an outage has been quiet for `quietMs`. */
export function createOutageGate(
    quietMs: number = OUTAGE_QUIET_MS,
    onEnd?: (end: OutageEnd) => void,
): OutageGate {
    let lastAt = Number.NEGATIVE_INFINITY;
    let startedAt = 0;
    let errors = 0;
    let suppressed = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (delayMs: number): void => {
        timer = setTimeout(() => {
            timer = undefined;
            const idleMs = Date.now() - lastAt;
            if (idleMs < quietMs) {
                arm(quietMs - idleMs);
                return;
            }
            onEnd?.({ durationMs: lastAt - startedAt, errors });
        }, delayMs);
        timer.unref?.();
    };
    return {
        note(now = Date.now()) {
            const first = now - lastAt > quietMs;
            const previouslySuppressed = suppressed;
            lastAt = now;
            if (first) {
                suppressed = 0;
                errors = 1;
                startedAt = now;
                if (onEnd && !timer) arm(quietMs);
                return { first: true, suppressed: previouslySuppressed };
            }
            errors++;
            suppressed++;
            return { first: false, suppressed: 0 };
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
    /connection is closed|connection closed|socket closed|getaddrinfo|^LOADING\b|^READONLY\b|^MASTERDOWN\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i;

/** True for errors that only say "the server is unreachable or restarting". */
export function isConnectionLossError(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && CONNECTION_LOSS_CODES.has(code)) return true;
    const message = err instanceof Error ? err.message : String(err);
    return CONNECTION_LOSS_MESSAGE.test(message);
}

const processGate = createOutageGate(OUTAGE_QUIET_MS, ({ durationMs, errors }) => {
    log.info('Task Valkey connection errors stopped; assuming it is reachable again', {
        outageSeconds: Math.round(durationMs / 1000),
        errors,
    });
});

interface ErrorEmitter {
    on(event: 'error', listener: (err: Error) => void): unknown;
}

function isErrorEmitter(target: unknown): target is ErrorEmitter {
    return typeof (target as ErrorEmitter | null)?.on === 'function';
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
        const message = err?.message ?? String(err);
        if (!isConnectionLossError(err)) {
            log.warn('Task Valkey error', { scope, err: message });
            return;
        }
        const outage = processGate.note();
        if (!outage.first) return;
        log.warn(
            'Task Valkey connection error; BullMQ reconnects on its own. Further connection errors of this outage are not logged',
            {
                scope,
                err: message,
                ...(outage.suppressed > 0 ? { suppressedInPreviousOutage: outage.suppressed } : {}),
            },
        );
    });
}

/** Test hook: forget the process-wide outage state. */
export function resetQueueOutageGateForTests(): void {
    processGate.note(Number.NEGATIVE_INFINITY);
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

interface ClosableQueueEvents {
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
 * Close a QueueEvents without waiting forever on a connection that is
 * reconnecting. On timeout both of its ioredis clients (command and blocking)
 * are told to stop reconnecting, so the orphaned connection neither retries nor
 * keeps the event loop alive, and the close counts as done: a QueueEvents only
 * reads the event stream, it holds no lock, lease or write that a successor
 * could collide with. Its `error` listeners stay attached on purpose; without
 * one BullMQ would console.error the next error. Rejects only when close()
 * itself fails.
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
