// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// component-health.ts — shared per-subsystem health probe (Slice 0 §5 / D11-Ops).
//
// Single source of truth for the component-health block, called by BOTH
// /api/health/components and /api/admin/task-system/observability so the two
// can't drift (folds in audit Theme F "doc/code drift" risk).
//
// Checks: database, valkey, orchestrator (+ queue leadership), webhookOutbox,
// pendingWriteDrain, transcoder, migration, authCacheBus. Each is independently try/caught —
// a failure in one component yields `{ status: 'fail', … }` rather than failing
// the whole probe. Admin reads use getDb() (web pool).
//
// Status vocabulary (application/health+json §4): pass | warn | fail.
// All component objects carry `status` as the ONLY health signal.
// Legacy `ok`/`healthy` fields are dropped — consumers read `status` directly.

import { getDb } from '$lib/server/database/connection.js';
import {
    getValkeyClient,
    getCoordinationClient,
    hasSeparateCoordinationValkey,
    isCacheValkeyConfigured,
} from '$lib/server/cache/valkey.js';
import { getOrchestrator } from '$lib/server/tasks/orchestrator.js';
import { OUTBOX_RETIRED_ERROR_PREFIX } from '$lib/server/tasks/webhook-outbox.js';
import { features } from '$lib/server/config.js';
import { getAuthCacheBusStatus } from '$lib/server/cache/auth-cache-bus.js';
import { valkeyCapacityStatus } from './valkey-capacity-status.js';

export type HealthStatus = 'pass' | 'warn' | 'fail';

export interface ComponentEntry {
    /** application/health+json canonical status. */
    status: HealthStatus;
    [key: string]: unknown;
}

export type ComponentHealthReport = {
    timestamp: string;
    [component: string]: ComponentEntry | string;
};

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Map a boolean pass/fail to the health+json status vocab. */
function boolStatus(ok: boolean): HealthStatus {
    return ok ? 'pass' : 'fail';
}

interface ValkeyCapacityInstance {
    name: 'cache' | 'tasks' | 'shared';
    roles: Array<'cache' | 'tasks'>;
    usedBytes: number;
    maxBytes: number;
    usagePercent: number | null;
    maxmemoryPolicy: string | null;
    keyCount: number;
    status: HealthStatus;
    reason?: string;
}

interface ValkeyMemoryClient {
    customCommand(args: string[]): Promise<unknown>;
}

function commandText(reply: unknown): string {
    return typeof reply === 'string'
        ? reply
        : reply instanceof Buffer
          ? reply.toString('utf8')
          : String(reply);
}

function parseInfoMemory(raw: string): {
    usedBytes: number;
    maxBytes: number;
    maxmemoryPolicy: string | null;
} {
    let usedBytes = 0;
    let maxBytes = 0;
    let maxmemoryPolicy: string | null = null;
    for (const line of raw.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (key === 'used_memory') usedBytes = Number(value) || 0;
        else if (key === 'maxmemory') maxBytes = Number(value) || 0;
        else if (key === 'maxmemory_policy') maxmemoryPolicy = value || null;
    }
    return { usedBytes, maxBytes, maxmemoryPolicy };
}

async function readValkeyCapacity(
    client: ValkeyMemoryClient,
    name: ValkeyCapacityInstance['name'],
    roles: ValkeyCapacityInstance['roles'],
): Promise<ValkeyCapacityInstance> {
    const [memoryReply, keyCountReply] = await Promise.all([
        client.customCommand(['INFO', 'memory']),
        client.customCommand(['DBSIZE']),
    ]);
    const { usedBytes, maxBytes, maxmemoryPolicy } = parseInfoMemory(commandText(memoryReply));
    const usagePercent = maxBytes > 0 ? Math.round((usedBytes / maxBytes) * 100) : null;
    const health = valkeyCapacityStatus(usagePercent, maxmemoryPolicy, roles);
    return {
        name,
        roles,
        usedBytes,
        maxBytes,
        usagePercent,
        maxmemoryPolicy,
        keyCount: Number(keyCountReply) || 0,
        ...health,
    };
}

