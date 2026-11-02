// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Embedding Projection Backfill Task
 *
 * APPLY-ONLY drain: stamps the quantized 64-dim download-pool projection
 * (`projected_vector` + `projection_version`) onto `media_audio_embeddings`
 * rows that don't yet carry one for the current `EMBEDDING_PROJECTION_VERSION`
 * — either because they predate the feature, or because a version bump moved
 * the goalposts and this hasn't caught up yet. See
 * `.superpowers/embedding-quantization-eval.md` and migration 16.224.0.
 *
 * This task NEVER fits a basis — it loads whatever
 * `music-embedding-projection-fit` has already produced (via
 * `getActiveProjectionBasis`, which itself refuses to return anything but an
 * exact `EMBEDDING_PROJECTION_VERSION` match) and only APPLIES it. When no
 * basis exists yet, this is a clean no-op: fresh install, or the operator
 * hasn't run the fit task yet. New embeddings get their projection stamped
 * inline by `sonic-embedding-backfill` once a basis exists; this task's job
 * is strictly the backlog of pre-existing rows (and rows left behind by a
 * version bump).
 *
 * Mirrors `sonic-embedding-backfill.ts`'s chunked drain-loop shape, without
 * the external Python sidecar: this is pure in-process matrix-vector math
 * per row (a 1024x64 multiply, ~65k multiply-adds), so it runs on the `cpu`
 * resource class rather than `embedding`.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext, BacklogStage } from '@sapd/lumastra-plugin-sdk';
import type postgres from 'postgres';
import { registry } from '../../registry.js';
import { MSCLAP_MODEL_ID } from '$lib/server/database/queries/sonic-constants.js';
import {
    EMBEDDING_PROJECTION_VERSION,
    getActiveProjectionBasis,
    fetchPendingProjectionRows,
    countPendingProjectionRows,
    updateEmbeddingProjection,
} from '$lib/server/database/queries/music-embedding-projection.queries.js';
import {
    projectAndQuantize,
    int8VectorToBuffer,
} from '../../../services/music-embedding-projection/quantize.js';
import { parsePgVectorText } from '$lib/server/database/queries/music-alchemy.queries.js';
import { sleepOrResolve } from '$lib/server/utils/abortable-sleep.js';

/** How many embedding rows to fetch and project per drain iteration. Cheap per-row work, so a large chunk amortises the round trip. */
const DRAIN_CHUNK_SIZE = 500;

/**
 * Backoff between drain rounds that projected nothing, and the round count
 * that gives up rather than hot-looping. `fetchPendingProjectionRows`'s
 * selection predicate is "not yet stamped with the current version" with no
 * ordering/offset, so a row that can never be written (a non-finite element
 * -- `parsePgVectorText` returns `null` -- or a dimension mismatch against
 * the basis) is re-selected on every single iteration forever: `rows.length`
 * is never 0, so the old `rows.length === 0` exit never fires, and the loop
 * would otherwise spin with no sleep until the 2h hard timeout, holding the
 * `maxConcurrent: 1` slot the whole time. Mirrors sonic-embedding-backfill's
 * identical guard (NO_PROGRESS_BACKOFF_MS / MAX_NO_PROGRESS_ROUNDS).
 */
const NO_PROGRESS_BACKOFF_MS = 5_000;
const MAX_NO_PROGRESS_ROUNDS = 4;

const inputSchema = z.object({}).passthrough();
type BackfillInput = z.infer<typeof inputSchema>;

interface BackfillResult {
    projected: number;
    parseErrors: number;
}

