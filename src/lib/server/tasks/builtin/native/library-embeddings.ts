// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native exemplar: library-embeddings (demo).
 *
 * TUTORIAL: This shows the "chunked drain" backlog pattern — large
 * background work that can't fit in one run. The orchestrator calls
 * `backlog.stages()` to report how much work is left, then repeatedly
 * calls `backlog.compute()` + your `processItems()` until the soft budget
 * is exhausted or the backlog is empty.
 *
 * Why a demo: the real library-embeddings logic is split across
 * `src/lib/server/ai/` and a thin sync plugin. Reproducing the full
 * implementation here would obscure the SDK pattern. The legacy plugin
 * keeps doing the heavy lifting via the shim; this exemplar exists so a
 * new contributor can read one file and learn `backlog.stages` /
 * `backlog.compute` / `processItems`.
 *
 * What it does: pretends there are N media items missing embeddings,
 * processes them in slices of M, and reports progress. Swap the
 * fake-id loop for a real query against `media_items WHERE
 * metadata_embedding IS NULL` to make it functional.
 */

import { z } from 'zod';
import { defineTask, type BacklogStage } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';

const SLICE_SIZE = 50;
const SOFT_BUDGET = '2m';

const inputSchema = z
    .object({
        /** Override max items per slice. Defaults to SLICE_SIZE. */
        sliceSize: z.number().int().min(1).max(500).optional(),
    })
    .passthrough();

interface FakeEmbeddingItem {
    id: string;
}

export const libraryEmbeddingsDemoTask = defineTask<z.infer<typeof inputSchema>, unknown>({
    id: 'library-embeddings-demo',
    purpose: 'music-ai',
    // SDK tutorial exemplar — hidden in production via the `demo` flag.
    // The real library-embeddings task lives at `library-embeddings.task.ts`
    // (id: 'library-embeddings'); this demo only exists to show the
    // chunked-drain backlog pattern.
    demo: true,
    name: 'Library Embeddings (demo)',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    // No `schedule` — this is a tutorial demo, not real library embeddings
    // (that lives in `discovery-embeddings` with target='library'). Demo
    // exemplars must NOT poll fake work in production; operators can still
    // hit it via /admin/tasks → manual run to see the backlog pattern fire.

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    // TUTORIAL: 'embedding' is its own resource class so heavy AI work
    // doesn't starve IO or maintenance tasks. The runner caps its
    // concurrency separately via LUMASTRA_CONCURRENCY_EMBEDDING.
    resourceClass: 'embedding',
    inputSchema,
    timeout: { hard: '30m', soft: '25m' },
    cost: { kind: 'openai_tokens' },

    // TUTORIAL: declare backlog when your work doesn't fit in one slice.
    // The orchestrator calls `stages()` to populate the admin UI's "X of
    // Y processed" card and `compute()` repeatedly to fetch the next
    // slice. processItems then handles each batch.
    backlog: {
        unitLabel: 'items',
        sliceSize: SLICE_SIZE,
        softBudget: SOFT_BUDGET,

        // TUTORIAL: idOf must return a STABLE identifier per item so the
        // runner can dedup retries.
        idOf: (row) => (row as FakeEmbeddingItem).id,

        async stages(_ctx) {
            // TUTORIAL: stages snapshot the backlog at slice boundaries.
            // Real plugins run cheap COUNT(*) queries here. The result
            // drives the "X of Y" admin card AND seeds the SSE update.
            // Use 'waiting'/'active'/'completed' to flag where the loop
            // is now.
            const fakeTotal = 200;
            const fakeProcessed = 50;
            const out: BacklogStage[] = [
                {
                    id: 'metadata-embedding',
                    label: 'Metadata embeddings',
                    count: fakeTotal - fakeProcessed,
                },
                {
                    id: 'cast-embedding',
                    label: 'Cast/crew embeddings',
                    count: 25,
                },
            ];
            return out;
        },

        async compute(_ctx, limit) {
            // TUTORIAL: return AT MOST `limit` items. The orchestrator
            // will call again until your `remainingHint` reaches 0 or the
            // softBudget elapses. Real implementations do
            //   SELECT id FROM media_items
            //   WHERE metadata_embedding IS NULL
            //   ORDER BY popularity DESC
            //   LIMIT ${limit}
            const items: FakeEmbeddingItem[] = Array.from(
                { length: Math.min(limit, 5) },
                (_, i) => ({ id: `fake-${Date.now()}-${i}` }),
            );
            return { items, remainingHint: 0 };
        },

        // TUTORIAL: wipe is optional. When the admin clicks "re-analyze
        // everything", the runner calls wipe() before re-draining. Use
        // it to delete derived rows (embeddings, fingerprints) so a
        // fresh pass regenerates them.
        async wipe(_ctx) {
            // No-op in the demo.
        },
    },

    // TUTORIAL: processItems is invoked per slice with whatever `compute`
    // returned. Keep it idempotent — retries may replay items.
    async processItems(ctx, items) {
        for (const item of items as FakeEmbeddingItem[]) {
            if (ctx.signal.aborted) return;
            ctx.logger.debug('processing item', { id: item.id });
            // Real impl: compute embedding, INSERT INTO metadata_embeddings.
            ctx.spend('openai_tokens', 100); // hypothetical cost per item
            ctx.reportProgress(1);
        }
    },

    // TUTORIAL: when backlog is declared, the runner drives the loop —
    // your execute() just needs to start the drain. Most backlog tasks
    // can use this one-liner verbatim.
    async execute(ctx) {
        const drain = await ctx.drain({ mode: 'catchup' });
        return {
            success: drain.stopReason !== 'aborted',
            itemsProcessed: drain.processed,
            stopReason: drain.stopReason,
        };
    },
});

registry.registerTask(libraryEmbeddingsDemoTask);
