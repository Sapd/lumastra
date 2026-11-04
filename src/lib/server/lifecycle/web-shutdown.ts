// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Graceful shutdown of the web process (SIGTERM/SIGINT).
 *
 * Order, and why:
 *  1. `draining`: readiness answers 503 and every NEW request answers
 *     503 shutting_down + Retry-After (never 500). Open event streams end, so
 *     clients reconnect elsewhere. adapter-node's own SIGTERM listener stops
 *     accepting connections and closes idle keep-alive sockets.
 *  2. Wait until in-flight requests finish: adapter-node emits
 *     `sveltekit:shutdown` once its HTTP server has closed every connection
 *     (it force-closes them after SHUTDOWN_TIMEOUT). Bounded by `drainTimeoutMs`.
 *  3. `closing`: stop services (task producer, transcode jobs, telemetry flush,
 *     advisory locks, ...). Before this fix these ran FIRST, so a play-session
 *     request still in flight hit "Service is shutting down" and returned 500.
 *  4. Close pools (Valkey, PostgreSQL, undici) last, then exit.
 *
 * In Kubernetes a preStop sleep runs before SIGTERM, so the router has already
 * stopped sending new requests here; the 503 gate covers the stragglers (an
 * nginx keep-alive connection, a client without the router in front).
 */

import { flushProviderCallsForShutdown } from '../utils/provider-calls.js';
import { flushRequestPathCalls } from '../utils/external-request-stats.js';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { problem } from '$lib/server/api/problem.js';

export type WebShutdownPhase = 'serving' | 'draining' | 'closing';

/** Seconds a client waits before retrying; the router sends the retry to another pod. */
export const SHUTDOWN_RETRY_AFTER_SECONDS = 2;

let phase: WebShutdownPhase = 'serving';
let inFlight = 0;
const idleWaiters = new Set<() => void>();
/** Aborted when the drain starts; open event streams end on it. */
let drainController = new AbortController();

export function getWebShutdownPhase(): WebShutdownPhase {
    return phase;
}

export function isShuttingDown(): boolean {
    return phase !== 'serving';
}

/** Requests the handle is still working on (until their Response is returned). */
export function inFlightRequestCount(): number {
    return inFlight;
}

function trackRequest(): () => void {
    inFlight++;
    let done = false;
    return () => {
        if (done) return;
        done = true;
        inFlight--;
        if (inFlight === 0) {
            for (const wake of idleWaiters) wake();
            idleWaiters.clear();
        }
    };
}

function waitForNoRequestsInFlight(): Promise<void> {
    if (inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
}

/**
 * The 503 every request gets once shutdown has begun. `Connection: close` makes
 * Node close the socket after the response, so nginx drops its keep-alive
 * connection to this pod instead of sending the next request down it.
 */
export function shuttingDownResponse(): Response {
    return problem('shutting_down', {
        retryAfter: SHUTDOWN_RETRY_AFTER_SECONDS,
        headers: { Connection: 'close', 'Cache-Control': 'no-store' },
    });
}

/**
 * Event streams (SSE) stay open as long as a page is, so they would hold every
 * drain to its timeout. End them when the drain starts instead: EventSource
 * reconnects on its own, through the router, to a pod that is not stopping.
 * Cancelling the source runs the route's own cancel() cleanup.
 */
function endOnDrain(response: Response): Response {
    const source = response.body;
    if (!source) return response;
    const reader = source.getReader();
    const signal = drainController.signal;
    let onDrain: (() => void) | undefined;
    const detach = (): void => {
        if (onDrain) signal.removeEventListener('abort', onDrain);
        onDrain = undefined;
    };
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            onDrain = () => {
                detach();
                void reader.cancel('server shutting down').catch(() => undefined);
                try {
                    controller.close();
                } catch {
                    // already closed or errored
                }
            };
            if (signal.aborted) onDrain();
            else signal.addEventListener('abort', onDrain, { once: true });
        },
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    detach();
                    controller.close();
                } else {
                    controller.enqueue(value);
                }
            } catch (error) {
                detach();
                try {
                    controller.error(error);
                } catch {
                    // closed by the drain meanwhile
                }
            }
        },
        cancel(reason) {
            detach();
            return reader.cancel(reason);
        },
    });
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

