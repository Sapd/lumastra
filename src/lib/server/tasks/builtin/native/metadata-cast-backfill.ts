// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native maintenance task: metadata-cast-backfill.
 *
 * Backfills structured cast (name + character + TMDB person id) onto library
 * items that were synced before `syncMissingMetadata` started persisting it,
 * or whose candidate predicate for `actors` was already satisfied by the
 * flat name list — see `sync-missing-metadata.ts`'s forward fix. Without
 * this backfill, `GET /api/v1/media/{id}?include=details` returns
 * `actors[]` with `name` set but `character`/`profileUrl` null for those
 * items forever, since the metadata-update stage never re-asks for a field
 * it already considers complete.
 *
 * Mirrors the deleted one-off `backfill-cast-structured.ts` script (removed
 * 2026-09-12): same candidate shape, same `buildStructuredCast` reduction,
 * same primary-provider write + re-aggregate — but as a scheduled,
 * batch-limited, resumable task instead of a manual dry-run/apply CLI.
 *
 * Scheduled daily, off-peak. Batch-limited so a large backlog trickles
 * rather than floods the primary provider's rate budget; candidates are
 * re-selected fresh each run (no cursor needed) because every successful
 * fetch attempt — even one that finds no cast — writes `cast_synced_at`,
 * removing the item from the candidate set.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type { ProviderDetailResult } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import type postgres from 'postgres';
import {
    findCastAggregationGaps,
    findCastBackfillCandidates,
} from '$lib/server/database/queries/ai-sync.queries.js';
import { upsertProviderMetadataUnlessLocked } from '$lib/server/database/queries/media-upsert.js';
import { batchAggregateMetadata } from '$lib/server/database/queries/metadata-aggregation.queries.js';
import { buildStructuredCast } from '$lib/server/ai/tmdb-metadata-sync.js';
import { invokeProviderDetail } from '$lib/server/tasks/plugin-context.js';
import { encodeDetailId } from '$lib/server/providers/encode-id.js';
import { isProviderNotFoundError } from '$lib/server/providers/not-found.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';

/** Candidates processed per scheduled run when the caller doesn't override `limit`. */
const DEFAULT_BATCH = 300;
/** Pause between provider detail calls, matching syncMissingMetadata's pacing. */
const REQUEST_PACING_MS = 150;
/** Per-request cap so a stalled provider response can't wedge the whole run. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Map an ExternalIdProvider key (e.g. 'tmdb') to its registered plugin id. */
const EXTERNAL_ID_TO_PLUGIN_ID: Record<string, string> = {
    tmdb: 'tmdb-metadata-provider',
};

function externalIdToPluginId(externalId: string): string {
    return EXTERNAL_ID_TO_PLUGIN_ID[externalId] ?? externalId;
}

const inputSchema = z
    .object({
        /** Max candidates fetched + written this run. */
        limit: z.number().int().min(1).max(2000).optional(),
    })
    .passthrough();

type MetadataCastBackfillInput = z.infer<typeof inputSchema>;

interface MetadataCastBackfillResult {
    /** Candidates missing structured cast considered this cycle. */
    candidates: number;
    /** Items whose provider detail yielded a non-empty structured cast. */
    written: number;
    /** Items whose provider detail returned no cast (marker still stamped). */
    noCast: number;
    /** Items re-aggregated because a source row had cast the aggregated row lacked. */
    reaggregated: number;
    /** Items whose provider id no longer exists upstream (404/410) — marker stamped. */
    notFound: number;
    /** Items whose provider fetch errored — left as candidates for next run. */
    failed: number;
}

/** Most gap items re-aggregated per run; in-DB only, so generous. */
const MAX_GAP_REAGGREGATE = 20_000;
const GAP_CHUNK = 500;

/**
 * Re-aggregate items whose source row carries structured cast that their
 * 'aggregated' row (what the detail API reads) lacks. Self-heals the
 * pre-2026-09-24 aggregator drop and any future regression of it. Never
 * throws: a failure here must not fail the fetch pass above.
 */
