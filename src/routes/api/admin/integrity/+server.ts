// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/integrity
 *
 * Returns open integrity violations and a per-rule open count for the admin
 * dashboard. The integrity-scanner plugin populates the underlying table on a
 * 24h schedule; this endpoint is the read path.
 *
 * Query params:
 *  - rule:     filter by exact rule id (e.g. `episode-parent-not-season`)
 *  - severity: filter by severity (`low` | `medium` | `high` | `critical`)
 *  - limit:    page size, default 100, capped at 500
 *
 * Auth: media:admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    listOpenViolations,
    countOpenViolationsByRule,
} from '$lib/server/database/queries/integrity-violations.queries.js';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
    rule: z.string().optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    visibility: 'internal',
    request: {
        query: QuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { rule, severity, limit: limitParam } = ctx.input!.query;
            const limit = Math.min(limitParam ?? 100, 500);

            const violations = await listOpenViolations(sql, {
                rule,
                severity: severity,
                limit,
            });
            const counts = await countOpenViolationsByRule(sql);

            return json({ violations, counts });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
