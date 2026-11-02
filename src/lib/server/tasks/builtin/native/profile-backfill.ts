// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Profile Backfill Task
 *
 * Proactively builds (or refreshes) `user_profiles.catalog_embedding` for all
 * users who have enough watch activity but whose profile is missing or stale.
 *
 * Phase A introduced `UserProfileService.rebuildUserProfile()` which combines
 * ratings AND watch history into a single centroid embedding. New users get a
 * profile lazily the first time they hit /api/ai/suggestions — but existing
 * users with heavy watch history and a NULL embedding are never proactively
 * touched. This task closes that gap.
 *
 * Behaviour:
 *   - `userId` input: rebuild that single user immediately and return.
 *   - Drain loop (default): page through `findProfileBackfillCandidates` in
 *     batches; rebuild each user; yield to the event loop between users so the
 *     serving path is never starved.
 *   - `staleOnly: false` / `force: true`: rebuild users even when they already
 *     have a non-null embedding. Tracks a processed Set so the drain loop
 *     doesn't loop forever over the same top-N candidates (they won't drop
 *     off the candidate list after a forced rebuild because their embedding is
 *     now non-null and not stale).
 *
 * Resource class:
 *   'maintenance' — no embedding-API calls, only DB reads (precomputed vectors)
 *   and a pgvector average. Yields to the serving path.
 *
 * Schedule: every 6 h, runOnStartup: false.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { registry } from '../../registry.js';
import { findProfileBackfillCandidates } from '../../../database/queries/profile-backfill.queries.js';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import type { UserProfile } from '$lib/server/database/connection.js';

const logger = Logger.for('ProfileBackfill');

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BATCH_SIZE = 50;

// =============================================================================
// Schema / types
// =============================================================================

const inputSchema = z.object({
    /** Process only this specific user ID (admin one-shot mode). */
    userId: z.string().optional(),
    /** Maximum users to process per page in drain loop. Default: 50. */
    batchSize: z.number().int().positive().optional(),
    /**
     * When true (default), only rebuild users whose embedding pre-dates their
     * most recent watch or rating activity. When false / when `force` is true,
     * rebuild every eligible user regardless of freshness.
     */
    staleOnly: z.boolean().optional(),
    /**
     * Alias for `staleOnly: false`. When true, ignore the staleness gate and
     * rebuild every eligible user. The in-run processed Set prevents infinite
     * loops over the same top-N candidates.
     */
    force: z.boolean().optional(),
});

type ProfileBackfillInput = z.infer<typeof inputSchema>;

interface ProfileBackfillResult {
    processed: number;
    skipped: number;
}

// =============================================================================
// Task definition
// =============================================================================

