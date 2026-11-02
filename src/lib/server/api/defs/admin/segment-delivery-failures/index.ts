// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/segment-delivery-failures/index.ts
 *
 * GET    /api/v1/admin/segment-delivery-failures?playSessionId=&userId=&category=&from=&to=&limit=&offset=
 * DELETE /api/v1/admin/segment-delivery-failures?playSessionId=
 *
 * Filtered, paginated list of HLS segment/playlist delivery failures, for the
 * admin "did segments actually reach this player?" lookup — the question that
 * `playback-incidents` (client-reported) and `transcode-failures` (FFmpeg-side)
 * both leave unanswered, since the delivery layer sits between them.
 *
 * Rows are aggregated per distinct failure with an `occurrences` counter, so a
 * penalty-boxed client retrying in a loop shows as one row with a high count
 * rather than thousands of rows.
 *
 * DELETE clears recorded failures, honouring `playSessionId` so a filtered page
 * clears only what it is showing; with no filter it clears every row.
 *
 * Auth: admin.
 * Surface: mounted on BOTH v1 and internal — the browser admin UI cannot
 * authenticate against /api/v1 at all, same reasoning as playback-incidents.
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    listSegmentDeliveryFailures,
    deleteSegmentDeliveryFailures,
    isUnfilteredFailureMatch,
    type SegmentDeliveryFailureRow,
} from '$lib/server/database/queries/segment-delivery-failures.queries.js';
import {
    SegmentDeliveryFailureListResponseSchema,
    SegmentDeliveryFailureClearedResponseSchema,
    SegmentFailureCategorySchema,
    type SegmentDeliveryFailureSummary,
} from '$lib/schemas/api-segment-delivery-failures.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('AdminSegmentDeliveryFailuresAPI');

/** A filtered lookup list, not a paged feed — bounded generously. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SegmentDeliveryFailuresQuerySchema = z.object({
    // Free text, not .uuid(): a native client's play session id is a valid UUID
    // but uppercase, and an id copied from a malformed request may not be a
    // UUID at all. The query layer lowercases before matching.
    playSessionId: z.string().min(1).max(200).optional(),
    userId: z.string().uuid().optional(),
    category: SegmentFailureCategorySchema.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).optional().default(0),
    all: z
        .enum(['1', 'true'])
        .optional()
        .describe('DELETE only: required to clear every row when no filter is given.'),
});

function toSummaryDto(row: SegmentDeliveryFailureRow): SegmentDeliveryFailureSummary {
    return {
        id: String(row.id),
        playSessionId: row.play_session_id,
        category: row.category,
        httpStatus: row.http_status,
        resourceKind: row.resource_kind,
        streamVariant: row.stream_variant,
        occurrences: row.occurrences,
        firstSeenAt: row.first_seen_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
        userId: row.user_id,
        mediaId: row.media_id,
        deviceId: row.device_id,
        clientName: row.client_name,
        username: row.username,
        mediaTitle: row.media_title,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: {
        query: SegmentDeliveryFailuresQuerySchema,
    },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin', 'Playback'],
            summary: 'List segment delivery failures',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Filtered, paginated list of HLS segment/playlist delivery failures (4xx/5xx), ' +
                'aggregated per distinct failure with an occurrence count. Answers whether ' +
                'segments were reaching a given play session, which the client-reported ' +
                'incident list and the FFmpeg-side transcode failure list cannot.',
            responses: {
                200: {
                    schema: SegmentDeliveryFailureListResponseSchema,
                    description: 'Segment delivery failure list',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Admin', 'Playback'],
            summary: 'Clear segment delivery failures',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Deletes recorded segment delivery failures matching the same filters as the list ' +
                '(`playSessionId`, `userId`, `category`, `from`, `to`), so a filtered view clears ' +
                'exactly what it shows. Clearing every row requires `all=1` and no filter; a ' +
                'request with neither is rejected with 422. Returns the number of rows removed.',
            responses: {
                200: {
                    schema: SegmentDeliveryFailureClearedResponseSchema,
                    description: 'Rows removed',
                },
                422: 'No filter and no all=1, or all=1 combined with a filter',
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

            const { playSessionId, userId, category, from, to, limit, offset } = ctx.input!.query!;

            const { rows, total } = await listSegmentDeliveryFailures(sql, {
                playSessionId,
                userId,
                category,
                from,
                to,
                limit,
                offset,
            });

            return json(
                paginate(rows.map(toSummaryDto), {
                    limit,
                    offset,
                    hasMore: offset + rows.length < total,
                    total,
                }),
            );
        },
        DELETE: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { playSessionId, userId, category, from, to, all } = ctx.input!.query!;
            const match = { playSessionId, userId, category, from, to };
            // Every list filter is honoured: a clear sent with `userId` used to
            // ignore it and wipe every row. Wiping everything must be asked for.
            const unfiltered = isUnfilteredFailureMatch(match);
            if (unfiltered && !all) {
                return ApiProblem.validationFailed(
                    'Refusing to clear every segment delivery failure without all=1; pass a filter or all=1.',
                );
            }
            if (!unfiltered && all) {
                return ApiProblem.validationFailed('all=1 cannot be combined with a filter.');
            }
            const cleared = await deleteSegmentDeliveryFailures(sql, match);
            logger.info('Cleared segment delivery failures', {
                filters: unfiltered ? 'ALL' : match,
                cleared,
            });
            return json({ cleared });
        },
    },
});
