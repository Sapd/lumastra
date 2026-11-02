// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** GET /api/v1/users/{id}/images (needs a principal, see [role].auth.test.ts): UUID only, no username lookup, 404 for unknown users. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const getDb = vi.fn(() => ({}) as unknown);
const userImageSets = vi.fn();

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => getDb() }));
vi.mock('$lib/server/services/image-descriptor/avatars.js', () => ({
    userImageSets: (...args: unknown[]) => userImageSets(...args),
}));

const { def } = await import('./index');

async function get(id: string): Promise<Response> {
    const handler = def.handlers.GET;
    if (!handler) throw new Error('no GET handler');
    return handler({ params: { id } } as unknown as RequestEvent, { surface: 'v1' } as never);
}

describe('users images listing', () => {
    beforeEach(() => {
        getDb.mockReset().mockReturnValue({});
        userImageSets.mockReset();
    });

    it('rejects a username: the route must not resolve names to UUIDs', async () => {
        const res = await get('alice');
        expect(res.status).toBe(422);
        expect(userImageSets).not.toHaveBeenCalled();
    });

    it('returns the primary descriptor for an existing user', async () => {
        const images = { primary: { href: '/api/v1/users/x/images/avatar?v=123456', revision: '123456', source: 'self' } };
        userImageSets.mockResolvedValue(new Map([[USER_ID, images]]));
        const res = await get(USER_ID);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: USER_ID, images });
    });

    it('404s for a user that does not exist', async () => {
        userImageSets.mockResolvedValue(new Map());
        const res = await get(USER_ID);
        expect(res.status).toBe(404);
    });

    it('503s without a database', async () => {
        getDb.mockReturnValue(null);
        const res = await get(USER_ID);
        expect(res.status).toBe(503);
    });
});
