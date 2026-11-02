// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * GET /Auth/PasswordResetProviders (Jellyfin SessionController, admin only) —
 * the password-reset providers a user can be assigned: Jellyfin's default one,
 * the id `Policy.PasswordResetProviderId` reports.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { PASSWORD_RESET_PROVIDERS } from '$lib/server/proprietary/jellyfin-compat/auth-providers';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const GET: RequestHandler = withJellyfinAuth((event) => {
    if (!localsIsAdmin(event.locals)) {
        return ApiResponses.forbidden('Administrator privileges required');
    }
    return json(PASSWORD_RESET_PROVIDERS);
});
