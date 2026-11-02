// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { serializeUser } from '$lib/server/proprietary/jellyfin-compat/serializers/user';
import { loadUserPlaybackPreferences } from '$lib/server/proprietary/jellyfin-compat/user-playback-preferences';
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
                users.map(async (u) =>
                    serializeUser(
                        {
                            id: u.id,
                            username: u.username,
                            is_admin: u.is_admin,
                            display_name: u.display_name,
                        },
                        await loadUserPlaybackPreferences(u.id, sql),
                    ),
                ),
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
