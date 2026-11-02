// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

const h = vi.hoisted(() => ({ watched: vi.fn(), unwatched: vi.fn(), read: vi.fn() }));
vi.mock('./middleware', () => ({ withJellyfinAuth: (handler: RequestHandler) => handler }));
vi.mock('./unknown-route-log', () => ({ recordUnknownRoute: vi.fn() }));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/watch-manager.service', () => ({
    watchManager: {
        markWatched: h.watched,
        markUnwatched: h.unwatched,
    },
}));
vi.mock('$lib/server/middleware/media-access', () => ({ checkMediaAccess: async () => true }));
vi.mock('./user-item-data', () => ({
    syntheticUserItemData: () => ({}),
    userItemDataAfterWrite: async (_sql: unknown, _id: string, _user: unknown, set: object) => set,
    readUserItemData: h.read,
}));

// Resolve through the catch-all until the legacy route is mounted, reproducing
// the actual 404 before the fix rather than a missing-import collection error.
const routes = import.meta.glob<{
    GET?: RequestHandler;
    POST?: RequestHandler;
    DELETE?: RequestHandler;
}>('/src/routes/**/+server.ts');
import { fallback } from '../../../../routes/(proprietary)/j/[...path]/+server';
const itemId = '77654321-1234-4123-8123-123456789012';
const userId = '12345678-1234-4123-8123-123456789012';
function event(path: string, method: string): RequestEvent {
    const url = new URL(`https://app.example/j/${path}?DatePlayed=2026-10-29T21%3A11%3A11.834Z`);
    return {
        url,
        request: new Request(url, { method }),
        params: { userId, itemId },
        locals: { user: { userId, username: 'viewer' } },
    } as unknown as RequestEvent;
}
async function call(route: string, method: 'GET' | 'POST' | 'DELETE'): Promise<Response> {
    const module = routes[`/src/routes/(proprietary)/j/${route}/+server.ts`];
    const handler = module ? ((await module())[method] ?? fallback) : fallback;
    return handler(event(route, method) as never);
}
beforeEach(() => {
    vi.clearAllMocks();
    h.read.mockResolvedValue({ Played: false });
});
for (const method of ['POST', 'DELETE'] as const) {
    it(`${method} legacy PlayedItems is the current watched action, including DatePlayed`, async () => {
        const response = await call('Users/[userId]/PlayedItems/[itemId]', method);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ Played: method === 'POST' });
        expect(method === 'POST' ? h.watched : h.unwatched).toHaveBeenCalledWith({
            userId,
            mediaId: itemId,
        });
    });
}
it('GET legacy item UserData reads the same data as UserItems', async () => {
    const response = await call('Users/[userId]/Items/[itemId]/UserData', 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ Played: false });
    expect(h.read).toHaveBeenCalled();
});
it('SyncPlay/List answers an empty group list', async () => {
    const response = await call('SyncPlay/List', 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
});
