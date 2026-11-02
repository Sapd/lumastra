// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Global provider telemetry, independent of request/task spend scopes.
 * Buffer in memory for one second, then atomically HINCRBY + EXPIRE on the
 * task/coordination Valkey. No I/O on a provider request's critical path.
 * Failed batches are dropped, never retried (an ambiguous write could double count).
 * Abrupt process termination can lose the current buffer.
 */
import { Logger } from './logger.js';
import { config } from '$lib/server/config.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import {
    ProviderCallProviderSchema,
    type ProviderCallProvider,
    type ProviderCallCounts,
    type ProviderCallsResponse,
} from '$lib/schemas/provider-calls.js';

const log = Logger.for('ProviderCalls');
const MAX_PENDING_KEYS = 512;
const DROP_LOG_INTERVAL_MS = 60_000;
const HOUR_MS = 3_600_000;
const TTL_SECONDS = 8 * 24 * 3600;
const FIELDS = [
    'requests',
    'success2xx',
    'client4xx',
    'rateLimited429',
    'server5xx',
    'networkErrors',
    'retries',
] as const;
const HOSTS: Readonly<Record<string, ProviderCallProvider>> = {
    'api.themoviedb.org': 'tmdb',
    'image.tmdb.org': 'tmdb',
    'api.mdblist.com': 'mdblist',
    'mdblist.com': 'mdblist',
    'www.theaudiodb.com': 'theaudiodb',
    'theaudiodb.com': 'theaudiodb',
    'webservice.fanart.tv': 'fanart',
    'assets.fanart.tv': 'fanart',
    'musicbrainz.org': 'musicbrainz',
    'coverartarchive.org': 'coverartarchive',
    'api.acoustid.org': 'acoustid',
    'api.openai.com': 'openai',
    'api.voyageai.com': 'voyage',
    'api.anthropic.com': 'anthropic',
    'lrclib.net': 'lrclib',
    'ws.audioscrobbler.com': 'lastfm',
    'api.deezer.com': 'deezer',
    'api.discogs.com': 'discogs',
    'api.anidb.net': 'anidb',
    'api.myanimelist.net': 'myanimelist',
};
const providerScope = new AsyncLocalStorage<ProviderCallProvider>();
type ProviderCallSink = (
    provider: ProviderCallProvider,
    status: number | null,
    retry: boolean,
    at: number,
) => void;
let observationSink: ProviderCallSink | undefined;

/** Isolated threads relay observations to the host that owns the Valkey connection. */
export function setProviderCallSink(sink: ProviderCallSink | undefined): void {
    observationSink = sink;
}

let pending = new Map<string, ProviderCallCounts>();
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | undefined;
let droppedObservations = 0;
let lastDropLogAt = -Infinity;

export function withProviderCallScope<T>(provider: ProviderCallProvider, run: () => T): T {
    return providerScope.run(provider, run);
}

export function emptyProviderCallCounts(): ProviderCallCounts {
    return {
        requests: 0,
        success2xx: 0,
        client4xx: 0,
        rateLimited429: 0,
        server5xx: 0,
        networkErrors: 0,
        retries: 0,
    };
}

function keyFor(provider: ProviderCallProvider, ms: number): string {
    return `pcalls:v1:${provider}:${new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, '')}`;
}

function getPendingCounts(
    provider: ProviderCallProvider,
    now: number,
): ProviderCallCounts | undefined {
    const key = keyFor(provider, now);
    let counts = pending.get(key);
    if (!counts) {
        if (pending.size >= MAX_PENDING_KEYS) {
            droppedObservations++;
            const logAt = Date.now();
            if (logAt - lastDropLogAt >= DROP_LOG_INTERVAL_MS) {
                const dropped = droppedObservations;
                droppedObservations = 0;
                lastDropLogAt = logAt;
                log.warn('Provider call counter buffer full; dropping observations', {
                    dropped,
                    maxKeys: MAX_PENDING_KEYS,
                });
            }
            return undefined;
        }
        pending.set(key, (counts = emptyProviderCallCounts()));
    }
    scheduleFlush();
    return counts;
}

function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
        timer = undefined;
        void flushProviderCalls();
    }, 1000);
    timer.unref();
}

/** Never throws; counts only fixed provider labels, across all processes/scopes. */
export function recordProviderCall(
    provider: ProviderCallProvider,
    status: number | null,
    now = Date.now(),
): void {
    try {
        if (observationSink) {
            observationSink(provider, status, false, now);
            return;
        }
        const counts = getPendingCounts(provider, now);
        if (!counts) return;
        counts.requests++;
        if (status === null) counts.networkErrors++;
        else if (status >= 200 && status < 300) counts.success2xx++;
        else if (status >= 400 && status < 500) {
            counts.client4xx++;
            if (status === 429) counts.rateLimited429++;
        } else if (status >= 500 && status < 600) counts.server5xx++;
    } catch {
        /* Best-effort telemetry must never affect a provider call. */
    }
}