export const musicEmbeddingProjectionBackfillTask = defineTask<BackfillInput, BackfillResult>({
    id: 'music-embedding-projection-backfill',
    purpose: 'music-ai',
    name: 'Music Embedding Projection Backfill',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    // Every 2h, same cadence as sonic-embedding-backfill (whose new rows this
    // catches up on) — a clean no-op when no basis exists yet or nothing is
    // pending, so there is no cost to leaving this scheduled.
    schedule: { every: '2h', runOnStartup: false },

    // Pure in-process compute (matrix-vector multiply), not GPU/API-bound —
    // 'cpu', not 'embedding' (reserved for the sidecar-backed embedder).
    resourceClass: 'cpu',
    quotas: { maxConcurrent: 1 },

    scope: 'global',
    identityFor: () => 'global',

    inputSchema,

    timeout: { hard: '2h', soft: '110m' },

    async execute(ctx) {
        const { sql: rawSql, signal, reportProgress, logger: ctxLogger } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        const basis = await getActiveProjectionBasis(sql, MSCLAP_MODEL_ID);
        if (!basis) {
            ctxLogger.info(
                'No projection basis for the current EMBEDDING_PROJECTION_VERSION yet — nothing to backfill (run music-embedding-projection-fit first)',
                { modelId: MSCLAP_MODEL_ID, version: EMBEDDING_PROJECTION_VERSION },
            );
            return {
                success: true,
                itemsProcessed: 0,
                result: { projected: 0, parseErrors: 0 },
                message: 'No active basis — no-op',
            };
        }

        let projected = 0;
        let parseErrors = 0;
        let totalSeen = 0;
        let consecutiveNoProgress = 0;

        while (!signal.aborted) {
            const rows = await fetchPendingProjectionRows(
                sql,
                MSCLAP_MODEL_ID,
                EMBEDDING_PROJECTION_VERSION,
                DRAIN_CHUNK_SIZE,
            );
            if (rows.length === 0) {
                ctxLogger.info(
                    'No more embeddings pending a current-version projection — drain complete',
                );
                break;
            }

            let projectedThisChunk = 0;
            for (const row of rows) {
                if (signal.aborted) break;

                const parsed = parsePgVectorText(row.embedding);
                if (!parsed || parsed.length !== basis.inputDim) {
                    // Malformed/wrong-dim row — skip rather than crash the whole
                    // drain; leaves it eligible to be revisited (it will keep
                    // being re-selected, same trade-off as sonic-embedding-backfill's
                    // 'failed' rows -- acceptable since this indicates a data
                    // problem elsewhere, not something retrying here fixes).
                    parseErrors++;
                    continue;
                }

                try {
                    const quantized = projectAndQuantize(parsed, basis);
                    await updateEmbeddingProjection(
                        sql,
                        row.media_id,
                        MSCLAP_MODEL_ID,
                        basis.version,
                        int8VectorToBuffer(quantized),
                    );
                    projected++;
                    projectedThisChunk++;
                } catch (err) {
                    ctxLogger.warn('Failed to write projected vector for a track', {
                        mediaId: row.media_id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    // Leave eligible for the next round — likely a transient DB error.
                }

                totalSeen++;
                reportProgress(totalSeen, totalSeen + rows.length, row.media_id);
            }

            ctxLogger.info('Backfill chunk complete', {
                chunkSize: rows.length,
                projected,
                parseErrors,
            });

            // Spin guard -- see NO_PROGRESS_BACKOFF_MS/MAX_NO_PROGRESS_ROUNDS
            // docstring above. A chunk that projected nothing means the same
            // still-eligible row(s) will just be re-selected next round, so
            // pace the retry and give up after a few fruitless rounds rather
            // than burning the full 2h hard timeout on it -- the next
            // scheduled/manual run retries.
            if (projectedThisChunk === 0) {
                consecutiveNoProgress++;
                if (consecutiveNoProgress >= MAX_NO_PROGRESS_ROUNDS) {
                    ctxLogger.warn(
                        'Music embedding projection backfill made no progress for several rounds — stopping (will retry on next scheduled/manual run)',
                        { rounds: consecutiveNoProgress },
                    );
                    break;
                }
                await sleepOrResolve(NO_PROGRESS_BACKOFF_MS, signal);
            } else {
                consecutiveNoProgress = 0;
            }
        }

        const message = `Music embedding projection backfill: ${projected} projected, ${parseErrors} parse errors`;
        ctxLogger.info(message);

        return {
            success: true,
            itemsProcessed: projected,
            result: { projected, parseErrors },
            message,
        };
    },

    backlog: {
        unitLabel: 'embeddings',
        sliceSize: DRAIN_CHUNK_SIZE,
        softBudget: '1s',
        idOf: (row) => {
            const r = row as { media_id?: string } | null | undefined;
            return r?.media_id ?? String(r);
        },
        async stages(ctx: TaskContext): Promise<BacklogStage[]> {
            const sql = ctx.sql as unknown as postgres.Sql;
            const basis = await getActiveProjectionBasis(sql, MSCLAP_MODEL_ID);
            if (!basis) return [];
            const pending = await countPendingProjectionRows(
                sql,
                MSCLAP_MODEL_ID,
                EMBEDDING_PROJECTION_VERSION,
            );
            return pending > 0 ? [{ id: 'pending', label: 'Pending', count: pending }] : [];
        },
        async compute(): Promise<{ items: unknown[]; remainingHint?: number }> {
            // Not used for pagination — execute() drives the drain loop directly.
            return { items: [], remainingHint: 0 };
        },
    },
});

// Self-register into the singleton registry.
registry.registerTask(musicEmbeddingProjectionBackfillTask);
