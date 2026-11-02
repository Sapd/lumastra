// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// circuit-fleet.service.ts — circuit-breaker fleet roll-up (Slice 3 §4.2).
//
// Reads task_circuit_state (via circuit-fleet.queries) into the fleet summary
// ("N tasks have open circuits") + the per-task entry list. Read-only.

import type postgres from 'postgres';
import { LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS } from '$lib/server/config.js';
import { listCircuitFleet } from '$lib/server/database/queries/circuit-fleet.queries.js';
import type {
    CircuitFleetEntry,
    CircuitFleetSummary,
} from '$lib/schemas/task-system-failure-detection.schema.js';

export interface CircuitFleet {
    summary: CircuitFleetSummary;
    entries: CircuitFleetEntry[];
}

/** Read the fleet and derive the summary counts. */
export async function getCircuitFleet(sql: postgres.Sql): Promise<CircuitFleet> {
    const entries = await listCircuitFleet(sql, {
        forceEnableTtlMs: LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS,
    });
    const summary: CircuitFleetSummary = {
        open: entries.filter((e) => e.state === 'open').length,
        halfOpen: entries.filter((e) => e.state === 'half_open').length,
        forceEnabled: entries.filter((e) => e.forceEnabled).length,
        total: entries.length,
    };
    return { summary, entries };
}