/**
 * Short-lived in-flight cache. A single attention-derive cycle calls
 * `buildComponentHealth` from two sources (degraded-component + task-liveness)
 * near-simultaneously, and the bell/strip/operations surfaces each trigger a
 * derive — without this, every derive double-probes DB+Valkey+orchestrator.
 * Memoising the in-flight promise collapses concurrent calls to one, and the
 * tiny TTL also folds rapid sequential calls. ≤1.5s staleness is negligible for
 * a health probe (component up/down doesn't flip meaningfully that fast).
 */
let inflight: { at: number; promise: Promise<ComponentHealthReport> } | null = null;
const COMPONENT_HEALTH_TTL_MS = 1500;

/**
 * Build the per-component health report. Returns a plain object keyed by
 * component name plus a `timestamp` field, matching the shape the original
 * /api/health/components route returned. Cached for {@link COMPONENT_HEALTH_TTL_MS}.
 *
 * Status vocab: `pass | warn | fail` (application/health+json §4, D11-Ops).
 */
export function buildComponentHealth(): Promise<ComponentHealthReport> {
    const now = Date.now();
    if (inflight && now - inflight.at < COMPONENT_HEALTH_TTL_MS) {
        return inflight.promise;
    }
    const promise = buildComponentHealthUncached();
    inflight = { at: now, promise };
    // Never cache a rejection: buildComponentHealthUncached is internally
    // guarded (shouldn't throw), but if it ever does, a cached rejected promise
    // would blind every consumer for the whole TTL window. Evict on failure so
    // the next call re-probes.
    void promise.catch(() => {
        if (inflight?.promise === promise) inflight = null;
    });
    return promise;
}

