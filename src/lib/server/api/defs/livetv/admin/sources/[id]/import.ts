// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/sources/[id]/import.ts
 *
 * POST /livetv/admin/sources/{sourceId}/import
 *   Triggers an immediate M3U + EPG import for this source.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response: { taskIds: { m3u: string; epg?: string } }  (bare object)
 *
 * No body validation — inputs are derived entirely from the [sourceId] path
 * param + the source row's stored M3U/XMLTV URLs.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getSourceById } from '$lib/server/database/queries/livetv-sources.queries.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { ImportTriggerResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Trigger an M3U + EPG import for a source',
            stability: 'experimental',
            auth: 'bearer',
            description:
                'Triggers an immediate M3U import (and an EPG import when the source has an XMLTV ' +
                'URL). Inputs derive entirely from the source row — no request body.',
            responses: {
                200: { schema: ImportTriggerResponseSchema, description: 'Import jobs started' },
                401: 'Authentication required',
                404: 'Source not found',
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
        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { sourceId } = ctx.input!.params;

            const source = await getSourceById(sql, sourceId);
            if (!source) return ApiProblem.notFound('Source not found');

            if (!source.m3u_url) {
                return ApiProblem.validationFailed('Source has no M3U URL configured');
            }

            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? 'admin';

            const m3uResult = await orchestrator.startRun(
                'import-m3u',
                { sourceId },
                {
                    trigger: {
                        kind: 'manual',
                        by: username,
                        sourceRoute: `admin/livetv/sources/${sourceId}/import`,
                    },
                    idempotencyKey: `manual_import-m3u_${sourceId}`,
                },
            );

            // The import-m3u run starts import-epg itself once the channels
            // exist (child run). Starting both here raced: the EPG run read the
            // channel list while the M3U run was replacing it.
            return json({
                taskIds: {
                    m3u: m3uResult.runId,
                },
            });
        },
    },
});
