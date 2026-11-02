// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/chat/index.ts — GET/POST /playlists/{id}/chat
 *
 * Auth: feature-gated (playlistChat) + any authenticated user with playlist access.
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/chat/+server.ts (internal surface)
 */

import { z } from 'zod';
import { authorOrPlaceholder, loadPublicAuthors } from '$lib/server/utils/public-author.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getUserRole } from '$lib/server/utils/playlist-utils.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getPlaylistChatMessages,
    insertPlaylistChatMessage,
} from '$lib/server/database/queries/chat.queries.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaylistChatDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ChatIdParams = z.object({
    id: z.coerce.number().int().positive(),
});

const ChatGetQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    cursor: z.coerce.number().int().positive().optional(),
    since: z.coerce.number().int().positive().optional(),
});

const ChatPostBody = z.object({
    message: z
        .string()
        .min(1, 'Message is required')
        .max(1000, 'Message too long (max 1000 characters)')
        .transform((s) => s.trim())
        .refine((s) => s.length > 0, { message: 'Message cannot be empty' }),
});

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'playlistChat', then: { kind: 'user' } },
    visibility: 'internal',
    request: {
        params: ChatIdParams,
        query: ChatGetQuery,
        body: ChatPostBody,
    },
    handlers: {
        /**
         * GET /playlists/{id}/chat
         * Get chat messages for a playlist (any member).
         *
         * Response: { items: ChatMessage[], page }
         */
        GET: async (event, ctx) => {
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

            const { role, isSystem } = await getUserRole(sql, playlistId, username);
            if (!role) return ApiProblem.notFound('Playlist not found or access denied');
            if (isSystem) {
                return ApiProblem.conflict('This playlist does not support that operation');
            }

            if (event.url.searchParams.has('before'))
                return ApiProblem.validationFailed('before is retired; use cursor');
            if (event.url.searchParams.has('cursor') && event.url.searchParams.has('since'))
                return ApiProblem.validationFailed('cursor and since cannot be combined');
            const limitParam = event.url.searchParams.get('limit');
            const beforeParam = event.url.searchParams.get('cursor');
            const sinceParam = event.url.searchParams.get('since');

            const limit = limitParam
                ? Math.min(Math.max(1, Number.parseInt(limitParam, 10)), 100)
                : 50;
            const before = beforeParam ? Number.parseInt(beforeParam, 10) : undefined;
            const since = sinceParam ? Number.parseInt(sinceParam, 10) : undefined;

            const rawRows = await getPlaylistChatMessages(sql, {
                playlistId,
                limit: limit + 1,
                before: before ?? undefined,
                since: since ?? undefined,
            });

            const messagesResult = rawRows.slice(0, limit);
            const hasMore = rawRows.length > limit;

            // When using 'since', messages are in ASC order; otherwise DESC and need reversing.
            const rawMessages = since ? messagesResult : messagesResult.toReversed();
            const authors = await loadPublicAuthors(
                rawMessages.map((row) => row.user_id),
                ctx.surface,
            );
            const messages = rawMessages.map((row) => ({
                id: row.id,
                author: authorOrPlaceholder(authors, row.user_id, ctx.surface),
                message: row.message,
                messageType: row.message_type || 'user',
                createdAt:
                    row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
            }));

            return json({
                items: messages,
                page: {
                    limit,
                    hasMore,
                    ...(!since && hasMore && messagesResult.length > 0
                        ? { nextCursor: String(messagesResult[messagesResult.length - 1].id) }
                        : {}),
                },
            });
        },

        /**
         * POST /playlists/{id}/chat
         * Send a chat message.
         *
         * Response: 201 + bare message object.
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

            const { role, isSystem } = await getUserRole(sql, playlistId, username);
            if (!role) return ApiProblem.notFound('Playlist not found or access denied');
            if (isSystem) {
                return ApiProblem.conflict('This playlist does not support that operation');
            }

            const userId = await getUserIdByUsername(sql, username);
            if (!userId) return ApiProblem.notFound('Playlist not found or access denied');

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = ChatPostBody.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const newMessage = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId,
                message: parsed.data.message,
            });

            logger.info('Chat message sent', {
                playlistId,
                messageId: newMessage.id,
                username,
            });

            return json(
                {
                    id: newMessage.id,
                    author: authorOrPlaceholder(
                        await loadPublicAuthors([userId], ctx.surface),
                        userId,
                        ctx.surface,
                    ),
                    message: newMessage.message,
                    messageType: newMessage.message_type,
                    createdAt:
                        newMessage.created_at instanceof Date
                            ? newMessage.created_at.toISOString()
                            : newMessage.created_at,
                },
                { status: 201 },
            );
        },
    },
});
