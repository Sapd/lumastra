// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/playback-incidents/index.ts
 *
 * GET    /api/v1/admin/playback-incidents?userId=&deviceId=&mediaId=&triggerType=&from=&to=&limit=&offset=
 * DELETE /api/v1/admin/playback-incidents?userId=
 *
 * Filtered, paginated list of client-reported playback incidents for the
 * admin "what happened to user X's playback around time Y" lookup. Mirrors
 * defs/admin/transcode-failures/index.ts's auth/mount shape.
 *
 * DELETE clears incidents in bulk for the list's "Clear all" button, honouring
 * the `userId` filter so a filtered page clears only what it is showing.
 *
 * Auth: admin.
 * Surface: mounted on BOTH v1 and internal — the browser admin UI cannot
 * authenticate against /api/v1 at all, same reasoning as transcode-failures.
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    listPlaybackIncidents,
    deletePlaybackIncidents,
    type PlaybackIncidentRow,
} from '$lib/server/database/queries/playback-incident-events.queries.js';
import {
    PlaybackIncidentListResponseSchema,
    PlaybackIncidentClearedResponseSchema,
    type PlaybackIncidentSummary,
} from '$lib/schemas/api-playback-incidents.js';
import { toTriggerType, handleInvalidTriggerType } from '../trigger-type.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const logger = Logger.for('AdminPlaybackIncidentsAPI');

/** A filtered lookup list, not a paged feed — bounded generously. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const PlaybackIncidentsQuerySchema = z.object({
    userId: z.string().uuid().optional(),
    deviceId: z.string().min(1).optional(),
    mediaId: z.string().uuid().optional(),
    triggerType: z.enum(['error', 'reconnect', 'terminal']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).optional().default(0),
});

function toIncidentSummaryDto(row: PlaybackIncidentRow): PlaybackIncidentSummary {
    return {
        id: row.id,
        attemptId: row.attempt_id,
        playSessionId: row.play_session_id,
        incidentAt: row.incident_at.toISOString(),
        serverRecordedAt: row.occurred_at.toISOString(),
        triggerType: toTriggerType(row.trigger_type),
        errorType: row.error_type,
        stage: row.stage,
        httpStatus: row.http_status,
        serverDiagnosticCode: row.server_diagnostic_code,
        reconnectCause: row.reconnect_cause,
        message: row.message,
        userId: row.user_id,
        deviceId: row.device_id,
        mediaId: row.media_id,
        username: row.username,
        deviceName: row.device_name,
        mediaTitle: row.media_title,
        resolvedAt: row.resolved_at?.toISOString() ?? null,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: {
        query: PlaybackIncidentsQuerySchema,
    },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin', 'Playback'],
            summary: 'List playback incidents',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Filtered, paginated list of client-reported playback incidents (errors, ' +
                'reconnects, terminal failures) for retroactive lookup by user, device, media, ' +
                'trigger type, or time range.',
            responses: {
                200: { schema: PlaybackIncidentListResponseSchema, description: 'Incident list' },
                401: 'Authentication required',
                403: 'Admin access required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Admin', 'Playback'],
            summary: 'Clear playback incidents',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Deletes recorded playback incidents. Honours `userId` so a page filtered to one ' +
                "user clears only that user's rows; with no filter it clears every incident. " +
                'Returns the number of rows removed. Other list filters are NOT honoured — the ' +
                'list UI only ever offers clear-all within its `userId` scope.',
            responses: {
                200: { schema: PlaybackIncidentClearedResponseSchema, description: 'Rows removed' },
                401: 'Authentication required',
                403: 'Admin access required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { userId, deviceId, mediaId, triggerType, from, to, limit, offset } =
                ctx.input!.query!;

            const { rows, total } = await listPlaybackIncidents(sql, {
                userId,
                deviceId,
                mediaId,
                triggerType,
                from,
                to,
                limit,
                offset,
            });

            try {
                return json(
                    PlaybackIncidentListResponseSchema.parse(
                        paginate(rows.map(toIncidentSummaryDto), {
                            limit,
                            offset,
                            hasMore: offset + rows.length < total,
                            total,
                        }),
                    ),
                );
            } catch (err) {
                return handleInvalidTriggerType(err);
            }
        },
        DELETE: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { userId } = ctx.input!.query!;
            const cleared = await deletePlaybackIncidents(sql, { userId });
            auditLog('playback_incidents.clear', userId ?? 'all', auditActor(event), { cleared });

            logger.info('Playback incidents cleared', { userId: userId ?? '(all)', cleared });

            return json(PlaybackIncidentClearedResponseSchema.parse({ cleared }));
        },
    },
});
