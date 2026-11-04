// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shutdown sequence of the web process against a real HTTP server.
 *
 * `serve()` stands in for adapter-node: it runs requests through the gate
 * handle and, on the signal, does what adapter-node's graceful_shutdown does
 * (close idle connections, server.close(), emit `sveltekit:shutdown` once every
 * connection closed). Prod incident 2026-10-21: services stopped before
 * in-flight play-session requests finished, which answered 500.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter, once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    _resetWebShutdownForTests,
    createShutdownGateHandle,
    createWebShutdown,
    drainTimeoutMsFromEnv,
    getWebShutdownPhase,
    SHUTDOWN_RETRY_AFTER_SECONDS,
    type WebShutdownOptions,
} from './web-shutdown.js';

type Route = (url: URL) => Promise<Response>;

interface Harness {
    url: string;
    order: string[];
    /** Our handler first, then the adapter's — the registration order in prod. */
    signal: () => Promise<void>;
    /** The signal handler alone, without the adapter emulation. */
    handler: (signal: string) => Promise<void>;
    exited: Promise<number>;
    close: () => Promise<void>;
}

const open: Harness[] = [];

afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
    _resetWebShutdownForTests();
});

async function serve(
    route: Route,
    opts: {
        adapter: boolean;
        drainTimeoutMs?: number;
        services?: WebShutdownOptions['services'];
        pools?: WebShutdownOptions['pools'];
        isDependencyGone?: WebShutdownOptions['isDependencyGone'];
    },
): Promise<Harness> {
    const order: string[] = [];
    const bus = new EventEmitter();
    const gate = createShutdownGateHandle({
        onRewrittenError: (status) => order.push(`rewrote ${status}`),
    });
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://test');
        void Promise.resolve(
            gate({
                event: { url },
                resolve: () => route(url),
            } as unknown as Parameters<typeof gate>[0]),
        ).then(async (response: Response) => {
            // Stream like adapter-node's setResponse: event streams never end on their own.
            res.writeHead(response.status, Object.fromEntries(response.headers));
            if (response.body) {
                const reader = response.body.getReader();
                res.on('close', () => void reader.cancel().catch(() => undefined));
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(value);
                }
            }
            res.end();
        });
        req.on('close', () => {
            if (closing) server.closeIdleConnections();
        });
    });
    let closing = false;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let exit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => (exit = resolve));
    const handler = createWebShutdown({
        waitForHttpServerClosed: opts.adapter
            ? () => once(bus, 'sveltekit:shutdown').then(() => undefined)
            : undefined,
        drainTimeoutMs: opts.drainTimeoutMs ?? 5_000,
        services: opts.services ?? [{ name: 'transcode', run: () => order.push('services') }],
        pools: opts.pools ?? [
            { name: 'valkey', run: () => order.push('valkey closed') },
            { name: 'db', run: () => order.push('db closed') },
        ],
        isDependencyGone: opts.isDependencyGone,
        exit: (code) => {
            order.push(`exit ${code}`);
            exit(code);
        },
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        cleanupDeadlineMs: 2_000,
    });
    const harness: Harness = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        order,
        exited,
        handler,
        signal: () => {
            const shutdown = handler('SIGTERM');
            if (opts.adapter) {
                closing = true;
                server.closeIdleConnections();
                server.close(() => bus.emit('sveltekit:shutdown', 'SIGTERM'));
            }
            return shutdown;
        },
        close: async () => {
            server.closeAllConnections();
            if (server.listening) await new Promise((r) => server.close(r));
        },
    };
    open.push(harness);
    return harness;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

