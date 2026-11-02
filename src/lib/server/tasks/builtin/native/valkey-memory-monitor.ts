// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * valkey-memory-monitor
 *
 * Runs every 5 minutes. Reads Valkey `INFO memory`, compares used vs
 * maxmemory, and logs loud warnings as the queue approaches OOM so
 * operators see the problem before workers wedge.
 *
 * Thresholds:
 *   - >80 % used → WARN
 *   - >95 % used → ERROR (queue is one large enqueue from a wedge)
 *
 * Background: preprod silently filled to 99.9 % after a coverage-row
 * migration cascade pushed 100k+ BullMQ jobs into Valkey. By the time
 * the worker-error stream started emitting `OOM command not allowed`
 * the queue had been stuck for ~30 min and several tasks were already
 * orphan-recovered. A periodic check at 5 min cadence gives operators
 * a real shot at intervening before that happens.
 *
 * Two-instance awareness: production can split coordination (noeviction)
 * and general cache (evictable) onto separate Valkey instances via
 * TASK_CACHE_URL (see `cache/valkey.ts`). The original implementation only
 * ever inspected `getCoordinationClient()` — when the two are split, that
 * misses the cache instance entirely, which is the evictable, general-
 * purpose-traffic instance most likely to actually fill up. When the two
 * clients resolve to the SAME connection (the common single-instance
 * deployment), we keep the original single-check behaviour.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';

const inputSchema = z.object({}).passthrough();

interface InstanceMemoryStats {
    used_bytes: number;
    max_bytes: number;
    used_pct: number;
    db0_keys: number;
}

interface MonitorResult {
    /** The `noeviction` coordination instance (or the sole instance when unsplit). */
    coordination: InstanceMemoryStats;
    /**
     * The general-purpose cache instance. Present ONLY when it is a distinct
     * connection from `coordination` (i.e. TASK_CACHE_URL points at a
     * separate Valkey instance). Absent on single-instance deployments.
     */
    cache?: InstanceMemoryStats;
}

const ZERO_STATS: InstanceMemoryStats = {
    used_bytes: 0,
    max_bytes: 0,
    used_pct: 0,
    db0_keys: 0,
};

/** Minimal shape this task needs from a Glide client — kept narrow for testability. */
interface MemoryInfoClient {
    customCommand(args: string[]): Promise<unknown>;
}

function parseInfoMemory(raw: string): {
    used: number;
    max: number;
    db0Keys: number;
} {
    let used = 0;
    let max = 0;
    let db0Keys = 0;
    for (const line of raw.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon);
        const val = line.slice(colon + 1).trim();
        if (key === 'used_memory') used = Number(val) || 0;
        else if (key === 'maxmemory') max = Number(val) || 0;
        else if (key === 'db0') {
            const m = val.match(/keys=(\d+)/);
            if (m) db0Keys = Number(m[1]);
        }
    }
    return { used, max, db0Keys };
}

/**
 * Run `INFO memory keyspace` against a single Valkey instance, log
 * threshold-based warnings labelled with `label` ('coordination' | 'cache'),
 * and return its usage stats.
 */
