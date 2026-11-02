// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PUT/DELETE /users/{id}/images/avatar — changing another user's avatar needs
 * an admin PRINCIPAL (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminOwnersDeviceToken,
    adminSession,
    adminUserWithoutPrincipal,
    TEST_USER_ID,
} from '$lib/server/api/principal-locals.test-helpers.js';

const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const deleteUserAvatar = vi.fn(async () => true);
const setUserAvatar = vi.fn(async () => true);

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: vi.fn(async () => ({ username: 'bob' })),
    setUserAvatar,
    deleteUserAvatar,
}));
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({ invalidateAvatarCache: vi.fn(async () => undefined) }),
    imageResponse: vi.fn(),
}));

const { def } = await import('./[role]');

async function call(
    method: 'PUT' | 'DELETE',
    locals: RequestEvent['locals'],
    targetId: string,
): Promise<Response> {
    const url = `http://localhost/api/v1/users/${targetId}/images/avatar`;
    const event = {
        request: new Request(url, { method }),
        params: { id: targetId, role: 'avatar' },
        url: new URL(url),
        locals,
    } as unknown as RequestEvent;
    return def.handlers[method]!(event, { surface: 'v1' } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('DELETE another user’s avatar', () => {
    it('an admin owner’s device token gets 403', async () => {
        expect((await call('DELETE', adminOwnersDeviceToken(), OTHER_USER_ID)).status).toBe(403);
        expect(deleteUserAvatar).not.toHaveBeenCalled();
    });

    it('a principal-less request with locals.user.isAdmin: no admin power', async () => {
        const res = await call('DELETE', adminUserWithoutPrincipal(), OTHER_USER_ID);
        expect(res.status).toBe(403);
        expect(deleteUserAvatar).not.toHaveBeenCalled();
    });

    it('control: an admin session gets 204', async () => {
        expect((await call('DELETE', adminSession(), OTHER_USER_ID)).status).toBe(204);
        expect(deleteUserAvatar).toHaveBeenCalledOnce();
    });

    it('a device token can still delete its own avatar', async () => {
        expect((await call('DELETE', adminOwnersDeviceToken(), TEST_USER_ID)).status).toBe(204);
    });
});

describe('PUT another user’s avatar', () => {
    it('an admin owner’s device token gets 403 before the body is read', async () => {
        expect((await call('PUT', adminOwnersDeviceToken(), OTHER_USER_ID)).status).toBe(403);
        expect(setUserAvatar).not.toHaveBeenCalled();
    });

    it('a principal-less request with locals.user.isAdmin gets 403', async () => {
        expect((await call('PUT', adminUserWithoutPrincipal(), OTHER_USER_ID)).status).toBe(403);
    });

    it('control: an admin session passes the admin gate (fails later on the empty body, not 403)', async () => {
        const res = await call('PUT', adminSession(), OTHER_USER_ID);
        expect(res.status).not.toBe(403);
        expect(res.status).not.toBe(401);
    });
});
