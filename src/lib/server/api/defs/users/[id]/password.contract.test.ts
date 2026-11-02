// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
const mocks = vi.hoisted(() => ({ reset: vi.fn() }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: async () => ({ username: 'target' }),
}));
vi.mock('$lib/server/api/token-minting.js', () => ({
    requireAdminCeilingForTarget: async () => null,
}));
vi.mock('$lib/server/services/admin-user.service.js', () => ({ resetPassword: mocks.reset }));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    auditActor: () => 'operator',
}));
import { def } from './password.js';
import { PasswordBody, def as adminDef } from '../../admin/users/[username]/password.js';
const { POST } = mount(def, { surface: 'v1' });
function event(body: unknown): RequestEvent {
    const url = new URL(
        'http://localhost/api/v1/users/22222222-2222-4222-8222-222222222222/password',
    );
    return {
        url,
        params: { id: '22222222-2222-4222-8222-222222222222' },
        request: new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        locals: {
            principal: buildPrincipal({
                kind: 'pat',
                userId: toUserId('11111111-1111-4111-8111-111111111111'),
                username: 'operator',
                userGroups: [],
                tokenScopes: ['users:admin'],
                ownerIsAdmin: true,
            }),
        },
    } as unknown as RequestEvent;
}
beforeEach(() => {
    mocks.reset.mockReset().mockResolvedValue({ ok: true });
});
describe('password body documentation and delegation', () => {
    it('shares the admin validation schema without consuming the delegated body', async () => {
        expect(def.docs!.POST!.body).toBe(PasswordBody);
        expect(adminDef.request!.body).toBe(PasswordBody);
        expect(def.request?.body).toBeUndefined();
        const response = await POST!(event({ newPassword: 'test-password' }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ username: 'target', passwordChanged: true });
        expect(mocks.reset).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
            targetUsername: 'target',
            newPassword: 'test-password',
        });
    });
    it.each([{}, { newPassword: '' }])(
        'rejects a missing or empty password in the delegated mount: %j',
        async (body) => {
            expect(PasswordBody.safeParse(body).success).toBe(false);
            expect((await POST!(event(body))).status).toBe(422);
            expect(mocks.reset).not.toHaveBeenCalled();
        },
    );
});
