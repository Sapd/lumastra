// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { hGetAll, hIncrBy, hSet, hSetNX, expire } from '$lib/server/cache/valkey.js';
import { apiResponseConformanceTotal } from '$lib/server/tasks/metrics.js';
import type { ConformanceItem, ConformanceKind } from '$lib/schemas/api-conformance.js';

export const CONFORMANCE_MAX_DAYS = 8;
const TTL_SECONDS = CONFORMANCE_MAX_DAYS * 86_400;
const FLUSH_MS = 10_000;
/** Short commit of this build (APP_COMMIT_SHORT is baked into the image), stored with the last hit. */
const BUILD = (process.env.APP_COMMIT_SHORT ?? '').slice(0, 40);

interface PendingCount {
    count: number;
    samples: string[];
    firstMs: number;
    lastMs: number;
}
let pending = new Map<string, Map<string, PendingCount>>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Best-effort telemetry: no I/O on the response path, no shutdown flush. */
export function countConformance(
    method: string,
    route: string | null,
    kind: ConformanceKind,
    samples: string[],
): void {
    try {
        // A synthetic/unrouted event must never fall back to its raw pathname.
        if (!route) return;
        apiResponseConformanceTotal.inc({ method, route, kind });
        const day = new Date().toISOString().slice(0, 10);
        const nowMs = Date.now();
        let fields = pending.get(day);
        if (!fields) pending.set(day, (fields = new Map()));
        const field = `${method} ${route}|${kind}`;
        const entry = fields.get(field);
        if (entry) {
            entry.count++;
            entry.lastMs = nowMs;
        } else {
            fields.set(field, {
                count: 1,
                samples: samples.slice(0, 5),
                firstMs: nowMs,
                lastMs: nowMs,
            });
        }
        scheduleFlush();
    } catch {
        // Observability must never break a response.
    }
}

function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
        void flush()
            .catch(() => {})
            .finally(() => {
                timer = undefined;
                if (pending.size > 0) scheduleFlush();
            });
    }, FLUSH_MS);
    timer.unref();
}

async function flush(): Promise<void> {
    const batch = pending;
    pending = new Map();
    await Promise.allSettled(
        [...batch].map(async ([day, fields]) => {
            const key = `apiconf:${day}`;
            const sampleKey = `apiconf:s:${day}`;
            const firstKey = `apiconf:f:${day}`;
            const lastKey = `apiconf:l:${day}`;
            await Promise.allSettled(
                [...fields].map(async ([field, entry]) => {
                    await hIncrBy(key, field, entry.count);
                    await hSetNX(sampleKey, field, JSON.stringify(entry.samples));
                    await hSetNX(firstKey, field, String(entry.firstMs));
                    // `<ms>|<build>`: the build is the short commit of the process that saw the hit.
                    await hSet(lastKey, field, `${entry.lastMs}|${BUILD}`);
                }),
            );
            await Promise.allSettled(
                [key, sampleKey, firstKey, lastKey].map((k) => expire(k, TTL_SECONDS)),
            );
        }),
    );
}

/**
 * Sum UTC daily buckets (today plus days-1 previous days). Never throws.
 * `since` keeps only items whose most recent hit is at or after it ("no hits since the deploy" =
 * empty list). Counts recorded before timestamps existed have no lastSeenAt and are dropped by it.
 */
export async function readConformance(
    days: number,
    now: Date = new Date(),
    since?: Date,
): Promise<ConformanceItem[]> {
    const n = Math.min(Math.max(Math.trunc(days) || 1, 1), CONFORMANCE_MAX_DAYS);
    const totals = new Map<string, ConformanceItem>();
    const seen = new Map<string, { first?: number; last?: number; build?: string }>();
    for (let i = 0; i < n; i++) {
        const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
        try {
            const [counts, samples, firsts, lasts] = await Promise.all([
                hGetAll(`apiconf:${day}`),
                hGetAll(`apiconf:s:${day}`),
                hGetAll(`apiconf:f:${day}`),
                hGetAll(`apiconf:l:${day}`),
            ]);
            for (const [field, value] of Object.entries(counts)) {
                const sep = field.lastIndexOf('|');
                const space = field.indexOf(' ');
                const kind = field.slice(sep + 1);
                const count = Number(value);
                if (
                    space < 1 ||
                    sep <= space ||
                    (kind !== 'stripped' && kind !== 'mismatch') ||
                    !Number.isSafeInteger(count) ||
                    count <= 0
                )
                    continue;
                let sample: string[] = [];
                try {
                    const parsed: unknown = JSON.parse(samples[field] ?? '[]');
                    if (Array.isArray(parsed))
                        sample = parsed
                            .filter((s): s is string => typeof s === 'string')
                            .slice(0, 5);
                } catch {
                    /* Ignore corrupt samples without losing counts. */
                }
                const stamp = seen.get(field) ?? {};
                const first = Number(firsts[field]);
                if (Number.isFinite(first) && first > 0)
                    stamp.first = Math.min(stamp.first ?? first, first);
                const [lastRaw = '', build = ''] = (lasts[field] ?? '').split('|');
                const last = Number(lastRaw);
                if (Number.isFinite(last) && last > 0 && last >= (stamp.last ?? 0)) {
                    stamp.last = last;
                    stamp.build = build;
                }
                seen.set(field, stamp);
                const entry = totals.get(field);
                if (entry) {
                    entry.count += count;
                    entry.samples = [...new Set([...entry.samples, ...sample])].slice(0, 5);
                } else
                    totals.set(field, {
                        method: field.slice(0, space),
                        route: field.slice(space + 1, sep),
                        kind,
                        count,
                        samples: sample,
                    });
            }
        } catch {
            /* Valkey telemetry is best effort. */
        }
    }
    for (const [field, item] of totals) {
        const stamp = seen.get(field);
        if (stamp?.first) item.firstSeenAt = new Date(stamp.first).toISOString();
        if (stamp?.last) item.lastSeenAt = new Date(stamp.last).toISOString();
        if (stamp?.build) item.lastBuild = stamp.build;
    }
    return [...totals.values()]
        .filter(
            (item) =>
                !since || (item.lastSeenAt !== undefined && item.lastSeenAt >= since.toISOString()),
        )
        .sort(
            (a, b) =>
                b.count - a.count ||
                a.route.localeCompare(b.route) ||
                a.method.localeCompare(b.method) ||
                a.kind.localeCompare(b.kind),
        );
}
