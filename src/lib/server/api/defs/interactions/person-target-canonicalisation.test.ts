// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * People comments/reactions share one canonical interaction target per person
 * (`tmdb:<n>`), whatever alias the caller used in the path. Invalid handles are
 * rejected with 422 before any query runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockSql = {};
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => mockSql }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn().mockResolvedValue('user-uuid-123'),
    getUserDisplayInfoByIds: async (_sql: unknown, ids: string[]) =>
        ids.map((id) => ({ id, display_name: 'Alice' })),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, resetAt: 0 }),
}));

const mockListComments = vi.fn().mockResolvedValue([]);
const mockInsertComment = vi.fn();
const mockListReactions = vi.fn().mockResolvedValue([]);
const mockUpsertReaction = vi.fn().mockResolvedValue(undefined);
const mockDeleteReaction = vi.fn().mockResolvedValue(undefined);

vi.mock('$lib/server/database/queries/interactions.queries.js', () => ({
    listComments: (...a: unknown[]) => mockListComments(...a),
    insertComment: (...a: unknown[]) => mockInsertComment(...a),
    getCommentOwner: vi.fn(),
    softDeleteComment: vi.fn(),
    listReactions: (...a: unknown[]) => mockListReactions(...a),
    upsertReaction: (...a: unknown[]) => mockUpsertReaction(...a),
    deleteReaction: (...a: unknown[]) => mockDeleteReaction(...a),
}));

const { def: commentsDef } = await import('$lib/server/api/defs/people/[id]/comments/index.js');
const { def: reactionsDef } = await import('$lib/server/api/defs/people/[id]/reactions/index.js');

const ctx: ApiContext = { surface: 'v1' };

function makeEvent(
    method: string,
    resource: 'comments' | 'reactions',
    id: string,
    body?: unknown,
): RequestEvent {
    const url = `http://localhost/api/v1/people/${id}/${resource}`;
    return {
        request: new Request(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        }),
        url: new URL(url),
        params: { id },
        locals: {
            principal: { username: 'alice', isAdmin: false },
            user: { username: 'alice', isAdmin: false },
        },
    } as unknown as RequestEvent;
}

function expectNoQuery(): void {
    expect(mockListComments).not.toHaveBeenCalled();
    expect(mockInsertComment).not.toHaveBeenCalled();
    expect(mockListReactions).not.toHaveBeenCalled();
    expect(mockUpsertReaction).not.toHaveBeenCalled();
    expect(mockDeleteReaction).not.toHaveBeenCalled();
}

const ALIASES = ['0123', '123', 'tmdb:00123'];
const INVALID = ['abc', '0', 'other:5'];

describe('person comments/reactions canonical target', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockListComments.mockResolvedValue([]);
        mockListReactions.mockResolvedValue([]);
        mockInsertComment.mockResolvedValue({
            id: '1',
            user_id: 'user-uuid-123',
            username: 'alice',
            body: 'hi',
            created_at: new Date('2026-01-01'),
            updated_at: new Date('2026-01-01'),
        });
    });

    it.each(ALIASES)('GET comments with id %s queries tmdb:123', async (id) => {
        const res = await commentsDef.handlers.GET!(makeEvent('GET', 'comments', id), ctx);
        expect((res as Response).status).toBe(200);
        expect(mockListComments).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ targetType: 'person', targetId: 'tmdb:123' }),
        );
    });

    it.each(ALIASES)('POST comments with id %s inserts on tmdb:123', async (id) => {
        const res = await commentsDef.handlers.POST!(
            makeEvent('POST', 'comments', id, { body: 'hi' }),
            ctx,
        );
        expect((res as Response).status).toBe(201);
        expect(mockInsertComment).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ targetType: 'person', targetId: 'tmdb:123' }),
        );
    });

    it.each(ALIASES)('GET reactions with id %s queries tmdb:123', async (id) => {
        const res = await reactionsDef.handlers.GET!(makeEvent('GET', 'reactions', id), ctx);
        expect((res as Response).status).toBe(200);
        expect(mockListReactions).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ targetType: 'person', targetId: 'tmdb:123' }),
        );
    });

    it.each(ALIASES)('PUT reactions with id %s upserts on tmdb:123', async (id) => {
        const res = await reactionsDef.handlers.PUT!(
            makeEvent('PUT', 'reactions', id, { emoji: '👍' }),
            ctx,
        );
        expect((res as Response).status).toBe(204);
        expect(mockUpsertReaction).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ targetType: 'person', targetId: 'tmdb:123' }),
        );
    });

    it.each(INVALID)('id %s is rejected with 422 and no query runs', async (id) => {
        const responses = await Promise.all([
            commentsDef.handlers.GET!(makeEvent('GET', 'comments', id), ctx),
            commentsDef.handlers.POST!(makeEvent('POST', 'comments', id, { body: 'hi' }), ctx),
            reactionsDef.handlers.GET!(makeEvent('GET', 'reactions', id), ctx),
            reactionsDef.handlers.PUT!(makeEvent('PUT', 'reactions', id, { emoji: '👍' }), ctx),
        ]);
        for (const res of responses) expect((res as Response).status).toBe(422);
        expectNoQuery();
    });
});