function isEventStream(response: Response): boolean {
    return (response.headers.get('content-type') ?? '')
        .toLowerCase()
        .startsWith('text/event-stream');
}

/**
 * The kubelet/Docker probes keep their own answers: liveness stays 200,
 * readiness turns 503 itself. Exactly these two: the other /api/health/*
 * routes read the database and are refused like any other request.
 */
function isHealthProbe(pathname: string): boolean {
    return pathname === '/api/health' || pathname === '/api/health/ready';
}

/**
 * Outer handle: refuses new work once shutdown began and counts the requests
 * still in flight. A 5xx produced once the services stopped (`closing`: the
 * drain timed out with this request still running) is answered as 503
 * shutting_down, which clients retry. While `draining` every service still
 * runs, so a 5xx then is a real error and passes unchanged: turning it into
 * a retry could repeat a POST whose work already committed.
 */
export function createShutdownGateHandle(options: {
    onRewrittenError?: (status: number, pathname: string, error?: unknown) => void;
    /** Adds headers the refusal needs on this request (the CORS grant). */
    decorate?: (event: RequestEvent, headers: Headers) => void;
}): Handle {
    const refuse = (event: RequestEvent): Response => {
        const response = shuttingDownResponse();
        options.decorate?.(event, response.headers);
        return response;
    };
    return async ({ event, resolve }) => {
        const probe = isHealthProbe(event.url.pathname);
        if (phase !== 'serving' && !probe) return refuse(event);
        const done = trackRequest();
        try {
            const response = await resolve(event);
            if (
                phase === 'closing' &&
                !probe &&
                response.status >= 500 &&
                response.status !== 503
            ) {
                options.onRewrittenError?.(response.status, event.url.pathname);
                await response.body?.cancel().catch(() => undefined);
                return refuse(event);
            }
            return isEventStream(response) ? endOnDrain(response) : response;
        } catch (error) {
            if (phase === 'closing' && !probe) {
                options.onRewrittenError?.(500, event.url.pathname, error);
                return refuse(event);
            }
            throw error;
        } finally {
            done();
        }
    };
}

/** The servers a shutdown step can wait for. The cache Valkey is optional and never decides. */
export type ShutdownDependency = 'postgres' | 'task-valkey' | 'cache-valkey';

export interface ShutdownStep {
    name: string;
    run: () => Promise<unknown> | unknown;
    /**
     * Which servers the step needs (default PostgreSQL and the task Valkey). Only
     * one of THESE being gone can make shutdown give up on the step: the cache
     * Valkey stopping on its own says nothing about a database flush.
     */
    needs?: ShutdownDependency[];
    /**
     * How long the step runs before shutdown asks whether a server it needs is
     * gone (default {@link DEFAULT_STEP_TIMEOUT_MS}). A step that is merely slow is
     * never cut short for that: it is only abandoned when the server is confirmed gone.
     */
    timeoutMs?: number;
    /**
     * Hard limit for the step itself (default {@link DEFAULT_STEP_MAX_MS}), for a step
     * stuck on its own bug with every server answering. It is also capped so the pool
     * closures keep their reserve of the cleanup deadline. Pools are not capped.
     */
    maxMs?: number;
    /** Keep `timeoutMs` as the budget even after a server was found gone (pool closure). */
    keepBudgetWhenGone?: boolean;
    /** The step bounds itself against the cleanup deadline (it reserves the pools' share); no cap here. */
    selfBounded?: boolean;
}

/**
 * Every step talks to PostgreSQL or Valkey, and a `docker compose restart` stops
 * those together with the web container: a step then waits for a server that is
 * gone, and the whole shutdown sat there until Docker's SIGKILL (exit 137). After
 * this long a running step triggers the "is the server gone?" question.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 3_000;
/** Check interval for a step that needs a server which was gone a moment ago. */
export const GONE_STEP_TIMEOUT_MS = 800;
/** Longest any one step may run while its servers answer. */
export const DEFAULT_STEP_MAX_MS = 10_000;
/** Part of the cleanup deadline kept back for the pool closures. */
export const POOL_RESERVE_MS = 6_000;
const DEFAULT_NEEDS: ShutdownDependency[] = ['postgres', 'task-valkey'];

