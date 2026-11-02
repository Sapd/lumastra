// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ops/status — THE canonical admin status endpoint (admin IA redesign).
 *
 * GET /api/admin/status → AdminStatusPayload: verdict + attention items +
 * nested system block + extras + session/task/library/user counters +
 * per-section nav status. Consolidates the former /api/admin/status,
 * /api/admin/status/extras and GET /api/admin/attention into one payload so
 * every admin surface reads the same numbers (spec §5, one source of truth).
 *
 * Auth: admin. Errors: problem+json incl. 503 dependency_unavailable.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getAdminStatusPayload } from '$lib/server/services/admin-status-payload.service.js';
import { AdminStatusPayloadSchema } from '$lib/schemas/api-admin-status-payload.js';

const logger = Logger.for('system-status');

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            try {
                const payload = await getAdminStatusPayload();
                return json(AdminStatusPayloadSchema.parse(payload), {
                    headers: { 'Cache-Control': 'no-store' },
                });
            } catch (error) {
                logger.error(
                    'Failed to check system status',
                    error instanceof Error ? error : undefined,
                );
                return ApiProblem.dependencyUnavailable(
                    'Failed to check system status — one or more dependencies may be down',
                );
            }
        },
    },
});
