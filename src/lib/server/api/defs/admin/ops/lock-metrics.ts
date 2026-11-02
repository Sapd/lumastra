// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ops/lock-metrics — distributed lock contention metrics endpoint def.
 *
 * GET /api/admin/lock-metrics → bare LockMetricsResponse object.
 * Auth: metrics:read. Errors: problem+json.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import { getLockMetrics } from '$lib/server/cache/valkey.js';

const logger = Logger.for('AdminLockMetrics');

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['metrics:read', 'admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const metrics = getLockMetrics();
            logger.debug('Lock metrics retrieved', { metrics });
            return json(metrics);
        },
    },
});
