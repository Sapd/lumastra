// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/admin/task-system/circuits (Slice 3 §4.2, §5)
//
// Circuit-breaker fleet: { summary: { open, halfOpen, forceEnabled, total },
// entries: CircuitFleetEntry[] }. Entries are open-first then by openedAt.
// Read-only over task_circuit_state.

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getCircuitFleet } from '$lib/server/tasks/observability/circuit-fleet.service.js';

const def = defineEndpoint({
    // Operational surface (circuit-breaker fleet state) — moved from
    // tasks:read to tasks:admin. security review 2026-09-12, C16.
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not configured');

            const fleet = await getCircuitFleet(sql);

            return json(fleet);
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
