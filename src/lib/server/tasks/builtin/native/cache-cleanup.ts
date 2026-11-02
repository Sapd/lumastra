// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native exemplar: cache-cleanup.
 *
 * TUTORIAL: This is the canonical "scheduled maintenance task" shape.
 * Real plugins doing periodic Valkey/Postgres housekeeping should look
 * like this. Compare with `dummy-sync.ts` to see what changes when a
 * task actually has work to do.
 *
 * What it does: scans Valkey for `recs:*` keys and deletes anything
 * older than `STALE_HOURS` based on the `cached_at` ISO field.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';

const STALE_HOURS = 24;

// TUTORIAL: pure marker input — no params today, but keeping the schema
// in place means the public /api/v1 surface gains a stable contract we
// can extend later without a breaking change.
const inputSchema = z.object({}).passthrough();

export const cacheCleanupTask = defineTask<z.infer<typeof inputSchema>, { deleted: number }>({
    id: 'cache-cleanup',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Cache Cleanup',
    version: '2.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { cache: true },

    schedule: { every: '24h', runOnStartup: false },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    // TUTORIAL: maintenance class — low priority, low concurrency. Cleanups
    // should not contend with user-facing IO.
    resourceClass: 'maintenance',
    inputSchema,
    timeout: { hard: '60m', soft: '55m' },

    async execute(ctx) {
        // TUTORIAL: prefer lazy imports for optional infrastructure. If
        // Valkey is unavailable the task should still load — we just
        // short-circuit at runtime.
        const valkey = await import('$lib/server/cache/valkey.js');
        if (!valkey.isValkeyReady()) {
            ctx.logger.debug('valkey not ready; skipping cache cleanup');
            return { success: true, itemsProcessed: 0, result: { deleted: 0 } };
        }

        const keys = await valkey.getKeysByPattern('recs:*', 5000);
        let deleted = 0;
        const errors: string[] = [];

        for (const key of keys) {
            if (ctx.signal.aborted) break;
            try {
                const raw = await valkey.cacheGet(key);
                if (!raw) {
                    await valkey.del(key);
                    deleted++;
                    continue;
                }
                let cachedAt: Date | null = null;
                try {
                    const parsed = JSON.parse(raw) as { cached_at?: string };
                    if (parsed && typeof parsed.cached_at === 'string') {
                        cachedAt = new Date(parsed.cached_at);
                    }
                } catch {
                    // Corrupt JSON — drop it.
                    await valkey.del(key);
                    deleted++;
                    continue;
                }
                if (cachedAt && (Date.now() - cachedAt.getTime()) / 3_600_000 > STALE_HOURS) {
                    await valkey.del(key);
                    deleted++;
                }
            } catch (err) {
                errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        ctx.logger.info('cache cleanup complete', {
            deleted,
            errors: errors.length,
        });

        // Total failure: every candidate key errored and nothing was
        // deleted. A bare `success:false` here never marks the Run failed or
        // feeds the circuit breaker (only a thrown error does) — a Valkey
        // instance that starts rejecting every command would otherwise run
        // "successfully" forever. Per-key isolation above is unaffected;
        // this only escalates when the whole pass produced zero deletions
        // alongside errors.
        if (errors.length > 0 && deleted === 0) {
            throw new TaskError({
                message: `cache-cleanup: total failure — 0 keys deleted across ${errors.length} error(s): ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '...' : ''}`,
                kind: 'transient',
                cause: errors,
            });
        }

        return {
            success: errors.length === 0,
            itemsProcessed: deleted,
            result: { deleted },
        };
    },
});

registry.registerTask(cacheCleanupTask);
