// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const fakeSql = vi.hoisted(() => ({ marker: 'sql' }));
const access = vi.hoisted(() => ({ library: { kind: 'all' }, age: { kind: 'any' } }));
const db = vi.hoisted(() => vi.fn((): object | null => fakeSql));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: db }));
vi.mock('$lib/server/database/queries/audiobook-browse.queries.js', () => ({
    getAudiobooksInProgress: vi.fn(async () => []),
}));
vi.mock('$lib/server/database/queries/audiobook-catalog.queries.js', () => ({
    audiobookPreviewsForAdmittedIds: vi.fn(),
    listCatalogBooks: vi.fn(),
    catalogFacets: vi.fn(),
    getCatalogResource: vi.fn(),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(),
    searchAccessBoundary: vi.fn(),
}));
vi.mock('$lib/server/api/defs/recommendations/feed-audiobook-activity-section.js', () => ({
    buildAudiobookActivitySection: vi.fn(),
}));
vi.mock('$lib/server/api/defs/recommendations/recommender.js', () => ({
    buildAccessContext: vi.fn(),
}));
vi.mock('$lib/server/utils/ui-locale.js', () => ({ resolveUiLocale: vi.fn() }));
import { getAudiobooksInProgress } from '$lib/server/database/queries/audiobook-browse.queries.js';
import {
    audiobookPreviewsForAdmittedIds,
    catalogFacets,
    getCatalogResource,
    listCatalogBooks,
} from '$lib/server/database/queries/audiobook-catalog.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { buildAccessContext } from '$lib/server/api/defs/recommendations/recommender.js';
import { audiobookRowToPreview } from '$lib/server/utils/audiobook-cards.js';
const { load } = await import('./+page.server');
beforeEach(() => {
    db.mockReturnValue(fakeSql);
});

describe('audiobook SSR query parsing', () => {
    it('drops invalid resource UUIDs before determining sort and API filters', async () => {
        const result = await load({
            locals: {},
            url: new URL(
                'http://localhost/audiobooks?seriesId=bad&authorId=bad&narratorId=bad&libraryGroupId=bad',
            ),
        } as Parameters<typeof load>[0]);
        expect(result).toMatchObject({
            filter: {
                series: null,
                author: null,
                narrator: null,
                group: null,
                sort: 'title_asc',
            },
        });
    });
    it('retains valid resource UUIDs and the series ordering default', async () => {
        const id = '11111111-1111-4111-8111-111111111111';
        const result = await load({
            locals: {},
            url: new URL(
                `http://localhost/audiobooks?seriesId=${id}&authorId=${id}&narratorId=${id}`,
            ),
        } as Parameters<typeof load>[0]);
        expect(result).toMatchObject({
            filter: { series: id, author: id, narrator: id, sort: 'series_sequence' },
        });
    });
    it('sends the renamed library filter and only facet-supported fields during SSR', async () => {
        const id = '11111111-1111-4111-8111-111111111111';
        vi.mocked(listCatalogBooks).mockResolvedValue({
            items: [],
            page: { limit: 60, offset: 0, hasMore: false },
        } as never);
        vi.mocked(catalogFacets).mockResolvedValue({
            shelves: [],
            languages: [],
            letterCounts: [],
        });
        vi.mocked(audiobookPreviewsForAdmittedIds).mockResolvedValue([]);
        const result = await load(
            loaderEvent(`http://localhost/audiobooks?libraryGroupId=${id}&letter=A&sort=year_desc`),
        );
        expect(result).toMatchObject({ loadError: false });
        const listInput = vi.mocked(listCatalogBooks).mock.lastCall?.[1];
        const facetInput = vi.mocked(catalogFacets).mock.lastCall?.[1];
        expect(listInput).toMatchObject({
            libraryGroupId: id,
            sort: 'year',
            order: 'desc',
            letter: 'A',
        });
        expect(facetInput).toMatchObject({ libraryGroupId: id });
        expect(facetInput).not.toHaveProperty('sort');
        expect(facetInput).not.toHaveProperty('letter');
    });
});

