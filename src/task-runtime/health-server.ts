// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

/** Connections the listener accepts at once, probes and scrapes together. */
const MAX_CONNECTIONS = 32;
/** Connections that only /api/health and /api/health/ready may use. */
const PROBE_RESERVED_CONNECTIONS = 8;
/** A connection that has not delivered a complete request head by then is dropped. */
const REQUEST_HEAD_DEADLINE_MS = 500;
/** Concurrent connections one non-loopback peer may hold. */
const MAX_CONNECTIONS_PER_PEER = 8;
const FIXED_HOST = 'task-runtime.local';
const REASON_PATTERN = /^[a-z0-9_]{1,48}$/;

export interface ReadinessResult {
    ready: boolean;
    /** Stable lower_snake codes only. Anything else is dropped, so no URL, host or error text can leak. */
    reasons?: string[];
}

export interface LivenessResult {
    alive: boolean;
    reason?: string;
}

export interface TaskHealthOptions {
    host: string;
    port: number;
    basePath: string;
    ready: () => Promise<boolean | ReadinessResult>;
    /** true, or a reason code, while readiness is held down on purpose (upgrade). */
    readinessBlocked?: () => boolean | string;
    /** Liveness beyond "the event loop answers", e.g. consumers/scheduler stopped turning over. */
    liveness?: () => LivenessResult;
    /** Test seams; production uses the defaults. */
    maxConnectionsPerPeer?: number;
    exemptLoopbackFromPeerLimit?: boolean;
    metrics: () => Promise<string>;
    metricsContentType: string;
    /** A function is read on every request so a changed setting applies without a restart. */
    metricsPublic: boolean | (() => boolean);
    metricsToken: string | (() => string);
    metricsAuthorized: (request: Request, url: URL, peer: string) => Promise<boolean>;
}

export interface TaskHealthServer {
    server: Server;
    drain: () => void;
    close: () => Promise<void>;
}

function tokenMatches(presented: string, expected: string): boolean {
    return timingSafeEqual(
        createHash('sha256').update(presented).digest(),
        createHash('sha256').update(expected).digest(),
    );
}

/** Probe/metrics-only HTTP server; no task mutation or web routes are exposed. */
function cleanReasons(reasons: string[] | undefined): string[] {
    return [...new Set((reasons ?? []).filter((r) => REASON_PATTERN.test(r)))].slice(0, 10);
}

