// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => ({ tag: 'sql' }));
const getDb = vi.hoisted(() => vi.fn());
const getCatalogResource = vi.hoisted(() => vi.fn());
const listCatalogBooks = vi.hoisted(() => vi.fn());
const buildSearchAccessContext = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/database/connection.js', () => ({ getDb }));
vi.mock('$lib/server/database/queries/audiobook-catalog.queries.js', () => ({
    getCatalogResource,
    listCatalogBooks,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext,
    searchAccessBoundary: (context: unknown) => ({ boundary: context }),
}));

import { loadAudiobookResource } from './resource-load';

const locals = { user: { userId: 'viewer' } } as App.Locals;
const id = '11111111-1111-4111-8111-111111111111';
const detail = { id, name: 'Contributor', bookCount: 1, durationMs: 1000 };
const book = {
    id,
    catalogId: id,
    title: 'Book',
    type: 'audiobook',
    ids: {},
    images: {},
    audiobook: { authors: [], narrators: [], series: null },
};
const seriesDetail = {
    ...detail,
    images: {},
    progress: { finishedCount: 0, bookCount: 1 },
    nextUp: book,
};
const books = { items: [book], page: { limit: 60, offset: 0, hasMore: true } };

beforeEach(() => {
    vi.resetAllMocks();
    getDb.mockReturnValue(sql);
    buildSearchAccessContext.mockResolvedValue('ctx');
    getCatalogResource.mockResolvedValue(detail);
    listCatalogBooks.mockResolvedValue(books);
});

describe('audiobook resource pages', () => {
    // Regression: these pages went through `event.fetch('/api/audiobooks/...')`, a
    // sub-request that drops the forward-auth identity headers, so every forward-auth
    // user got a 401 page. The load must not make a self-request at all.
    it.each([
        ['authors', 'author', { authorId: id }],
        ['narrators', 'narrator', { narratorId: id }],
        ['series', 'series', { seriesId: id, sort: 'series', order: 'asc' }],
    ] as const)('reads %s in-process, with no self-request', async (kind, resource, extra) => {
        getCatalogResource.mockResolvedValue(kind === 'series' ? seriesDetail : detail);
        const fetchSpy = vi.fn();
        const result = await loadAudiobookResource(
            { params: { id }, locals, fetch: fetchSpy } as never,
            kind,
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(getCatalogResource).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({ resource, id, viewerId: 'viewer', surface: 'internal' }),
        );
        expect(listCatalogBooks).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({
                ...extra,
                limit: 60,
                offset: 0,
                viewerId: 'viewer',
                collapse: undefined,
            }),
        );
        expect(result.kind).toBe(kind);
        expect(result.detail).toEqual(kind === 'series' ? seriesDetail : detail);
        expect(result.books.page.hasMore).toBe(true);
    });

    it('applies the viewer access boundary to the catalog queries', async () => {
        await loadAudiobookResource({ params: { id }, locals }, 'authors');
        expect(buildSearchAccessContext).toHaveBeenCalledWith(sql, locals.user);
        expect(getCatalogResource).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({ access: { boundary: 'ctx' } }),
        );
    });

    it('rejects malformed UUIDs before touching the database', async () => {
        await expect(
            loadAudiobookResource({ params: { id: 'invalid' }, locals }, 'authors'),
        ).rejects.toMatchObject({ status: 404 });
        expect(getCatalogResource).not.toHaveBeenCalled();
    });

    it('guards the server load itself for anonymous __data.json requests', async () => {
        // No parent layout or HTML navigation guard participates in this call.
        await expect(
            loadAudiobookResource({ params: { id }, locals: {} as App.Locals }, 'authors'),
        ).rejects.toMatchObject({ status: 401 });
        expect(getCatalogResource).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown or inaccessible resource, without listing books', async () => {
        getCatalogResource.mockResolvedValue(null);
        await expect(
            loadAudiobookResource({ params: { id }, locals }, 'authors'),
        ).rejects.toMatchObject({ status: 404 });
        expect(listCatalogBooks).not.toHaveBeenCalled();
    });

    it('answers 503 when the database is unavailable', async () => {
        getDb.mockReturnValue(null);
        await expect(
            loadAudiobookResource({ params: { id }, locals }, 'narrators'),
        ).rejects.toMatchObject({ status: 503 });
    });
});
