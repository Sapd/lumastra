// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * access-gate.ts — shared resource-level access gate for playlist sub-resources.
 *
 * Enforces that the caller is a member (owner / editor / readonly) OR that the
 * playlist is public before allowing them to read or write comments/reactions.
 *
 * Rule (matches legacy /api/playlists/[id]/chat + chat/[messageId] behaviour):
 *   - Any role (including 'readonly') → allowed for both read and write ops.
 *   - No role on a PRIVATE playlist → 404 (not 403) so private playlist
 *     existence is not leaked to non-members.
 *   - Public playlists → getUserRole returns 'readonly' for anonymous callers,
 *     which satisfies the role check above.
 *   - The watchlist (a system playlist, `is_system`) → 409, below. It is
 *     never shared and has no members to comment or react, so it fails the
 *     membership rule above in spirit even when the caller IS the owner —
 *     this is a separate check, not a special case of the membership rule.
 *
 * The `op` parameter is accepted for interface conformance but both 'read' and
 * 'write' use the same membership check — any member may post a comment or react,
 * replicating the chat-route policy. If a stricter write policy is needed in
 * future (e.g. readonly members may not post), thread `op` into the guard here.
 */

import { ApiProblem } from '$lib/server/api/problem.js';
import { getUserRole } from '$lib/server/utils/playlist-utils.js';
import type { AccessGateFn } from '$lib/server/api/defs/interactions/handlers.js';

/**
 * Playlist membership access gate for the `AccessGateFn` contract.
 *
 * Reads the playlist id from `event.params.id` (the standard SvelteKit param
 * for routes mounted under `/playlists/[id]/*`).
 *
 * Returns `null` (allow) when the caller has any role; returns a 404 problem
 * response when they have no role on a private playlist.
 */
export const playlistAccessGate: AccessGateFn = async (sql, _targetId, event, _op) => {
    // The playlist id is the [id] segment of the route, not the interaction
    // targetId (which is the same value but comes from the factory as a string).
    // Use event.params.id so the gate is decoupled from the factory's targetId
    // extraction logic.
    const rawId = event.params.id ?? '';
    const playlistId = Number.parseInt(rawId, 10);
    if (Number.isNaN(playlistId) || playlistId <= 0) {
        // Malformed id — let the handler's own validationFailed run (gate passes).
        return null;
    }

    // Resolve caller identity: principal (token auth) → user (session auth).
    const username = event.locals.principal?.username ?? event.locals.user?.username ?? null;

    const { role, isSystem } = await getUserRole(sql, playlistId, username ?? null);

    if (!role) {
        // No role → either the playlist does not exist or the caller is not a
        // member and the playlist is private. Return 404 in both cases so we
        // do not leak whether a private playlist exists.
        return ApiProblem.notFound('Playlist not found or access denied');
    }

    // A system playlist (the watchlist) is never shared and has no members to
    // comment or react — comments/index.ts and reactions/index.ts both route
    // through this gate, so guarding here covers both without duplicating the
    // check in each file. Keyed on is_system, not playlist_type — see
    // PlaylistRoleResult.isSystem.
    if (isSystem) {
        return ApiProblem.conflict('This playlist does not support that operation');
    }

    return null; // allowed
};