/** Plain GET/POST on its own connection (agent: false), so keep-alive never hides a refusal. */
function request(
    url: string,
    method = 'GET',
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method, agent: false }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (body += chunk));
            res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
            );
        });
        req.on('error', reject);
        req.end(method === 'GET' ? undefined : '{}');
    });
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('web shutdown sequence (adapter-node close)', () => {
    it('lets a request in flight at SIGTERM finish, refuses new connections, closes pools last', async () => {
        const release = deferred();
        const entered = deferred();
        const h = await serve(
            async (url) => {
                if (url.pathname === '/api/play-sessions') {
                    entered.resolve();
                    await release.promise;
                    h.order.push('request finished');
                    return new Response('{"id":"s1"}', { status: 201 });
                }
                return new Response('ok');
            },
            { adapter: true },
        );

        const inFlight = request(`${h.url}/api/play-sessions`, 'POST');
        await entered.promise;
        void h.signal();
        await tick();

        expect(getWebShutdownPhase()).toBe('draining');
        // Nothing is stopped while the request is still running.
        expect(h.order).toEqual([]);
        // The listener is closed: a new connection is refused.
        await expect(request(`${h.url}/api/play-sessions/s1`, 'PUT')).rejects.toMatchObject({
            code: 'ECONNREFUSED',
        });

        release.resolve();
        const answer = await inFlight;
        expect(answer.status).toBe(201);
        expect(await h.exited).toBe(0);
        expect(h.order).toEqual([
            'request finished',
            'services',
            'valkey closed',
            'db closed',
            'exit 0',
        ]);
    });

    it('ends an open event stream when the drain starts, so the drain does not wait for it', async () => {
        const h = await serve(
            async () => {
                const encoder = new TextEncoder();
                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode(': connected\n\n'));
                    },
                    cancel() {
                        h.order.push('route stream cancelled');
                    },
                });
                return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
            },
            { adapter: true, drainTimeoutMs: 10_000 },
        );
        const ended = new Promise<string>((resolve, reject) => {
            http.get(`${h.url}/api/events`, { agent: false }, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                    if (body.includes('connected')) void h.signal();
                });
                res.on('end', () => resolve(body));
            }).on('error', reject);
        });
        expect(await ended).toBe(': connected\n\n');
        const started = Date.now();
        expect(await h.exited).toBe(0);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(h.order).toEqual([
            'route stream cancelled',
            'services',
            'valkey closed',
            'db closed',
            'exit 0',
        ]);
    });

    it('a repeated signal shares the first shutdown', async () => {
        const h = await serve(async () => new Response('ok'), { adapter: true });
        const first = h.signal();
        const second = h.handler('SIGINT');
        expect(second).toBe(first);
        await Promise.all([first, second]);
        expect(h.order).toEqual(['services', 'valkey closed', 'db closed', 'exit 0']);
    });

    it('passes event-stream chunks through while serving, and a client disconnect cancels the route stream', async () => {
        const encoder = new TextEncoder();
        const cancelled = deferred();
        const h = await serve(
            async () => {
                let n = 0;
                const stream = new ReadableStream<Uint8Array>({
                    pull(controller) {
                        n++;
                        if (n <= 3) controller.enqueue(encoder.encode(`data: ${n}\n\n`));
                        // after three frames the stream stays open, like a real SSE route
                        return n <= 3 ? undefined : new Promise(() => undefined);
                    },
                    cancel() {
                        cancelled.resolve();
                    },
                });
                return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
            },
            { adapter: true },
        );
        const received = await new Promise<string>((resolve, reject) => {
            const req = http.get(`${h.url}/api/events`, { agent: false }, (res) => {
                expect(res.headers['content-type']).toBe('text/event-stream');
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                    if (body.includes('data: 3')) {
                        resolve(body);
                        req.destroy();
                    }
                });
            });
            req.on('error', () => undefined);
            setTimeout(() => reject(new Error('no frames')), 2_000);
        });
        expect(received).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n');
        // The harness, like adapter-node, cancels the body when the socket closes.
        await cancelled.promise;
        expect(getWebShutdownPhase()).toBe('serving');
    });
});

describe('web shutdown sequence (no adapter close: vite dev, a straggler connection)', () => {
    it('answers a new request during the drain with 503 shutting_down + Retry-After', async () => {
        const release = deferred();
        const entered = deferred();
        const h = await serve(
            async (url) => {
                if (url.pathname === '/slow') {
                    entered.resolve();
                    await release.promise;
                    return new Response('slow done');
                }
                return new Response('should not run', { status: 200 });
            },
            { adapter: false },
        );

        const inFlight = request(`${h.url}/slow`);
        await entered.promise;
        void h.signal();

        const late = await request(`${h.url}/api/play-sessions`, 'POST');
        expect(late.status).toBe(503);
        expect(late.headers['retry-after']).toBe(String(SHUTDOWN_RETRY_AFTER_SECONDS));
        expect(late.headers['content-type']).toContain('application/problem+json');
        expect(late.headers.connection).toBe('close');
        expect(JSON.parse(late.body)).toMatchObject({
            code: 'shutting_down',
            status: 503,
            retryAfter: SHUTDOWN_RETRY_AFTER_SECONDS,
        });

        // Liveness keeps answering from the route.
        expect((await request(`${h.url}/api/health`)).body).toBe('should not run');

        expect(h.order).toEqual([]);
        release.resolve();
        expect((await inFlight).body).toBe('slow done');
        expect(await h.exited).toBe(0);
        expect(h.order).toEqual(['services', 'valkey closed', 'db closed', 'exit 0']);
    });

    it('drain timeout: cleanup starts anyway, and a request failing because services stopped answers 503, not 500', async () => {
        const stuck = deferred();
        const entered = deferred();
        let servicesStopped = false;
        const h = await serve(
            async () => {
                entered.resolve();
                await stuck.promise;
                // What ffmpeg-transcode.service did on prod: it already shut down.
                if (servicesStopped)
                    return new Response('Service is shutting down', { status: 500 });
                return new Response('ok');
            },
            {
                adapter: false,
                drainTimeoutMs: 50,
                services: [
                    {
                        name: 'transcode',
                        run: () => {
                            servicesStopped = true;
                            stuck.resolve();
                        },
                    },
                ],
            },
        );

        const inFlight = request(`${h.url}/api/play-sessions/s1`, 'PUT');
        await entered.promise;
        await h.signal();

        const answer = await inFlight;
        expect(answer.status).toBe(503);
        expect(JSON.parse(answer.body)).toMatchObject({ code: 'shutting_down' });
        expect(h.order).toContain('rewrote 500');
        expect(h.order.at(-1)).toBe('exit 0');
    });

    it('while draining (services still up) a 500 is a real error and passes unchanged; only the two probes bypass the gate', async () => {
        const release = deferred();
        const entered = deferred();
        const h = await serve(
            async (url) => {
                if (url.pathname === '/api/play-sessions') {
                    entered.resolve();
                    await release.promise;
                    return new Response('bug', { status: 500 });
                }
                return new Response(`route ${url.pathname}`);
            },
            { adapter: false },
        );
        const inFlight = request(`${h.url}/api/play-sessions`, 'POST');
        await entered.promise;
        void h.signal();
        expect((await request(`${h.url}/api/health/ready`)).body).toBe('route /api/health/ready');
        expect((await request(`${h.url}/api/health/config`)).status).toBe(503);
        release.resolve();
        const answer = await inFlight;
        expect(answer.status).toBe(500);
        expect(h.order).not.toContain('rewrote 500');
        await h.exited;
    });

    it('a failing service step still closes the pools', async () => {
        const h = await serve(async () => new Response('ok'), {
            adapter: false,
            services: [
                {
                    name: 'broken',
                    run: () => {
                        throw new Error('boom');
                    },
                },
            ],
        });
        await h.signal();
        expect(h.order).toEqual(['valkey closed', 'db closed', 'exit 0']);
    });
});

