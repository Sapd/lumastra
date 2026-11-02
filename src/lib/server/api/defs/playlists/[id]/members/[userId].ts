// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/members/[userId].ts — PUT/DELETE /playlists/{id}/members/{userId}
 *
 * Per-member operations keyed by user UUID.
 *
 * Both internal and v1 surfaces address members by their stable users.id UUID.
 *
 * Auth:
 *   PUT    — playlist owner only (role change)
 *   DELETE — owner OR self-removal
 *
 * Mounted at:
 *   src/routes/api/v1/playlists/[id]/members/[userId]/+server.ts
 *   src/routes/api/playlists/[id]/members/[userId]/+server.ts
 */

import { authorOrPlaceholder, loadPublicAuthors } from '$lib/server/utils/public-author.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getUserRole, canManageMembers } from '$lib/server/utils/playlist-utils.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    updateMemberRole,
    deleteMember,
    deleteMemberWatchedStatus,
} from '$lib/server/database/queries/playlists.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import { updateMemberRoleSchema } from '$lib/schemas/playlists.js';
import { Logger } from '$lib/server/utils/logger.js';
import { playlistMemberSchema } from '$lib/schemas/playlists';

const logger = Logger.for('PlaylistMemberByIdDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * Path params for /playlists/{id}/members/{userId}.
 *
 * `id` is coerced to a number (positive integer playlist id).
 * `userId` is a plain string path segment (NOT .uuid()): the handler runs its
 * own UUID regex check and 422s a malformed id before any DB work, so it stays
 * authoritative. A stricter schema .uuid() (which also enforces the UUID version
 * nibble) would pre-reject formerly-valid ids the handler's regex accepts.
 */
const MemberByIdParams = z.object({
    id: z.coerce.number().int().positive(),
    userId: z.string().min(1),
});

export const def = defineEndpoint({
    docs: {
        PUT: {
            tags: ['Playlists'],
            summary: 'Update a playlist member role',
            stability: 'stable',
            auth: 'bearer',
            description: "Updates a member's role (editor/readonly) on the playlist. Owner-only.",
            body: updateMemberRoleSchema,
            responses: {
                200: {
                    schema: playlistMemberSchema,
                    description: 'Updated member',
                },
                400: 'Validation error',
                401: 'Authentication required',
                403: 'Not the playlist owner',
                404: 'Playlist or member not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Playlists'],
            summary: 'Remove a playlist member',
            stability: 'stable',
            auth: 'bearer',
            description: 'Removes a member from the playlist. Owner-only, or self-removal.',
            responses: {
                204: 'Member removed',
                401: 'Authentication required',
                403: 'Not the playlist owner',
                404: 'Playlist or member not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'feature', flag: 'playlists', then: { kind: 'user' } },
    // No def-level `request.body`: mount() applies a declared body schema to
    // every method that can carry one, including DELETE (see mount.ts
    // `methodCanHaveBody`). `updateMemberRoleSchema` has a required `role`
    // field, so declaring it here would reject every DELETE (empty body)
    // before this handler ever runs. PUT validates the body itself instead
    // (it already does — see below).
    request: {
        params: MemberByIdParams,
    },
    handlers: {
        /**
         * PUT /playlists/{id}/members/{userId}
         * Update a member's role (owner only).
         *
         * PARITY GAP FIX: this PUT was implemented internally but was not exposed
         * on the v1 surface (the shim only re-exported DELETE). This def closes that.
         *
         * Body: { role: 'editor'|'readonly' }
         * Response: 200 + bare updated member object.
         */
        PUT: async (event, ctx) => {
            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;
            if (!username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rawId = event.params.id;
            const playlistId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
            if (Number.isNaN(playlistId) || playlistId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a positive integer' },
                ]);
            }

            const userId = event.params.userId ?? '';
            if (!userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
                return ApiProblem.validationFailed([
                    { field: 'userId', message: 'Must be a valid UUID' },
                ]);
            }

            // Caller must be owner
            const { role: callerRole, isSystem } = await getUserRole(sql, playlistId, username);
            if (!callerRole) {
                return ApiProblem.notFound('Playlist not found');
            }
            if (!canManageMembers(callerRole)) {
                return ApiProblem.forbidden('Only the owner can update member roles');
            }
            if (isSystem) {
                return ApiProblem.conflict('This playlist does not support that operation');
            }

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = updateMemberRoleSchema.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const targetUserId = toUserId(userId);
            const member = await updateMemberRole(sql, playlistId, targetUserId, parsed.data.role);

            if (!member) {
                return ApiProblem.notFound('Member not found');
            }

            logger.info('Member role updated', {
                playlistId,
                targetUserId: userId,
                newRole: parsed.data.role,
                updatedBy: username,
            });

            return json({
                author: authorOrPlaceholder(
                    await loadPublicAuthors([member.user_id], ctx.surface),
                    member.user_id,
                    ctx.surface,
                ),
                role: member.role,
                status: member.status,
                invitedAt:
                    member.invited_at instanceof Date
                        ? member.invited_at.toISOString()
                        : member.invited_at,
            });
        },

        /**
         * DELETE /playlists/{id}/members/{userId}
         * Remove a member from a playlist.
         *
         * Auth: owner can remove any member; a user may remove themselves (self-leave).
         * Response: 204 No Content.
         */
        DELETE: async (event) => {
            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;
            const callerUserId =
                event.locals.principal?.userId ?? event.locals.user?.userId ?? null;
            if (!username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rawId = event.params.id;
            const playlistId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
            if (Number.isNaN(playlistId) || playlistId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a positive integer' },
                ]);
            }

            const userId = event.params.userId ?? '';
            if (!userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
                return ApiProblem.validationFailed([
                    { field: 'userId', message: 'Must be a valid UUID' },
                ]);
            }

            const { role: callerRole, isSystem } = await getUserRole(sql, playlistId, username);
            if (!callerRole) {
                return ApiProblem.notFound('Playlist not found');
            }

            const isOwner = canManageMembers(callerRole);
            // Q8: compare UUIDs not usernames for self-removal
            const isSelf = callerUserId ? String(callerUserId) === userId : false;

            if (!isOwner && !isSelf) {
                return ApiProblem.forbidden('Only the owner can remove other members');
            }
            if (isSystem) {
                return ApiProblem.conflict('This playlist does not support that operation');
            }

            const targetUserId = toUserId(userId);
            const deleted = await sql.begin(async (txRaw) => {
                const tx = txRaw as unknown as typeof sql;
                const result = await deleteMember(tx, playlistId, targetUserId);
                if (result) {
                    await deleteMemberWatchedStatus(tx, playlistId, targetUserId);
                }
                return result;
            });

            if (!deleted) {
                return ApiProblem.notFound('Member not found');
            }

            logger.info('Member removed from playlist', {
                playlistId,
                removedUserId: userId,
                removedBy: username,
                selfRemoval: isSelf,
            });

            return new Response(null, { status: 204 });
        },
    },
});
