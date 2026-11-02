// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({
    db: vi.fn(),
    hydrate: vi.fn(),
    access: vi.fn(),
    boundary: vi.fn(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: mocks.db }));
vi.mock('$lib/server/services/media-preview-batch.service.js', () => ({
    hydrateMediaPreviews: mocks.hydrate,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: mocks.access,
    searchAccessBoundary: mocks.boundary,
}));
import { def, MediaBatchBodySchema } from './media-batch.js';
import { mount } from '$lib/server/api/mount.js';

function event(body: unknown, authenticated = true): RequestEvent {
    const url = new URL('http://localhost/api/v1/media/batch');
    return {
        url,
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        params: {},
        route: { id: '/api/v1/media/batch' },
        locals: { user: authenticated ? { username: 'reader' } : undefined },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        cookies: {},
        fetch,
    } as unknown as RequestEvent;
}
beforeEach(() => vi.clearAllMocks());

describe('POST /media/batch', () => {
    const { POST } = mount(def, { surface: 'v1' });
    it.each([[], Array(101).fill('tmdb:550'), [''], ['   ']])(
        'returns 422 for invalid IDs (%j)',
        async (ids) => {
            expect((await POST!(event({ ids }))).status).toBe(422);
            expect(mocks.hydrate).not.toHaveBeenCalled();
        },
    );
    it('accepts 100 handles and rejects invalid include values', () => {
        expect(MediaBatchBodySchema.safeParse({ ids: Array(100).fill('tmdb:550') }).success).toBe(
            true,
        );
        expect(
            MediaBatchBodySchema.safeParse({ ids: ['tmdb:550'], include: 'streams' }).success,
        ).toBe(false);
    });
    it('requires authentication', async () => {
        expect((await POST!(event({ ids: ['tmdb:550'] }, false))).status).toBe(401);
    });
    it('passes the listing access boundary, user and include to hydration', async () => {
        const sql = {};
        const access = { library: { kind: 'all' }, age: { kind: 'any' } };
        mocks.db.mockReturnValue(sql);
        mocks.access.mockResolvedValue({ deniedGroupIds: null });
        mocks.boundary.mockReturnValue(access);
        mocks.hydrate.mockResolvedValue({ items: [], missing: ['tmdb:550'] });
        const ev = event({ ids: ['tmdb:550'], include: 'detail' });
        const response = await POST!(ev);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ items: [], missing: ['tmdb:550'] });
        expect(mocks.access).toHaveBeenCalledWith(sql, ev.locals.user);
        expect(mocks.hydrate).toHaveBeenCalledWith(
            { sql, user: ev.locals.user, access, surface: 'v1' },
            ['tmdb:550'],
            { ids: ['tmdb:550'], include: 'detail' },
        );
    });
    it('rejects include=detail with 26 ids as 422 without hydrating', async () => {
        mocks.db.mockReturnValue({});
        mocks.access.mockResolvedValue({});
        mocks.boundary.mockReturnValue({});
        const ids = Array.from({ length: 26 }, (_, i) => `tmdb:${i + 1}`);
        expect((await POST!(event({ ids, include: 'detail' }))).status).toBe(422);
        expect(mocks.hydrate).not.toHaveBeenCalled();
    });
    it('accepts include=detail with 25 ids', async () => {
        mocks.db.mockReturnValue({});
        mocks.access.mockResolvedValue({});
        mocks.boundary.mockReturnValue({});
        mocks.hydrate.mockResolvedValue({ items: [], missing: [] });
        const ids = Array.from({ length: 25 }, (_, i) => `tmdb:${i + 1}`);
        expect((await POST!(event({ ids, include: 'detail' }))).status).toBe(200);
        expect(mocks.hydrate).toHaveBeenCalledTimes(1);
    });
});