export interface ShutdownLogger {
    info: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, error: Error) => void;
}

export interface WebShutdownOptions {
    /**
     * Resolves once the HTTP server closed every connection (adapter-node emits
     * `sveltekit:shutdown`). Omit where nothing owns a server (vite dev): only
     * the in-flight request count is waited for then.
     */
    waitForHttpServerClosed?: () => Promise<void>;
    /** Upper bound on step 2; cleanup starts when it expires. */
    drainTimeoutMs: number;
    /** Services, in order. Each runs even when an earlier one failed. */
    services: ShutdownStep[];
    /** Pools and clients, closed after every service step. */
    pools: ShutdownStep[];
    exit: (code: number) => void;
    log: ShutdownLogger;
    /** Exit(1) when cleanup hangs this long after the drain. Default 25 s. */
    cleanupDeadlineMs?: number;
    /**
     * Which of the named servers are confirmed gone right now (the network refused
     * the connection), not merely slow. Asked again at every check, never remembered.
     * Without it no step is abandoned for a gone server; `maxMs` and the cleanup
     * deadline are the only limits.
     */
    goneDependencies?: (needs: ShutdownDependency[]) => Promise<ShutdownDependency[]>;
}

/** Returns the signal handler. Repeated signals share the first shutdown. */
export function createWebShutdown(options: WebShutdownOptions): (signal: string) => Promise<void> {
    let shutdown: Promise<void> | undefined;
    return (signal) => {
        if (shutdown) return shutdown;
        phase = 'draining';
        drainController.abort();
        // Subscribe synchronously: adapter-node's listener for the same signal
        // runs right after this one and may finish closing quickly.
        const httpClosed = options.waitForHttpServerClosed?.();
        shutdown = run(signal, httpClosed);
        return shutdown;
    };

    async function run(signal: string, httpClosed: Promise<void> | undefined): Promise<void> {
        const { log } = options;
        const startedAt = Date.now();
        log.info('Shutdown: draining HTTP requests', {
            signal,
            inFlight,
            drainTimeoutMs: options.drainTimeoutMs,
        });

        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<'timeout'>((resolve) => {
            drainTimer = setTimeout(() => resolve('timeout'), options.drainTimeoutMs);
        });
        const drained = Promise.all([httpClosed, waitForNoRequestsInFlight()]).then(
            () => 'drained' as const,
        );
        const outcome = await Promise.race([drained, timedOut]);
        clearTimeout(drainTimer);
        if (outcome === 'timeout') {
            log.warn('Shutdown: drain timed out; stopping services with requests open', {
                inFlight,
            });
        } else {
            log.info('Shutdown: HTTP drained', { ms: Date.now() - startedAt });
        }

        phase = 'closing';
        const cleanupMs = options.cleanupDeadlineMs ?? 25_000;
        const cleanupDeadlineAt = Date.now() + cleanupMs;
        const deadline = setTimeout(() => {
            log.error(
                'Shutdown: cleanup deadline exceeded; exiting with cleanup incomplete',
                new Error('web shutdown deadline exceeded'),
            );
            options.exit(1);
        }, cleanupMs);

        let failed = false;
        // Servers found gone at a check, remembered only to shorten the next check of a
        // step that needs them. Every timeout asks again, so a server that came back,
        // or one that never was gone, stops counting at once.
        const recentlyGone = new Set<ShutdownDependency>();
        const poolReserveMs = Math.min(POOL_RESERVE_MS, cleanupMs / 3);
        for (const step of [
            ...options.services,
            { name: 'external request stats', selfBounded: true, run: flushRequestPathCalls },
            {
                name: 'provider call counters',
                selfBounded: true,
                // Reserve at least half the remaining cleanup budget for pool shutdown.
                run: () => flushProviderCallsForShutdown((cleanupDeadlineAt - Date.now()) / 2),
            },
            ...options.pools,
        ] as ShutdownStep[]) {
            const needs = step.needs ?? DEFAULT_NEEDS;
            const isPool = options.pools.includes(step) || step.selfBounded === true;
            const remainingMs = cleanupDeadlineAt - Date.now();
            const capMs = Math.max(
                0,
                isPool
                    ? remainingMs
                    : Math.min(step.maxMs ?? DEFAULT_STEP_MAX_MS, remainingMs - poolReserveMs),
            );
            const capAt = Date.now() + capMs;
            let stepTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                const running = Promise.resolve().then(() => step.run());
                // An abandoned step may still reject later; that must stay silent.
                running.catch(() => undefined);
                for (;;) {
                    const checkMs = Math.min(
                        needs.some((n) => recentlyGone.has(n)) && !step.keepBudgetWhenGone
                            ? Math.min(GONE_STEP_TIMEOUT_MS, step.timeoutMs ?? GONE_STEP_TIMEOUT_MS)
                            : (step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS),
                        Math.max(0, capAt - Date.now()),
                    );
                    const outcome = await Promise.race([
                        running.then(() => 'done' as const),
                        new Promise<'timeout'>((resolve) => {
                            stepTimer = setTimeout(() => resolve('timeout'), checkMs);
                        }),
                    ]);
                    clearTimeout(stepTimer);
                    if (outcome === 'done') break;
                    // Slow is not gone. Later steps are ordered after this one (flushes
                    // before pools), so shutdown moves on while it still runs only when a
                    // server it needs is confirmed gone, or the step outlived its own limit.
                    const gone = (await options.goneDependencies?.(needs).catch(() => [])) ?? [];
                    for (const n of needs) recentlyGone.delete(n);
                    if (gone.length > 0) {
                        for (const n of gone) recentlyGone.add(n);
                        failed = true;
                        log.warn(
                            `Shutdown: ${step.name} still running with ${gone.join(', ')} gone; moving on`,
                        );
                        break;
                    }
                    if (Date.now() >= capAt) {
                        failed = true;
                        log.warn(
                            `Shutdown: ${step.name} still running after ${capMs} ms with its servers answering; moving on`,
                        );
                        break;
                    }
                }
            } catch (error) {
                failed = true;
                log.warn(`Shutdown: ${step.name} failed`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            } finally {
                clearTimeout(stepTimer);
            }
        }
        clearTimeout(deadline);
        log.info('Shutdown: cleanup completed, exiting', {
            ms: Date.now() - startedAt,
            clean: !failed,
        });
        // A failed release step is logged; the exit status stays 0 like before,
        // because Kubernetes treats every web exit after SIGTERM the same.
        options.exit(0);
    }
}

/**
 * Drain when SHUTDOWN_TIMEOUT is unset (Docker): leaves most of Docker's
 * default 10 s stop timeout for persisting transcodes and closing pools.
 */
export const DEFAULT_DRAIN_MS = 3_000;

/**
 * Drain budget. With SHUTDOWN_TIMEOUT set (the Helm chart sets it from
 * web.drainSeconds), adapter-node force-closes connections after that many
 * seconds and then emits `sveltekit:shutdown`; wait slightly longer so its own
 * close normally ends the drain. Unset (Docker), adapter-node would wait 30 s,
 * past Docker's SIGKILL, so the services stop after DEFAULT_DRAIN_MS instead.
 */
export function drainTimeoutMsFromEnv(env: Record<string, string | undefined>): number {
    const raw = env.SHUTDOWN_TIMEOUT?.trim() ?? '';
    if (!/^\d+$/.test(raw)) return DEFAULT_DRAIN_MS;
    return (Number(raw) + 2) * 1000;
}

/** Test seam: the phase and counters are module state. */
export function _resetWebShutdownForTests(): void {
    phase = 'serving';
    inFlight = 0;
    idleWaiters.clear();
    drainController = new AbortController();
}
