// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native exemplar: dummy-sync.
 *
 * TUTORIAL: This is the smallest possible `defineTask` plugin. It exists
 * so a new contributor can read one file end-to-end and understand the
 * shape every other plugin follows. Pair this with `cache-cleanup.ts` for
 * the next-smallest example (real maintenance), then `tmdb-metadata-sync`
 * (external API), then `library-embeddings` (chunked drain), then
 * `file-system-scan` (multi-stage pipeline).
 *
 * What this plugin does: nothing useful — it counts up to `itemCount`,
 * sleeping `itemDelayMs` between each item, and reports progress. Use it
 * to:
 *   - smoke-test the orchestrator end-to-end
 *   - demonstrate cancel propagation (`mode: 'fail'` aborts mid-run)
 *   - verify the settings UI without touching real data
 *
 * Side-effects: registers itself with the module-level `registry`
 * singleton at import time. The builtin loader imports this module so
 * registration happens once at boot.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';

// TUTORIAL: Define your input schema with Zod. It validates every request
// from /api/v1/runs (HTTP) or `orchestrator.startRun(taskId, input)`
// (in-process) before your `execute` ever runs. The schema also becomes
// part of the OpenAPI surface served by /api/v1.
const inputSchema = z.object({
    /** How many fake items to process. */
    itemCount: z.number().int().min(1).max(1000).default(10),
    /** Delay between items in ms. */
    itemDelayMs: z.number().int().min(0).max(5000).default(100),
    /** When 'fail', throw at the midpoint to exercise the error path. */
    mode: z.enum(['ok', 'fail']).default('ok'),
});

type DummyInput = z.infer<typeof inputSchema>;

// TUTORIAL: defineTask returns the same definition you passed in (with
// runtime validation that mandatory fields are present). You register it
// into the registry directly — there's no auto-discovery magic.
export const dummySyncTask = defineTask<DummyInput, { processed: number }>({
    // ─── identity ─────────────────────────────────────────────────────────────
    id: 'dummy-sync',
    purpose: 'maintenance',
    name: 'Dummy Sync',
    version: '2.0.0',
    // SDK tutorial exemplar — hidden in production via the `demo` flag.
    // Runs in dev only so plugin authors can manual-trigger and learn the
    // smallest-possible-plugin shape.
    demo: true,
    // TUTORIAL: bump processingVersion when the work this task does changes
    // (new model, fixed bug). The orchestrator surfaces processingVersion
    // alongside each Run so admins can tell whether a row is "stale".
    processingVersion: 1,
    minAppVersion: '0.0.0',

    // ─── capabilities ─────────────────────────────────────────────────────────
    // TUTORIAL: only request what you actually need. Each capability is a
    // dependency the runner injects into `ctx` — declare http to get
    // `ctx.dep()`, ffmpeg for `ctx.ffmpeg`, etc.
    capabilities: { database: true },

    // ─── scheduling ───────────────────────────────────────────────────────────
    // TUTORIAL: leave `schedule` undefined for manual-only tasks. With it
    // set, the orchestrator's scheduler subsystem fires `startRun` every
    // `every` interval. The dummy-sync demo is intentionally manual-only
    // — it produces fake progress events that have no place on a
    // production replica's scheduler. Trigger from /admin/tasks to watch
    // the smallest possible task run end-to-end.

    // ─── concurrency keys ─────────────────────────────────────────────────────
    // TUTORIAL: identityFor is the dedup key. The orchestrator uses
    // SET NX on `identity:<formula>` to prevent two runs with the same
    // identity from racing. Singleton tasks vary by trigger mode so a
    // force-run (`mode='force'`) can bypass the scheduled ('global-catchup')
    // dedup TTL. Return `global-${mode}` for singletons; return
    // `media:${input.mediaId}` for per-item tasks; return `user:${input.userId}`
    // for per-user.
    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',

    // TUTORIAL: pick the resource class that matches your bottleneck.
    // 'io' for network/disk, 'cpu' for ffmpeg/intensive work, 'embedding'
    // for OpenAI/local models, 'maintenance' for low-priority cleanups.
    resourceClass: 'maintenance',

    // ─── input validation ─────────────────────────────────────────────────────
    inputSchema,

    // ─── lifecycle ────────────────────────────────────────────────────────────
    timeout: { hard: '60s', soft: '50s' },

    // ─── execute ──────────────────────────────────────────────────────────────
    async execute(ctx) {
        const { itemCount, itemDelayMs, mode } = ctx.input;
        ctx.logger.info('dummy-sync starting', { itemCount, mode });

        for (let i = 0; i < itemCount; i++) {
            // TUTORIAL: always check ctx.signal between work units so admin
            // cancel/timeout takes effect mid-run. The runner throws an
            // AbortError out of the rest of execute on cancel.
            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: i,
                    stopReason: 'aborted',
                };
            }

            // TUTORIAL: reportProgress is throttled to ~250ms by the runner
            // — feel free to call it every iteration of a tight loop.
            ctx.reportProgress(i + 1, itemCount);

            if (mode === 'fail' && i === Math.floor(itemCount / 2)) {
                throw new Error('Simulated failure at midpoint');
            }

            await new Promise((r) => setTimeout(r, itemDelayMs));
        }

        ctx.logger.info('dummy-sync completed', { processed: itemCount });
        return {
            success: true,
            itemsProcessed: itemCount,
            result: { processed: itemCount },
        };
    },
});

// TUTORIAL: register at module top-level. The builtin loader simply
// imports this file; the side effect populates the registry.
registry.registerTask(dummySyncTask);
