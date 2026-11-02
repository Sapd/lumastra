// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Chat Query Module
 *
 * Tests playlist chat message CRUD, pagination, and soft delete against a
 * real PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

import {
    getPlaylistChatMessages,
    getChatMessageWithContext,
    insertPlaylistChatMessage,
    softDeleteChatMessage,
} from './chat.queries.js';

describe('Chat Queries', () => {
    let sql: postgres.Sql;
    const testUser: UserId = toUserId(randomUUID());

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM collaborative_chat_messages WHERE context_id IN (SELECT id FROM playlists WHERE user_id = ${testUser}::uuid)`;
        await sql`DELETE FROM playlists WHERE user_id = ${testUser}::uuid`;
        await sql`DELETE FROM users WHERE id = ${testUser}::uuid`;
        await ensureTestUser(sql, testUser);
    });

    async function insertPlaylist(userId: string, name: string): Promise<number> {
        const rows = await sql<{ id: number }[]> /* sql */ `
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${userId}::uuid, ${name}, 'private', 'general')
            RETURNING id
        `;
        return rows[0].id;
    }

    // ========================================================================
    // insertPlaylistChatMessage
    // ========================================================================

    describe('insertPlaylistChatMessage', () => {
        it('inserts a message and returns it with id, user_id, message, message_type, created_at', async () => {
            const playlistId = await insertPlaylist(testUser, 'Insert Test');

            const result = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'Hello, chat!',
            });

            expect(result.id).toBeGreaterThan(0);
            expect(result.user_id).toBe(testUser);
            expect(result.message).toBe('Hello, chat!');
            expect(result.message_type).toBe('user');
            expect(result.created_at).toBeInstanceOf(Date);
        });
    });

    // ========================================================================
    // getPlaylistChatMessages
    // ========================================================================

    describe('getPlaylistChatMessages', () => {
        it('returns messages for a playlist ordered DESC by created_at by default', async () => {
            const playlistId = await insertPlaylist(testUser, 'Order Desc');

            const msg1 = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'First',
            });
            await new Promise((r) => setTimeout(r, 20));
            const msg2 = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'Second',
            });

            const messages = await getPlaylistChatMessages(sql, {
                playlistId,
                limit: 10,
            });

            expect(messages.length).toBe(2);
            expect(messages[0].id).toBe(msg2.id);
            expect(messages[1].id).toBe(msg1.id);
        });

        it('with since returns only messages with id > since, ordered ASC', async () => {
            const playlistId = await insertPlaylist(testUser, 'Since Pag');

            const msg1 = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'A',
            });
            const msg2 = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'B',
            });
            const msg3 = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'C',
            });

            const messages = await getPlaylistChatMessages(sql, {
                playlistId,
                limit: 10,
                since: msg1.id,
            });

            expect(messages.length).toBe(2);
            expect(messages[0].id).toBe(msg2.id);
            expect(messages[1].id).toBe(msg3.id);
        });

        it('with before returns only messages with id < before, ordered DESC', async () => {
            const playlistId = await insertPlaylist(testUser, 'Before Pag');

            const msg1 = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'A',
            });
            const msg2 = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'B',
            });
            const msg3 = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'C',
            });

            const messages = await getPlaylistChatMessages(sql, {
                playlistId,
                limit: 10,
                before: msg3.id,
            });

            expect(messages.length).toBe(2);
            expect(messages[0].id).toBe(msg2.id);
            expect(messages[1].id).toBe(msg1.id);
        });

        it('respects the limit parameter', async () => {
            const playlistId = await insertPlaylist(testUser, 'Limit Test');

            await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: '1',
            });
            await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: '2',
            });
            await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: '3',
            });

            const messages = await getPlaylistChatMessages(sql, {
                playlistId,
                limit: 2,
            });

            expect(messages.length).toBe(2);
        });

        it('does NOT return soft-deleted messages', async () => {
            const playlistId = await insertPlaylist(testUser, 'SoftDelete Filter');

            const msg1 = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'Keep me',
            });
            const msg2 = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'Delete me',
            });
            await softDeleteChatMessage(sql, msg2.id);

            const messages = await getPlaylistChatMessages(sql, {
                playlistId,
                limit: 10,
            });

            expect(messages.length).toBe(1);
            expect(messages[0].id).toBe(msg1.id);
        });

        it('returns empty array for playlist with no messages', async () => {
            const playlistId = await insertPlaylist(testUser, 'Empty Playlist');

            const messages = await getPlaylistChatMessages(sql, {
                playlistId,
                limit: 10,
            });

            expect(messages).toEqual([]);
        });
    });

    // ========================================================================
    // getChatMessageWithContext
    // ========================================================================

    describe('getChatMessageWithContext', () => {
        it('returns message with owner_user_id for an existing message', async () => {
            const playlistId = await insertPlaylist(testUser, 'Context Test');

            const msg = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'Context check',
            });

            const result = await getChatMessageWithContext(sql, {
                messageId: msg.id,
                playlistId,
            });

            expect(result).not.toBeNull();
            expect(result!.id).toBe(msg.id);
            expect(result!.user_id).toBe(testUser);
            expect(result!.context_id).toBe(playlistId);
            expect(result!.owner_user_id).toBe(testUser);
        });

        it('returns null for non-existent messageId', async () => {
            const playlistId = await insertPlaylist(testUser, 'Null Context');

            const result = await getChatMessageWithContext(sql, {
                messageId: 999999,
                playlistId,
            });

            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // softDeleteChatMessage
    // ========================================================================

    describe('softDeleteChatMessage', () => {
        it('sets deleted_at, after which message no longer appears in getPlaylistChatMessages', async () => {
            const playlistId = await insertPlaylist(testUser, 'SoftDelete Lifecycle');

            const msg = await insertPlaylistChatMessage(sql, {
                playlistId,
                userId: testUser,
                message: 'Goodbye',
            });
            await softDeleteChatMessage(sql, msg.id);

            const messages = await getPlaylistChatMessages(sql, {
                playlistId,
                limit: 10,
            });

            expect(messages.some((m) => m.id === msg.id)).toBe(false);
        });
    });
});
