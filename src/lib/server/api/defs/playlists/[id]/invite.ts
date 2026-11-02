// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/invite.ts — POST /playlists/{id}/invite
 *
 * Accept or deny a pending playlist invite for the authenticated user.
 *
 * Auth: authenticated user (no feature flag — invites must be processable
 * even if the playlists feature is temporarily disabled, so the recipient
 * can still decline).
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/invite/+server.ts (internal surface)
 */

import { z } from 'zod';
import { authorOrPlaceholder, loadPublicAuthors } from '$lib/server/utils/public-author.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getPlaylistInvite,
    acceptInvite,
    deleteInvite,
} from '$lib/server/database/queries/playlists.queries.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import {
    processInviteSchema,
    inviteAcceptedResponseSchema,
    inviteDeniedResponseSchema,
} from '$lib/schemas/playlists.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaylistInviteDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const InviteParams = z.object({
    id: z.coerce.number().int().positive(),
});

// Body validation uses the shared named schema (processInviteSchema) — the same
// object the retired _openapi.ts $ref'd — so the emitted spec keeps the
// #/components/schemas/processInvite reference (byte-identical). It is
// structurally identical to the previous local InviteBody.
const InviteBody = processInviteSchema;

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    // OpenAPI docs for the /api/v1/playlists/{id}/invite (public/native) surface.
    // Migrated verbatim from the retired
    // src/routes/api/playlists/[id]/invite/_openapi.ts (which the v1 _openapi.ts
    // re-exported).
    docs: {
        POST: {
            tags: ['Playlists'],
            stability: 'beta',
            summary: 'Accept or decline a playlist invite',
            description:
                'Accept or deny a pending playlist invite. When accepted, returns the playlist info with assigned role.',
            body: processInviteSchema,
            responses: {
                200: {
                    schema: z.union([inviteAcceptedResponseSchema, inviteDeniedResponseSchema]),
                    description: 'Invite processed',
                },
                404: 'Playlist not found',
            },
        },
    },

    request: {
        params: InviteParams,
        body: InviteBody,
    },
    handlers: {
        /**
         * POST /playlists/{id}/invite
         * Accept or deny a pending playlist invite.
         *
         * Body: { action: 'accept' | 'deny' }
         * Response: bare object with outcome details.
         */
        POST: async (event, ctx) => {
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

            const userUuid = await getUserIdByUsername(sql, username);
            if (!userUuid) return ApiProblem.notFound('No invite found for this playlist');

            const invite = await getPlaylistInvite(sql, playlistId, userUuid);
            if (!invite) return ApiProblem.notFound('No invite found for this playlist');

            if (invite.status !== 'pending') {
                return ApiProblem.conflict('Invite has already been processed');
            }

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = InviteBody.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const { action } = parsed.data;

            if (action === 'accept') {
                await acceptInvite(sql, playlistId, userUuid);

                logger.info('Invite accepted', {
                    playlistId,
                    username,
                    playlistName: invite.playlist_name,
                    owner: invite.owner_username,
                });

                return json({
                    message: 'Invite accepted',
                    playlist: {
                        id: playlistId,
                        name: invite.playlist_name,
                        owner: authorOrPlaceholder(
                            await loadPublicAuthors([invite.user_id], ctx.surface),
                            invite.user_id,
                            ctx.surface,
                        ),
                        role: invite.role,
                    },
                });
            } else {
                await deleteInvite(sql, playlistId, userUuid);

                logger.info('Invite denied', {
                    playlistId,
                    username,
                    playlistName: invite.playlist_name,
                    owner: invite.owner_username,
                });

                return json({ message: 'Invite declined' });
            }
        },
    },
});
