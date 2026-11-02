// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Boot guard for the task Valkey (TASK_CACHE_URL), run by the dedicated worker
 * and its executor children before they touch task state.
 *
 * The endpoint check in config/valkey-endpoints.ts only compares URL spellings.
 * These checks ask the servers themselves:
 *  - the task instance must not evict (`maxmemory-policy noeviction`), or a
 *    lock, identity key or run hash can vanish under memory pressure;
 *  - AOF should be on, or a restart loses everything since the last RDB save;
 *  - the task and cache clients must be two different servers (`run_id`), which
 *    URL comparison cannot see through DNS aliases, localhost vs 127.0.0.1, or
 *    a proxy;
 *  - task data must be in the database TASK_CACHE_URL selects (single-Valkey
 *    installs kept it in DB 0; an upgrade that picks another DB starts empty);
 *  - an EMPTY task store while Postgres still shows in-flight work means the
 *    store was lost (typically: an RDB-only Valkey restarted with
 *    `--appendonly yes`, which starts empty and ignores dump.rdb). Starting
 *    anyway would silently drop those runs and the ownership fence.
 */

import type postgres from 'postgres';
import { VALKEY_UPGRADE_DOCS_URL } from '../config/valkey-endpoints.js';

/** The commands this guard needs; GlideClient satisfies it. */
export interface GuardValkey {
    customCommand(args: string[]): Promise<unknown>;
}

/** A short-lived client on another logical database of the task instance. */
export interface GuardValkeyDb extends GuardValkey {
    close(): void;
}

