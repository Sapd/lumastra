// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/playlists/[id]/members/index.ts — GET keyset conversion.
 *
 * All DB I/O is mocked. Verifies:
 *   • offset mode stays byte-identical (page = {limit, offset, hasMore}, no
 *     total, no cursor when there is no next page);
 *   • Gate J1 bootstrap cursor on offset responses when hasMore;
 *   • cursor mode routes to the query's cursor page, ignores offset, drops
 *     total, keeps items/hasMore/limit, and emits page.nextCursor on n+1 lookahead;
 *   • the encode→decode round-trip carries (status, invited_at, user_id);
 *   • a malformed cursor and a cross-feed ('pi:') cursor both 422.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import { derivedUsername } from '../../../../../../tests/integration/fixtures/user.fixtures.js';

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
                {
                    userId,
                    displayName: null,
                    images: {
                        primary: { href: `/avatar/${userId}`, revision: '0', source: 'self' },
                    },
                },
            ]),
        ),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const mockGetUserRole = vi.fn();
const mockCanManageMembers = vi.fn();
vi.mock('$lib/server/utils/playlist-utils.js', () => ({
    getUserRole: (...a: unknown[]) => mockGetUserRole(...a),
    canManageMembers: (...a: unknown[]) => mockCanManageMembers(...a),
}));

const mockGetPlaylistMembers = vi.fn();
const mockInviteMember = vi.fn();
vi.mock('$lib/server/database/queries/playlists.queries.js', () => ({
    getPlaylistMembers: (...a: unknown[]) => mockGetPlaylistMembers(...a),
    inviteMember: (...a: unknown[]) => mockInviteMember(...a),
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: vi.fn(),
}));

vi.mock('$lib/shared/user-id.js', () => ({ toUserId: (id: string) => id }));

const { def } = await import('./[id]/members/index.js');

const ctx: ApiContext = { surface: 'internal' };

const UUID_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const UUID_B = 'bbbbbbbb-2222-2222-2222-222222222222';

function member(
    userId: string,
    status: 'accepted' | 'pending',
    invitedAt: string | null,
): Record<string, unknown> {
    return {
        user_id: userId,
        username: derivedUsername(userId),
        role: 'readonly',
        status,
        invited_at: invitedAt,
        invited_at_cursor: invitedAt ?? undefined,
    };
}

function getEvent(search = ''): RequestEvent {
    return {
        url: new URL(`http://localhost/api/playlists/42/members${search}`),
        params: { id: '42' },
        locals: { principal: { userId: UUID_A, username: 'owner' } },
    } as unknown as RequestEvent;
}

async function body(res: Response): Promise<{ items: unknown[]; page: Record<string, unknown> }> {
    return (await res.json()) as { items: unknown[]; page: Record<string, unknown> };
}

