// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AI Assistant Query Module
 *
 * Centralized queries for AI assistant operations including:
 * - Assistant message storage
 * - Rate limit tracking
 *
 * @module queries/assistant
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// AI Assistant Message Queries
// =============================================================================

export interface InsertUserMessageParams {
    userId: UserId;
    content: string;
    contextMediaIds: string[];
    /** Serialised vector string `[x,y,…]`; null when the embedding service was unavailable. */
    embeddingQuery: string | null;
    model: string;
    tokensUsed: number;
    costUsd: number;
    responseTimeMs: number;
}

/**
 * Insert a user message to AI assistant with embedding query.
 * `embeddingQuery` may be null when the embedding service is unavailable
 * (graceful-degradation path); the column is nullable in the schema.
 */
export async function insertUserMessage(
    sql: postgres.Sql,
    params: InsertUserMessageParams,
): Promise<void> {
    if (params.embeddingQuery !== null) {
        await sql`
            INSERT INTO assistant_messages (
                user_id, role, content, context_media_ids, embedding_query,
                model, tokens_used, cost_usd, response_time_ms
            ) VALUES (
                ${params.userId}, 'user', ${params.content}, ${params.contextMediaIds},
                ${params.embeddingQuery}::vector, ${params.model},
                ${params.tokensUsed}, ${params.costUsd}, ${params.responseTimeMs}
            )
        `;
    } else {
        await sql`
            INSERT INTO assistant_messages (
                user_id, role, content, context_media_ids,
                model, tokens_used, cost_usd, response_time_ms
            ) VALUES (
                ${params.userId}, 'user', ${params.content}, ${params.contextMediaIds},
                ${params.model}, ${params.tokensUsed}, ${params.costUsd}, ${params.responseTimeMs}
            )
        `;
    }
}

// =============================================================================
// AI Assistant Conversation History (read)
// =============================================================================

/** A single persisted chat turn, as returned to the client for hydration. */
export interface AssistantConversationMessage {
    role: 'user' | 'assistant';
    content: string;
    /** ISO-8601 timestamp string. */
    createdAt: string;
}

export interface GetRecentAssistantConversationOptions {
    /** Max number of messages to return (most recent N). */
    limit: number;
    /** Only include messages strictly newer than this timestamp (`created_at > after`). */
    after?: Date;
}

/**
 * Fetch the most recent N text messages ('user'/'assistant' only — 'system'
 * rows, if any, are never surfaced to the client) for a user, returned in
 * chronological order (oldest of the recent window first) so the caller can
 * render them directly into a transcript.
 *
 * `opts.after` supports the client's "New chat" cutoff: when set, only
 * messages persisted after that timestamp are considered — this makes the
 * cutoff durable across a page reload instead of living only in memory.
 *
 * Recommendation cards attached to assistant replies are NOT persisted
 * alongside `content` — this returns text-only history.
 */
export async function getRecentAssistantConversation(
    sql: postgres.Sql,
    userId: UserId,
    opts: GetRecentAssistantConversationOptions,
): Promise<AssistantConversationMessage[]> {
    const { limit, after } = opts;
    const afterFilter = after ? sql`AND am.created_at > ${after}` : sql``;

    const rows = await sql<
        Array<{ role: 'user' | 'assistant'; content: string; created_at: Date }>
    >`
        SELECT role, content, created_at
        FROM (
            SELECT am.role, am.content, am.created_at
            FROM assistant_messages am
            WHERE am.user_id = ${userId}
              AND am.role IN ('user', 'assistant')
              ${afterFilter}
            ORDER BY am.created_at DESC
            LIMIT ${limit}
        ) recent
        ORDER BY created_at ASC
    `;

    return rows.map((row) => ({
        role: row.role,
        content: row.content,
        createdAt: row.created_at.toISOString(),
    }));
}

export interface InsertAssistantMessageParams {
    userId: UserId;
    content: string;
    contextMediaIds: string[];
    model: string;
    tokensUsed: number;
    costUsd: number;
    responseTimeMs: number;
}

/**
 * Insert an AI assistant response message.
 */
export async function insertAssistantMessage(
    sql: postgres.Sql,
    params: InsertAssistantMessageParams,
): Promise<void> {
    await sql`
        INSERT INTO assistant_messages (
            user_id, role, content, context_media_ids,
            model, tokens_used, cost_usd, response_time_ms
        ) VALUES (
            ${params.userId}, 'assistant', ${params.content}, ${params.contextMediaIds},
            ${params.model}, ${params.tokensUsed}, ${params.costUsd}, ${params.responseTimeMs}
        )
    `;
}

/**
 * Insert both user and assistant messages in sequence.
 * Convenience function for the common pattern of saving an assistant exchange.
 */
export async function insertChatExchange(
    sql: postgres.Sql,
    userMessage: InsertUserMessageParams,
    assistantMessage: Omit<InsertAssistantMessageParams, 'userId' | 'contextMediaIds'>,
): Promise<void> {
    await insertUserMessage(sql, userMessage);
    await insertAssistantMessage(sql, {
        userId: userMessage.userId,
        contextMediaIds: userMessage.contextMediaIds,
        ...assistantMessage,
    });
}
