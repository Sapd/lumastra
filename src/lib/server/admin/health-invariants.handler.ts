// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * health-invariants.handler.ts — shared request handler for system-health invariants.
 *
 * Mounted at two surfaces:
 *   GET /api/v1/admin/system-health/invariants  (token surface, v1)
 *   GET /api/admin/system-health/invariants     (internal cookie/forward-auth surface)
 *
 * authenticate() validates a Bearer token (PAT/svc) on the v1 surface and, on
 * the internal /api/* surface, falls back to the logged-in admin's
 * cookie/forward-auth identity (internalAdminAuth) — so this shared handler
 * works correctly on both surfaces without additional wrapping.
 */

import * as m from '$lib/paraglide/messages.js';
import type { RequestEvent } from '@sveltejs/kit';
import { problem } from '$lib/server/api/problem.js';
import { authenticate, requireScope } from '$lib/server/tasks/api-auth.js';
import { getDb } from '$lib/server/database/connection.js';
import { listFindings } from '$lib/server/database/queries/health-check-findings.queries.js';
import type {
    HealthInvariantsResponse,
    InvariantDetailLink,
} from '$lib/schemas/health-invariants.schema.js';

export async function handleHealthInvariants(event: RequestEvent): Promise<Response> {
    const auth = await authenticate(event);
    requireScope(auth, 'tasks:admin');

    const sql = getDb();
    if (!sql) {
        return problem('dependency_unavailable', { error: 'database unavailable' });
    }

    const rows = await listFindings(sql);

    const findings = rows.map((row) => ({
        id: row.invariant_id,
        label:
            row.invariant_id === 'jellyfin-unpaired-watch-records'
                ? m.admin_jellyfin_not_paired_label()
                : row.label,
        status: row.status,
        value: row.value !== null ? Number(row.value) : null,
        description:
            row.invariant_id === 'jellyfin-unpaired-watch-records'
                ? m.admin_jellyfin_not_paired_description()
                : row.description,
        remediation:
            row.invariant_id === 'jellyfin-unpaired-watch-records'
                ? m.admin_jellyfin_not_paired_hint()
                : (row.remediation ?? null),
        thresholdAmber: row.threshold_amber !== null ? Number(row.threshold_amber) : null,
        thresholdRed: row.threshold_red !== null ? Number(row.threshold_red) : null,
        lastRunAt:
            row.last_run_at instanceof Date
                ? row.last_run_at.toISOString()
                : String(row.last_run_at),
        lastChangeAt:
            row.last_change_at instanceof Date
                ? row.last_change_at.toISOString()
                : String(row.last_change_at),
        error: row.error ?? null,
        // Stored as JSONB — validate the shape defensively rather than
        // trusting the column blindly (Zod on the way out also enforces this).
        details: Array.isArray(row.details) ? (row.details as InvariantDetailLink[]) : undefined,
    }));

    // Three timestamps with distinct semantics. `lastFullRunAt` is the most
    // recent UPSERT across all findings — present even when some invariants
    // threw and were recorded as `unknown`. `lastSuccessfulRunAt` lags it
    // whenever at least one finding's latest attempt produced an error, and
    // tells the operator "the last clean check completed at X". `erroredCount`
    // lets the UI badge the heading without re-scanning the array.
    const lastFullRunAt =
        findings.length > 0
            ? findings.reduce(
                  (latest, f) => (f.lastRunAt > latest ? f.lastRunAt : latest),
                  findings[0].lastRunAt,
              )
            : null;

    const cleanFindings = findings.filter((f) => f.error === null);
    const lastSuccessfulRunAt =
        cleanFindings.length > 0 && cleanFindings.length === findings.length
            ? cleanFindings.reduce(
                  (latest, f) => (f.lastRunAt > latest ? f.lastRunAt : latest),
                  cleanFindings[0].lastRunAt,
              )
            : null;

    const erroredCount = findings.length - cleanFindings.length;

    const body: HealthInvariantsResponse = {
        findings,
        lastFullRunAt,
        lastSuccessfulRunAt,
        erroredCount,
    };
    return Response.json(body);
}
