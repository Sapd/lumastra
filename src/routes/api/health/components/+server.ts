// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/health/components — per-subsystem health detail.
//
// Returns structured JSON describing:
//   - database: connection state
//   - valkey: connection state
//   - orchestrator: leader per class, healthy flag
//   - webhookOutbox: pending + dead counts
//   - pendingWriteDrain: queue depth in Valkey
//   - transcoder: FFmpeg availability
//   - migration: pending migration count
//
// Auth: admin session OR a token carrying the `metrics:read` scope.
// Both are authorised because metrics:read is the monitoring-scrape scope that
// also gates /metrics; an admin session always passes.
//
// The per-component logic lives in the shared buildComponentHealth() helper so
// this route and /api/admin/task-system/observability cannot drift.
// Content-Type: application/health+json.

import type { RequestHandler } from './$types.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { buildComponentHealth } from '$lib/server/health/component-health.js';
import { enforce } from '$lib/server/api/mount.js';

export const GET: RequestHandler = async (event) => {
    // Accept either an admin or a token carrying metrics:read. The admin verdict
    // comes from enforce({kind:'admin'}), which trusts locals.principal: the
    // group-derived locals.user.isAdmin ignores token scopes and would let an
    // admin's device-flow JWT or low-scope PAT through.
    const denied = await enforce(
        {
            kind: 'any',
            specs: [{ kind: 'admin' }, { kind: 'scope', anyOf: ['metrics:read'] }],
        },
        event,
    );
    if (denied !== null) {
        return ApiProblem.forbidden('Admin session or metrics:read scope required');
    }

    const report = await buildComponentHealth();

    return new Response(JSON.stringify(report), {
        status: 200,
        headers: { 'Content-Type': 'application/health+json' },
    });
};
