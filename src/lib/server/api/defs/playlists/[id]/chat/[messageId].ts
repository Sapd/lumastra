// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/chat/[messageId].ts — DELETE /playlists/{id}/chat/{messageId}
 *
 * Soft-delete a chat message. Only the message author or the playlist owner
 * may delete a message.
 *
 * Auth: feature-gated (playlistChat) + authenticated user.
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/chat/[messageId]/+server.ts (internal surface)
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getUserRole } from '$lib/server/utils/playlist-utils.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getChatMessageWithContext,
    softDeleteChatMessage,
} from '$lib/server/database/queries/chat.queries.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaylistChatMessageDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ChatMessageParams = z.object({
    id: z.coerce.number().int().positive(),
    messageId: z.coerce.number().int().positive(),
});

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'playlistChat', then: { kind: 'user' } },
    visibility: 'internal',
    request: {
        params: ChatMessageParams,
    },
    handlers: {
        /**
         * DELETE /playlists/{id}/chat/{messageId}
         * Soft-delete a chat message (author or playlist owner only).
         *
         * Response: 200 + { message }.
         */
        DELETE: async (event) => {
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

            const rawMessageId = event.params.messageId;
            const messageId = rawMessageId ? Number.parseInt(rawMessageId, 10) : Number.NaN;
            if (Number.isNaN(messageId) || messageId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'messageId', message: 'Must be a positive integer' },
                ]);
            }

            const { role } = await getUserRole(sql, playlistId, username);
            if (!role) return ApiProblem.notFound('Playlist not found or access denied');

            const message = await getChatMessageWithContext(sql, { messageId, playlistId });
            if (!message) return ApiProblem.notFound('Message not found');

            const effectiveUserId = await getUserIdByUsername(sql, username);
            const isAuthor = effectiveUserId !== null && message.user_id === effectiveUserId;
            const isOwner = effectiveUserId !== null && message.owner_user_id === effectiveUserId;

            if (!isAuthor && !isOwner) {
                return ApiProblem.forbidden('You can only delete your own messages');
            }

            await softDeleteChatMessage(sql, messageId);

            logger.info('Chat message deleted', {
                playlistId,
                messageId,
                deletedBy: username,
                wasAuthor: isAuthor,
            });

            return json({ message: 'Message deleted' });
        },
    },
});
