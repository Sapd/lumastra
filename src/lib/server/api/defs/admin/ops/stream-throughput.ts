// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ops/stream-throughput — cluster-wide stream throughput for the sessions page.
 *
 * GET /api/admin/stream-throughput → bare StreamThroughput object.
 * Auth: admin. Errors: problem+json.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import { getStreamThroughput } from '$lib/server/services/stream-throughput.service.js';

const logger = Logger.for('stream-throughput-admin');

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            try {
                return json(await getStreamThroughput(), {
                    headers: { 'Cache-Control': 'no-store' },
                });
            } catch (error) {
                logger.error(
                    'Failed to get stream throughput',
                    error instanceof Error ? error : undefined,
                );
                return ApiProblem.internalError('Failed to retrieve stream throughput');
            }
        },
    },
});
