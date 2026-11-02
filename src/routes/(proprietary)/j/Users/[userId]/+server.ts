// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { serializeUser } from '$lib/server/proprietary/jellyfin-compat/serializers/user';
import { loadUserPlaybackPreferences } from '$lib/server/proprietary/jellyfin-compat/user-playback-preferences';
import { getUserByUsername } from '$lib/server/database/queries/users.queries';
import type { UserRow } from '$lib/server/database/queries/users.queries';
import { getDb } from '$lib/server/database';
import { hasGroupPermission } from '$lib/server/auth';
import { config } from '$lib/server/config';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';

async function getUserById(sql: ReturnType<typeof getDb>, id: string): Promise<UserRow | null> {
    if (!sql) return null;
    const rows = await sql<UserRow[]>`
        SELECT id, username, is_admin, display_name, email, hide_streams, groups, groups_updated_at, created_at, updated_at, last_seen_at
        FROM users
        WHERE id = ${id}
        LIMIT 1
    `;
    return rows[0] ?? null;
}

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, params } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const currentUser = await getUserByUsername(sql, locals.user.username);
    if (!currentUser) {
        return ApiResponses.notFound('User');
    }

    // Compat IDs are users.id in Jellyfin's compact UUID form, never the
    // upstream jellyfin_user_id (which belongs exclusively to Jellyfin sync).
    const rawUserId = params.userId ?? '';
    if (!isUuid(rawUserId)) return ApiResponses.notFound('User');
    const targetUserId = normalizeUuid(rawUserId);

    if (currentUser.id === targetUserId) {
        return json(
            serializeUser(
                {
                    id: currentUser.id,
                    username: currentUser.username,
                    is_admin: currentUser.is_admin,
                    display_name: currentUser.display_name,
                    hasLiveTvPermission: locals.user.hasLiveTvPermission,
                    maxAgeRating: locals.user.maxAgeRating,
                },
                await loadUserPlaybackPreferences(currentUser.id, sql),
            ),
        );
    }

    // Non-admins may only read their own user (handled above). For any other
    // target they get 404 — NOT 403 — so they cannot distinguish an existing
    // user UUID from a missing one (existence-leak rule). Only admins are
    // allowed to learn whether a given user actually exists.
    if (!localsIsAdmin(locals)) {
        return ApiResponses.notFound('User');
    }

    const targetUser = await getUserById(sql, targetUserId);
    if (!targetUser) {
        return ApiResponses.notFound('User');
    }

    return json(
        serializeUser(
            {
                id: targetUser.id,
                username: targetUser.username,
                is_admin: targetUser.is_admin,
                display_name: targetUser.display_name,
                hasLiveTvPermission:
                    targetUser.is_admin ||
                    hasGroupPermission(targetUser.groups ?? [], config.LIVETV_GROUPS),
            },
            await loadUserPlaybackPreferences(targetUser.id, sql),
        ),
    );
});
