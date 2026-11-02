// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/connection-budget/index.ts
 *
 * GET /api/admin/connection-budget
 *
 * Admin-only sanity-check for the Postgres connection budget. Compares the
 * sum of this deployment's per-instance DB pools (× live replica count) against
 * Postgres max_connections, surfacing the "connection-budget chain" foot-gun
 * before it causes connection exhaustion under load.
 *
 * Read-only and advisory: it never changes config.
 *
 * Auth: admin.
 * Surface: internal-only.
 * Response: bare ConnectionBudgetCheck object.
 * 503 dependency_unavailable when the budget check itself fails.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { checkConnectionBudget } from '$lib/server/services/connection-budget.js';

const PoolsSchema = z.object({
    web: z.number().int(),
    task: z.number().int(),
    admin: z.number().int(),
    heartbeat: z.number().int().optional(),
});

const ConnectionBudgetResponseSchema = z.object({
    status: z.enum(['ok', 'warning', 'critical', 'unknown']),
    maxConnections: z.number().int(),
    reservedConnections: z.number().int(),
    usableConnections: z.number().int(),
    pools: PoolsSchema,
    perInstanceTotal: z.number().int(),
    replicaCount: z.number().int(),
    worstCaseDemand: z.number().int(),
    spareConnections: z.number().int(),
    detail: z.string(),
    recommendation: z.string().optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const r = await checkConnectionBudget();
            return json(
                ConnectionBudgetResponseSchema.parse({
                    status: r.status,
                    maxConnections: r.maxConnections,
                    reservedConnections: r.reservedConnections,
                    usableConnections: r.usableConnections,
                    pools: r.pools,
                    perInstanceTotal: r.perInstanceTotal,
                    replicaCount: r.replicaCount,
                    worstCaseDemand: r.worstCaseDemand,
                    spareConnections: r.spareConnections,
                    detail: r.detail,
                    recommendation: r.recommendation,
                }),
            );
        },
    },
});
