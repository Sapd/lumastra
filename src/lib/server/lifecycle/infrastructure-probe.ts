// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Is the server I am waiting for gone?" for the shutdown paths.
 *
 * A `docker compose restart` stops PostgreSQL and Valkey together with the app,
 * and every release or flush that still wants them then waits for a server that
 * will not answer. Shutdown may only stop waiting for such a step when the
 * server is really gone, never because the step is merely slow: a busy
 * connection pool, a CPU-bound job or a long flush all look slow and are not.
 *
 * So the probe goes around every pool and client the application owns: a plain
 * TCP connect to the configured host and port. It calls a server gone only on
 * evidence from the network (connection refused, name not resolvable, host or
 * network unreachable, reset) or after two connects in a row that got no answer
 * at all. One late answer, which a blocked event loop also produces, is
 * "unknown", and unknown counts as alive.
 */

import net from 'node:net';

export interface ProbeTarget {
    name: string;
    host: string;
    port: number;
}

export type ProbeAttempt = { ok: true } | { ok: false; code: string } | { timeout: true };

export interface ProbeVerdict {
    state: 'up' | 'gone' | 'unknown';
    /** `error`: the network said so. `silence`: repeated connects got no answer. */
    evidence?: 'error' | 'silence';
    target?: string;
}

/** Errors that say the server (or its name, or the route to it) is not there. */
const GONE_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EHOSTDOWN',
    'ENETDOWN',
]);

/** Consecutive silent connects after which a server counts as gone. */
const SILENT_ATTEMPTS_FOR_GONE = 2;

function tcpConnect(target: ProbeTarget, timeoutMs: number): Promise<ProbeAttempt> {
    return new Promise((resolve) => {
        const socket = net.connect({ host: target.host, port: target.port });
        let settled = false;
        const done = (result: ProbeAttempt): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => done({ timeout: true }), timeoutMs);
        socket.once('connect', () => done({ ok: true }));
        socket.once('error', (err: Error & { code?: string }) =>
            done({ ok: false, code: err.code ?? 'UNKNOWN' }),
        );
    });
}

export interface InfrastructureProbe {
    verdict(): Promise<ProbeVerdict>;
}

export function createInfrastructureProbe(options: {
    targets: ProbeTarget[];
    timeoutMs?: number;
    /** Test seam. */
    connect?: (target: ProbeTarget, timeoutMs: number) => Promise<ProbeAttempt>;
}): InfrastructureProbe {
    const timeoutMs = options.timeoutMs ?? 1_000;
    const connect = options.connect ?? tcpConnect;
    const silent = new Map<string, number>();
    return {
        async verdict(): Promise<ProbeVerdict> {
            const results = await Promise.all(
                options.targets.map(async (target) => ({
                    target,
                    attempt: await connect(target, timeoutMs).catch((): ProbeAttempt => ({
                        timeout: true,
                    })),
                })),
            );
            let verdict: ProbeVerdict = { state: 'up' };
            for (const { target, attempt } of results) {
                if ('timeout' in attempt) {
                    const count = (silent.get(target.name) ?? 0) + 1;
                    silent.set(target.name, count);
                    if (count >= SILENT_ATTEMPTS_FOR_GONE) {
                        return { state: 'gone', evidence: 'silence', target: target.name };
                    }
                    if (verdict.state === 'up') verdict = { state: 'unknown', target: target.name };
                    continue;
                }
                silent.set(target.name, 0);
                if (!attempt.ok && GONE_CODES.has(attempt.code)) {
                    return { state: 'gone', evidence: 'error', target: target.name };
                }
                // Any other error (a TLS or protocol surprise) says nothing about the host.
            }
            return verdict;
        },
    };
}

function targetFromUrl(name: string, raw: string | undefined, defaultPort: number): ProbeTarget[] {
    if (!raw) return [];
    try {
        const url = new URL(raw);
        if (!url.hostname) return [];
        const host = url.hostname.replace(/^\[|\]$/g, '');
        return [{ name, host, port: url.port ? Number(url.port) : defaultPort }];
    } catch {
        return [];
    }
}

/** The servers the process depends on, from the same variables its clients read. */
export function probeTargetsFromEnvironment(
    env: Record<string, string | undefined>,
    include: { cache: boolean },
): ProbeTarget[] {
    return [
        ...targetFromUrl('postgres', env.DATABASE_URL, 5432),
        ...targetFromUrl('task-valkey', env.TASK_CACHE_URL, 6379),
        ...(include.cache ? targetFromUrl('cache-valkey', env.CACHE_URL, 6379) : []),
    ];
}
