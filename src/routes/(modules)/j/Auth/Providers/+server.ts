// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /Auth/Providers (Jellyfin SessionController, admin only) — the
 * authentication providers a user can be assigned. Lumastra checks app
 * passwords itself, which apps know as Jellyfin's default provider, so that is
 * the one entry — the same id `Policy.AuthenticationProviderId` reports.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { AUTH_PROVIDERS } from '$lib/server/jellyfin-compat/auth-providers';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const GET: RequestHandler = withJellyfinAuth((event) => {
    if (!localsIsAdmin(event.locals)) {
        return ApiResponses.forbidden('Administrator privileges required');
    }
    return json(AUTH_PROVIDERS);
});
