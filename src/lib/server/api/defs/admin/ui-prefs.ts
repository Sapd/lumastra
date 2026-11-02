// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ui-prefs — per-admin-user UI preferences (admin IA redesign, spec §4).
 *
 * GET   /api/admin/ui-prefs  → { navStyle }   (defaults to 'sidebar' when unset)
 * PATCH /api/admin/ui-prefs  → { navStyle }   (persists the chosen nav style)
 *
 * Per-USER (keyed by users.id), not an instance setting — two admins on the same
 * server can prefer different nav layouts. Auth: admin session.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getAdminUiPrefs,
    upsertAdminNavStyle,
    type StoredNavStyle,
} from '$lib/server/database/queries/admin-ui-prefs.queries.js';
import { AdminUiPrefsPatchBodySchema } from '$lib/schemas/api-admin-responses.js';

const DEFAULT_NAV_STYLE: StoredNavStyle = 'sidebar';

/** Coerce a stored free-text nav_style back to the known union (fail-safe). */
function normalizeNavStyle(value: string | undefined | null): StoredNavStyle {
    return value === 'mega' ? 'mega' : 'sidebar';
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event, _ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized('Admin session required');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const row = await getAdminUiPrefs(sql, userId);
            return json({ navStyle: normalizeNavStyle(row?.nav_style ?? DEFAULT_NAV_STYLE) });
        },

        PATCH: async (event, _ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized('Admin session required');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            let rawBody: unknown;
            try {
                rawBody = await readBoundedJson(event.request);
            } catch {
                return ApiProblem.validationFailed('Invalid JSON body');
            }
            const parsed = AdminUiPrefsPatchBodySchema.safeParse(rawBody);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }

            const row = await upsertAdminNavStyle(sql, userId, parsed.data.navStyle);
            return json({ navStyle: normalizeNavStyle(row.nav_style) });
        },
    },
});
