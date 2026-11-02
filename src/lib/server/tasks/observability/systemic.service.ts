// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// systemic.service.ts — composed systemic-failure roll-up (Slice 3 §4.3).
//
// Composes three already-existing sources into one panel payload:
//   - stalledByClass  — orchestrator.getStalledCounts() (SCARD probe, §4.3)
//   - backpressureShed / orphansReclaimed — windowed SUMs over the coarse
//     system_audit_log rows the reconciler already writes (no new writer)
//   - openCircuits    — from the circuit fleet summary (§4.2)
//
// All reads are best-effort: a failing source contributes 0 / empty rather than
// failing the whole panel.

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { sumAuditDetailField } from '$lib/server/database/queries/observability.queries.js';
import { getCircuitFleet } from './circuit-fleet.service.js';
import type { SystemicResponse } from '$lib/schemas/task-system-failure-detection.schema.js';

const log = Logger.for('Systemic');

/**
 * Build the systemic-failures panel payload over the last `sinceHours`.
 * `getStalledCounts` is injected (the orchestrator owns the Valkey client +
 * queue prefixes) so the service stays free of a queue dependency and is
 * trivially testable.
 */
export async function getSystemicFailures(
    sql: postgres.Sql,
    {
        sinceHours,
        getStalledCounts,
    }: {
        sinceHours: number;
        getStalledCounts: () => Promise<Record<string, number>>;
    },
): Promise<SystemicResponse> {
    let stalledByClass: Record<string, number> = {};
    try {
        stalledByClass = await getStalledCounts();
    } catch (err) {
        log.warn('getStalledCounts failed (best-effort)', {
            err: err instanceof Error ? err.message : String(err),
        });
    }

    const [backpressureShed, orphansReclaimed, fleet] = await Promise.all([
        sumAuditDetailField(sql, {
            category: 'backpressure',
            action: 'backpressure-shed',
            field: 'total',
            sinceHours,
        }).catch(() => 0),
        sumAuditDetailField(sql, {
            category: 'reconciler',
            action: 'orphans-reclaimed',
            field: 'orphansReclaimed',
            sinceHours,
        }).catch(() => 0),
        getCircuitFleet(sql).catch(() => ({
            summary: { open: 0, halfOpen: 0, forceEnabled: 0, total: 0 },
            entries: [],
        })),
    ]);

    return {
        stalledByClass,
        backpressureShed,
        orphansReclaimed,
        openCircuits: fleet.summary.open,
        window: { sinceHours },
    };
}
