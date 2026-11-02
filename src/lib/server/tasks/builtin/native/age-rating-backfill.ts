// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native maintenance task: age-rating-backfill.
 *
 * Re-derives `media_items.age_rating` from national certifications (FSK, MPAA,
 * BBFC, ...) for titles rated before the national certification became the source
 * of truth. The national certification wins over MDBList; MDBList only fills gaps.
 * See `age-rating-backfill.service.ts` for the two phases.
 *
 * Rate limited: at most `limit` TMDB detail requests per run (default 200),
 * paced at ~3 requests per second, once an hour and on startup. Converges: every
 * title answered by TMDB carries an `age_rating_country_checked` stamp and leaves
 * the candidate set; changing the Age Rating Country setting makes all titles
 * candidates again.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import { config } from '$lib/server/config.js';
import { effectiveAgeRatingCountry } from '$lib/server/utils/age-rating-country.js';
import { invokeProviderDetail } from '$lib/server/tasks/plugin-context.js';
import { encodeDetailId } from '$lib/server/providers/encode-id.js';
import { isProviderNotFoundError } from '$lib/server/providers/not-found.js';
import { batchAggregateMetadata } from '$lib/server/database/queries/metadata-aggregation.queries.js';
import {
    deriveFromStoredCertifications,
    findCertificationLookupCandidates,
    lookupCertifications,
} from '$lib/server/services/age-rating-backfill.service.js';

const DEFAULT_BATCH = 200;
const REQUEST_PACING_MS = 330;
const REQUEST_TIMEOUT_MS = 30_000;
const TMDB_PLUGIN_ID = 'tmdb-metadata-provider';

const inputSchema = z
    .object({
        /** Max TMDB lookups this run. */
        limit: z.number().int().min(1).max(2000).optional(),
    })
    .passthrough();

type AgeRatingBackfillInput = z.infer<typeof inputSchema>;

interface AgeRatingBackfillResult {
    /** Titles with a stored certification that were considered (phase A). */
    storedScanned: number;
    /** Age ratings written from stored certifications (phase A). */
    storedWritten: number;
    /** TMDB lookups attempted (phase B). */
    lookups: number;
    /** Lookups that produced a national certification. */
    lookupWritten: number;
    /** Lookups where TMDB has no usable certification. */
    noCertification: number;
    notFound: number;
    failed: number;
}

export const ageRatingBackfillTask = defineTask<AgeRatingBackfillInput, AgeRatingBackfillResult>({
    id: 'age-rating-backfill',
    purpose: 'library',
    name: 'Age Rating Backfill',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    schedule: { every: '1h', runOnStartup: true },

    identityFor: () => 'global',
    scope: 'global',
    resourceClass: 'maintenance',
    quotas: { maxConcurrent: 1 },
    exclusiveWith: { scope: 'global', ttl: '20m' },
    inputSchema,
    timeout: { hard: '15m', soft: '13m' },
    cost: { kind: 'api_calls' },

    async execute(ctx) {
        return withApiCallSpend(ctx, async () => {
            const { logger, sql, signal } = ctx;
            const limit = ctx.input.limit ?? DEFAULT_BATCH;
            const country = effectiveAgeRatingCountry();

            // A: certifications already stored. No network.
            const stored = await deriveFromStoredCertifications(sql, {
                shouldAbort: () => signal.aborted,
                country,
            });

            // B: titles TMDB has not been asked about for this country.
            let lookups = 0;
            let lookupWritten = 0;
            let noCertification = 0;
            let notFound = 0;
            let failed = 0;

            if (config.TMDB_API_KEY?.trim() && !signal.aborted) {
                const candidates = await findCertificationLookupCandidates(sql, country, limit);
                lookups = candidates.length;
                if (candidates.length > 0) {
                    logger.info('age-rating-backfill: looking up certifications', {
                        candidates: candidates.length,
                        country,
                    });
                    const result = await lookupCertifications(sql, candidates, country, {
                        fetchDetail: async (candidate) => {
                            const controller = new AbortController();
                            const onAbort = (): void => controller.abort();
                            signal.addEventListener('abort', onAbort);
                            const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
                            try {
                                return await invokeProviderDetail<unknown>(
                                    TMDB_PLUGIN_ID,
                                    encodeDetailId(
                                        TMDB_PLUGIN_ID,
                                        candidate.media_type,
                                        candidate.external_id,
                                    ),
                                    { signal: controller.signal },
                                );
                            } finally {
                                clearTimeout(timer);
                                signal.removeEventListener('abort', onAbort);
                            }
                        },
                        isNotFound: isProviderNotFoundError,
                        pace: () => new Promise((resolve) => setTimeout(resolve, REQUEST_PACING_MS)),
                        shouldAbort: () => signal.aborted,
                        onError: (candidate, err) =>
                            logger.warn('age-rating-backfill: TMDB lookup failed', {
                                mediaId: candidate.media_id,
                                error: err instanceof Error ? err.message : String(err),
                            }),
                    });
                    lookupWritten = result.written;
                    noCertification = result.noCertification;
                    notFound = result.notFound;
                    failed = result.failed;

                    // The detail API reads the 'aggregated' row: rebuild it so the
                    // stored certification shows up next to the new age.
                    if (result.touchedIds.length > 0) {
                        try {
                            await batchAggregateMetadata(sql, result.touchedIds);
                        } catch (err) {
                            logger.warn('age-rating-backfill: re-aggregation failed', {
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                    }
                }
            }

            const result: AgeRatingBackfillResult = {
                storedScanned: stored.scanned,
                storedWritten: stored.written,
                lookups,
                lookupWritten,
                noCertification,
                notFound,
                failed,
            };
            logger.info('age-rating-backfill: cycle complete', result);

            if (lookups > 0 && failed === lookups) {
                throw new TaskError({
                    message: `age-rating-backfill: all ${lookups} lookups failed`,
                    kind: 'transient',
                });
            }
            return {
                success: true,
                itemsProcessed: stored.written + lookupWritten,
                result,
            };
        });
    },
});

registry.registerTask(ageRatingBackfillTask);
