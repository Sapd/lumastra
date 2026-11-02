// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /users/{id}/pats/{tokenId}: the revoke is scoped to the {id} owner,
 * a token of another user answers 404 (no audit entry), and success is audited.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
    revoke: vi.fn(),
    audit: vi.fn(),
    getUserById: vi.fn(),
}));
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ revoke: mocks.revoke }),
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: mocks.audit,
    auditActor: () => ({ username: 'root', kind: 'pat' }),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: mocks.getUserById,
}));

// The target is a plain user here; the admin-target ceiling is covered in
// admin/pats.admin-ceiling.test.ts.
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', () => ({
    resolveOwnerAdminStatusById: async () => ({ isAdmin: false }),
}));

const { def } = await import('./pats-id.js');
const ownerId = '110e8400-e29b-41d4-a716-446655440000';

function del(tokenId: string, id = ownerId) {
    const url = new URL(`http://localhost/api/v1/users/${id}/pats/${tokenId}`);
    return def.handlers.DELETE!(
        {
            url,
            params: { id, tokenId },
            request: new Request(url, { method: 'DELETE' }),
            locals: { principal: { username: 'root', kind: 'pat' } },
        } as unknown as RequestEvent,
        { surface: 'v1' },
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.revoke.mockResolvedValue(true);
    mocks.getUserById.mockResolvedValue({ username: 'target' });
});

describe('DELETE /users/{id}/pats/{tokenId}', () => {
    it('revokes with (tokenId, ownerUserId) and audits pat.revoke against the owner', async () => {
        const response = await del('42');
        expect(response.status).toBe(204);
        expect(mocks.revoke).toHaveBeenCalledWith(42, ownerId);
        expect(mocks.audit).toHaveBeenCalledWith(
            'pat.revoke',
            'target',
            expect.objectContaining({ username: 'root' }),
            { patId: 42 },
        );
    });

    it("answers 404 for another user's token and writes no audit entry", async () => {
        mocks.revoke.mockResolvedValue(false);
        const response = await del('42');
        expect(response.status).toBe(404);
        expect(mocks.revoke).toHaveBeenCalledWith(42, ownerId);
        expect(mocks.audit).not.toHaveBeenCalled();
    });

    it('falls back to the user id as audit target when the user lookup fails', async () => {
        mocks.getUserById.mockRejectedValue(new Error('gone'));
        expect((await del('9')).status).toBe(204);
        expect(mocks.audit).toHaveBeenCalledWith(
            'pat.revoke',
            ownerId,
            expect.anything(),
            { patId: 9 },
        );
    });

    it.each(['abc', '0', '-1', '1.5'])(
        'rejects the non-positive-integer token id %j with 422',
        async (tokenId) => {
            const response = await del(tokenId);
            expect(response.status).toBe(422);
            expect(mocks.revoke).not.toHaveBeenCalled();
        },
    );
});