async function bounded<T>(operation: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Probe timeout')), ms);
    });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export async function startTaskHealthServer(options: TaskHealthOptions): Promise<TaskHealthServer> {
    let closing = false;
    let lastReady: { at: number; value: ReadinessResult } = {
        at: 0,
        value: { ready: false, reasons: [] },
    };
    let pending: Promise<ReadinessResult> | undefined;
    const open = new Set<Socket>();
    const reserved = new WeakSet<Socket>();
    const blockedReason = (): string | undefined => {
        const blocked = options.readinessBlocked?.();
        if (!blocked) return undefined;
        return typeof blocked === 'string' ? blocked : 'blocked';
    };
    const readiness = async (): Promise<ReadinessResult> => {
        if (closing) return { ready: false, reasons: ['draining'] };
        const blocked = blockedReason();
        if (blocked) return { ready: false, reasons: cleanReasons([blocked]) };
        if (Date.now() - lastReady.at >= 1000) {
            pending ??= bounded(options.ready(), 2000)
                .then((value): ReadinessResult => {
                    const result =
                        typeof value === 'boolean'
                            ? { ready: value, reasons: value ? [] : ['not_ready'] }
                            : { ready: value.ready, reasons: cleanReasons(value.reasons) };
                    if (!result.ready && result.reasons.length === 0)
                        result.reasons = ['not_ready'];
                    lastReady = { at: Date.now(), value: result };
                    return result;
                })
                .catch((): ReadinessResult => {
                    const result = { ready: false, reasons: ['readiness_check_failed'] };
                    lastReady = { at: Date.now(), value: result };
                    return result;
                })
                .finally(() => {
                    pending = undefined;
                });
            await pending;
        }
        // Re-check after the (possibly shared) probe: drain or an upgrade may have begun meanwhile.
        if (closing) return { ready: false, reasons: ['draining'] };
        const blockedNow = blockedReason();
        if (blockedNow) return { ready: false, reasons: cleanReasons([blockedNow]) };
        return lastReady.value;
    };
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        // Requests with bodies are never consumed by these read-only probes.
        // Closing prevents unread upload bodies from tying up keep-alive slots.
        res.setHeader('Connection', 'close');
        res.setHeader('Cache-Control', 'no-store');
        // Only origin-form targets ("/path?query"). Absolute-form, "*", authority-form and
        // protocol-relative ("//host/path") targets are not something these probes serve.
        const target = req.url ?? '';
        if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) {
            res.writeHead(400).end();
            return;
        }
        let url: URL;
        try {
            url = new URL(target, `http://${FIXED_HOST}`);
            if (url.host !== FIXED_HOST) throw new Error('target changed the host');
        } catch {
            res.writeHead(400).end();
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { Allow: 'GET, HEAD' }).end();
            return;
        }
        const liveness = url.pathname === `${options.basePath}/api/health`;
        const readinessPath = url.pathname === `${options.basePath}/api/health/ready`;
        if (liveness || readinessPath) {
            // Liveness never depends on backend health (DB, Valkey): a dependency outage must
            // not get the worker restarted in a loop. It does fail when the process is alive
            // but its scheduler and consumers have stopped turning over.
            let pass: boolean;
            let body: Record<string, unknown>;
            if (liveness) {
                const verdict = options.liveness?.() ?? { alive: true };
                pass = verdict.alive;
                body = pass
                    ? { status: 'pass' }
                    : { status: 'fail', reason: cleanReasons([verdict.reason ?? 'stalled'])[0] };
            } else {
                const result = await readiness();
                pass = result.ready;
                body = {
                    status: pass ? 'pass' : 'fail',
                    ready: pass,
                    reasons: result.reasons ?? [],
                };
            }
            res.writeHead(pass ? 200 : 503, { 'Content-Type': 'application/health+json' });
            res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
            return;
        }
        if (url.pathname !== `${options.basePath}/metrics`) {
            res.writeHead(404).end();
            return;
        }
        // Probes own the last PROBE_RESERVED_CONNECTIONS slots, so scrapes and stray
        // traffic cannot starve kubelet into restarting a healthy worker.
        if (reserved.has(req.socket)) {
            res.writeHead(503, { 'Retry-After': '1' }).end();
            return;
        }
        const authorization = req.headers.authorization ?? '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        // Read per request: a rotated token or a toggled public flag applies without a restart.
        const metricsPublic =
            typeof options.metricsPublic === 'function'
                ? options.metricsPublic()
                : options.metricsPublic;
        const metricsToken =
            typeof options.metricsToken === 'function'
                ? options.metricsToken()
                : options.metricsToken;
        let authorized = metricsPublic || !!(metricsToken && tokenMatches(token, metricsToken));
        if (!authorized) {
            // Reuse the same PAT/service credential, strict peer-IP and scope
            // validation as web /metrics. No caller-supplied user headers.
            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers)) {
                if (Array.isArray(value)) {
                    for (const item of value) headers.append(key, item);
                } else if (value !== undefined) headers.set(key, value);
            }
            const request = new Request(url, { method: req.method, headers });
            authorized = await bounded(
                options.metricsAuthorized(request, url, req.socket.remoteAddress ?? ''),
                2000,
            ).catch(() => false);
        }
        if (!authorized) {
            res.writeHead(401).end('Unauthorized');
            return;
        }
        const body = await bounded(options.metrics(), 2000);
        res.writeHead(200, { 'Content-Type': options.metricsContentType });
        res.end(req.method === 'HEAD' ? undefined : body);
    };
    const server = createServer(
        { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
        (req, res) => {
            void handle(req, res).catch(() => {
                if (!res.headersSent) res.writeHead(503);
                res.end();
            });
        },
    );
    server.maxConnections = MAX_CONNECTIONS;
    server.keepAliveTimeout = 1000;
    server.setTimeout(5000, (socket) => socket.destroy());
    // Reservation on the same port (no deploy change): a connection accepted while
    // MAX_CONNECTIONS - PROBE_RESERVED_CONNECTIONS are already open may only carry
    // probes, and must send its request quickly. The cap itself stays in Node.
    const peerLimit = options.maxConnectionsPerPeer ?? MAX_CONNECTIONS_PER_PEER;
    const exemptLoopback = options.exemptLoopbackFromPeerLimit ?? true;
    const perPeer = new Map<string, number>();
    const headDeadline = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
    const isLoopback = (address: string | undefined): boolean =>
        !!address &&
        (address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.'));
    server.on('connection', (socket: Socket) => {
        // One peer cannot hold the whole listener; loopback (local tooling, tests) is exempt.
        const peer = socket.remoteAddress ?? '';
        const held = (perPeer.get(peer) ?? 0) + 1;
        if (peer && !(exemptLoopback && isLoopback(peer))) {
            if (held > peerLimit) {
                socket.destroy();
                return;
            }
            perPeer.set(peer, held);
            socket.once('close', () => {
                const left = (perPeer.get(peer) ?? 1) - 1;
                if (left <= 0) perPeer.delete(peer);
                else perPeer.set(peer, left);
            });
        }
        if (open.size >= MAX_CONNECTIONS - PROBE_RESERVED_CONNECTIONS) reserved.add(socket);
        // Idle sockets that never send a request must not sit on a slot for the 5 s
        // header timeout: probes and scrapes send their head immediately.
        const timer = setTimeout(() => socket.destroy(), REQUEST_HEAD_DEADLINE_MS);
        timer.unref();
        headDeadline.set(socket, timer);
        open.add(socket);
        socket.once('close', () => {
            clearTimeout(timer);
            open.delete(socket);
        });
    });
    server.on('request', (req: IncomingMessage) => {
        clearTimeout(headDeadline.get(req.socket));
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    return {
        server,
        drain: () => {
            closing = true;
        },
        close: async (): Promise<void> => {
            closing = true;
            const stopped = new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
            server.closeAllConnections();
            await stopped;
        },
    };
}