async function checkInstanceMemory(
    client: MemoryInfoClient,
    label: string,
    logger: TaskContext['logger'],
): Promise<InstanceMemoryStats> {
    // Two INFO sections in one call — `memory` for the usage stats,
    // `keyspace` for the db0 key count that lets us tell "lots of
    // small keys" (BullMQ job sprawl) from "fewer huge values".
    const raw = await client.customCommand(['INFO', 'memory', 'keyspace']);
    const text =
        typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString('utf8') : String(raw);
    const { used, max, db0Keys } = parseInfoMemory(text);

    // `maxmemory: 0` means unlimited (no cap configured) — the shipped
    // single-instance default (noeviction, no cap). Don't divide-by-zero;
    // debug-level, since this runs every 5 minutes.
    if (max <= 0) {
        logger.debug(
            `valkey-memory-monitor (${label}): maxmemory not configured — skipping pressure check`,
            { instance: label, used_bytes: used, db0_keys: db0Keys },
        );
        return { used_bytes: used, max_bytes: 0, used_pct: 0, db0_keys: db0Keys };
    }

    const usedPct = Math.round((used / max) * 100);
    // The eviction policy decides whether high usage is a problem. Under an
    // eviction policy (allkeys-lru / volatile-lru / …) the cap is
    // self-enforcing — Valkey evicts to stay under maxmemory and will NOT
    // OOM, so ~95% is the NORMAL steady state, not an alarm. Only
    // `noeviction` (where an over-cap write is rejected) makes high usage a
    // real OOM risk. Reading the policy avoids a false "one enqueue from
    // OOM" ERROR on the common evicting setup.
    const policy = /maxmemory_policy:\s*(\S+)/.exec(text)?.[1] ?? 'unknown';
    const evicts = policy !== 'noeviction' && policy !== 'unknown';
    const fields = {
        instance: label,
        used_bytes: used,
        max_bytes: max,
        used_pct: usedPct,
        db0_keys: db0Keys,
        maxmemory_policy: policy,
        used_human: `${(used / 1024 / 1024).toFixed(1)} MB`,
        max_human: `${(max / 1024 / 1024).toFixed(1)} MB`,
    };

    if (evicts) {
        if (usedPct >= 95) {
            logger.info(
                `Valkey (${label}) at ${usedPct}% of maxmemory (policy '${policy}') — expected steady state; ` +
                    `keys are evicted to stay under the cap, no OOM risk. Run the TASK keyspace under ` +
                    `'noeviction' if task-state keys must never be evicted.`,
                fields,
            );
        } else {
            logger.debug(`Valkey (${label}) memory healthy`, fields);
        }
    } else if (usedPct >= 95) {
        logger.error(
            `Valkey (${label}) memory critical (>95% used, policy 'noeviction') — one large enqueue from an ` +
                'OOM rejection. Raise `--maxmemory` in docker-compose.yml, or reduce stage-sweep enqueue volume.',
            fields,
        );
    } else if (usedPct >= 80) {
        logger.warn(
            `Valkey (${label}) memory pressure (>80% used, policy 'noeviction') — consider raising --maxmemory ` +
                'before an enqueue is rejected.',
            fields,
        );
    } else {
        logger.debug(`Valkey (${label}) memory healthy`, fields);
    }

    return { used_bytes: used, max_bytes: max, used_pct: usedPct, db0_keys: db0Keys };
}

export const valkeyMemoryMonitorTask = defineTask<z.infer<typeof inputSchema>, MonitorResult>({
    id: 'valkey-memory-monitor',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Valkey Memory Monitor',
    version: '1.1.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { cache: true },

    // 5-minute cadence — short enough that operators see warnings well
    // before OOM, long enough that the periodic INFO call is negligible.
    schedule: { every: '5m', runOnStartup: false },
    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    resourceClass: 'maintenance',
    inputSchema,
    timeout: { hard: '1m', soft: '30s' },

    async execute(ctx) {
        const valkey = await import('$lib/server/cache/valkey.js');
        // The noeviction task Valkey is the one that must be watched: gate on
        // it, not on the optional cache (down/unset must not silence this).
        const coordClient = valkey.getCoordinationClient();
        if (!coordClient) {
            ctx.logger.debug('valkey-memory-monitor: task Valkey not ready; skipping');
            return {
                success: true,
                itemsProcessed: 0,
                result: { coordination: ZERO_STATS },
            };
        }

        const coordination = await checkInstanceMemory(coordClient, 'coordination', ctx.logger);

        // getValkeyClient() is the general-purpose cache client. On a
        // single-instance deployment (no distinct TASK_CACHE_URL) it is the
        // SAME connection object as getCoordinationClient() — skip the
        // redundant second INFO round-trip in that case. Guarding on
        // `cacheClient` itself (not a separately-computed boolean) so
        // TypeScript narrows it to non-null below.
        const cacheClient = valkey.getValkeyClient();
        if (!cacheClient || cacheClient === coordClient) {
            return {
                success: true,
                itemsProcessed: 1,
                result: { coordination },
            };
        }

        const cache = await checkInstanceMemory(cacheClient, 'cache', ctx.logger);
        return {
            success: true,
            itemsProcessed: 2,
            result: { coordination, cache },
        };
    },
});

registry.registerTask(valkeyMemoryMonitorTask);
