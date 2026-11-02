// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const { find } = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/database/queries/keyword-media.queries.js', () => ({
    findKeywordMedia: find,
    findKeywordMediaPersonalized: find,
    userHasCatalogProfile: async () => false,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: async () => ({}),
    searchAccessBoundary: () => ({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));
vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));
import { GET } from './+server';

function event(query: string): RequestEvent {
    const url = new URL(`https://example.test/api/keyword-movies?keyword=space&${query}`);
    return {
        url,
        request: new Request(url),
        params: {},
        locals: {
            user: { userId: 'u1', username: 'alice' },
            principal: {
                kind: 'session',
                userId: 'u1',
                username: 'alice',
                userGroups: [],
                scopes: ['read'],
                isAdmin: false,
            },
        },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}
function row(id: number, media_type = 'movie') {
    return { internal_id: `item-${id}`, primary_ext_id: id, media_type, title: `Film ${id}` };
}
beforeEach(() => {
    vi.clearAllMocks();
});

describe('keyword collection pages', () => {
    it('fetches a lookahead and returns items/page without the retired flat fields', async () => {
        find.mockResolvedValue([row(1), row(2), row(3)]);
        const response = await GET!(event('limit=2&offset=4'));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.items.map((item: { title: string }) => item.title)).toEqual([
            'Film 1',
            'Film 2',
        ]);
        expect(body.page).toEqual({ limit: 2, offset: 4, hasMore: true });
        expect(body).not.toHaveProperty('movies');
        expect(body).not.toHaveProperty('hasMore');
        expect(find).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ limit: 3, offset: 4 }),
        );
    });
    it('does not claim another page for exactly limit rows', async () => {
        find.mockResolvedValue([row(1), row(2)]);
        expect((await (await GET!(event('limit=2'))).json()).page.hasMore).toBe(false);
    });
    it('keeps the candidate offset when unsupported media types are omitted', async () => {
        find.mockResolvedValue([row(1, 'track'), row(2)]);
        const body = await (await GET!(event('limit=1&offset=3'))).json();
        expect(body.items).toEqual([]);
        expect(body.page).toEqual({ limit: 1, offset: 3, hasMore: true });
    });
});
