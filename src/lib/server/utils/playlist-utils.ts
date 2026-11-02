// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared utilities for Playlist API endpoints
 * Reduces code duplication across playlist CRUD operations
 */

import { ApiResponses } from './api-responses';
import { toUserId, type UserId } from '$lib/shared/user-id';
import * as m from '$lib/paraglide/messages';
import type postgres from 'postgres';

export type PlaylistRole = 'owner' | 'editor' | 'readonly' | null;

export interface PlaylistRoleResult {
    role: PlaylistRole;
    visibility?: 'private' | 'public';
    userId?: UserId;
    /**
     * True when the playlist may not be deleted, renamed, shared or reordered.
     * Keyed on the `is_system` column, NOT on playlist_type: playlist_type is
     * writable through PUT, so a guard keyed on it is defeated by flipping the
     * row to 'general' first.
     *
     * Deliberately non-optional: the row's `is_system` value is always known
     * whenever this function runs (including the `role: null` paths — no
     * playlist, or no access — where it is `false`). An optional field here
     * would let a guard written as `if (isSystem)` in code that destructures
     * this result silently fail open the moment `isSystem` is `undefined`.
     */
    isSystem: boolean;
}

export interface PlaylistContext {
    playlistId: number;
    username: string;
    /** UUID from users.id — use for user_data writes (playlist_item_watched, etc.) */
    userId: UserId | null;
    sql: postgres.Sql;
    role: PlaylistRole;
    /** See PlaylistRoleResult.isSystem. Undefined when requireRole is false. */
    isSystem?: boolean;
}

export interface PlaylistItemContext extends PlaylistContext {
    itemId: number;
}

/**
 * Event shape required by getPlaylistContext
 * Accepts params.id as string or number for compatibility with both
 * raw RequestEvent and ValidatedRequestEvent (which coerces to number)
 */
interface PlaylistEventLike {
    params: { id?: string | number };
    request: Request;
    locals: { user?: { username?: string } };
}

/**
 * Validates and extracts common playlist context
 * Returns null Response if validation fails, context if successful
 *
 * Accepts both standard RequestEvent and ValidatedRequestEvent types
 */
export async function getPlaylistContext(
    event: PlaylistEventLike,
    options: { requireRole?: boolean } = {},
): Promise<{ error: Response } | { context: PlaylistContext }> {
    const { params, request, locals } = event;

    // Parse and validate playlist ID
    if (params.id === undefined || params.id === null) {
        return {
            error: ApiResponses.badRequest(m.validation_playlist_id_required()),
        };
    }
    // Handle both string and number params (from raw event or validated event)
    const playlistId = typeof params.id === 'number' ? params.id : Number.parseInt(params.id, 10);
    if (Number.isNaN(playlistId)) {
        return {
            error: ApiResponses.badRequest(m.validation_playlist_id_invalid()),
        };
    }

    // Get authenticated user
    const { getEffectiveUser } = await import('$lib/server/dev-user');
    const authenticatedUser = locals.user?.username ?? null;
    const username = getEffectiveUser(request, authenticatedUser);

    if (!username) {
        return {
            error: ApiResponses.unauthorized(m.validation_auth_required()),
        };
    }

    // Get database connection
    const { getDb } = await import('$lib/server/database/connection');
    const sql = getDb();
    if (!sql) {
        return {
            error: ApiResponses.error(m.error_database_not_initialized()),
        };
    }

    // Resolve username → UUID once; used for role check and returned in context
    const userRows = await sql<Array<{ id: string }>>`
        SELECT id FROM users WHERE username = ${username} LIMIT 1
    `;
    const userId = userRows[0]?.id ? toUserId(userRows[0].id) : null;

    // Get user's role if required
    let role: PlaylistRole = null;
    let isSystem: boolean | undefined;
    if (options.requireRole !== false) {
        // Pass userId directly to skip the duplicate username→UUID lookup inside getUserRole
        const roleResult = await getUserRole(sql, playlistId, null, userId ?? undefined);
        role = roleResult.role;
        isSystem = roleResult.isSystem;

        if (!role) {
            return {
                error: ApiResponses.notFound(m.error_playlist_not_found_or_denied()),
            };
        }
    }

    return {
        context: { playlistId, username, userId, sql, role, isSystem },
    };
}

/**
 * Event shape required by getPlaylistItemContext
 *
 * The `url` field is required so we can parse both the playlist id and item id
 * from the URL path. The route nests two `[id]` segments
 * (`/playlists/[id]/items/[id]`) — SvelteKit only surfaces the innermost one
 * via `params.id`, so the playlist id must come from the URL.
 */
interface PlaylistItemEventLike {
    params: { id?: string | number };
    url: { pathname: string };
    request: Request;
    locals: { user?: { username?: string } };
}

