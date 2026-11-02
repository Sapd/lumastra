// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: public — readiness probe for load balancers / Docker health checks
//         admin or metrics:read — per-component breakdown

// GET /api/health/ready — readiness probe.
//
// Returns 200 when all three GATING conditions hold:
//   - orchestrator bootstrapped
//   - PostgreSQL reachable
//   - the task Valkey (TASK_CACHE_URL) reachable
// The disposable cache (CACHE_URL) is NOT gated: it is optional, may be unset,
// and the app serves without it (cache misses). Neither is worker presence —
// the web container serves requests without a worker; it is reported in the
// detail and on the admin banner instead.
// Leadership is NOT gated: a follower replica holds no class leader lock, so
// gating on it would keep every non-leader permanently unready (503). Leader
// status is still surfaced in the `checks` detail for admins, just not gated.
//
// Returns 503 with body {status:'fail'} when any gating condition fails, and
// right away once the process received SIGTERM (it is draining; see
// $lib/server/lifecycle/web-shutdown.ts) without running any check.
// Used by the Docker healthcheck and Kubernetes readiness probes.
//
// Admin callers and callers with the `metrics:read` scope also receive a
// per-component `checks` object — but the public probe never leaks infra
// topology (which subsystems exist, their health, cluster leader presence).
//
// The checks themselves live in `$lib/server/health/readiness-checks.ts`, which
// the admin debug report reads too.
//
// Content-Type: application/health+json.

import type { RequestHandler } from './$types.js';
import { enforce } from '$lib/server/api/mount.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import { getReadinessChecks } from '$lib/server/health/readiness-checks.js';
import { isShuttingDown } from '$lib/server/lifecycle/web-shutdown.js';

/** Test seam kept on the route module; the memo itself lives in readiness-checks.ts. */
export { resetReadinessCache as _resetReadinessCache } from '$lib/server/health/readiness-checks.js';

export const GET: RequestHandler = async (event) => {
    if (isShuttingDown()) {
        return new Response(JSON.stringify({ status: 'fail', reason: 'shutting_down' }), {
            status: 503,
            headers: { 'Content-Type': 'application/health+json' },
        });
    }
    const checks = await getReadinessChecks();

    // `leader` is intentionally excluded from the readiness gate — a follower
    // replica never holds a leader lock for any resource class, so gating on
    // it would keep every non-leader replica permanently unready (503). It is
    // still surfaced in the `checks` detail object below for admin visibility.
    const allReady = checks.orchestrator && checks.database && checks.valkey;
    const status = allReady ? 'pass' : 'fail';

    // Admin callers and metrics:read token holders receive the per-component
    // breakdown. All other callers (load balancers, Docker healthcheck, plain
    // users) get only the overall status — no topology leak.
    const isAdmin = localsIsAdmin(event.locals);
    const hasScopeResult = await enforce({ kind: 'scope', anyOf: ['metrics:read'] }, event);
    const hasMetricsScope = hasScopeResult === null;
    const showDetail = isAdmin || hasMetricsScope;

    const body = showDetail ? { status, checks } : { status };

    return new Response(JSON.stringify(body), {
        status: allReady ? 200 : 503,
        headers: { 'Content-Type': 'application/health+json' },
    });
};