async function healAggregationGaps(ctx: {
    sql: postgres.Sql;
    signal: AbortSignal;
    logger: { info: (m: string, d?: object) => void; warn: (m: string, d?: object) => void };
}): Promise<number> {
    const { sql, signal, logger } = ctx;
    try {
        const ids = await findCastAggregationGaps(sql, MAX_GAP_REAGGREGATE);
        let updated = 0;
        for (let i = 0; i < ids.length && !signal.aborted; i += GAP_CHUNK) {
            const stats = await batchAggregateMetadata(sql, ids.slice(i, i + GAP_CHUNK));
            updated += stats.updated;
        }
        if (ids.length > 0) {
            logger.info('metadata-cast-backfill: healed aggregation gaps', {
                gaps: ids.length,
                reaggregated: updated,
            });
        }
        return updated;
    } catch (error) {
        logger.warn('metadata-cast-backfill: aggregation-gap pass failed', {
            error: error instanceof Error ? error.message : String(error),
        });
        return 0;
    }
}

export const metadataCastBackfillTask = defineTask<
    MetadataCastBackfillInput,
    MetadataCastBackfillResult
>({
    id: 'metadata-cast-backfill',
    purpose: 'library',
    name: 'Metadata Cast Backfill',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    // Off-peak daily trickle, same shape as episode-thumbnail-backfill: a
    // small batch per cycle converges over time without contending with the
    // primary provider's rate budget or the metadata-update stage's own
    // quota.
    schedule: { every: '24h', runOnStartup: false },

    identityFor: () => 'global',
    scope: 'global',
    resourceClass: 'maintenance',
    quotas: { maxConcurrent: 1 },
    // Singleton guard against the scheduler's narrow double-fire window; ttl
    // exceeds the hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '35m' },
    inputSchema,
    timeout: { hard: '30m', soft: '28m' },
    cost: { kind: 'api_calls' },

    async execute(ctx) {
        // Record this task's TMDB detail requests on the cost page (it was the
        // one TMDB-calling task not wrapped, so its volume was invisible).
        return withApiCallSpend(ctx, async () => {
            const { logger, sql, signal } = ctx;
            const limit = ctx.input.limit ?? DEFAULT_BATCH;
            const primaryProvider = getPrimaryExternalIdProvider();
            const pluginId = externalIdToPluginId(primaryProvider);

            const candidates = await findCastBackfillCandidates(sql, limit);

            if (candidates.length === 0) {
                logger.debug('metadata-cast-backfill: no candidates missing structured cast');
                const reaggregated = await healAggregationGaps(ctx);
                return {
                    success: true,
                    itemsProcessed: reaggregated,
                    result: {
                        candidates: 0,
                        written: 0,
                        noCast: 0,
                        notFound: 0,
                        failed: 0,
                        reaggregated,
                    },
                };
            }

            logger.info('metadata-cast-backfill: candidates found', {
                candidateCount: candidates.length,
            });

            const touchedIds: string[] = [];
            let written = 0;
            let noCast = 0;
            let notFound = 0;
            let failed = 0;

            for (const [i, candidate] of candidates.entries()) {
                if (signal.aborted) {
                    logger.info('metadata-cast-backfill: aborted', {
                        processedSoFar: i,
                        written,
                        noCast,
                        notFound,
                        failed,
                    });
                    break;
                }

                const controller = new AbortController();
                const onParentAbort = (): void => controller.abort();
                signal.addEventListener('abort', onParentAbort);
                const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

                try {
                    const encodedId = encodeDetailId(
                        pluginId,
                        candidate.media_type,
                        candidate.external_id,
                    );
                    const detail = await invokeProviderDetail<ProviderDetailResult>(
                        pluginId,
                        encodedId,
                        {
                            signal: controller.signal,
                        },
                    );

                    const structured = buildStructuredCast(detail?.cast);

                    // Always stamp the marker after a fetch attempt that returned a
                    // detail — even an empty cast is an answer, and without the
                    // marker this candidate would be re-selected and re-fetched
                    // forever. Only a THROWN fetch (handled in the catch below)
                    // leaves the item as a candidate for the next run.
                    await upsertProviderMetadataUnlessLocked(
                        sql,
                        candidate.media_id,
                        primaryProvider,
                        {
                            ...(structured.length > 0 ? { cast: structured } : {}),
                            cast_synced_at: new Date().toISOString(),
                        },
                    );
                    touchedIds.push(candidate.media_id);

                    if (structured.length > 0) {
                        written++;
                    } else {
                        noCast++;
                    }

                    ctx.reportProgress(i + 1, candidates.length);
                } catch (err) {
                    let stamped = false;
                    if (isProviderNotFoundError(err)) {
                        // The id was deleted upstream: a definitive answer, not an
                        // outage. Stamp the same exclusion marker as the empty-cast
                        // case so the item leaves the candidate set for good.
                        try {
                            await upsertProviderMetadataUnlessLocked(
                                sql,
                                candidate.media_id,
                                primaryProvider,
                                {
                                    cast_synced_at: new Date().toISOString(),
                                    cast_sync_error: 'not_found',
                                },
                            );
                            stamped = true;
                        } catch (markerErr) {
                            logger.warn('metadata-cast-backfill: not-found marker write failed', {
                                mediaId: candidate.media_id,
                                error:
                                    markerErr instanceof Error
                                        ? markerErr.message
                                        : String(markerErr),
                            });
                        }
                    }
                    if (stamped) {
                        notFound++;
                        logger.info('metadata-cast-backfill: provider id not found, marked', {
                            mediaId: candidate.media_id,
                            externalId: candidate.external_id,
                        });
                        ctx.reportProgress(i + 1, candidates.length);
                    } else {
                        failed++;
                        logger.warn('metadata-cast-backfill: provider fetch failed', {
                            mediaId: candidate.media_id,
                            externalId: candidate.external_id,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                } finally {
                    clearTimeout(timeout);
                    signal.removeEventListener('abort', onParentAbort);
                }

                if (REQUEST_PACING_MS > 0 && i < candidates.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, REQUEST_PACING_MS));
                }
            }

            // The detail API reads the highest-priority ('aggregated')
            // provider_metadata row, so writing `cast` to the primary provider's
            // row alone is invisible until 'aggregated' is rebuilt to include it.
            if (touchedIds.length > 0) {
                try {
                    const aggStats = await batchAggregateMetadata(sql, touchedIds);
                    logger.info('metadata-cast-backfill: re-aggregation complete', {
                        aggregated: aggStats.updated,
                        skipped: aggStats.skipped,
                        errors: aggStats.errors,
                    });
                } catch (aggError) {
                    logger.warn(
                        'metadata-cast-backfill: re-aggregation failed — provider rows written, aggregated row may be stale',
                        { error: aggError instanceof Error ? aggError.message : String(aggError) },
                    );
                }
            }

            const reaggregated = await healAggregationGaps(ctx);

            const result: MetadataCastBackfillResult = {
                candidates: candidates.length,
                written,
                noCast,
                notFound,
                failed,
                reaggregated,
            };

            logger.info('metadata-cast-backfill: cycle complete', result);

            // A cycle where EVERY candidate errored is a real failure — throw so
            // the run is marked failed and the circuit breaker can quarantine a
            // persistently broken provider, rather than logging success while
            // making zero progress.
            if (failed > 0 && failed === candidates.length) {
                throw new TaskError({
                    message: `metadata-cast-backfill: all ${candidates.length} candidates errored`,
                    kind: 'transient',
                });
            }

            return {
                success: true,
                itemsProcessed: written + noCast,
                result,
            };
        });
    },
});

registry.registerTask(metadataCastBackfillTask);
