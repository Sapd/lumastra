// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/integrations/homepage.ts — GET /api/v1/integrations/homepage
 *
 * Read-only server summary shaped for gethomepage.dev's generic `customapi` widget:
 * sessions, cluster nodes, running tasks, health alerts, library counts and recently
 * added items.
 *
 * Auth: an administrator (`principal.isAdmin` — deriveIsAdmin: an admin session, or an
 * admin-scoped token whose owner is STILL an admin) OR a service token with the
 * `integrations:read` grant whose owner is still an administrator
 * (`integrationTokenDenial()`). The payload names every user and what they are watching,
 * so the handler re-checks one of the two after mount's
 * `{kind:'scope', anyOf:['integrations:read']}` gate (which `admin` scopes also pass).
 * The recommended credential is an `integrations:read` service token.
 *
 * v1-only: HAND-MOUNTED from src/routes/api/v1/integrations/homepage/+server.ts — no
 * internal twin generated.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { integrationTokenDenial } from '$lib/server/auth/integration-token.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { getHomepageSummary } from '$lib/server/services/homepage-summary.service.js';
import { HomepageSummarySchema } from '$lib/schemas/api-homepage-responses.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['integrations:read'] },
    docs: {
        visibility: 'public',
        GET: {
            tags: ['Integrations'],
            summary: 'Server summary for Homepage dashboards',
            description:
                'Sessions, cluster nodes, running tasks, health alerts, library counts and recently added items, shaped for the gethomepage.dev `customapi` widget: flat numbers under `summary`/`library`, and `name`/`label` rows for its `dynamic-list` view. Cached for 5 s (library data for 5 min). For administrators and service tokens with the `integrations:read` grant (owner still admin); use an `integrations:read` service token.',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: { schema: HomepageSummarySchema, description: 'Summary snapshot' },
                401: 'Authentication required',
                403: 'Not an admin or an integrations:read service token',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            const principal = event.locals.principal;
            if (principal?.isAdmin !== true) {
                const denial = integrationTokenDenial(principal);
                if (denial) return denial;
            }

            const sql = getAdminDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const summary = await getHomepageSummary(sql);
            return json(HomepageSummarySchema.parse(summary), {
                headers: { 'Cache-Control': 'no-store' },
            });
        },
    },
});