export interface TaskValkeyGuardOptions {
    task: GuardValkey;
    /** Null when CACHE_URL is unset or the cache is down (best-effort). */
    cache: GuardValkey | null;
    /** The logical database TASK_CACHE_URL selects. */
    taskDatabase: number;
    env?: Record<string, string | undefined>;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface TaskValkeyDataGuardOptions extends TaskValkeyGuardOptions {
    sql: postgres.Sql;
    /** Opens a client on another database of the task instance (DB check). */
    openDatabase: (db: number) => Promise<GuardValkeyDb>;
}

/** A refusal with an operator-facing message. */
export class TaskValkeyGuardError extends Error {
    constructor(message: string) {
        super(`${message} See ${VALKEY_UPGRADE_DOCS_URL}`);
        this.name = 'TaskValkeyGuardError';
    }
}

export const ALLOW_EVICTING_ENV = 'LUMASTRA_ALLOW_EVICTING_TASK_VALKEY';
export const ALLOW_EMPTY_ENV = 'LUMASTRA_ALLOW_EMPTY_TASK_VALKEY';

function text(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    return undefined;
}

function isRecordEntry(value: unknown): value is { key: unknown; value: unknown } {
    return typeof value === 'object' && value !== null && 'key' in value && 'value' in value;
}

function flag(env: Record<string, string | undefined>, name: string): boolean {
    return env[name]?.trim().toLowerCase() === 'true';
}

/**
 * CONFIG GET reply → value, or undefined. Shapes: RESP2 flat pairs (ioredis),
 * GLIDE's GlideRecord (`[{ key, value }]`, its RESP3 map form), a Map, or a
 * plain record.
 */
export function configValue(reply: unknown, name: string): string | undefined {
    if (Array.isArray(reply) && reply.some((entry) => isRecordEntry(entry))) {
        const entry = reply.find((e) => isRecordEntry(e) && text(e.key) === name) as
            { key: unknown; value: unknown } | undefined;
        return entry ? text(entry.value) : undefined;
    }
    if (Array.isArray(reply)) {
        const index = reply.findIndex((value) => text(value) === name);
        return index >= 0 ? text(reply[index + 1]) : undefined;
    }
    if (reply instanceof Map) {
        for (const [key, value] of reply) if (text(key) === name) return text(value);
        return undefined;
    }
    if (typeof reply === 'object' && reply !== null && name in reply)
        return text((reply as Record<string, unknown>)[name]);
    return undefined;
}

/** `field:value` lines of an INFO section. */
export function infoFields(reply: unknown): Map<string, string> {
    const fields = new Map<string, string>();
    for (const line of (text(reply) ?? '').split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon > 0 && !line.startsWith('#'))
            fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    return fields;
}

async function readConfig(client: GuardValkey, name: string): Promise<string | undefined> {
    try {
        return configValue(await client.customCommand(['CONFIG', 'GET', name]), name);
    } catch {
        // CONFIG can be disabled/renamed on managed services.
        return undefined;
    }
}

async function runId(client: GuardValkey): Promise<string | undefined> {
    try {
        return infoFields(await client.customCommand(['INFO', 'server'])).get('run_id');
    } catch {
        return undefined;
    }
}

/**
 * Policy checks shared by the worker and its executors: noeviction (fatal unless
 * overridden), AOF (warning) and two distinct servers (fatal).
 */
export async function assertTaskValkeyPolicy(options: TaskValkeyGuardOptions): Promise<void> {
    const env = options.env ?? process.env;
    const warn = options.warn ?? (() => undefined);
    let policy = await readConfig(options.task, 'maxmemory-policy');
    let maxmemory = await readConfig(options.task, 'maxmemory');
    if (policy === undefined) {
        // CONFIG disabled/renamed (managed services): INFO memory reports both.
        try {
            const memory = infoFields(await options.task.customCommand(['INFO', 'memory']));
            policy = memory.get('maxmemory_policy');
            maxmemory ??= memory.get('maxmemory');
        } catch {
            // stays undefined → refused below unless overridden
        }
    }
    if (policy !== undefined && policy !== 'noeviction' && maxmemory === '0') {
        // No memory limit: the policy can never trigger. Safe today, a trap the
        // day someone sets maxmemory — say so, but start.
        warn(
            `Task Valkey maxmemory-policy is "${policy}" with no maxmemory limit, so nothing is evicted today; set --maxmemory-policy noeviction before adding a limit`,
        );
    } else if (policy !== 'noeviction') {
        const seen =
            policy === undefined
                ? 'could not be read (CONFIG GET maxmemory-policy failed)'
                : `is "${policy}"`;
        if (!flag(env, ALLOW_EVICTING_ENV)) {
            throw new TaskValkeyGuardError(
                `The task Valkey (TASK_CACHE_URL) maxmemory-policy ${seen}; it must be noeviction, or locks, run state and dedup keys can be evicted and runs double-execute or get stuck. ` +
                    'Run `CONFIG SET maxmemory-policy noeviction` on it and add --maxmemory-policy noeviction to its command. ' +
                    `If you verified the policy another way (CONFIG disabled on a managed service), set ${ALLOW_EVICTING_ENV}=true.`,
            );
        }
        warn(`Task Valkey maxmemory-policy ${seen}; continuing because ${ALLOW_EVICTING_ENV}=true`);
    }
    const appendonly = await readConfig(options.task, 'appendonly');
    if (appendonly !== 'yes') {
        warn(
            'The task Valkey (TASK_CACHE_URL) runs without AOF (appendonly is not "yes"): a restart loses task state written since the last RDB save. ' +
                'Enable it WITHOUT data loss: `CONFIG SET appendonly yes`, wait until INFO persistence shows aof_rewrite_in_progress:0 and aof_last_bgrewrite_status:ok, then add --appendonly yes to its command.',
            { appendonly: appendonly ?? 'unknown' },
        );
    }
    if (options.cache) {
        const [taskRun, cacheRun] = await Promise.all([runId(options.task), runId(options.cache)]);
        if (taskRun && cacheRun && taskRun === cacheRun) {
            throw new TaskValkeyGuardError(
                'TASK_CACHE_URL and CACHE_URL reach the SAME Valkey server (identical INFO run_id), through different host names or a proxy. ' +
                    'The cache evicts under memory pressure, so task state would be evicted with it. Point CACHE_URL at a separate Valkey.',
            );
        }
    }
}

/**
 * True when a SCAN finds at least one key matching `pattern`. Bounded: a store
 * too large to finish within `maxRounds` counts as "has keys" — the safe
 * answer, since it skips the refusals instead of raising a false alarm.
 */
async function hasKeys(client: GuardValkey, pattern: string, maxRounds = 200): Promise<boolean> {
    let cursor = '0';
    for (let round = 0; round < maxRounds; round++) {
        const reply = await client.customCommand([
            'SCAN',
            cursor,
            'MATCH',
            pattern,
            'COUNT',
            '1000',
        ]);
        if (!Array.isArray(reply) || reply.length < 2) return false;
        const keys = reply[1];
        if (Array.isArray(keys) && keys.length > 0) return true;
        cursor = text(reply[0]) ?? '0';
        if (cursor === '0') return false;
    }
    return true;
}

/** Logical databases that hold keys, from INFO keyspace (`db3:keys=12,...`). */
export function keyspaceDatabases(reply: unknown): number[] {
    const dbs: number[] = [];
    for (const [field, value] of infoFields(reply)) {
        const match = /^db(\d+)$/.exec(field);
        const keys = /(?:^|,)keys=(\d+)/.exec(value);
        if (match && keys && Number(keys[1]) > 0) dbs.push(Number(match[1]));
    }
    return dbs;
}

/**
 * Keys only a live task system has: the queues, run hashes and the ownership
 * fence. Deliberately NOT all of `task:*` — the web producer writes e.g.
 * `task:queue-paused:*` on its own, which says nothing about lost queues.
 */
const TASK_DATA_PATTERNS = ['bull:*', 'task:run:*', 'task:runtime:*'];

/**
 * Worker-only data checks: task data in the selected DB, and no silently-empty
 * store while Postgres shows in-flight work.
 */
export async function assertTaskValkeyData(options: TaskValkeyDataGuardOptions): Promise<void> {
    const env = options.env ?? process.env;
    const warn = options.warn ?? (() => undefined);
    const selected = options.taskDatabase;
    const selectedHasQueues = await hasKeys(options.task, 'bull:*');
    let selectedHasTaskData = selectedHasQueues;
    for (const pattern of TASK_DATA_PATTERNS) {
        if (selectedHasTaskData) break;
        selectedHasTaskData = await hasKeys(options.task, pattern);
    }

    // Wrong-DB check on the queues alone: any other task key can be written by
    // the web container to the new DB before the worker starts.
    if (!selectedHasQueues) {
        const others = keyspaceDatabases(
            await options.task.customCommand(['INFO', 'keyspace']),
        ).filter((db) => db !== selected);
        for (const db of others) {
            let client: GuardValkeyDb;
            try {
                client = await options.openDatabase(db);
            } catch (err) {
                warn(`Could not inspect database ${db} of the task Valkey for misplaced queues`, {
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }
            try {
                if (await hasKeys(client, 'bull:*')) {
                    throw new TaskValkeyGuardError(
                        `TASK_CACHE_URL selects database ${selected}, but the existing task queues (bull:* keys) are in database ${db} of the same Valkey. ` +
                            `Starting would ignore every queued job. Set TASK_CACHE_URL to .../${db} (single-Valkey installs used /0). ` +
                            'A TASK_CACHE_URL without a /<db> path selects database 0.',
                    );
                }
            } finally {
                client.close();
            }
        }
    }

    // "Empty" means no TASK data, not DBSIZE 0: the web container and the
    // proxy write cluster heartbeats, rate limits and locks to this instance
    // before the worker boots, so a lost store is never literally empty.
    if (selectedHasTaskData) return;
    const [inflight] = await options.sql<{ runs: number; owned: boolean }[]>`
        SELECT
            (SELECT COUNT(*)::int FROM task_history
              WHERE state IN ('pending', 'active', 'cancelling')) AS runs,
            EXISTS (SELECT 1 FROM task_runtime_authorities) AS owned
    `;
    const runs = inflight?.runs ?? 0;
    const owned = inflight?.owned ?? false;
    if (runs === 0 && !owned) return;
    const detail =
        runs > 0
            ? `${runs} run(s) are still pending/active/cancelling in Postgres`
            : 'Postgres records task ownership (task_runtime_authorities) whose Valkey fence keys are gone';
    if (flag(env, ALLOW_EMPTY_ENV)) {
        warn(
            `Task Valkey holds no task data but ${detail}; continuing because ${ALLOW_EMPTY_ENV}=true (recovery will fail or re-run them)`,
        );
        return;
    }
    throw new TaskValkeyGuardError(
        `The task Valkey (TASK_CACHE_URL, database ${selected}) holds no task data (no queues, run state or ownership fence), but ${detail}. The task store was probably lost: ` +
            'an RDB-only Valkey restarted with --appendonly yes starts empty and ignores dump.rdb, or TASK_CACHE_URL points at a new instance or the wrong database. ' +
            'Restore the data (start the old Valkey without --appendonly, then `CONFIG SET appendonly yes` and wait for aof_rewrite_in_progress:0 before adding the flag), ' +
            `or set ${ALLOW_EMPTY_ENV}=true once to accept losing the in-flight runs.`,
    );
}
