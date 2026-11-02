// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET  /admin/developer/vod-embeddings — coverage stats for movie/TV AI text embeddings.
 * POST /admin/developer/vod-embeddings — enqueue the library / discovery embedding tasks.
 *
 * Backs the friendly coverage dashboard (CoverageDashboard.svelte). The sonic
 * page is the sibling for the music domain; this is the VOD pilot proving the
 * shared component generalizes.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { features } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('admin:vod-embeddings');

/** Tasks the dashboard can trigger, mapped from action id → task id. */
const ACTION_TASKS: Record<string, string> = {
    'start-library-backfill': 'library-embeddings',
    'start-discovery-backfill': 'discovery-embeddings',
};

export const GET: RequestHandler = async ({ locals }) => {
    try {
        if (!localsIsAdmin(locals)) {
            return ApiResponses.unauthorized();
        }

        if (!features.aiRecommendations) {
            return json({ enabled: false });
        }

        const { getVodEmbeddingCoverage } =
            await import('$lib/server/database/queries/embedding-stats.queries.js');
        const { aiDbService } = await import('$lib/server/services/database.service.js');

        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable');

        const coverage = await getVodEmbeddingCoverage(sql);

        return json({ enabled: true, coverage });
    } catch (error) {
        logger.error(
            'Failed to load VOD embedding coverage',
            error instanceof Error ? error : undefined,
        );
        return ApiResponses.error('Failed to load VOD embedding coverage');
    }
};

export const POST: RequestHandler = async ({ locals, request }) => {
    try {
        if (!localsIsAdmin(locals)) {
            return ApiResponses.unauthorized();
        }

        if (!features.aiRecommendations) {
            return json(
                { success: false, error: 'AI recommendations are not enabled' },
                { status: 400 },
            );
        }

        const body = await readBoundedJson(request).catch(() => ({}));
        const action = (body as Record<string, unknown>).action;
        const taskId = typeof action === 'string' ? ACTION_TASKS[action] : undefined;

        if (!taskId) {
            return json(
                { success: false, error: `Unknown action: ${String(action)}` },
                { status: 400 },
            );
        }

        const result = await orchestrator.startRun(
            taskId,
            {},
            {
                trigger: {
                    kind: 'manual',
                    by: locals.user.username,
                    sourceRoute: 'admin/vod-embeddings',
                },
                priority: 1,
            },
        );

        return json({
            success: true,
            runId: result.runId,
            message: 'Task enqueued successfully',
        });
    } catch (error) {
        logger.error(
            'Failed to enqueue VOD embedding task',
            error instanceof Error ? error : undefined,
        );
        return ApiResponses.error('Failed to enqueue task');
    }
};
