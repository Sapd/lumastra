// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/sources/[id]/refresh.ts
 *
 * GET  /livetv/admin/sources/{sourceId}/refresh — last refresh result
 * POST /livetv/admin/sources/{sourceId}/refresh — trigger manual M3U refresh
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response bodies:
 *   GET  → { lastRefreshAt?, lastRefreshStatus?, lastRefreshSummary? }  (bare object)
 *   POST → { taskId: string }                                           (bare object)
 *          409 conflict when a refresh is already in progress.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getSourceById } from '$lib/server/database/queries/livetv-sources.queries.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { handleTriggerFailure } from '$lib/server/tasks/handle-trigger-failure.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    SourceRefreshStatusResponseSchema,
    RefreshTriggerResponseSchema,
} from '$lib/schemas/livetv';

const logger = Logger.for('AdminLiveTvRefresh');

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'Get the last refresh status for a source',
            stability: 'experimental',
            auth: 'bearer',
            responses: {
                200: {
                    schema: SourceRefreshStatusResponseSchema,
                    description: 'Last refresh status',
                },
                401: 'Authentication required',
                404: 'Source not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Live TV'],
            summary: 'Trigger a manual M3U refresh for a source',
            stability: 'experimental',
            auth: 'bearer',
            responses: {
                200: { schema: RefreshTriggerResponseSchema, description: 'Refresh job started' },
                401: 'Authentication required',
                404: 'Source not found',
                409: 'Refresh already in progress for this source',
                422: 'Source has no M3U URL configured',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ sourceId: z.string().min(1) }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { sourceId } = ctx.input!.params;

            const source = await getSourceById(sql, sourceId);
            if (!source) return ApiProblem.notFound('Source not found');

            return json({
                lastRefreshAt: source.last_refresh_at?.toISOString() ?? undefined,
                lastRefreshStatus: source.last_refresh_status ?? undefined,
                lastRefreshSummary: source.last_refresh_summary ?? undefined,
            });
        },

        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { sourceId } = ctx.input!.params;

            const source = await getSourceById(sql, sourceId);
            if (!source) return ApiProblem.notFound('Source not found');

            if (!source.m3u_url) {
                return ApiProblem.validationFailed('Source has no M3U URL configured');
            }

            const username = event.locals.principal?.username ?? event.locals.user?.username;

            const result = await orchestrator.startRun(
                'refresh-m3u',
                { sourceId },
                {
                    trigger: {
                        kind: 'manual',
                        by: username,
                        sourceRoute: `admin/livetv/sources/${sourceId}/refresh`,
                    },
                    priority: 1,
                    idempotencyKey: `refresh-m3u:${sourceId}`,
                },
            );

            if (result.deduped) {
                return ApiProblem.conflict('Refresh already in progress for this source');
            }

            // Also trigger EPG refresh if source has XMLTV URL.
            // Best-effort: M3U response succeeds regardless of EPG outcome.
            if (source.xmltv_url) {
                await orchestrator
                    .startRun(
                        'refresh-epg',
                        { sourceId },
                        {
                            trigger: {
                                kind: 'manual',
                                by: username,
                                sourceRoute: `admin/livetv/sources/${sourceId}/refresh`,
                            },
                            priority: 1,
                            idempotencyKey: `refresh-epg:${sourceId}`,
                        },
                    )
                    .catch((err: unknown) => {
                        handleTriggerFailure(err, {
                            logger,
                            action: 'enqueue refresh-epg from admin/livetv/refresh',
                            taskId: 'refresh-epg',
                            context: { sourceId, by: username },
                        });
                    });
            }

            return json({ taskId: result.runId });
        },
    },
});
