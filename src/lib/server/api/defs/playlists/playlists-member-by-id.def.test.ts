// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/playlists/[id]/members/[userId].ts
 *
 * Focuses on:
 *   1. UUID validation for {userId} path param (Q8)
 *   2. PUT: owner-only role change (parity gap fix — was missing from old v1 shim)
 *   3. DELETE: owner can remove any member; member can remove themselves (self-leave)
 *   4. DELETE: neither owner nor self → 403
 *
 * All external I/O (DB) is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ──────────────────────────────────────────────────────────────

// The DELETE handler uses sql.begin() to wrap deleteMember + deleteMemberWatchedStatus.
// We mock begin() to execute the callback directly with the same mock sql object.
const mockSql = {
    begin: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockSql)),
};

vi.mock('$lib/server/utils/public-author.js', () => ({
    authorOrPlaceholder: (authors: Map<string, unknown>, userId: string) =>
        authors.get(userId) ?? {
            userId,
            displayName: null,
            images: { primary: { href: `/avatar/${userId}`, revision: '0', source: 'self' } },
        },
    loadPublicAuthors: async (ids: string[]) =>
        new Map(
            ids.map((userId) => [
                userId,
                { userId, displayName: null, images: { primary: { href: `/avatar/${userId}`, revision: '0', source: 'self' } } },
            ]),
        ),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockSql,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

const mockGetUserRole = vi.fn();
const mockCanManageMembers = vi.fn();
const mockUpdateMemberRole = vi.fn();
const mockDeleteMember = vi.fn();
const mockDeleteMemberWatchedStatus = vi.fn();

vi.mock('$lib/server/utils/playlist-utils.js', () => ({
    getUserRole: (...args: unknown[]) => mockGetUserRole(...args),
    canManageMembers: (...args: unknown[]) => mockCanManageMembers(...args),
}));

vi.mock('$lib/server/database/queries/playlists.queries.js', () => ({
    updateMemberRole: (...args: unknown[]) => mockUpdateMemberRole(...args),
    deleteMember: (...args: unknown[]) => mockDeleteMember(...args),
    deleteMemberWatchedStatus: (...args: unknown[]) => mockDeleteMemberWatchedStatus(...args),
}));

vi.mock('$lib/shared/user-id.js', () => ({
    toUserId: (id: string) => id,
}));

// ── Import def AFTER mocks ────────────────────────────────────────────────────

const MEMBER_DEF_PATH = './[id]/members/[userId].js';
const { def } = await import(MEMBER_DEF_PATH);

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const CALLER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PLAYLIST_ID = '42';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePutEvent(
    targetUserId: string,
    body: unknown,
    {
        username = 'alice',
        userId = CALLER_UUID,
        isOwner = true,
    }: { username?: string; userId?: string; isOwner?: boolean } = {},
): Partial<RequestEvent> {
    mockGetUserRole.mockResolvedValue({ role: isOwner ? 'owner' : 'editor', userId });
    mockCanManageMembers.mockReturnValue(isOwner);

    return {
        request: new Request(`http://localhost/api/v1/playlists/${PLAYLIST_ID}/members/${targetUserId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        url: new URL(`http://localhost/api/v1/playlists/${PLAYLIST_ID}/members/${targetUserId}`),
        params: { id: PLAYLIST_ID, userId: targetUserId },
        locals: {
            principal: { username, userId },
        } as RequestEvent['locals'],
    };
}

function makeDeleteEvent(
    targetUserId: string,
    {
        username = 'alice',
        userId = CALLER_UUID,
        isOwner = true,
    }: { username?: string; userId?: string; isOwner?: boolean } = {},
): Partial<RequestEvent> {
    mockGetUserRole.mockResolvedValue({ role: isOwner ? 'owner' : 'editor', userId });
    mockCanManageMembers.mockReturnValue(isOwner);

    return {
        request: new Request(`http://localhost/api/v1/playlists/${PLAYLIST_ID}/members/${targetUserId}`, {
            method: 'DELETE',
        }),
        url: new URL(`http://localhost/api/v1/playlists/${PLAYLIST_ID}/members/${targetUserId}`),
        params: { id: PLAYLIST_ID, userId: targetUserId },
        locals: {
            principal: { username, userId },
        } as RequestEvent['locals'],
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('defs/playlists/[id]/members/[userId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: delete succeeds
        mockDeleteMember.mockResolvedValue(true);
        mockDeleteMemberWatchedStatus.mockResolvedValue(undefined);
    });

    describe('def.auth shape', () => {
        it('requires feature:playlists + user auth for PUT', () => {
            const authSpec =
                (def.auth as Record<string, unknown>).PUT ?? (def.auth as Record<string, unknown>);
            // Both per-method and single-spec shapes are valid
            expect(JSON.stringify(authSpec)).toContain('user');
        });
    });

    // ── PUT tests ────────────────────────────────────────────────────────────

    describe('PUT — role change (parity gap fix)', () => {
        it('returns 422 for non-UUID userId', async () => {
            const event = makePutEvent('not-a-uuid', { role: 'editor' });
            const res = await def.handlers.PUT!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(422);
        });

        it('returns 403 when caller is not owner', async () => {
            const event = makePutEvent(VALID_UUID, { role: 'editor' }, { isOwner: false });
            const res = await def.handlers.PUT!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(403);
        });

        it('returns 404 when member not found', async () => {
            mockUpdateMemberRole.mockResolvedValue(null);
            const event = makePutEvent(VALID_UUID, { role: 'editor' });
            const res = await def.handlers.PUT!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(404);
        });

        it('returns 200 with updated member when successful', async () => {
            mockUpdateMemberRole.mockResolvedValue({
                user_id: VALID_UUID,
                username: 'bob',
                role: 'editor',
                status: 'accepted',
                invited_at: new Date('2026-01-01'),
            });
            const event = makePutEvent(VALID_UUID, { role: 'editor' });
            const res = await def.handlers.PUT!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(200);
            const body = (await (res as Response).json()) as Record<string, unknown>;
            expect(body.role).toBe('editor');
            expect((body.author as { userId: string }).userId).toBe(VALID_UUID);
        });

        it('returns 422 for invalid role in body', async () => {
            const event = makePutEvent(VALID_UUID, { role: 'superadmin' });
            const res = await def.handlers.PUT!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(422);
        });

        it('returns 401 when no authenticated user', async () => {
            const event = {
                ...makePutEvent(VALID_UUID, { role: 'editor' }),
                locals: {} as RequestEvent['locals'],
            };
            const res = await def.handlers.PUT!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(401);
        });
    });

    // ── DELETE tests ─────────────────────────────────────────────────────────

    describe('DELETE — remove member', () => {
        it('returns 422 for non-UUID userId', async () => {
            const event = makeDeleteEvent('not-a-uuid');
            const res = await def.handlers.DELETE!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(422);
        });

        it('allows owner to remove any member', async () => {
            const event = makeDeleteEvent(VALID_UUID, { isOwner: true });
            const res = await def.handlers.DELETE!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(204);
        });

        it('allows self-removal even without owner role (Q8 comparison by UUID)', async () => {
            // Caller's userId matches userId → self-removal is allowed
            const event = makeDeleteEvent(CALLER_UUID, {
                isOwner: false,
                userId: CALLER_UUID,
            });
            const res = await def.handlers.DELETE!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(204);
        });

        it('returns 403 when non-owner tries to remove another member', async () => {
            const anotherMemberUuid = '12345678-1234-1234-1234-123456789abc';
            const event = makeDeleteEvent(anotherMemberUuid, {
                isOwner: false,
                userId: CALLER_UUID, // caller !== target
            });
            const res = await def.handlers.DELETE!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(403);
        });

        it('returns 404 when member not found', async () => {
            mockDeleteMember.mockResolvedValue(false);
            const event = makeDeleteEvent(VALID_UUID, { isOwner: true });
            const res = await def.handlers.DELETE!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(404);
        });

        it('returns 401 when no authenticated user', async () => {
            const event = {
                ...makeDeleteEvent(VALID_UUID),
                locals: {} as RequestEvent['locals'],
            };
            const res = await def.handlers.DELETE!(event as RequestEvent, { surface: 'v1' });
            expect((res as Response).status).toBe(401);
        });
    });
});
