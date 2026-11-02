// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/debug-report/cluster/nodes/[instanceId].ts —
 * GET /api/v1/admin/debug-report/cluster/nodes/{instanceId}
 *
 * One cluster node: role, version, live memory and heartbeat age when it is live,
 * restarts and unclean exits in the last 24 hours, and its recent online and offline
 * events. Host names, pod IPs and placement are never included.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { diagnosticsAccessDenial } from '$lib/server/auth/diagnostics-grant.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { buildClusterNodeDetail } from '$lib/server/debug-report/build.js';
import {
    debugReportFailure,
    debugReportRateKey,
    NO_STORE_HEADERS,
    noStore,
} from '$lib/server/debug-report/http.js';
import { ClusterNodeDetailSchema } from '$lib/schemas/debug-report.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['diagnostics:read'] },
    rateLimit: {
        limit: 1,
        windowSec: 5,
        keyBy: (event) => debugReportRateKey(event, 'debug-report-cluster-node'),
    },
    docs: {
        visibility: 'public',
        GET: {
            tags: ['Admin'],
            summary: 'Get one cluster node of the debug report',
            stability: 'beta',
            auth: 'bearer',
            description:
                'One cluster node: whether it is live now, its role, version, memory, heartbeat age, restarts and unclean exits in the last 24 hours, and its recent online and offline events. Authorised by an administrator, or a service token with the `diagnostics:read` grant whose owner is an administrator.',
            responses: {
                200: { schema: ClusterNodeDetailSchema, description: 'The node and its events' },
                401: 'Authentication required',
                403: 'Not an administrator and not a diagnostics:read token whose owner is an administrator',
                404: 'Node not known: no live heartbeat and no events',
                429: 'Rate limited: one request per 5 seconds per credential',
                503: 'Database unavailable or configuration not loaded',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            const denial = diagnosticsAccessDenial(event.locals.principal);
            if (denial) return noStore(denial);

            try {
                const sql = getAdminDb();
                if (!sql) return noStore(ApiProblem.dependencyUnavailable('Database unavailable'));

                const detail = await buildClusterNodeDetail(sql, event.params.instanceId!);
                if (!detail) return noStore(ApiProblem.notFound('Cluster node not found'));
                return json(ClusterNodeDetailSchema.parse(detail), { headers: NO_STORE_HEADERS });
            } catch (error) {
                return debugReportFailure(error);
            }
        },
    },
});
