// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// backpressure-buffer.ts — hot-path backpressure counters (Slice 0 §4.4).
//
// Backpressure observability must NEVER add per-event Postgres load (a storm
// would worsen itself). Instead, on each backpressure action the hot path does:
//   - increments a Prometheus counter (metrics.ts) — for scrapers, and
//   - INCRs a cheap Valkey counter `task:backpressure:<action>:<class>`.
//
// The reconciler tick (leader-gated, 30s) read-and-resets the Valkey counters
// and, if any are non-zero, writes ONE rolled-up audit_log row (source='subsystem').
//
// Both are best-effort: a Valkey failure on the hot path is swallowed so an
// enqueue is never blocked by observability.

import { RESOURCE_CLASSES, type ResourceClass } from '@sapd/lumastra-plugin-sdk';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { taskBackpressureTotal } from '$lib/server/tasks/metrics.js';
import type { BackpressureAction } from '$lib/server/tasks/backpressure.js';

const log = Logger.for('BackpressureBuffer');

const KEY_PREFIX = 'task:backpressure:';

/** All actions the rollup must read-and-reset each tick. */
const ACTIONS: readonly BackpressureAction[] = ['drop', 'fail-fast', 'shed-oldest'] as const;

function counterKey(action: string, cls: string): string {
    return `${KEY_PREFIX}${action}:${cls}`;
}

/**
 * Record one backpressure action on the hot path: Prometheus inc + Valkey INCR.
 * Best-effort — never throws into the enqueue path.
 */
export function recordBackpressure(cls: ResourceClass, action: BackpressureAction): void {
    try {
        taskBackpressureTotal.inc({ resource_class: cls, action });
    } catch {
        // prom-client inc never normally throws; guard anyway.
    }
    // Fire-and-forget the Valkey INCR — the hot path must not await it.
    void incrCounter(cls, action);
}

async function incrCounter(cls: ResourceClass, action: BackpressureAction): Promise<void> {
    try {
        const client = getCoordinationClient();
        if (!client) return;
        await client.customCommand(['INCR', counterKey(action, cls)]);
    } catch (err) {
        log.warn('backpressure INCR failed (best-effort)', {
            cls,
            action,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

export interface BackpressureRollupEntry {
    resourceClass: string;
    action: string;
    count: number;
}

/**
 * Atomically read-and-reset every backpressure counter
 * (`task:backpressure:<action>:<class>`) over the STATIC action × class grid
 * (never SCAN). Returns only the non-zero entries. Best-effort — a Valkey
 * failure yields an empty list so the rollup simply no-ops this tick.
 */
export async function readAndResetCounters(): Promise<BackpressureRollupEntry[]> {
    const out: BackpressureRollupEntry[] = [];
    try {
        const client = getCoordinationClient();
        if (!client) return out;
        for (const action of ACTIONS) {
            for (const cls of RESOURCE_CLASSES) {
                const key = counterKey(action, cls);
                // GETDEL is atomic read-and-reset (Valkey 6.2+).
                const raw = await client.customCommand(['GETDEL', key]);
                const count = Number(glideToNumber(raw));
                if (Number.isFinite(count) && count > 0) {
                    out.push({ resourceClass: cls, action, count });
                }
            }
        }
    } catch (err) {
        log.warn('readAndResetCounters failed (best-effort)', {
            err: err instanceof Error ? err.message : String(err),
        });
    }
    return out;
}

function glideToNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Number(value);
    if (value instanceof Uint8Array || value instanceof Buffer) {
        return Number(Buffer.from(value).toString('utf-8'));
    }
    return 0;
}
