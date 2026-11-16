// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { serializeUser } from '$lib/server/jellyfin-compat/serializers/user';
import { withDownloadPermissionFor } from '$lib/server/jellyfin-compat/user-download-permission';
import { loadUserPlaybackPreferences } from '$lib/server/jellyfin-compat/user-playback-preferences';
import { getUserByUsername, listUsers } from '$lib/server/database/queries/users.queries';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    if (localsIsAdmin(locals)) {
        const users = await listUsers(sql);
        return json(
            await Promise.all(
                users.map(async (u) => {
                    const playback = await loadUserPlaybackPreferences(u.id, sql);
                    // Each row carries THAT user's download permission, not the caller's.
                    return withDownloadPermissionFor(
                        { userId: u.id, username: u.username, isAdmin: u.is_admin },
                        () =>
                            serializeUser(
                                {
                                    id: u.id,
                                    username: u.username,
                                    is_admin: u.is_admin,
                                    display_name: u.display_name,
                                },
                                playback,
                            ),
                    );
                }),
            ),
        );
    }

    const user = await getUserByUsername(sql, locals.user.username);
    if (!user) {
        return ApiResponses.notFound('User not found');
    }

    return json([
        serializeUser(
            {
                id: user.id,
                username: user.username,
                is_admin: user.is_admin,
                display_name: user.display_name,
                hasLiveTvPermission: locals.user.hasLiveTvPermission,
                maxAgeRating: locals.user.maxAgeRating,
            },
            await loadUserPlaybackPreferences(user.id, sql),
        ),
    ]);
});
