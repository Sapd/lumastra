// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/admin/task-system/systemic (Slice 3 §4.3, §5)
//
// Composed systemic-failure roll-up: { stalledByClass, backpressureShed,
// orphansReclaimed, openCircuits, window }. Stalled counts come from the
// orchestrator's SCARD probe (never a keyspace SCAN); backpressure/orphan
// counts are windowed SUMs over the coarse audit rows; openCircuits from the
// circuit fleet.
//
//   ?sinceHours=  (default 24, max 168)

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getSystemicFailures } from '$lib/server/tasks/observability/systemic.service.js';

const DEFAULT_SINCE_HOURS = 24;
const MAX_SINCE_HOURS = 168;

const def = defineEndpoint({
    // Operational surface (systemic failure roll-up) — moved from tasks:read
    // to tasks:admin. security review 2026-09-12, C16.
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not configured');

            // `|| NaN`: Number(null) and Number('') are 0, which would clamp a missing
            // param to the minimum instead of falling back to the default.
            const rawSince = Number(event.url.searchParams.get('sinceHours') || NaN);
            const sinceHours = Number.isFinite(rawSince)
                ? Math.min(MAX_SINCE_HOURS, Math.max(1, Math.trunc(rawSince)))
                : DEFAULT_SINCE_HOURS;

            const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');

            const result = await getSystemicFailures(sql, {
                sinceHours,
                getStalledCounts: () => orchestrator.getStalledCounts(),
            });

            return json(result);
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
