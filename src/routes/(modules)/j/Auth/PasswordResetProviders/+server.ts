// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /Auth/PasswordResetProviders (Jellyfin SessionController, admin only) —
 * the password-reset providers a user can be assigned: Jellyfin's default one,
 * the id `Policy.PasswordResetProviderId` reports.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { PASSWORD_RESET_PROVIDERS } from '$lib/server/jellyfin-compat/auth-providers';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const GET: RequestHandler = withJellyfinAuth((event) => {
    if (!localsIsAdmin(event.locals)) {
        return ApiResponses.forbidden('Administrator privileges required');
    }
    return json(PASSWORD_RESET_PROVIDERS);
});
