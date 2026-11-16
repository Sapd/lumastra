// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request-level wrapper around canDownload for every download route: returns
 * the 403 problem response when the caller may not download, null otherwise.
 * Call it AFTER auth and checkMediaAccess so an item the user cannot see stays
 * a 404 (no existence leak).
 */

import { ApiProblem } from '$lib/server/api/problem.js';
import { canDownload, userMayDownload } from '$lib/server/services/download-access.service.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import * as m from '$lib/paraglide/messages';

type GuardLocals = Parameters<typeof localsIsAdmin>[0] & {
    user?: { userId?: string; username?: string } | null;
};

export async function downloadForbiddenResponse(
    locals: GuardLocals | null | undefined,
    opts: { kind: 'original' | 'rendition' } = { kind: 'original' },
): Promise<Response | null> {
    const user = locals?.user;
    // Admin is decided by the principal: an admin using a Quick Connect session or
    // a /j API key is treated as a normal user. 'rendition' skips the
    // FEATURE_MEDIA_DOWNLOAD switch (renditions have FEATURE_DOWNLOAD_RENDITIONS).
    const check = opts.kind === 'rendition' ? userMayDownload : canDownload;
    const allowed = await check(
        user
            ? { userId: user.userId, username: user.username, isAdmin: localsIsAdmin(locals) }
            : null,
    );
    if (allowed) return null;
    return ApiProblem.forbidden(m.downloads_not_allowed(), { reason: 'downloads_not_allowed' });
}