export const profileBackfillTask = defineTask<ProfileBackfillInput, ProfileBackfillResult>({
    id: 'profile-backfill',
    purpose: 'music-ai',
    name: 'User Profile Backfill',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    resourceClass: 'maintenance',
    quotas: { maxConcurrent: 1 },

    scope: 'global',
    identityFor: () => 'global',

    schedule: { every: '6h', runOnStartup: false },

    inputSchema,

    timeout: { hard: '4h', soft: '3h' },

    async execute(ctx): Promise<{
        success: boolean;
        itemsProcessed: number;
        result: ProfileBackfillResult;
        message?: string;
    }> {
        const { sql: rawSql, signal, reportProgress, logger: ctxLogger } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        const input = ctx.input as ProfileBackfillInput;
        const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
        const force = input.force ?? false;
        const staleOnly = force ? false : (input.staleOnly ?? true);
        const minWatched = config.FORYOU_MIN_WATCHED;

        // Lazy import — keep the service import out of the orchestrator boot path.
        const { aiDbService } = await import('$lib/server/services/database.service.js');

        const profileService = await aiDbService.getUserProfileService();
        if (!profileService) {
            ctxLogger.warn('UserProfileService unavailable — profile backfill skipped');
            return {
                success: false,
                itemsProcessed: 0,
                result: { processed: 0, skipped: 0 },
                message: 'UserProfileService unavailable',
            };
        }

        // ── Single-user mode ────────────────────────────────────────────────
        if (input.userId) {
            ctxLogger.info('Profile backfill: single-user mode', { userId: input.userId });
            try {
                // rebuildUserProfile catches internally and returns null on
                // failure (or when no usable embedding could be built) — it does
                // not throw. A null result is a skip, not a success.
                const profile: UserProfile | null = await profileService.rebuildUserProfile(
                    input.userId as UserId,
                );
                const built = profile !== null;
                return {
                    success: built,
                    itemsProcessed: built ? 1 : 0,
                    result: { processed: built ? 1 : 0, skipped: built ? 0 : 1 },
                    message: built
                        ? `Rebuilt profile for user ${input.userId}`
                        : `No usable profile built for user ${input.userId}`,
                };
            } catch (err) {
                // Defensive only — the service is not expected to throw.
                logger.warn('Profile rebuild failed for single user', {
                    userId: input.userId,
                    error: err instanceof Error ? err.message : String(err),
                });
                return {
                    success: false,
                    itemsProcessed: 0,
                    result: { processed: 0, skipped: 1 },
                    message: `Failed to rebuild profile for user ${input.userId}`,
                };
            }
        }

        // ── Drain loop ──────────────────────────────────────────────────────
        // When force=true (staleOnly=false), a rebuilt user still appears in
        // the next page because their embedding is non-null but not stale.
        // Track processed IDs within this run to avoid infinite loops.
        const processedIds = new Set<string>();
        let processed = 0;
        let skipped = 0;

        ctxLogger.info('Profile backfill: drain loop starting', {
            batchSize,
            staleOnly,
            force,
            minWatched,
        });

        while (!signal.aborted) {
            const candidates = await findProfileBackfillCandidates(sql, {
                limit: batchSize,
                staleOnly,
                minWatched,
            });

            // Filter out already-processed users (relevant when force=true
            // since a rebuilt user won't drop off the candidate list).
            const pending = candidates.filter((c) => !processedIds.has(c.user_id));

            if (pending.length === 0) {
                ctxLogger.info('Profile backfill: drain complete', { processed, skipped });
                break;
            }

            for (let i = 0; i < pending.length; i++) {
                if (signal.aborted) break;

                const candidate = pending[i];
                const userId = candidate.user_id as UserId;

                try {
                    // rebuildUserProfile catches internally and returns null on
                    // failure / when no usable embedding could be built — it does
                    // NOT throw, so null (not an exception) is the failure signal.
                    const profile: UserProfile | null =
                        await profileService.rebuildUserProfile(userId);
                    processedIds.add(candidate.user_id);
                    if (profile !== null) {
                        processed++;
                    } else {
                        skipped++;
                    }
                } catch (err) {
                    // Defensive only — the service is not expected to throw.
                    logger.warn('Profile rebuild failed', {
                        userId: candidate.user_id,
                        watchedCount: candidate.watched_count,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    processedIds.add(candidate.user_id);
                    skipped++;
                }

                // Monotonic progress: numerator (done) only grows; denominator is
                // done + users still left in THIS page, so it never resets backward
                // (it may extend when the next page loads — expected for a drain).
                const done = processed + skipped;
                const remainingInPage = pending.length - (i + 1);
                reportProgress(done, done + remainingInPage, candidate.user_id);

                // Yield to the event loop between users so the serving path
                // (HTTP requests, heartbeat) is not starved by a tight CPU loop.
                await new Promise<void>((resolve) => setImmediate(resolve));
            }

            ctxLogger.info('Profile backfill: batch complete', { processed, skipped });
        }

        const message = `Profile backfill: ${processed} rebuilt, ${skipped} skipped`;
        ctxLogger.info(message);

        return {
            success: true,
            itemsProcessed: processed,
            result: { processed, skipped },
            message,
        };
    },
});

// Self-register into the singleton registry (mirrors lyrics-ingestion-backfill.ts pattern).
registry.registerTask(profileBackfillTask);