describe('defs/playlists/[id]/members (keyset)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUserRole.mockResolvedValue({ role: 'owner', userId: UUID_A });
        mockCanManageMembers.mockReturnValue(true);
        mockGetPlaylistMembers.mockResolvedValue([]);
    });

    it('no cursor → query receives offset mode (no page arg)', async () => {
        await def.handlers.GET!(getEvent('?limit=10&offset=20'), ctx);
        // Offset path calls getPlaylistMembers(sql, playlistId) with no 3rd arg.
        expect(mockGetPlaylistMembers).toHaveBeenCalledTimes(1);
        expect(mockGetPlaylistMembers.mock.calls[0][2]).toBeUndefined();
    });

    it('offset mode stays byte-identical (no total, no cursor when no next page)', async () => {
        mockGetPlaylistMembers.mockResolvedValue([
            member(UUID_A, 'accepted', '2026-07-20T00:00:00.000000Z'),
        ]);
        const res = await def.handlers.GET!(getEvent('?limit=10&offset=0'), ctx);
        const b = await body(res);
        expect(b.items).toHaveLength(1);
        expect(b.page).toEqual({ limit: 10, offset: 0, hasMore: false });
        expect(b.page).not.toHaveProperty('total');
        expect(b.page).not.toHaveProperty('cursor');
    });

    it('offset mode emits J1 bootstrap cursor when hasMore', async () => {
        mockGetPlaylistMembers.mockResolvedValue([
            member(UUID_A, 'accepted', '2026-07-20T00:00:00.000000Z'),
            member(UUID_B, 'accepted', '2026-07-19T00:00:00.000000Z'),
        ]);
        const res = await def.handlers.GET!(getEvent('?limit=1&offset=0'), ctx);
        const b = await body(res);
        expect(b.page.hasMore).toBe(true);
        expect(typeof b.page.nextCursor).toBe('string');
    });

    it('cursor param → query receives cursor mode, offset ignored, total dropped', async () => {
        // Bootstrap a real cursor from an offset response.
        mockGetPlaylistMembers.mockResolvedValueOnce([
            member(UUID_A, 'accepted', '2026-07-20T00:00:00.123456Z'),
            member(UUID_B, 'pending', '2026-07-19T00:00:00.000000Z'),
        ]);
        const boot = await body(await def.handlers.GET!(getEvent('?limit=1'), ctx));
        const cursor = boot.page.nextCursor as string;
        expect(cursor).toBeTruthy();

        mockGetPlaylistMembers.mockResolvedValueOnce([
            member(UUID_B, 'pending', '2026-07-19T00:00:00.000000Z'),
        ]);
        const res = await def.handlers.GET!(
            getEvent(`?limit=5&offset=999&cursor=${encodeURIComponent(cursor)}`),
            ctx,
        );
        const b = await body(res);
        // Decoded cursor carries the last offset row (UUID_A, accepted, micro ts).
        expect(mockGetPlaylistMembers.mock.calls[1][2]).toEqual({
            mode: 'cursor',
            cursor: {
                status: 'accepted',
                invitedAt: '2026-07-20T00:00:00.123456Z',
                userId: UUID_A,
            },
            limit: 5,
        });
        expect(b.page).not.toHaveProperty('total');
        expect(b.page).not.toHaveProperty('offset');
        expect(b.page.limit).toBe(5);
    });

    it('cursor mode: hasMore from n+1 lookahead + emits next cursor', async () => {
        mockGetPlaylistMembers.mockResolvedValueOnce([
            member(UUID_A, 'accepted', '2026-07-20T00:00:00.000000Z'),
            member(UUID_B, 'accepted', '2026-07-19T00:00:00.000000Z'),
        ]);
        const boot = await body(await def.handlers.GET!(getEvent('?limit=1'), ctx));
        const cursor = boot.page.nextCursor as string;

        // limit=1 with 2 rows returned → hasMore true, one item.
        mockGetPlaylistMembers.mockResolvedValueOnce([
            member(UUID_B, 'accepted', '2026-07-19T00:00:00.000000Z'),
            member(
                'cccccccc-3333-3333-3333-333333333333',
                'pending',
                '2026-07-18T00:00:00.000000Z',
            ),
        ]);
        const b = await body(
            await def.handlers.GET!(getEvent(`?limit=1&cursor=${encodeURIComponent(cursor)}`), ctx),
        );
        expect(b.items).toHaveLength(1);
        expect(b.page.hasMore).toBe(true);
        expect(typeof b.page.nextCursor).toBe('string');
    });

    it('D2b: a NULL-invited_at last row mints a NULL-group cursor that decodes back', async () => {
        mockGetPlaylistMembers.mockResolvedValueOnce([
            member(UUID_A, 'accepted', null),
            member(UUID_B, 'accepted', '2026-07-19T00:00:00.000000Z'),
        ]);
        const boot = await body(await def.handlers.GET!(getEvent('?limit=1'), ctx));
        const cursor = boot.page.nextCursor as string;

        mockGetPlaylistMembers.mockResolvedValueOnce([]);
        await def.handlers.GET!(getEvent(`?cursor=${encodeURIComponent(cursor)}`), ctx);
        expect(mockGetPlaylistMembers.mock.calls[1][2]).toEqual({
            mode: 'cursor',
            cursor: { status: 'accepted', invitedAt: null, userId: UUID_A },
            limit: 100,
        });
    });

    it('malformed cursor → 422', async () => {
        const res = await def.handlers.GET!(getEvent('?cursor=not-a-real-cursor'), ctx);
        expect(res.status).toBe(422);
        expect(mockGetPlaylistMembers).not.toHaveBeenCalled();
    });

    it('cross-feed cursor (items pi: tag) → 422, never decoded here', async () => {
        // A 'pi:' token is valid for the items feed but must not cross-decode.
        const foreign = 'pi:' + Buffer.from('5:9', 'utf-8').toString('base64url');
        const res = await def.handlers.GET!(
            getEvent(`?cursor=${encodeURIComponent(foreign)}`),
            ctx,
        );
        expect(res.status).toBe(422);
        expect(mockGetPlaylistMembers).not.toHaveBeenCalled();
    });
});