export function recordProviderCallForUrl(url: string, status: number | null): void {
    try {
        const target = new URL(url);
        let provider = providerScope.getStore() ?? HOSTS[target.hostname];
        if (!provider && config.JELLYFINURL) {
            const base = new URL(config.JELLYFINURL);
            if (
                target.origin === base.origin &&
                (target.pathname === base.pathname ||
                    target.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`))
            )
                provider = 'jellyfin';
        }
        if (provider) recordProviderCall(provider, status);
    } catch {
        /* Invalid URLs are not telemetry labels. */
    }
}

export function recordProviderRetry(provider: ProviderCallProvider, now = Date.now()): void {
    try {
        if (observationSink) {
            observationSink(provider, null, true, now);
            return;
        }
        const counts = getPendingCounts(provider, now);
        if (counts) counts.retries++;
    } catch {
        /* Best effort. */
    }
}

const INCREMENT_SCRIPT = `
for i = 2, #ARGV, 2 do
    redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], ARGV[1])
return 1`;

/** Exported for deterministic tests and graceful shutdown. Swallows all Valkey failures. */
export function flushProviderCalls(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = undefined;
    // Never retain a chain of detached batches behind a hung Valkey command.
    if (flushing) return flushing;
    const batch = pending;
    pending = new Map();
    flushing = Promise.resolve()
        .then(async () => {
            const client = getCoordinationClient();
            if (!client) return;
            await Promise.allSettled(
                [...batch].map(async ([key, counts]) => {
                    const args = FIELDS.filter((field) => counts[field] > 0).flatMap((field) => [
                        field,
                        String(counts[field]),
                    ]);
                    await client.customCommand([
                        'EVAL',
                        INCREMENT_SCRIPT,
                        '1',
                        key,
                        String(TTL_SECONDS),
                        ...args,
                    ]);
                }),
            );
        })
        .catch(() => {})
        .finally(() => {
            flushing = undefined;
            if (pending.size > 0) scheduleFlush();
        });
    return flushing;
}

/** Telemetry may use at most 1.5 s of shutdown; the underlying write is not retried. */
export async function flushProviderCallsForShutdown(timeoutMs = 1_500): Promise<void> {
    const budgetMs = Math.max(0, Math.min(1_500, timeoutMs));
    if (budgetMs === 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const timedOut = new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
            expired = true;
            resolve();
        }, budgetMs);
    });
    const drain = async (): Promise<void> => {
        do {
            await flushProviderCalls();
        } while (!expired && pending.size > 0);
    };
    try {
        await Promise.race([drain(), timedOut]);
    } finally {
        clearTimeout(timeout);
    }
}

/** An unavailable store rejects, so admin readers never mistake an outage for zero traffic. */
export async function readProviderCalls(
    hours: number,
    now = new Date(),
): Promise<ProviderCallsResponse> {
    const client = getCoordinationClient();
    if (!client) throw new Error('Provider call counters unavailable');
    const windowHours = Math.min(192, Math.max(1, Math.trunc(hours) || 24));
    const lastHour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
    const from = lastHour - (windowHours - 1) * HOUR_MS;
    const providers: ProviderCallsResponse['providers'] = [];
    for (const provider of ProviderCallProviderSchema.options) {
        const totals = emptyProviderCallCounts();
        const series: ProviderCallsResponse['providers'][number]['series'] = [];
        // Bound read concurrency; no SCAN and no unbounded user-controlled fanout.
        for (let start = 0; start < windowHours; start += 24) {
            const chunk = Array.from(
                { length: Math.min(24, windowHours - start) },
                (_, i) => from + (start + i) * HOUR_MS,
            );
            const hashes = await Promise.all(
                chunk.map((ms) => client.hmget(keyFor(provider, ms), [...FIELDS])),
            );
            for (const [i, values] of hashes.entries()) {
                const counts = emptyProviderCallCounts();
                FIELDS.forEach((field, index) => {
                    const value = Number(values[index] ?? 0);
                    counts[field] = Number.isSafeInteger(value) && value > 0 ? value : 0;
                    totals[field] += counts[field];
                });
                series.push({ hour: new Date(chunk[i]).toISOString(), ...counts });
            }
        }
        providers.push({ provider, totals, series });
    }
    return {
        hours: windowHours,
        from: new Date(from).toISOString(),
        to: now.toISOString(),
        providers,
    };
}
