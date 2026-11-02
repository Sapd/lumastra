// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/system-metrics.ts — GET /api/v1/system-metrics
 *
 * System observability. Exposed under the `metrics:read` scope so monitoring
 * tokens (Prometheus/Grafana/Uptime) don't need a full admin token.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/system-metrics/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../routes/api/admin/system-metrics/+server.js';
import { SystemMetricsSchema } from '$lib/schemas/admin-types';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['metrics:read'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get system metrics (cluster hosts + the answering process)',
            description:
                'CPU, memory, network and GPU probe of the ONE server process that answered (named in `hostname`), plus cluster-wide stream throughput. Behind a load balancer with several replicas, consecutive calls can describe different processes, and none of them is necessarily the machine that transcodes. For the whole cluster read `hosts`: every machine with its CPU, memory and GPU (engine use, encoder sessions), from the heartbeats all services publish through Valkey every 10 seconds.',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: { schema: SystemMetricsSchema, description: 'System metrics snapshot' },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            return delegateToAdmin(event, adminGET!);
        },
    },
});