/** Pattern matches both /api/playlists/{playlistId}/items/{itemId} and the /api/v1 variant. */
const PLAYLIST_ITEM_PATH_RE = /\/playlists\/(\d+)\/items\/(\d+)/;

/**
 * Validates and extracts playlist item context (includes itemId).
 *
 * Both path params ({id} = playlist, {itemId} = entry) are parsed from the URL
 * pathname, anchored on `/playlists/<id>/items/<itemId>`, so both ids always
 * come from the same place regardless of how the mount validated `params`.
 *
 * Accepts both standard RequestEvent and ValidatedRequestEvent types.
 */
export async function getPlaylistItemContext(
    event: PlaylistItemEventLike,
    options: { requireRole?: boolean } = {},
): Promise<{ error: Response } | { context: PlaylistItemContext }> {
    const match = PLAYLIST_ITEM_PATH_RE.exec(event.url.pathname);
    if (!match) {
        return {
            error: ApiResponses.badRequest(m.validation_item_id_required()),
        };
    }

    const playlistIdRaw = match[1];
    const itemIdRaw = match[2];

    const itemId = Number.parseInt(itemIdRaw, 10);
    if (Number.isNaN(itemId) || itemId <= 0) {
        return {
            error: ApiResponses.badRequest(m.validation_item_id_invalid()),
        };
    }

    // Synthesise a playlist-scoped event for getPlaylistContext, injecting the
    // playlist id parsed from the URL so it isn't overridden by the innermost
    // `[id]` segment (which SvelteKit resolves to the item id).
    const playlistEvent = {
        ...event,
        params: { id: playlistIdRaw },
    };

    // Get base playlist context
    const result = await getPlaylistContext(playlistEvent, options);

    if ('error' in result) {
        return result;
    }

    return {
        context: { ...result.context, itemId },
    };
}

// =============================================================================
// Permission Helpers
// =============================================================================

/**
 * Get user's role for a playlist (owner, editor, readonly, or null if no access)
 *
 * @param sql - postgres.Sql instance
 * @param playlistId - ID of the playlist to check (string or number)
 * @param username - Username to check access for (text lookup). Pass null when
 *   userId is provided directly.
 * @param userId - Optional UUID (users.id) to use directly, bypassing the
 *   username→UUID resolution. Preferred when the caller already has the UUID
 *   (e.g. SubsonicAuthContext.userId).
 * @returns Role information including visibility for public playlist handling
 */
export async function getUserRole(
    sql: postgres.Sql,
    playlistId: string | number,
    username: string | null,
    userId?: string,
): Promise<PlaylistRoleResult> {
    // Resolve username → UUID (playlists.user_id is now a UUID FK to users.id).
    // If the caller already has the UUID (userId param), skip the text lookup.
    let userUuid: string | null = userId ?? null;
    if (!userUuid && username) {
        const userRows = await sql<Array<{ id: string }>>`
            SELECT id FROM users WHERE username = ${username} LIMIT 1
        `;
        userUuid = userRows[0]?.id ?? null;
    }

    // Check if user is owner and get playlist visibility
    const ownerResult = await sql<
        Array<{
            user_id: string;
            visibility: 'private' | 'public';
            is_system: boolean;
        }>
    >`
        SELECT user_id, visibility, is_system
        FROM playlists
        WHERE id = ${playlistId}
    `;

    if (ownerResult.length === 0) {
        return { role: null, isSystem: false };
    }

    const { user_id, visibility, is_system } = ownerResult[0];
    // The playlist owner's user_id is a users.id UUID (mig 16.46.0) — mint the brand.
    const ownerUserId = toUserId(user_id);

    if (userUuid && user_id === userUuid) {
        return { role: 'owner', visibility, userId: ownerUserId, isSystem: is_system === true };
    }

    if (userUuid) {
        // Check if user is an accepted member
        const memberResult = await sql<Array<{ role: PlaylistRole }>>`
            SELECT role
            FROM playlist_members
            WHERE playlist_id = ${playlistId} AND user_id = ${userUuid}::uuid AND status = 'accepted'
        `;

        if (memberResult.length > 0) {
            return {
                role: memberResult[0].role,
                visibility,
                userId: ownerUserId,
                isSystem: is_system === true,
            };
        }
    }

    // Check public access
    if (visibility === 'public') {
        return { role: 'readonly', visibility, userId: ownerUserId, isSystem: is_system === true };
    }

    return { role: null, isSystem: false };
}

/**
 * Check if user can edit playlist content (owner or editor)
 */
export function canEdit(role: PlaylistRole): boolean {
    return role === 'owner' || role === 'editor';
}

/**
 * Check if user can manage playlist members (owner only)
 */
export function canManageMembers(role: PlaylistRole): boolean {
    return role === 'owner';
}
