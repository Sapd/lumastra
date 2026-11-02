// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
// Default implementations live on the mocks themselves: a mockReset/restoreMocks
// between tests (CI's config) restores them instead of leaving undefined behind.
const mocks = vi.hoisted(() => {
    const page = { items: [], page: { limit: 60, offset: 0, hasMore: false } };
    const row = {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Writer',
        bookCount: 1,
        durationMs: 1000,
    };
    return {
        db: vi.fn((): object | null => ({})),
        list: vi.fn(async (..._args: unknown[]) => page),
        get: vi.fn(async (..._args: unknown[]): Promise<object | null> => row),
        books: vi.fn(async (..._args: unknown[]) => page),
        access: vi.fn(async (..._args: unknown[]) => ({})),
    };
});
vi.mock('$lib/server/database/connection.js', () => ({ getDb: mocks.db }));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: mocks.access,
    searchAccessBoundary: () => ({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));
vi.mock('$lib/server/database/queries/audiobook-catalog.queries.js', () => ({
    listCatalogResources: mocks.list,
    getCatalogResource: mocks.get,
    listCatalogBooks: mocks.books,
}));
import { def as authorsList } from './authors.js';
import { def as authorsDetail } from './authors-id.js';
import { def as authorsBooks } from './authors-books.js';
import { def as narratorsList } from './narrators.js';
import { def as narratorsDetail } from './narrators-id.js';
import { def as narratorsBooks } from './narrators-books.js';
import { def as seriesList } from './series.js';
import { def as seriesDetail } from './series-id.js';
import { def as seriesBooks } from './series-books.js';
// Static imports (vi.mock above is hoisted over them): concurrent dynamic imports raced
// the mock registration, so a def could bind the real getDb and answer 503 in CI.
const cases = [
    {
        name: 'authors',
        resource: 'author',
        list: authorsList,
        detail: authorsDetail,
        books: authorsBooks,
    },
    {
        name: 'narrators',
        resource: 'narrator',
        list: narratorsList,
        detail: narratorsDetail,
        books: narratorsBooks,
    },
    {
        name: 'series',
        resource: 'series',
        list: seriesList,
        detail: seriesDetail,
        books: seriesBooks,
    },
];
const id = '11111111-1111-4111-8111-111111111111';
type Case = (typeof cases)[number];
type Def = Case['list'] | Case['detail'] | Case['books'];
/** Arms the dependencies right before the call, so no earlier reset can leave them empty. */
async function invoke(def: Def, input: Record<string, unknown>): Promise<Response> {
    mocks.db.mockReturnValue({});
    mocks.access.mockResolvedValue({});
    const response = (await def.handlers.GET!(
        {
            locals: { user: { userId: '11111111-1111-4111-8111-111111111111' } },
        } as unknown as RequestEvent,
        { surface: 'v1', input } as never,
    )) as Response;
    return response;
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({});
    mocks.db.mockReturnValue({});
    mocks.list.mockResolvedValue({ items: [], page: { limit: 60, offset: 0, hasMore: false } });
    mocks.get.mockResolvedValue({ id, name: 'Writer', bookCount: 1, durationMs: 1000 });
    mocks.books.mockResolvedValue({ items: [], page: { limit: 60, offset: 0, hasMore: false } });
});
describe.each(cases)('$name resources', ({ resource, list, detail, books }) => {
    it('documents and mounts the paginated collection', async () => {
        const def = list;
        const query = def.request!.query!.parse({
            q: 'Writer',
            sort: 'books',
            order: 'desc',
            limit: '1',
            offset: '4',
        });
        const response = await invoke(def, { query });
        expect(response.status, await response.clone().text()).toBe(200);
        expect(mocks.list).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                resource,
                resourceSort: 'books',
                order: 'desc',
                limit: 1,
                offset: 4,
            }),
        );
    });
    it('strips list queries from details and probes existence without book filters', async () => {
        const raw = {
            q: 'zzz',
            lang: 'zz',
            libraryGroupId: id,
            seriesId: id,
            authorId: id,
            narratorId: id,
            sort: 'year',
            limit: 1,
            offset: 100,
        };
        const detailQuery = detail.request!.query!.parse(raw);
        expect(detailQuery).toEqual({});
        const detailResponse = await invoke(detail, { query: detailQuery, params: { id } });
        expect(detailResponse.status, await detailResponse.clone().text()).toBe(200);
        expect(mocks.get.mock.calls[0][1]).toEqual({
            access: expect.anything(),
            viewerId: id,
            surface: 'v1',
            resource,
            id,
        });
        expect(books.request!.query!.safeParse(raw).success).toBe(false);
        const { seriesId: _series, authorId: _author, narratorId: _narrator, ...bookFilters } = raw;
        const query = books.request!.query!.parse(bookFilters);
        expect(query).not.toHaveProperty('seriesId');
        expect(query).not.toHaveProperty('authorId');
        expect(query).not.toHaveProperty('narratorId');
        const response = await invoke(books, { query, params: { id } });
        expect(response.status).toBe(200);
        expect((await response.json()).items).toEqual([]);
        expect(mocks.get.mock.calls[1][1]).toEqual(mocks.get.mock.calls[0][1]);
        const options = mocks.books.mock.calls[0][1];
        expect(options).toMatchObject({ q: 'zzz', lang: 'zz', groupId: id, [resource + 'Id']: id });
        for (const key of ['seriesId', 'authorId', 'narratorId']) {
            if (key !== resource + 'Id') expect(options).not.toHaveProperty(key);
        }
    });
    it('bounds pagination offsets', () => {
        expect(books.request!.query!.safeParse({ offset: 100001 }).success).toBe(false);
        expect(books.request!.query!.safeParse({ offset: 100000 }).success).toBe(true);
    });
    it('returns 404 for an absent or inaccessible entity and for its books', async () => {
        mocks.get.mockResolvedValue(null);
        for (const def of [detail, books]) {
            const query = def.request!.query!.parse({});
            const response = await invoke(def, { query, params: { id } });
            expect(response.status, await response.clone().text()).toBe(404);
        }
        expect(mocks.books).not.toHaveBeenCalled();
    });
    it('uses stable ids on the book list and enforces series order', async () => {
        const def = books;
        const query = def.request!.query!.parse({ sort: 'year', order: 'desc' });
        await invoke(def, { query, params: { id } });
        expect(mocks.books).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                [resource + 'Id']: id,
                sort: resource === 'series' ? 'series' : 'year',
                order: resource === 'series' ? 'asc' : 'desc',
                collapse: undefined,
            }),
        );
    });
});
