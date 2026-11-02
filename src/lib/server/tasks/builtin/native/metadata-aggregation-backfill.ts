// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native maintenance task: metadata-aggregation-backfill.
 *
 * Re-aggregates provider_metadata rows that already exist in the DB without
 * making any external API calls. Reads the source provider rows already
 * present and re-runs aggregateMetadataForMedia over them, writing a fresh
 * 'aggregated' row.
 *
 * Use-case: items whose aggregated row is missing or sparse (e.g. a series
 * that has genres on its 'tmdb' provider row but whose 'aggregated' row was
 * never written because the bulk enrichment path predates the aggregation
 * step). Running this task is safe to repeat — the upsert is idempotent.
 *
 * Candidate set: every media_item that has at least one non-aggregated
 * provider_metadata row (SELECT DISTINCT media_id FROM provider_metadata
 * WHERE provider <> 'aggregated'). A full re-aggregate is acceptable because
 * the operation is cheap (in-DB only, no network) and idempotent.
 *
 * manualOnly: operator-triggered (library-wide; no quota pressure, but best
 * run once rather than on a schedule). identityFor global so a concurrent
 * double-trigger is a no-op.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { batchAggregateMetadata } from '$lib/server/database/queries/metadata-aggregation.queries.js';

const CHUNK_SIZE = 500;

const inputSchema = z.object({}).passthrough();

const AGGREGATION_CHECKPOINT_VERSION = 1;

interface AggregationCheckpoint {
    v: number;
    afterMediaId: string;
    totals: MetadataAggregationBackfillResult;
}

const aggregationCheckpointSchema = z.object({
    v: z.literal(AGGREGATION_CHECKPOINT_VERSION),
    afterMediaId: z.string().uuid(),
    totals: z.object({
        updated: z.number().int().min(0),
        skipped: z.number().int().min(0),
        errors: z.number().int().min(0),
        candidateCount: z.number().int().min(0),
    }),
});

/** The saved keyset position, or null to start from the beginning. */
export function parseAggregationCheckpoint(raw: unknown): AggregationCheckpoint | null {
    const parsed = aggregationCheckpointSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}
type MetadataAggregationBackfillInput = z.infer<typeof inputSchema>;

interface MetadataAggregationBackfillResult {
    updated: number;
    skipped: number;
    errors: number;
    candidateCount: number;
}

export const metadataAggregationBackfillTask = defineTask<
    MetadataAggregationBackfillInput,
    MetadataAggregationBackfillResult
>({
    id: 'metadata-aggregation-backfill',
    purpose: 'library',
    name: 'Metadata Aggregation Backfill',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },

    // Operator-triggered only — re-aggregates the whole library in-DB (no
    // external API calls). manualOnly keeps the boot trigger-coverage audit
    // from flagging it as an orphan.
    manualOnly: true,
    // Safe to resume: the aggregation upsert is idempotent and in-DB only. The
    // checkpoint below (last media id of the last finished chunk) lets a
    // resumed run skip what the interrupted one already re-aggregated.
    resumeAfterRestart: true,
    identityFor: () => 'metadata-aggregation-backfill',
    scope: 'global',
    // Claim the identity for the in-flight run so a double-trigger is a no-op.
    exclusiveWith: { scope: 'global', ttl: '2h' },
    resourceClass: 'maintenance',
    inputSchema,
    timeout: { hard: '2h', soft: '110m' },

    async execute(ctx) {
        const { logger, sql, signal } = ctx;

        // Resumed after a restart: continue after the last finished chunk.
        const saved = parseAggregationCheckpoint(await ctx.checkpoint?.load());

        logger.info('metadata-aggregation-backfill: querying candidates', {
            resumingAfter: saved?.afterMediaId,
        });

        // Collect every media_item that has at least one non-aggregated
        // provider row. A full re-aggregate is idempotent and cheap. Ordered by
        // the uuid so the checkpoint is a keyset position.
        const afterMediaId = saved?.afterMediaId ?? null;
        const rows = await sql<{ media_id: string }[]>`
            SELECT d.media_id::text AS media_id
            FROM (
                SELECT DISTINCT media_id
                FROM provider_metadata
                WHERE provider <> 'aggregated'
                  AND (${afterMediaId}::uuid IS NULL OR media_id > ${afterMediaId}::uuid)
            ) d
            ORDER BY d.media_id
        `;

        const allIds = rows.map((r) => r.media_id);

        logger.info('metadata-aggregation-backfill: candidates found', {
            candidateCount: allIds.length,
        });

        const totals: MetadataAggregationBackfillResult = saved
            ? { ...saved.totals, candidateCount: saved.totals.candidateCount }
            : {
                  updated: 0,
                  skipped: 0,
                  errors: 0,
                  candidateCount: allIds.length,
              };

        if (allIds.length === 0) {
            return {
                success: true,
                itemsProcessed: totals.updated + totals.skipped + totals.errors,
                result: totals,
            };
        }

        // Process in chunks so the abort signal is checked between each chunk.
        // batchAggregateMetadata does not accept a signal; chunking here gives
        // timely cancellation without requiring changes to the inner function.
        for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
            if (signal.aborted) {
                logger.info('metadata-aggregation-backfill: aborted', {
                    processedSoFar: i,
                    ...totals,
                });
                break;
            }

            const chunk = allIds.slice(i, i + CHUNK_SIZE);
            const chunkIndex = Math.floor(i / CHUNK_SIZE) + 1;
            const totalChunks = Math.ceil(allIds.length / CHUNK_SIZE);

            logger.debug(`metadata-aggregation-backfill: chunk ${chunkIndex}/${totalChunks}`, {
                chunkSize: chunk.length,
            });

            try {
                const stats = await batchAggregateMetadata(sql, chunk);
                totals.updated += stats.updated;
                totals.skipped += stats.skipped;
                totals.errors += stats.errors;
            } catch {
                // Broken by cancel/shutdown (pool closing), not a real failure:
                // don't count it and don't checkpoint past it — a resumed run
                // re-does it (the upsert is idempotent).
                if (signal.aborted) break;
                logger.error('metadata-aggregation-backfill: chunk failed', {
                    chunkIndex,
                    chunkSize: chunk.length,
                });
                totals.errors += chunk.length;
            }
            // The chunk reached a final outcome (each upsert commits on its
            // own; a genuinely failed chunk is counted in `errors`, as before).
            await ctx.checkpoint?.save({
                v: AGGREGATION_CHECKPOINT_VERSION,
                afterMediaId: chunk[chunk.length - 1],
                totals,
            } satisfies AggregationCheckpoint);
        }

        logger.info('metadata-aggregation-backfill: completed', totals);

        const itemsProcessed = totals.updated + totals.skipped + totals.errors;
        // Stopped by cancel or a shutdown: not a finished pass.
        if (signal.aborted) {
            return { success: false, itemsProcessed, result: totals, stopReason: 'aborted' };
        }
        return {
            success: true,
            itemsProcessed,
            result: totals,
        };
    },
});

registry.registerTask(metadataAggregationBackfillTask);
