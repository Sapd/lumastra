// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Jellyfin compat: POST /Sessions/Logout — revoke the current session token.
// Jellyfin clients (Swiftfin, Streamyfin, Jellyfin Mobile) call this on
// sign-out. Without it the Valkey session lives on for the full 30-day TTL,
// so a stolen/lost device retains a working AccessToken.

import type { RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { revokeSession } from '$lib/server/proprietary/jellyfin-compat/auth';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:Logout');

const handler: RequestHandler = async (event) => {
    const jfToken = (event.locals as unknown as { jfToken?: string }).jfToken;

    // PAT-authenticated requests carry an empty jfToken — there's no Valkey
    // session to revoke. Return 204 anyway; the client can drop the PAT
    // locally if it wants to.
    if (jfToken) {
        await revokeSession(jfToken);
        logger.info('jfcompat session revoked via /Sessions/Logout', {
            username: event.locals.user?.username,
        });
    }

    return new Response(null, { status: 204 });
};

export const POST: RequestHandler = withJellyfinAuth(handler, {
    mode: 'write',
});