describe('web shutdown step bounds', () => {
    it('abandons steps that wait for a server confirmed gone, still closes the pools, exits 0', async () => {
        const h = await serve(async () => new Response('ok'), {
            adapter: false,
            isDependencyGone: async () => true,
            services: [
                { name: 'hung db flush', timeoutMs: 100, run: () => new Promise(() => undefined) },
                {
                    name: 'second hung step',
                    timeoutMs: 100,
                    run: () => new Promise(() => undefined),
                },
                { name: 'quick', run: () => h.order.push('quick ran') },
            ],
        });
        const startedAt = Date.now();
        void h.signal();
        await expect(h.exited).resolves.toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(1_500);
        expect(h.order).toEqual(['quick ran', 'valkey closed', 'db closed', 'exit 0']);
    });

    it('never cuts a slow step short while its server answers, and keeps the documented order', async () => {
        const probe = vi.fn(async () => false);
        const h = await serve(async () => new Response('ok'), {
            adapter: false,
            isDependencyGone: probe,
            services: [
                {
                    name: 'slow but healthy flush',
                    timeoutMs: 50,
                    run: async () => {
                        await tick(400);
                        h.order.push('flush finished');
                    },
                },
                { name: 'later flush', timeoutMs: 50, run: () => h.order.push('later flush') },
            ],
        });
        void h.signal();
        await expect(h.exited).resolves.toBe(0);
        // The pools close after every flush finished, not while one still runs.
        expect(h.order).toEqual([
            'flush finished',
            'later flush',
            'valkey closed',
            'db closed',
            'exit 0',
        ]);
        expect(probe).toHaveBeenCalled();
    });

    it('does not shorten a pool closure that needs its own time after another server went away', async () => {
        const h = await serve(async () => new Response('ok'), {
            adapter: false,
            isDependencyGone: async () => true,
            services: [
                { name: 'hung flush', timeoutMs: 50, run: () => new Promise(() => undefined) },
            ],
            pools: [
                {
                    name: 'db',
                    timeoutMs: 1_000,
                    keepBudgetWhenGone: true,
                    run: async () => {
                        await tick(300);
                        h.order.push('db drained');
                    },
                },
            ],
        });
        void h.signal();
        await expect(h.exited).resolves.toBe(0);
        expect(h.order).toEqual(['db drained', 'exit 0']);
    });

    it('stays silent when an abandoned step rejects later', async () => {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const h = await serve(async () => new Response('ok'), {
                adapter: false,
                isDependencyGone: async () => true,
                services: [
                    {
                        name: 'rejects late',
                        timeoutMs: 20,
                        run: () =>
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('late')), 60),
                            ),
                    },
                ],
            });
            void h.signal();
            await h.exited;
            await tick(100);
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
});

describe('drainTimeoutMsFromEnv', () => {
    it('follows adapter-node SHUTDOWN_TIMEOUT plus a margin; 3 s when unset (Docker stop timeout 10 s)', () => {
        expect(drainTimeoutMsFromEnv({ SHUTDOWN_TIMEOUT: '30' })).toBe(32_000);
        expect(drainTimeoutMsFromEnv({ SHUTDOWN_TIMEOUT: '10' })).toBe(12_000);
        expect(drainTimeoutMsFromEnv({})).toBe(3_000);
        expect(drainTimeoutMsFromEnv({ SHUTDOWN_TIMEOUT: 'junk' })).toBe(3_000);
        expect(drainTimeoutMsFromEnv({ SHUTDOWN_TIMEOUT: '30s' })).toBe(3_000);
    });
});
