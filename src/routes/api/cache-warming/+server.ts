// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cache Warming Status and Control Endpoint
 *
 * GET /api/cache-warming - Get warming status and progress
 * POST /api/cache-warming?action=start - Manually trigger cache warming (admin only)
 */

import type { RequestHandler } from './$types';
import { getCacheWarmingService } from '$lib/server/cache/warming';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { z } from 'zod';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('CacheWarmingEndpoint');

/**
 * Get cache warming status
 */
export const GET: RequestHandler = withErrorHandler(async ({ locals }) => {
    try {
        // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
        // IdP groups misses both non-group admin paths — the `admin_pinned` DB
        // override and the in-app `admin` capability (see buildUserPermissions).
        if (!localsIsAdmin(locals)) {
            return ApiResponses.forbidden('Admin access required to view cache warming status');
        }

        const warmingService = getCacheWarmingService();
        const progress = warmingService.getProgress();

        // Calculate additional metrics
        const percentComplete =
            progress.tasksTotal > 0
                ? Math.round((progress.tasksCompleted / progress.tasksTotal) * 100)
                : 0;

        const isRunning = progress.status === 'warming';
        const hasErrors = progress.errors.length > 0;

        const CacheWarmingStatusSchema = z
            .object({
                percentComplete: z.number(),
                isRunning: z.boolean(),
                hasErrors: z.boolean(),
                config: z.object({
                    enabled: z.boolean(),
                    trending: z.boolean(),
                    metadata: z.boolean(),
                    browse: z.boolean(),
                    activeUsersLimit: z.number(),
                    metadataLimit: z.number(),
                }),
            })
            .passthrough();

        return typedJson(CacheWarmingStatusSchema, {
            ...progress,
            percentComplete,
            isRunning,
            hasErrors,
            config: {
                enabled: process.env.CACHE_WARMING_ENABLED !== 'false',
                trending: process.env.CACHE_WARM_TRENDING !== 'false',
                metadata: process.env.CACHE_WARM_METADATA !== 'false',
                browse: process.env.CACHE_WARM_BROWSE !== 'false',
                activeUsersLimit: parseInt(process.env.CACHE_WARM_USERS_LIMIT || '20'),
                metadataLimit: parseInt(process.env.CACHE_WARM_METADATA_LIMIT || '100'),
            },
        });
    } catch (error) {
        logger.error('Failed to get cache warming status', error as Error);
        return ApiResponses.error('Failed to get cache warming status', error as Error, 500);
    }
});

/**
 * Trigger manual cache warming
 */
export const POST: RequestHandler = withErrorHandler(async ({ url, locals }) => {
    try {
        // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
        // IdP groups misses both non-group admin paths — the `admin_pinned` DB
        // override and the in-app `admin` capability (see buildUserPermissions).
        if (!localsIsAdmin(locals)) {
            return ApiResponses.forbidden('Admin access required for cache warming control');
        }

        const action = url.searchParams.get('action');

        const SuccessMessageSchema = z
            .object({
                message: z.string(),
            })
            .passthrough();

        switch (action) {
            case 'start':
                await handleStartWarming();
                return typedJson(SuccessMessageSchema, {
                    message: 'Cache warming started',
                });

            case 'reset':
                await handleResetWarming();
                return typedJson(SuccessMessageSchema, {
                    message: 'Cache warming progress reset',
                });

            default:
                return ApiResponses.badRequest('Invalid action. Use: start, reset');
        }
    } catch (error) {
        logger.error('Cache warming action failed', error as Error);
        return ApiResponses.error('Cache warming action failed', error as Error, 500);
    }
});

/**
 * Start cache warming
 */
async function handleStartWarming(): Promise<void> {
    const warmingService = getCacheWarmingService();

    // Check if already running
    if (warmingService.getProgress().status === 'warming') {
        throw new Error('Cache warming already in progress');
    }

    logger.info('Manual cache warming triggered');

    await warmingService.warmCaches();
}

/**
 * Reset warming progress
 */
async function handleResetWarming(): Promise<void> {
    const warmingService = getCacheWarmingService();

    // Check if warming is running
    if (warmingService.getProgress().status === 'warming') {
        throw new Error('Cannot reset while warming is in progress');
    }

    logger.info('Cache warming progress reset');

    warmingService.reset();
}
