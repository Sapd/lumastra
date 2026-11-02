// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { integrationRedirectUri } from '$lib/shared/public-base-url.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { getMalLinkStatus } from '$lib/server/database/queries/mal-credentials.queries.js';
import { getPreference } from '$lib/server/database/queries/watch-sync-preferences.queries.js';

const PROVIDER = 'mal';

/**
 * GET /api/integrations/mal/status
 *
 * Returns the current MyAnimeList link status for the authenticated user.
 * Bare response: { configured, linked, malUsername?, linkedAt?, direction }
 */
export const malStatusDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();

            const configured = Boolean(config.MAL_CLIENT_ID && config.MAL_CLIENT_SECRET);

            const redirectUri = integrationRedirectUri(config.PUBLIC_BASE_URL, 'mal');
            const sql = getDb();
            if (!sql) {
                return json({ configured, redirectUri, linked: false });
            }

            const [status, pref] = await Promise.all([
                getMalLinkStatus(sql, user.userId),
                getPreference(sql, user.userId, PROVIDER),
            ]);

            if (!status) {
                return json({ configured, redirectUri, linked: false, direction: pref.direction });
            }

            return json({
                configured,
                linked: !status.authFailed,
                auth_failed: status.authFailed,
                redirectUri,
                malUsername: status.providerUsername,
                linkedAt: status.createdAt,
                direction: pref.direction,
            });
        },
    },
});
