// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// failure-patterns.service.ts — read-time error aggregation (Slice 3 §4.1).
//
// Folds bounded raw failure rows (run-level task_history.error + item-level
// plugin_failure_events.reason) into grouped FailurePattern[] by normalizing +
// hashing each message (error-fingerprint.ts), then caches the result in Valkey
// for a short TTL (read-through). NO persisted hash, NO rollup task — the group
// is computed on read so a normalization-rule change instantly re-groups.

import type postgres from 'postgres';
import { getValkeyClient } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { fingerprintError, normalizeError } from './error-fingerprint.js';
import {
    listRunFailureRows,
    listItemFailureRows,
} from '$lib/server/database/queries/failure-patterns.queries.js';
import type { FailurePattern } from '$lib/schemas/task-system-failure-detection.schema.js';

const log = Logger.for('FailurePatterns');

/** Valkey cache TTL for a computed pattern set (§4.1: 30–60s). */
const CACHE_TTL_MS = 45_000;
/** Cap on distinct task ids listed per pattern; overflow counted separately. */
const AFFECTED_TASKS_CAP = 10;
/** Versioned cache key namespace (project convention). */
const CACHE_VERSION = 'v3';

export type FailurePatternSource = 'run' | 'item' | 'all';

interface RawFailure {
    taskId: string;
    message: string;
    at: Date;
    kind?: string | null;
    source: 'run' | 'item';
}

interface Accum {
    fingerprint: string;
    normalizedMessage: string;
    sampleMessage: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
    tasks: Set<string>;
    kinds: Set<string>;
    source: 'run' | 'item';
}

/** Fold raw failures into grouped, count-sorted patterns. Pure — testable. */
export function groupFailures(rows: RawFailure[]): FailurePattern[] {
    const groups = new Map<string, Accum>();
    for (const row of rows) {
        const fingerprint = fingerprintError(row.message);
        // Run and item failures with the same text are still distinct rows
        // (different sources render differently); key on source + fingerprint.
        const key = `${row.source}:${fingerprint}`;
        const at = row.at.getTime();
        let acc = groups.get(key);
        if (!acc) {
            acc = {
                fingerprint,
                normalizedMessage: normalizeError(row.message),
                sampleMessage: row.message,
                count: 0,
                firstSeen: at,
                lastSeen: at,
                tasks: new Set<string>(),
                kinds: new Set<string>(),
                source: row.source,
            };
            groups.set(key, acc);
        }
        acc.count += 1;
        if (at < acc.firstSeen) acc.firstSeen = at;
        if (at > acc.lastSeen) {
            acc.lastSeen = at;
            acc.sampleMessage = row.message; // freshest verbatim example
        }
        acc.tasks.add(row.taskId);
        if (row.kind) acc.kinds.add(row.kind);
    }

    const patterns: FailurePattern[] = [...groups.values()].map((acc) => {
        const allTasks = [...acc.tasks];
        const affectedTasks = allTasks.slice(0, AFFECTED_TASKS_CAP);
        return {
            fingerprint: acc.fingerprint,
            normalizedMessage: acc.normalizedMessage,
            sampleMessage: acc.sampleMessage,
            count: acc.count,
            firstSeen: new Date(acc.firstSeen).toISOString(),
            lastSeen: new Date(acc.lastSeen).toISOString(),
            affectedTasks,
            affectedTasksOverflow: Math.max(0, allTasks.length - affectedTasks.length),
            source: acc.source,
            kinds: acc.source === 'run' && acc.kinds.size > 0 ? [...acc.kinds] : undefined,
        };
    });

    patterns.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
    return patterns;
}

function cacheKey(source: FailurePatternSource, sinceHours: number, taskId?: string): string {
    return `${CACHE_VERSION}:obs:failure-patterns:${source}:${sinceHours}:${taskId ?? 'all'}`;
}

async function readCache(key: string): Promise<FailurePattern[] | null> {
    try {
        const client = getValkeyClient();
        if (!client) return null;
        const raw = await client.customCommand(['GET', key]);
        const str =
            typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString('utf8') : null;
        if (!str) return null;
        return JSON.parse(str) as FailurePattern[];
    } catch (err) {
        log.warn('failure-patterns cache read failed (best-effort)', {
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

async function writeCache(key: string, patterns: FailurePattern[]): Promise<void> {
    try {
        const client = getValkeyClient();
        if (!client) return;
        await client.customCommand([
            'SET',
            key,
            JSON.stringify(patterns),
            'PX',
            String(CACHE_TTL_MS),
        ]);
    } catch (err) {
        log.warn('failure-patterns cache write failed (best-effort)', {
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Compute (or read-through-cache) the grouped failure patterns for a source +
 * window. `limit` caps the returned (already count-sorted) patterns. `taskId`
 * scopes to a single task (the per-task detail panel).
 */
export async function getFailurePatterns(
    sql: postgres.Sql,
    {
        source,
        sinceHours,
        limit,
        taskId,
    }: {
        source: FailurePatternSource;
        sinceHours: number;
        limit: number;
        taskId?: string;
    },
): Promise<FailurePattern[]> {
    const key = cacheKey(source, sinceHours, taskId);
    const sourceSensitive = source !== 'run' && (!taskId || taskId === 'lumastra-intro-analyzer');
    const cached = sourceSensitive ? null : await readCache(key);
    if (cached) return cached.slice(0, limit);

    const raw: RawFailure[] = [];
    if (source === 'run' || source === 'all') {
        const runRows = await listRunFailureRows(sql, { sinceHours, taskId });
        for (const r of runRows) {
            raw.push({
                taskId: r.taskId,
                message: r.message,
                at: r.completedAt,
                kind: r.kind,
                source: 'run',
            });
        }
    }
    if (source === 'item' || source === 'all') {
        const itemRows = await listItemFailureRows(sql, { sinceHours, taskId });
        for (const r of itemRows) {
            raw.push({
                taskId: r.taskId,
                message: r.message,
                at: r.occurredAt,
                source: 'item',
            });
        }
    }

    const patterns = groupFailures(raw);
    if (!sourceSensitive) await writeCache(key, patterns);
    return patterns.slice(0, limit);
}
