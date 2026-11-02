// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/playback-incidents/[id]/index.ts
 *
 * GET    /api/v1/admin/playback-incidents/{id}
 * DELETE /api/v1/admin/playback-incidents/{id}
 *
 * One incident's full detail, including its timeline and any correlated
 * transcode_failure_events rows across every play_session_id its attempt
 * has used (see listCorrelatedTranscodeFailures's own doc comment for why
 * that must go through attempt_id, not just the flush-time session id).
 *
 * IMPORTANT: the correlation lookup is scoped by the INCIDENT'S OWN user_id
 * (read from the fetched row), never a client-supplied value — this is an
 * admin surface, but the underlying query is user_id-scoped by design and
 * must stay that way.
 *
 * The drawer also carries the delivery EVIDENCE for the same session: the
 * receiver-timed `delivery_window` rows (the only honest delivery timer — see
 * delivery-windows.queries.ts) and any speed tests the same user ran in the
 * last week. Those two together answer the question an operator actually has
 * in front of a stall: was it their line, or was it ours?
 *
 * DELETE clears that one incident — the list's per-row clear button. 404 when the
 * row is already gone, so a double-click reads as "already cleared" rather than
 * silently succeeding twice.
 *
 * Auth: admin.
 * Surface: mounted on BOTH v1 and internal — see ../index.ts's doc comment.
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    getPlaybackIncidentById,
    deletePlaybackIncidentById,
    listCorrelatedTranscodeFailures,
} from '$lib/server/database/queries/playback-incident-events.queries.js';
import { listDeliveryWindows } from '$lib/server/database/queries/delivery-windows.queries.js';
import { listRecentSpeedTests } from '$lib/server/database/queries/network-speed-tests.queries.js';
import { toSpeedTestResponse } from '$lib/schemas/api-network-responses.js';
import {
    PlaybackIncidentDetailResponseSchema,
    PlaybackIncidentClearedResponseSchema,
    type PlaybackIncidentDetail,
} from '$lib/schemas/api-playback-incidents.js';
import { toTriggerType, handleInvalidTriggerType } from '../../trigger-type.js';

const ParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/** How far back the drawer looks for the user's own active measurements. */
const SPEED_TEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Enough to see a trend next to one incident without turning the drawer into a chart. */
const SPEED_TEST_LIMIT = 5;

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: {
        params: ParamsSchema,
    },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin', 'Playback'],
            summary: 'Get one playback incident',
            stability: 'stable',
            auth: 'bearer',
            description:
                "One incident's full detail: forensic fields, timeline, any correlated " +
                'transcode failures for the same attempt, the receiver-timed delivery ' +
                "windows for its session, and the user's recent speed tests.",
            responses: {
                200: {
                    schema: PlaybackIncidentDetailResponseSchema,
                    description: 'Incident detail',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                404: 'Incident not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Admin', 'Playback'],
            summary: 'Clear one playback incident',
            stability: 'stable',
            auth: 'bearer',
            description: 'Deletes a single recorded playback incident.',
            responses: {
                200: { schema: PlaybackIncidentClearedResponseSchema, description: 'Rows removed' },
                401: 'Authentication required',
                403: 'Admin access required',
                404: 'Incident not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { id } = ctx.input!.params!;
            const row = await getPlaybackIncidentById(sql, id);
            if (!row) return ApiProblem.notFound('Incident not found');

            // Every correlated block is scoped by the INCIDENT'S OWN ids, never a
            // client-supplied one — see the file header note.
            const speedTestSince = new Date(Date.now() - SPEED_TEST_WINDOW_MS);
            const [correlated, deliveryWindows, speedTests] = await Promise.all([
                row.user_id
                    ? listCorrelatedTranscodeFailures(sql, row.attempt_id, row.user_id)
                    : Promise.resolve([]),
                // The session id is free text here and may be UPPERCASE or not a
                // uuid at all (listDeliveryWindows folds and guards it) — but the
                // no-session unload beacon stores an empty string, which can
                // never match, so skip the round trip entirely.
                row.play_session_id
                    ? listDeliveryWindows(sql, row.play_session_id)
                    : Promise.resolve([]),
                row.user_id
                    ? listRecentSpeedTests(sql, row.user_id, SPEED_TEST_LIMIT, speedTestSince)
                    : Promise.resolve([]),
            ]);

            try {
                const incident: PlaybackIncidentDetail = {
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
                    timeline: row.timeline as Record<string, unknown>[],
                    clientInfo: row.client_info,
                };

                return json(
                    PlaybackIncidentDetailResponseSchema.parse({
                        incident,
                        correlatedTranscodeFailures: correlated.map((c) => ({
                            occurredAt: c.occurred_at.toISOString(),
                            category: c.category,
                            summary: c.summary,
                        })),
                        deliveryWindows,
                        speedTests: speedTests.map(toSpeedTestResponse),
                    }),
                );
            } catch (err) {
                return handleInvalidTriggerType(err);
            }
        },
        DELETE: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { id } = ctx.input!.params!;
            const cleared = await deletePlaybackIncidentById(sql, id);
            if (cleared === 0) return ApiProblem.notFound('Incident not found');
            auditLog('playback_incident.delete', String(id), auditActor(event));

            return json(PlaybackIncidentClearedResponseSchema.parse({ cleared }));
        },
    },
});
