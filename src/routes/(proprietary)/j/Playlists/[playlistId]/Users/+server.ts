// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import {
    getShares,
    resolvePlaylistAccess,
} from '$lib/server/proprietary/jellyfin-compat/playlist-service';
import type { JellyfinPlaylistUserPermissions } from '$lib/server/proprietary/jellyfin-compat/types';

/**
 * GET /j/Playlists/{playlistId}/Users — GetPlaylistUsers. Owner only (403 for
 * anyone else who can see the playlist), as in Jellyfin. Pending invites are
 * listed too: they are shares the owner made.
 */
export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, params } = event;
    const user = locals.user;
    if (!user) return ApiResponses.unauthorized();
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const resolved = await resolvePlaylistAccess(sql, params.playlistId, user);
    if ('error' in resolved) return resolved.error;
    const { access } = resolved;

    if (access.role !== 'owner') {
        return ApiResponses.forbidden('Only the owner can list playlist users');
    }
    const shares: JellyfinPlaylistUserPermissions[] = await getShares(sql, access, user);
    return json(shares);
});
