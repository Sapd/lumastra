// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/system-health/invariants-v1.ts — GET /api/v1/admin/system-health/invariants
 *
 * NAMING NOTE: named `invariants-v1.ts` (NOT `invariants.ts`/`invariants/index.ts`)
 * because `defs/admin/system-health/invariants/index.ts` already exists as a
 * RELATED-but-DIFFERENT def: the internal (cookie/forward-auth) facade for
 * `/api/admin/system-health/invariants`, mounted with `{kind:'admin'}` as an
 * outer gate — appropriate there since a cookie session is already
 * admin-verified.
 *
 * The ORIGINAL hand-written `/api/v1/admin/system-health/invariants` route had
 * NO outer gate — it called `handleHealthInvariants(event)` directly, which
 * does its own `authenticate()` + `requireScope(auth, 'tasks:admin')`. Reusing
 * the internal def's `{kind:'admin'}` gate here would reject a
 * `tasks:admin`-scoped PAT/service token lacking the literal `admin` scope,
 * which the original v1 route accepted — a behaviour regression. This def uses
 * the narrower, byte-faithful `{kind:'scope', anyOf:['tasks:admin']}` outer
 * gate instead; mount()'s enforce() runs the SAME primitives as the handler's
 * own check, so the 401/403 contract is preserved exactly.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no new internal twin
 * (the existing `/api/admin/system-health/invariants` internal facade is
 * untouched).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { handleHealthInvariants } from '$lib/server/admin/health-invariants.handler.js';
import { HealthInvariantsResponseSchema } from '$lib/schemas/health-invariants.schema';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get system-health invariants',
            stability: 'beta',
            description:
                'Returns the current pass/fail status of the task-system health invariants (green/amber/red findings). Requires `admin` scope.',
            responses: {
                200: {
                    schema: HealthInvariantsResponseSchema,
                    description: 'Health invariant findings',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => handleHealthInvariants(event),
    },
});
