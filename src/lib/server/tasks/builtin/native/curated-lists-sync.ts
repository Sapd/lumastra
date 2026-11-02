// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Curated Lists Sync — native defineTask implementation.
 *
 * Synchronizes curated lists (trending, popular, etc.) from external sources.
 *
 * Configuration:
 * - SYNC_CURATED_LISTS_HOURS: Duration-string override for the 12h cadence
 *   (e.g. '6h', '1d'). Read via schedule.envOverride.
 * - DISABLE_CURATED_LISTS_SYNC: Set to 'true' to disable this task entirely
 *   (both scheduled and manual triggers). Checked at execute() entry.
 *   Note: schedule.envOverride is for interval override only, not full-disable;
 *   we gate here instead so manual triggers are also blocked.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import { config } from '$lib/server/config.js';

type CuratedListsSyncInput = Record<string, unknown>;

interface CuratedListsSyncResult {
    listsSynced: number;
    listsFailed: number;
    itemsSynced: number;
    stopped: boolean;
    errors: string[];
    message: string;
}

const inputSchema = z.object({}).passthrough();

export const curatedListsSyncTask = defineTask<CuratedListsSyncInput, CuratedListsSyncResult>({
    id: 'curated-lists-sync',
    purpose: 'library',
    name: 'Curated Lists Sync',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },

    schedule: {
        every: '12h',
        runOnStartup: false,
        envOverride: 'SYNC_CURATED_LISTS_HOURS',
    },
    feedsInto: ['library-embeddings'],

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    resourceClass: 'io',

    inputSchema,

    timeout: { hard: '60m', soft: '55m' },
    cost: { kind: 'api_calls' },

    // Singleton guard: spends real TMDB/MDBList API quota (cost: 'api_calls').
    // Without exclusiveWith, the scheduler's narrow double-fire window
    // (fast-completing run + failed scheduler_state advance) can spawn a
    // second concurrent 'global-catchup' sweep that doubles spend for no
    // extra coverage. identityFor is mode-suffixed but stable for the
    // scheduled entry point ('global-catchup' — same shape as watch-sync-pull/
    // push). ttl exceeds the 60m hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '70m' },

    async execute(ctx) {
        return withApiCallSpend(ctx, async () => {
            const { logger, signal } = ctx;

            if (config.DISABLE_CURATED_LISTS_SYNC) {
                return {
                    success: true,
                    itemsProcessed: 0,
                    result: {
                        listsSynced: 0,
                        listsFailed: 0,
                        itemsSynced: 0,
                        stopped: false,
                        errors: [],
                        message: 'curated-lists-sync disabled via DISABLE_CURATED_LISTS_SYNC',
                    },
                };
            }

            const { mdblistApi } = await import('$lib/server/services/mdblist-api.js');
            if (!mdblistApi.isAvailable()) {
                return {
                    success: true,
                    itemsProcessed: 0,
                    result: {
                        listsSynced: 0,
                        listsFailed: 0,
                        itemsSynced: 0,
                        stopped: false,
                        errors: [],
                        message: 'MDBList not configured (no MDBLIST_API_KEY) — nothing to sync',
                    },
                };
            }

            const { syncList, CURATED_LISTS } = await import('../../../ai/list-sync.js');
            const { sleepOrResolve } = await import('$lib/server/utils/abortable-sleep.js');

            type ListSyncResult = Awaited<ReturnType<typeof syncList>>;

            if (CURATED_LISTS.length === 0) {
                return {
                    success: true,
                    itemsProcessed: 0,
                    result: {
                        listsSynced: 0,
                        listsFailed: 0,
                        itemsSynced: 0,
                        stopped: false,
                        errors: [],
                        message: 'No curated lists configured',
                    },
                };
            }

            logger.info('Starting curated lists sync...');

            const results: ListSyncResult[] = [];
            const listErrors: string[] = [];
            let total_synced = 0;
            let stopped = false;

            for (let i = 0; i < CURATED_LISTS.length; i++) {
                if (signal.aborted) {
                    stopped = true;
                    break;
                }
                const listConfig = CURATED_LISTS[i];

                try {
                    const result = await syncList(listConfig, 50, ctx.sql);
                    results.push(result);
                    total_synced += result.items_synced ?? 0;
                } catch (listError) {
                    const message =
                        listError instanceof Error ? listError.message : String(listError);
                    logger.warn(`Failed to sync list ${listConfig.name}`, {
                        error: message,
                    });
                    listErrors.push(`${listConfig.name}: ${message}`);
                }

                ctx.reportProgress(i + 1, CURATED_LISTS.length, listConfig.name);

                await sleepOrResolve(500, signal);
            }

            const successCount = results.filter((r) => r.success === true).length;
            // `syncList` NEVER rejects — it wraps its body in try/catch and always
            // RESOLVES `{ success: false, error }` on failure. So a total upstream
            // outage lands in `results` as success:false entries, NOT in the
            // `listErrors` catch path (which only fires on the rare case syncList
            // itself throws before returning). Count real failures from BOTH
            // sources so the outage guard below is actually reachable and
            // `listsFailed` reflects reality instead of always reading 0.
            const failedResults = results.filter((r) => r.success !== true).length;
            const listsFailed = failedResults + listErrors.length;
            const attempted = results.length + listErrors.length;

            logger.info('Curated lists sync completed', {
                totalSynced: total_synced,
                listsSynced: successCount,
                listsFailed,
                stopped,
            });

            const messageSuffix = listsFailed > 0 ? ` (${listsFailed} failed)` : '';
            const baseMessage = `Synced ${total_synced} items across ${successCount} of ${attempted} lists${messageSuffix}`;

            const message = stopped ? `${baseMessage} (aborted)` : baseMessage;

            // Monitoring-blindness guard: every configured list attempt failed and
            // none succeeded → total upstream outage. A returned success:false is
            // invisible — the runner records a returned result as a COMPLETED run
            // and reports SUCCESS to the circuit breaker. Throw a transient
            // TaskError instead so the run is marked failed, retried, and the
            // breaker can trip. Genuine no-work is handled earlier (an empty
            // CURATED_LISTS early-returns success). Aborts (stopped) fall through to
            // the normal return untouched. Gate on the RESULT objects (listsFailed),
            // NOT listErrors.length — syncList resolves-false rather than throwing.
            if (!stopped && successCount === 0 && listsFailed > 0) {
                // Distinguish MDBList's free-tier rate limit (self-healing, expected
                // under normal load) from a genuine upstream outage/bug — same gap
                // fixed in mdblist-sync.ts, same reasoning applies here since
                // syncList() also goes through the MDBList API.
                const isRateLimited = [
                    ...results.filter((r) => r.success !== true).map((r) => r.error),
                    ...listErrors,
                ].some((e) => e && /rate.?limit/i.test(e));
                throw new TaskError({
                    message: isRateLimited
                        ? `curated-lists-sync: rate limit reached (mdblist.com free-tier quota) — ` +
                          `resumes automatically once the quota window resets ` +
                          `(${listsFailed} list(s) deferred).`
                        : `curated-lists-sync: upstream outage — all ${listsFailed} ` +
                          `configured list(s) failed, none synced.`,
                    kind: 'transient',
                });
            }

            return {
                success: !stopped && listsFailed === 0 && successCount > 0,
                itemsProcessed: total_synced,
                stopReason: stopped ? 'aborted' : undefined,
                result: {
                    listsSynced: successCount,
                    listsFailed,
                    itemsSynced: total_synced,
                    stopped,
                    errors: listErrors,
                    message,
                },
            };
        });
    },
});

registry.registerTask(curatedListsSyncTask);
