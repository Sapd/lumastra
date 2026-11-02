// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ops/cluster — live cluster node status endpoint def.
 *
 * GET /api/admin/cluster → bare ClusterStatusResponse object (cached, per-TTL).
 * Auth: admin. Errors: problem+json incl. 503 dependency_unavailable.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { getClusterCore } from '$lib/server/services/admin-cluster-core.service.js';
import { config } from '$lib/server/config.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            // The DB-derived core runs on the dedicated admin pool (getAdminDb), isolated
            // from the playback hot path, and is cached under a single-flight lock so
            // concurrent admin tabs across replicas collapse to one recompute per TTL.
            // Inject the replica-local self id at the edge so the shared cache never
            // reports one replica's identity to another.
            const core = await getClusterCore();
            return json(
                { ...core, selfInstanceId: config.INSTANCE_ID },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        },
    },
});
