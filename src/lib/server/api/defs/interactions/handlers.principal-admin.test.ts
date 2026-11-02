// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /{resource}/{id}/comments/{commentId}: the comment author or an ADMIN
 * PRINCIPAL may delete. An admin owner's device token / read-write PAT has
 * `locals.user.isAdmin === true` but a non-admin principal, so it must not
 * delete other users' comments (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import {
    TEST_USER_ID,
    adminOwnersDeviceToken,
    adminOwnersReadWritePat,
    adminSession,
    adminScopedPat,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}),
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn(async () => '11111111-1111-4111-8111-111111111111'),
}));

const mockGetCommentOwner = vi.fn();
const mockSoftDeleteComment = vi.fn();
vi.mock('$lib/server/database/queries/interactions.queries.js', () => ({
    listComments: vi.fn(),
    insertComment: vi.fn(),
    getCommentOwner: (...a: unknown[]) => mockGetCommentOwner(...a),
    softDeleteComment: (...a: unknown[]) => mockSoftDeleteComment(...a),
    listReactions: vi.fn(),
    upsertReaction: vi.fn(),
    deleteReaction: vi.fn(),
}));

// The person variant has no resource-level access gate, so only the
// author/admin check is exercised.
const { def } = await import('$lib/server/api/defs/people/[id]/comments/[commentId].js');
const ctx: ApiContext = { surface: 'v1' };

const OTHER_AUTHOR = '99999999-9999-4999-8999-999999999999';

async function remove(locals: RequestEvent['locals']): Promise<Response> {
    const url = 'http://localhost/api/v1/people/42/comments/c1';
    const event = {
        url: new URL(url),
        params: { id: '42', commentId: 'c1' },
        locals,
        request: new Request(url, { method: 'DELETE' }),
    } as unknown as RequestEvent;
    return (await def.handlers.DELETE!(event, ctx)) as Response;
}

describe('DELETE comment: admin principal required to delete others’ comments', () => {
    beforeEach(() => {
        mockGetCommentOwner.mockReset();
        mockSoftDeleteComment.mockReset();
        mockGetCommentOwner.mockResolvedValue({ user_id: OTHER_AUTHOR });
    });

    it('an admin owner’s device token cannot delete a non-author comment (403)', async () => {
        const res = await remove(adminOwnersDeviceToken());
        expect(res.status).toBe(403);
        expect(mockSoftDeleteComment).not.toHaveBeenCalled();
    });

    it('an admin owner’s read/write PAT cannot delete a non-author comment (403)', async () => {
        const res = await remove(adminOwnersReadWritePat());
        expect(res.status).toBe(403);
        expect(mockSoftDeleteComment).not.toHaveBeenCalled();
    });

    it('locals.user.isAdmin without a principal cannot delete a non-author comment (403)', async () => {
        const res = await remove(adminUserWithoutPrincipal());
        expect(res.status).toBe(403);
        expect(mockSoftDeleteComment).not.toHaveBeenCalled();
    });

    it('control: an admin session may delete a non-author comment', async () => {
        const res = await remove(adminSession());
        expect(res.status).toBe(204);
        expect(mockSoftDeleteComment).toHaveBeenCalledTimes(1);
    });

    it('control: an admin-scoped PAT may delete a non-author comment', async () => {
        const res = await remove(adminScopedPat());
        expect(res.status).toBe(204);
        expect(mockSoftDeleteComment).toHaveBeenCalledTimes(1);
    });

    it('an admin owner’s device token can still delete its OWN comment', async () => {
        mockGetCommentOwner.mockResolvedValue({ user_id: TEST_USER_ID });
        const res = await remove(adminOwnersDeviceToken());
        expect(res.status).toBe(204);
        expect(mockSoftDeleteComment).toHaveBeenCalledTimes(1);
    });
});