const userId = '22222222-2222-4222-8222-222222222222';
const bookId = '33333333-3333-4333-8333-333333333333';
const authorId = '11111111-1111-4111-8111-111111111111';
const seriesId = '44444444-4444-4444-8444-444444444444';

/** An event whose internal sub-request path must never run: it has no proxy identity. */
function loaderEvent(url: string): Parameters<typeof load>[0] {
    return {
        locals: { user: { userId } },
        url: new URL(url),
        fetch: () => {
            throw new Error('no internal fetch');
        },
    } as unknown as Parameters<typeof load>[0];
}

function onePage() {
    const item = audiobookRowToPreview(
        {
            id: bookId,
            title: 'A book',
            year: 2020,
            ids: {},
            authors: [{ id: authorId, name: 'Writer' }],
            narrators: [],
            series: null,
            position_ms: null,
            duration_ms: '3600000',
            finished: false,
            state_id: null,
            updated_at: null,
        },
        {},
    );
    return { items: [item], page: { limit: 60, offset: 0, hasMore: false, total: 1 } };
}

describe('audiobook SSR loader runs in-process (no internal fetch)', () => {
    beforeEach(() => {
        vi.mocked(buildSearchAccessContext).mockResolvedValue(access as never);
        vi.mocked(searchAccessBoundary).mockReturnValue(access as never);
        vi.mocked(buildAccessContext).mockResolvedValue(null as never);
        vi.mocked(getAudiobooksInProgress).mockResolvedValue([]);
        vi.mocked(audiobookPreviewsForAdmittedIds).mockResolvedValue([]);
        vi.mocked(listCatalogBooks).mockResolvedValue(onePage() as never);
        vi.mocked(catalogFacets).mockResolvedValue({
            shelves: [],
            languages: [],
            letterCounts: [],
        });
        vi.mocked(getCatalogResource).mockResolvedValue({
            id: authorId,
            name: 'Writer',
            bookCount: 1,
            durationMs: 3600000,
        } as never);
    });

    it('returns the books and facets without any event.fetch', async () => {
        const result = await load(loaderEvent('http://localhost/audiobooks'));
        expect(result).toMatchObject({
            loadError: false,
            totalCount: 1,
            hasMore: false,
            items: [expect.objectContaining({ id: bookId })],
            shelves: [],
            languages: [],
            letterCounts: [],
        });
        expect(listCatalogBooks).toHaveBeenCalledWith(
            fakeSql,
            expect.objectContaining({
                access,
                viewerId: userId,
                surface: 'internal',
                sort: 'title',
                order: 'asc',
                limit: 60,
                offset: 0,
                collapse: 'series',
            }),
        );
    });

    it('resolves the author name in-process for an author filter', async () => {
        const result = await load(loaderEvent(`http://localhost/audiobooks?authorId=${authorId}`));
        expect(result).toMatchObject({
            loadError: false,
            filterNames: { author: 'Writer', narrator: null, series: null },
        });
        expect(getCatalogResource).toHaveBeenCalledWith(
            fakeSql,
            expect.objectContaining({
                access,
                viewerId: userId,
                surface: 'internal',
                resource: 'author',
                id: authorId,
            }),
        );
    });

    it('drops the series collapse and uses reading order for a series drill-down', async () => {
        const result = await load(loaderEvent(`http://localhost/audiobooks?seriesId=${seriesId}`));
        expect(result).toMatchObject({ loadError: false, filter: { sort: 'series_sequence' } });
        expect(listCatalogBooks).toHaveBeenCalledWith(
            fakeSql,
            expect.objectContaining({
                seriesId,
                sort: 'series',
                order: 'asc',
                collapse: undefined,
            }),
        );
        expect(catalogFacets).toHaveBeenCalledWith(
            fakeSql,
            expect.objectContaining({ seriesId, collapse: undefined }),
        );
    });
});