async function buildComponentHealthUncached(): Promise<ComponentHealthReport> {
    const report: ComponentHealthReport = {
        timestamp: new Date().toISOString(),
    };

    // Database.
    try {
        const sql = getDb();
        if (sql) {
            await sql`SELECT 1`;
            report.database = { status: 'pass' };
        } else {
            report.database = { status: 'fail', reason: 'not configured' };
        }
    } catch (err) {
        // best-effort: probe failure IS the result — recorded as the component's
        // health status (surfaced in admin UI), not a swallowed error.
        report.database = { status: 'fail', reason: errMsg(err) };
    }

    // Valkey. The coordination instance is the required one (tasks, locks,
    // revocations); the cache is optional, so an unset or down cache only warns.
    try {
        const client = getCoordinationClient();
        if (client) {
            const pong = await client.customCommand(['PING']);
            const ok = pong === 'PONG' || pong === 'pong';
            report.valkey = { status: boolStatus(ok) };
            if (ok && hasSeparateCoordinationValkey() && isCacheValkeyConfigured()) {
                const cache = getValkeyClient();
                const cachePong = cache
                    ? await cache.customCommand(['PING']).catch(() => null)
                    : null;
                if (cachePong !== 'PONG' && cachePong !== 'pong') {
                    report.valkey = { status: 'warn', reason: 'cache instance unavailable' };
                }
            }
        } else {
            report.valkey = { status: 'fail', reason: 'not configured' };
        }
    } catch (err) {
        // best-effort: probe failure recorded as component status, not swallowed.
        report.valkey = { status: 'fail', reason: errMsg(err) };
    }

    // Cross-replica auth-cache invalidation bus (THIS replica's subscription).
    // While it is down, revocations from other replicas can be missed, so the
    // device-session check reads the DB per request instead of its cache.
    // Omitted when not started or disabled (no CACHE_URL: single instance).
    try {
        const bus = getAuthCacheBusStatus();
        if (bus.state === 'subscribed') {
            report.authCacheBus = { status: 'pass', subscribed: true };
        } else if (bus.state === 'unsubscribed') {
            report.authCacheBus = {
                status: 'warn',
                subscribed: false,
                reason: bus.reason ?? 'not subscribed',
                since: new Date(bus.since).toISOString(),
            };
        }
    } catch (err) {
        report.authCacheBus = { status: 'warn', error: errMsg(err) };
    }

    // Valkey capacity. Cache and task coordination are independently measured
    // when TASK_CACHE_URL uses a distinct target; otherwise the one shared
    // instance is presented once with both roles. This stays deliberately
    // constant-cost (INFO memory + DBSIZE per instance) because this endpoint
    // is polled every 15 seconds by System Health.
    try {
        const cache = getValkeyClient();
        const separateTasks = hasSeparateCoordinationValkey();
        const tasks = getCoordinationClient();
        const instances: ValkeyCapacityInstance[] = [];

        // The cache is optional: unset → not listed, down → warn (the app runs
        // on cache misses). Only a missing task Valkey is a failure.
        if (cache) {
            instances.push(
                await readValkeyCapacity(
                    cache,
                    separateTasks ? 'cache' : 'shared',
                    separateTasks ? ['cache'] : ['cache', 'tasks'],
                ),
            );
        } else if (isCacheValkeyConfigured()) {
            instances.push({
                name: separateTasks ? 'cache' : 'shared',
                roles: separateTasks ? ['cache'] : ['cache', 'tasks'],
                usedBytes: 0,
                maxBytes: 0,
                usagePercent: null,
                maxmemoryPolicy: null,
                keyCount: 0,
                status: separateTasks ? 'warn' : 'fail',
                reason: 'cache Valkey is not connected (running on cache misses)',
            });
        }

        if (separateTasks) {
            if (tasks) {
                instances.push(await readValkeyCapacity(tasks, 'tasks', ['tasks']));
            } else {
                instances.push({
                    name: 'tasks',
                    roles: ['tasks'],
                    usedBytes: 0,
                    maxBytes: 0,
                    usagePercent: null,
                    maxmemoryPolicy: null,
                    keyCount: 0,
                    status: 'fail',
                    reason: 'task/coordination Valkey is not connected',
                });
            }
        }

        report.valkeyCapacity = {
            status: instances.some((instance) => instance.status === 'fail')
                ? 'fail'
                : instances.some((instance) => instance.status === 'warn')
                  ? 'warn'
                  : 'pass',
            instances,
        };
    } catch (err) {
        report.valkeyCapacity = { status: 'fail', error: errMsg(err) };
    }

    // Orchestrator + queue leadership.
    try {
        const orch = await getOrchestrator();
        report.orchestrator = {
            status: boolStatus(orch.isHealthy()),
            isLeaderForAnyClass: orch.isLeaderForAnyClass(),
        };
    } catch (err) {
        // best-effort: probe failure recorded as component status, not swallowed.
        report.orchestrator = { status: 'fail', reason: errMsg(err) };
    }

    // Webhook outbox counts. Healthy = no dead-letter entries and a bounded
    // pending backlog.
    try {
        const sql = getDb();
        if (sql) {
            const pending = await sql<{ n: string }[]>`
                SELECT COUNT(*) AS n FROM task_webhook_outbox
                WHERE delivered_at IS NULL AND dead = false
            `;
            // `dead = true` covers two unrelated things, split here by the
            // OUTBOX_RETIRED_ERROR_PREFIX marker the outbox worker writes:
            //
            //   dead    — delivery FAILED (retries exhausted, or a permanent
            //             404/410). A fault; non-self-healing; worth waking an
            //             operator for.
            //   retired — the worker declined to send, because the operator
            //             turned the per-user webhook feature off or the
            //             owning account was disabled/deleted. The system
            //             working as configured.
            //
            // Only the first gates health. Counting both meant that disabling
            // a single user — a routine admin action — parked a "Webhook
            // delivery degraded" warning in the attention panel until the row
            // aged past DB_CLEANUP_TASK_WEBHOOK_OUTBOX_DAYS (30 days), because
            // the prune cutoff is on `created_at` and nothing else clears a
            // dead row. `retired` is still reported so the count stays visible
            // to anyone actually looking at the component.
            const dead = await sql<{ failed: string; retired: string }[]>`
                SELECT
                    COUNT(*) FILTER (
                        WHERE last_error IS NULL
                           OR last_error NOT LIKE ${OUTBOX_RETIRED_ERROR_PREFIX + '%'}
                    ) AS failed,
                    COUNT(*) FILTER (
                        WHERE last_error LIKE ${OUTBOX_RETIRED_ERROR_PREFIX + '%'}
                    ) AS retired
                FROM task_webhook_outbox
                WHERE dead = true
            `;
            const pendingN = parseInt(pending[0]?.n ?? '0', 10);
            const deadN = parseInt(dead[0]?.failed ?? '0', 10);
            const retiredN = parseInt(dead[0]?.retired ?? '0', 10);
            // `pending < 50_000` covers ~14 h of webhook backlog on a busy
            // cluster before tripping pass=false. Anything in the dead-letter
            // table is non-self-healing and warrants attention immediately.
            const ok = deadN === 0 && pendingN < 50_000;
            report.webhookOutbox = {
                status: boolStatus(ok),
                pending: pendingN,
                dead: deadN,
                retired: retiredN,
            };
        }
    } catch (err) {
        // best-effort: probe failure recorded as component status, not swallowed.
        report.webhookOutbox = { status: 'fail', error: errMsg(err) };
    }

    // Pending-write drain depth. Healthy = below a soft cap; anything larger
    // signals Postgres has been unavailable for an extended period and writes
    // are queueing in Valkey.
    try {
        // task:pending-writes lives on the coordination instance.
        const client = getCoordinationClient();
        if (client) {
            const depth = Number(await client.customCommand(['LLEN', 'task:pending-writes']));
            // `depth < 5_000` ≈ Postgres unreachable for ~8 minutes at the
            // worst-case drain rate (~10/s). Beyond that the drain queue risks
            // OOM'ing Valkey and operators need to intervene.
            const ok = Number.isFinite(depth) && depth < 5_000;
            report.pendingWriteDrain = {
                status: boolStatus(ok),
                depth,
            };
        }
    } catch (err) {
        // best-effort: probe failure recorded as component status, not swallowed.
        report.pendingWriteDrain = { status: 'fail', error: errMsg(err) };
    }

    // Transcoder (FFmpeg). Presence-only check — no live probe, just whether the
    // configured binary path exists. Pass = ffmpegAvailable; fail = not configured.
    try {
        const available = features.ffmpegAvailable;
        report.transcoder = {
            status: available ? 'pass' : 'warn',
            available,
            engine: available ? 'ffmpeg' : null,
        };
    } catch (err) {
        // best-effort: unexpected error checking feature flag.
        report.transcoder = { status: 'fail', available: false, error: errMsg(err) };
    }

    // Migration status. Pass = no pending migrations; warn = migrations pending
    // (the app started from a previous schema version and is running newer code).
    try {
        const { getMigrationStatus } = await import('$lib/server/database/migrate-schema.js');
        const status = await getMigrationStatus();
        // `pending_migrations` is the number of migrations not yet applied.
        const pendingCount =
            typeof status.pending_migrations === 'number' ? status.pending_migrations : 0;
        report.migration = {
            status: pendingCount === 0 ? 'pass' : 'warn',
            currentVersion: status.current_version,
            appliedMigrations: status.applied_migrations,
            pendingMigrations: pendingCount,
        };
    } catch (err) {
        // best-effort: probe failure recorded as component status, not swallowed.
        report.migration = { status: 'warn', error: errMsg(err) };
    }

    return report;
}

/**
 * Derive the overall health status from a component report.
 * Uses the worst-case component status: any `fail` → 'fail', any `warn` → 'warn'.
 */
export function deriveOverallStatus(report: ComponentHealthReport): HealthStatus {
    let worst: HealthStatus = 'pass';
    for (const [key, value] of Object.entries(report)) {
        if (key === 'timestamp') continue;
        if (typeof value === 'object' && value !== null && 'status' in value) {
            const s = (value as ComponentEntry).status;
            if (s === 'fail') return 'fail';
            if (s === 'warn') worst = 'warn';
        }
    }
    return worst;
}
