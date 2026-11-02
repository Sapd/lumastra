// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request-path external-call stats: how often each third-party provider was
 * called within active HTTP request handling (browsing, image proxy, search,
 * lyrics, admin probes), bucketed per UTC hour, per host, per outcome class.
 *
 * Shape follows `api/conformance-counter.ts`: increments are buffered in
 * process memory and flushed to Valkey hashes every 10 s, so a hot request
 * path never does a Valkey (or DB) round trip per call. Keys are
 * `extcall:h:<YYYY-MM-DDTHH>` with fields `<host>|<outcome>`, TTL 8 days.
 * Multiple replicas each flush their own buffer; HINCRBY sums them.
 *
 * Graceful shutdown flushes the last buffer; an abrupt crash can lose <= 10 s.
 */

import { expire, hGetAll, hIncrBy } from '$lib/server/cache/valkey.js';

/** Outcome class of one external call. */
export type ExternalCallOutcome =
    'ok' | 'not_found' | 'client_error' | 'rate_limited' | 'server_error' | 'network_error';

export const EXTERNAL_CALL_OUTCOMES: readonly ExternalCallOutcome[] = [
    'ok',
    'not_found',
    'client_error',
    'rate_limited',
    'server_error',
    'network_error',
];

/** Per-outcome counts for one host. */
export type ExternalCallOutcomeCounts = Record<ExternalCallOutcome, number>;

/** Keep this many days of hourly buckets (Valkey TTL); reads clamp to it. */
export const REQUEST_PATH_RETENTION_DAYS = 8;

const FLUSH_MS = 10_000;
const KEY_PREFIX = 'extcall:h:';
const HOUR_MS = 3_600_000;
const TTL_SECONDS = REQUEST_PATH_RETENTION_DAYS * 86_400 + HOUR_MS / 1000;
/** Parallel hGetAll calls per read batch. */
const READ_BATCH = 48;

/** hour key (`YYYY-MM-DDTHH`, UTC) → field (`host|outcome`) → pending count. */
let pending = new Map<string, Map<string, number>>();
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> = Promise.resolve();

function hourOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 13);
}

function zeroCounts(): ExternalCallOutcomeCounts {
    return {
        ok: 0,
        not_found: 0,
        client_error: 0,
        rate_limited: 0,
        server_error: 0,
        network_error: 0,
    };
}

/**
 * Buffer one request-path call. Never throws, never does I/O on the caller's
 * path: the increment is flushed in the next batch.
 */
export function recordRequestPathCall(
    host: string,
    outcome: ExternalCallOutcome,
    nowMs: number = Date.now(),
): void {
    try {
        const hour = hourOf(nowMs);
        let fields = pending.get(hour);
        if (!fields) pending.set(hour, (fields = new Map()));
        const field = `${host}|${outcome}`;
        fields.set(field, (fields.get(field) ?? 0) + 1);
        scheduleFlush();
    } catch {
        // Telemetry must never break a provider call.
    }
}

function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
        void flushRequestPathCalls()
            .catch(() => {})
            .finally(() => {
                timer = undefined;
                if (pending.size > 0) scheduleFlush();
            });
    }, FLUSH_MS);
    timer.unref();
}

/** Write the buffered increments to Valkey. Exported for tests and shutdown hooks. */
export function flushRequestPathCalls(): Promise<void> {
    const batch = pending;
    pending = new Map();
    // Queue behind any timer flush already in flight so shutdown waits for it.
    flushing = flushing.then(async () => {
        await Promise.allSettled(
            [...batch].map(async ([hour, fields]) => {
                const key = `${KEY_PREFIX}${hour}`;
                await Promise.allSettled([...fields].map(([field, n]) => hIncrBy(key, field, n)));
                await expire(key, TTL_SECONDS);
            }),
        );
    });
    return flushing;
}

export interface RequestPathCallCounts {
    /** Effective window in days (requested days clamped to retention). */
    windowDays: number;
    /** Per host, summed over the window. */
    byHost: Map<string, ExternalCallOutcomeCounts>;
}

function isOutcome(value: string): value is ExternalCallOutcome {
    return (EXTERNAL_CALL_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Sum hourly buckets over the last `days` days (clamped to the retention).
 * Never throws: an unreadable Valkey yields an empty result.
 */
export async function readRequestPathCalls(
    days: number,
    now: Date = new Date(),
): Promise<RequestPathCallCounts> {
    const windowDays = Math.min(Math.max(Math.trunc(days) || 1, 1), REQUEST_PATH_RETENTION_DAYS);
    const hours = windowDays * 24;
    const byHost = new Map<string, ExternalCallOutcomeCounts>();
    const keys: string[] = [];
    for (let i = 0; i < hours; i++)
        keys.push(`${KEY_PREFIX}${hourOf(now.getTime() - i * HOUR_MS)}`);

    for (let start = 0; start < keys.length; start += READ_BATCH) {
        const chunk = keys.slice(start, start + READ_BATCH);
        const results = await Promise.all(
            chunk.map((key) => hGetAll(key).catch((): Record<string, string> => ({}))),
        );
        for (const hash of results) {
            for (const [field, raw] of Object.entries(hash)) {
                const sep = field.lastIndexOf('|');
                if (sep < 1) continue;
                const host = field.slice(0, sep);
                const outcome = field.slice(sep + 1);
                const count = Number(raw);
                if (!isOutcome(outcome) || !Number.isSafeInteger(count) || count <= 0) continue;
                const counts = byHost.get(host) ?? zeroCounts();
                counts[outcome] += count;
                byHost.set(host, counts);
            }
        }
    }
    return { windowDays, byHost };
}

/** One provider row on the admin cost page, task and live calls side by side. */
export interface ProviderCallRow {
    host: string;
    /** Calls made inside background tasks (cost_breakdown, sinceDays window). */
    taskCalls: number;
    /** Calls made on the request path (hourly stats, up to 8 days). */
    liveCalls: number;
    /** Failed calls (4xx except 404, 5xx, network), task + live. Includes 429s. */
    errors: number;
    /** HTTP 429 responses, task + live. A subset of `errors`. */
    rateLimited: number;
}

export interface TaskHostCallTotals {
    host: string;
    calls: number;
    errors: number;
    rateLimited: number;
}

/**
 * Merge task-side and request-path counts into one row per host, busiest first.
 * Hosts seen on only one side still get a row.
 */
export function buildProviderCallRows(
    tasks: readonly TaskHostCallTotals[],
    live: ReadonlyMap<string, ExternalCallOutcomeCounts>,
): ProviderCallRow[] {
    const rows = new Map<string, ProviderCallRow>();
    const rowFor = (host: string): ProviderCallRow => {
        let row = rows.get(host);
        if (!row) {
            row = { host, taskCalls: 0, liveCalls: 0, errors: 0, rateLimited: 0 };
            rows.set(host, row);
        }
        return row;
    };
    for (const t of tasks) {
        const row = rowFor(t.host);
        row.taskCalls += t.calls;
        row.errors += t.errors;
        row.rateLimited += t.rateLimited;
    }
    for (const [host, c] of live) {
        const row = rowFor(host);
        row.liveCalls +=
            c.ok + c.not_found + c.client_error + c.rate_limited + c.server_error + c.network_error;
        row.errors += c.client_error + c.rate_limited + c.server_error + c.network_error;
        row.rateLimited += c.rate_limited;
    }
    return [...rows.values()].sort(
        (a, b) =>
            b.taskCalls + b.liveCalls - (a.taskCalls + a.liveCalls) || a.host.localeCompare(b.host),
    );
}
