// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { AudiobookPageSchema } from '$lib/schemas/api-audiobook-preview.js';
const mocks = vi.hoisted(() => ({ db: vi.fn(), list: vi.fn(), access: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: mocks.db }));
vi.mock('$lib/server/database/queries/audiobook-catalog.queries.js', () => ({
    listCatalogBooks: mocks.list,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: mocks.access,
    searchAccessBoundary: (x: unknown) => x,
}));
const { def } = await import('./index.js');
beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.mockReturnValue({});
    mocks.access.mockResolvedValue({ library: { kind: 'all' }, age: { kind: 'all' } });
    mocks.list.mockResolvedValue({
        items: [],
        page: { limit: 60, offset: 0, hasMore: false, total: 0 },
    });
});
async function call(query: Record<string, string> = {}, surface: 'internal' | 'v1' = 'v1') {
    const event = { locals: { user: { userId: 'viewer' } } } as unknown as RequestEvent;
    return def.handlers.GET!(event, {
        surface,
        input: { query: def.request!.query!.parse(query) },
    } as never);
}
describe('GET /audiobooks', () => {
    it.each(['internal', 'v1'] as const)(
        'returns the canonical envelope on %s',
        async (surface) => {
            const response = await call({}, surface);
            const body = await response.json();
            expect(AudiobookPageSchema.parse(body)).toEqual(body);
            expect(mocks.list).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    surface,
                    viewerId: 'viewer',
                    sort: 'title',
                    order: 'asc',
                    limit: 60,
                    offset: 0,
                }),
            );
            expect(body).not.toHaveProperty('nextOffset');
        },
    );
    it('accepts stable resource ids, paging and explicit collapse', async () => {
        const id = '11111111-1111-4111-8111-111111111111';
        await call({
            authorId: id,
            narratorId: id,
            seriesId: id,
            libraryGroupId: id,
            lang: 'de',
            q: 'Milo',
            letter: 'M',
            collapse: 'series',
            sort: 'year',
            order: 'desc',
            offset: '60',
            limit: '20',
        });
        expect(mocks.list).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                authorId: id,
                narratorId: id,
                seriesId: id,
                groupId: id,
                offset: 60,
                limit: 20,
                collapse: 'series',
            }),
        );
    });
    it('rejects invalid ids, sort, collapse and pagination', () => {
        for (const input of [
            { authorId: 'name' },
            { sort: 'title_asc' },
            { collapse: 'true' },
            { limit: '0' },
            { offset: '-1' },
        ])
            expect(def.request!.query!.safeParse(input).success).toBe(false);
    });
    it('returns 503 without a database', async () => {
        mocks.db.mockReturnValue(null);
        expect((await call()).status).toBe(503);
        expect(mocks.list).not.toHaveBeenCalled();
    });
});
