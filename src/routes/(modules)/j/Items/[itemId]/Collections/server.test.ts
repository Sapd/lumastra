// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /j/Items/{itemId}/Collections (Jellyfin 12.x). Lumastra has no BoxSets: always empty.

import type { RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCheckMediaAccess, mockSql } = vi.hoisted(() => ({
    mockCheckMediaAccess: vi.fn(),
    mockSql: vi.fn(),
}));

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => mockSql }));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
}));

const { GET } = await import('./+server');

const ITEM_ID = '46b44b87-d6d8-406d-8678-117c96d0af2b';

function call(itemId: string, query = ''): Promise<Response> {
    const url = new URL(`http://localhost/j/Items/${itemId}/Collections${query}`);
    return GET!({
        params: { itemId },
        url,
        request: new Request(url),
        locals: { user: { userId: 'u1', username: 'alice', ownerIsAdmin: false } },
    } as never) as Promise<Response>;
}

describe('GET /j/Items/{itemId}/Collections', () => {
    beforeEach(() => {
        mockCheckMediaAccess.mockReset().mockResolvedValue(true);
        mockSql.mockReset().mockResolvedValue([{ one: 1 }]);
    });

    it('answers an empty BaseItemDtoQueryResult for an accessible item', async () => {
        const res = await call(ITEM_ID);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    });

    it('echoes StartIndex', async () => {
        const res = await call(ITEM_ID, '?StartIndex=3');
        expect((await res.json()).StartIndex).toBe(3);
    });

    it('404s when the caller may not access the item', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        expect((await call(ITEM_ID)).status).toBe(404);
    });

    it('404s for an unknown item and for a non-uuid id', async () => {
        mockSql.mockResolvedValue([]);
        expect((await call(ITEM_ID)).status).toBe(404);
        expect((await call('not-a-uuid')).status).toBe(404);
    });
});
