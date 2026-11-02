// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Assistant Query Module
 *
 * Tests insertUserMessage, insertAssistantMessage, and insertChatExchange.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { toUserId } from '$lib/shared/user-id';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';

import {
    insertUserMessage,
    insertAssistantMessage,
    insertChatExchange,
} from './assistant.queries.js';

describe('Assistant Queries', () => {
    let sql: postgres.Sql;
    const userId = toUserId(randomUUID());

    beforeAll(async () => {
        sql = getTestDb();
        await ensureTestUser(sql, userId);
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM assistant_messages WHERE user_id = ${userId}::uuid`;
    });

    describe('insertUserMessage', () => {
        it('inserts a user message with embedding', async () => {
            const embeddingQuery = '[' + Array(1024).fill(0.1).join(',') + ']';
            await insertUserMessage(sql, {
                userId,
                content: 'Hello AI',
                contextMediaIds: [],
                embeddingQuery,
                model: 'gpt-4',
                tokensUsed: 10,
                costUsd: 0.001,
                responseTimeMs: 500,
            });

            const rows = await sql`
                SELECT * FROM assistant_messages WHERE user_id = ${userId}::uuid
            `;
            expect(rows.length).toBe(1);
            expect(rows[0].role).toBe('user');
            expect(rows[0].content).toBe('Hello AI');
            expect(rows[0].model).toBe('gpt-4');
        });
    });

    describe('insertAssistantMessage', () => {
        it('inserts an assistant message', async () => {
            await insertAssistantMessage(sql, {
                userId,
                content: 'Hello User',
                contextMediaIds: [crypto.randomUUID()],
                model: 'gpt-4',
                tokensUsed: 20,
                costUsd: 0.002,
                responseTimeMs: 600,
            });

            const rows = await sql`
                SELECT * FROM assistant_messages WHERE user_id = ${userId}::uuid
            `;
            expect(rows.length).toBe(1);
            expect(rows[0].role).toBe('assistant');
            expect(rows[0].content).toBe('Hello User');
        });
    });

    describe('insertChatExchange', () => {
        it('inserts both user and assistant messages', async () => {
            const embeddingQuery = '[' + Array(1024).fill(0.1).join(',') + ']';
            await insertChatExchange(
                sql,
                {
                    userId,
                    content: 'Question?',
                    contextMediaIds: [],
                    embeddingQuery,
                    model: 'gpt-4',
                    tokensUsed: 5,
                    costUsd: 0.0005,
                    responseTimeMs: 300,
                },
                {
                    content: 'Answer!',
                    model: 'gpt-4',
                    tokensUsed: 15,
                    costUsd: 0.0015,
                    responseTimeMs: 400,
                },
            );

            const rows = await sql`
                SELECT * FROM assistant_messages WHERE user_id = ${userId}::uuid ORDER BY id
            `;
            expect(rows.length).toBe(2);
            expect(rows[0].role).toBe('user');
            expect(rows[1].role).toBe('assistant');
        });
    });
});
