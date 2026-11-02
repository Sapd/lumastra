// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/browse/genre-name.ts — E2 keyset conversion.
 *
 * Covers: offset/cursor routing, F9c cross-feed tag guard, malformed-cursor 422,
 * Gate E2 (cache bypass in cursor mode) + F6 (v2genre: key bump), Gate I1
 * (totalCount/nextOffset dropped in cursor mode), Gate J1 (offset bootstrap
 * nextCursor), and F8 (a cursor-mode query error surfaces as 500, not an empty
 * page). All DB/cache I/O mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetDb = vi.fn();
const mockGetMediaByGenre = vi.fn();
const mockGetMediaByGenreCount = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    getMediaByGenre: (...args: unknown[]) => mockGetMediaByGenre(...args),
    getMediaByGenreCount: (...args: unknown[]) => mockGetMediaByGenreCount(...args),
}));

vi.mock('$lib/server/utils/search-access-context.js', async (importActual) => {
    const actual =
        await importActual<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    };
});

vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { browseGenres: 'browseGenres' },
    cacheManager: {
        for: () => ({
            get: (...args: unknown[]) => mockCacheGet(...args),
            set: (...args: unknown[]) => mockCacheSet(...args),
        }),
    },
}));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

const mockConfig: Record<string, unknown> = { METADATA_ADDITIONAL_LANGUAGES: [] as string[] };
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

const { def } = await import('./genre-name.js');
const {
    encodeKeysetCursor,
}: typeof import('$lib/server/database/queries/builders/keyset-cursor.builder.js') =
    await import('$lib/server/database/queries/builders/keyset-cursor.builder.js');

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

function genreValueCursor(pop: string, id: string): string {
    return 'gv:' + encodeKeysetCursor({ ts: pop, id });
}

const UNRESTRICTED_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: false,
};

interface GenreQ {
    type: 'movie' | 'series' | 'all';
    offset: number;
    limit: number;
    cursor?: string;
}

function makeCtx(query: Partial<GenreQ> = {}) {
    return {
        surface: 'v1' as const,
        input: {
            params: { name: 'Action' },
            query: { type: 'all', offset: 0, limit: 50, ...query } as GenreQ,
            body: undefined,
        },
    };
}

function makeEvent(): Partial<RequestEvent> {
    const url = new URL('http://localhost/api/v1/browse/genre/Action');
    return {
        url,
        params: { name: 'Action' },
        request: new Request(url.toString()),
        locals: {
            user: { userId: UUID_A, username: 'alice', userGroups: ['viewer'] },
        } as RequestEvent['locals'],
        setHeaders: vi.fn(),
    };
}

function genreRow(id: string, popularity: string) {
    return {
        id,
        title: `Title ${id.slice(0, 4)}`,
        media_type: 'movie',
        overview: null,
        community_rating: Number(popularity),
        year: 2020,
        popularity_cursor: popularity,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({ query: vi.fn() });
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
    mockGetMediaByGenre.mockResolvedValue([]);
    mockGetMediaByGenreCount.mockResolvedValue(0);
    mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
});

describe('GET /browse/genre/{name} — offset mode (default)', () => {
    it('routes to offset mode and never passes a page cursor', async () => {
        await def.handlers.GET!(makeEvent() as RequestEvent, makeCtx({ offset: 20, limit: 10 }));
        const arg = mockGetMediaByGenre.mock.calls[0][2] as Record<string, unknown>;
        expect(arg.offset).toBe(20);
        expect(arg.page).toBeUndefined();
    });

    it('F6: offset cache key uses the v2genre: prefix', async () => {
        await def.handlers.GET!(makeEvent() as RequestEvent, makeCtx());
        expect(mockCacheSet).toHaveBeenCalled();
        const [key] = mockCacheSet.mock.calls[0] as [string, unknown];
        expect(key).toContain('v3genre:action:');
        expect(key).not.toContain('v1genre:');
    });

    it('Gate J1: offset response emits a bootstrap nextCursor when hasMore', async () => {
        mockGetMediaByGenre.mockResolvedValue([genreRow(UUID_A, '9.5'), genreRow(UUID_B, '8.5')]);
        mockGetMediaByGenreCount.mockResolvedValue(10); // more than offset+limit
        const res = await def.handlers.GET!(
            makeEvent() as RequestEvent,
            makeCtx({ offset: 0, limit: 2 }),
        );
        const body = await (res as Response).json();
        expect(body.page.total).toBe(10);
        expect(body.page.offset).toBe(0);
        expect(body.page.nextCursor).toBe(genreValueCursor('8.5', UUID_B));
    });

    it('offset response omits nextCursor when there are no more items', async () => {
        mockGetMediaByGenre.mockResolvedValue([genreRow(UUID_A, '9.5')]);
        mockGetMediaByGenreCount.mockResolvedValue(1);
        const res = await def.handlers.GET!(
            makeEvent() as RequestEvent,
            makeCtx({ offset: 0, limit: 2 }),
        );
        const body = await (res as Response).json();
        expect(body.page.nextCursor).toBeUndefined();
    });
});

describe('GET /browse/genre/{name} — cursor mode', () => {
    it('routes to cursor mode, bypasses the cache, and skips the count query', async () => {
        mockGetMediaByGenre.mockResolvedValue([genreRow(UUID_A, '9.5')]);
        const cursor = genreValueCursor('9.9', UUID_B);
        await def.handlers.GET!(makeEvent() as RequestEvent, makeCtx({ cursor }));

        const arg = mockGetMediaByGenre.mock.calls[0][2] as Record<string, unknown>;
        expect(arg.page).toEqual({ mode: 'cursor', cursor: { popularity: '9.9', id: UUID_B } });
        expect(arg.offset).toBeUndefined();
        // Gate E2: cache untouched. Gate I1: no count query.
        expect(mockCacheGet).not.toHaveBeenCalled();
        expect(mockCacheSet).not.toHaveBeenCalled();
        expect(mockGetMediaByGenreCount).not.toHaveBeenCalled();
    });

    it('Gate I1: cursor response omits totalCount/nextOffset/currentOffset, emits nextCursor when hasMore', async () => {
        // limit 2, three rows → hasMore, sliced to 2.
        mockGetMediaByGenre.mockResolvedValue([
            genreRow(UUID_A, '9.5'),
            genreRow(UUID_B, '8.5'),
            genreRow('33333333-3333-3333-3333-333333333333', '7.5'),
        ]);
        const cursor = genreValueCursor('9.9', UUID_A);
        const res = await def.handlers.GET!(
            makeEvent() as RequestEvent,
            makeCtx({ cursor, limit: 2 }),
        );
        const body = await (res as Response).json();
        expect(body.items).toHaveLength(2);
        expect(body.page.hasMore).toBe(true);
        expect(body.page.total).toBeUndefined();
        expect(body.page.offset).toBeUndefined();
        expect(body.page.offset).toBeUndefined();
        expect(body.page.nextCursor).toBe(genreValueCursor('8.5', UUID_B));
    });

    it('cursor response omits nextCursor when hasMore is false', async () => {
        mockGetMediaByGenre.mockResolvedValue([genreRow(UUID_A, '9.5')]);
        const cursor = genreValueCursor('9.9', UUID_A);
        const res = await def.handlers.GET!(
            makeEvent() as RequestEvent,
            makeCtx({ cursor, limit: 2 }),
        );
        const body = await (res as Response).json();
        expect(body.page.nextCursor).toBeUndefined();
    });

    it('malformed cursor → 422, query never called', async () => {
        const res = await def.handlers.GET!(
            makeEvent() as RequestEvent,
            makeCtx({ cursor: 'not-a-cursor!!!' }),
        );
        expect((res as Response).status).toBe(422);
        expect(mockGetMediaByGenre).not.toHaveBeenCalled();
    });

    it('F9c: a cursor tagged for another feed (series sv:) → 422', async () => {
        const foreign = 'sv:' + encodeKeysetCursor({ ts: '2026-07-20T00:00:00Z', id: UUID_B });
        const res = await def.handlers.GET!(
            makeEvent() as RequestEvent,
            makeCtx({ cursor: foreign }),
        );
        expect((res as Response).status).toBe(422);
        expect(mockGetMediaByGenre).not.toHaveBeenCalled();
    });

    it('decodable-but-bogus cursor (non-numeric popularity) → 422', async () => {
        const bogus = 'gv:' + encodeKeysetCursor({ ts: 'not-a-number', id: UUID_B });
        const res = await def.handlers.GET!(
            makeEvent() as RequestEvent,
            makeCtx({ cursor: bogus }),
        );
        expect((res as Response).status).toBe(422);
        expect(mockGetMediaByGenre).not.toHaveBeenCalled();
    });

    it('F8: a cursor-mode query error surfaces as 500, not an empty page', async () => {
        mockGetMediaByGenre.mockRejectedValue(new Error('boom'));
        const cursor = genreValueCursor('9.9', UUID_A);
        const res = await def.handlers.GET!(makeEvent() as RequestEvent, makeCtx({ cursor }));
        expect((res as Response).status).toBe(500);
        const body = await (res as Response).json();
        expect(body.code).toBe('internal_error');
    });
});

describe('GET /browse/genre/{name} — image hrefs follow ctx.surface', () => {
    it('emits v1-prefixed entity-image URLs on the v1 surface', async () => {
        mockGetMediaByGenre.mockResolvedValue([genreRow(UUID_A, '9.5')]);
        mockGetMediaByGenreCount.mockResolvedValue(1);
        const res = await def.handlers.GET!(makeEvent() as RequestEvent, makeCtx());
        const body = await (res as Response).json();
        // `/api/image/catalog/...` has no v1 route, so a v1 client used to 404.
        expect(body.items[0].image).toBe(`/api/v1/media/${UUID_A}/images/poster?size=thumb`);
        expect(body.items[0].backdrop).toBe(`/api/v1/media/${UUID_A}/images/backdrop?size=thumb`);
    });

    it('emits internal-prefixed entity-image URLs on the internal surface', async () => {
        mockGetMediaByGenre.mockResolvedValue([genreRow(UUID_A, '9.5')]);
        mockGetMediaByGenreCount.mockResolvedValue(1);
        const res = await def.handlers.GET!(makeEvent() as RequestEvent, {
            ...makeCtx(),
            surface: 'internal' as const,
        });
        const body = await (res as Response).json();
        expect(body.items[0].image).toBe(`/api/media/${UUID_A}/images/poster?size=thumb`);
        expect(body.items[0].backdrop).toBe(`/api/media/${UUID_A}/images/backdrop?size=thumb`);
    });
});

describe('GET /browse/genre/{name} — overview truncation follows ctx.surface', () => {
    /**
     * `overview` truncation (see truncate-overview.ts) is applied ONLY on the
     * internal surface — this def is also mounted at /api/v1/browse/genre/
     * {name}, which must stay byte-identical for native clients. A dropped or
     * flipped `ctx.surface === 'internal'` gate at the response boundary
     * would not fail any OTHER test in this file (none of them use an
     * overview long enough to need truncation), so this pins it directly —
     * both in offset mode AND cursor mode, since the handler has a separate
     * `json()` return for each.
     */
    const LONG_OVERVIEW =
        'Awakening is a 2016 science fiction film. '.repeat(6) +
        'It is definitely over 150 characters long.';

    function longOverviewRow(id: string, popularity: string) {
        return { ...genreRow(id, popularity), overview: LONG_OVERVIEW };
    }

    it('trims item overview to <=150 chars ending with the ellipsis, offset mode, internal surface', async () => {
        mockGetMediaByGenre.mockResolvedValue([longOverviewRow(UUID_A, '9.5')]);
        mockGetMediaByGenreCount.mockResolvedValue(1);
        const res = await def.handlers.GET!(makeEvent() as RequestEvent, {
            ...makeCtx(),
            surface: 'internal' as const,
        });
        const body = await (res as Response).json();

        expect(body.items[0].overview!.length).toBeLessThanOrEqual(150);
        expect(body.items[0].overview!.endsWith('...')).toBe(true);
    });

    it('leaves item overview FULL/untouched, offset mode, v1 surface', async () => {
        mockGetMediaByGenre.mockResolvedValue([longOverviewRow(UUID_A, '9.5')]);
        mockGetMediaByGenreCount.mockResolvedValue(1);
        const res = await def.handlers.GET!(makeEvent() as RequestEvent, makeCtx());
        const body = await (res as Response).json();

        expect(body.items[0].overview).toBe(LONG_OVERVIEW);
    });

    it('trims item overview to <=150 chars ending with the ellipsis, cursor mode, internal surface', async () => {
        mockGetMediaByGenre.mockResolvedValue([longOverviewRow(UUID_A, '9.5')]);
        const res = await def.handlers.GET!(makeEvent() as RequestEvent, {
            ...makeCtx({ cursor: genreValueCursor('9.9', UUID_B) }),
            surface: 'internal' as const,
        });
        const body = await (res as Response).json();

        expect(body.items[0].overview!.length).toBeLessThanOrEqual(150);
        expect(body.items[0].overview!.endsWith('...')).toBe(true);
    });

    it('leaves item overview FULL/untouched, cursor mode, v1 surface', async () => {
        mockGetMediaByGenre.mockResolvedValue([longOverviewRow(UUID_A, '9.5')]);
        const res = await def.handlers.GET!(
            makeEvent() as RequestEvent,
            makeCtx({ cursor: genreValueCursor('9.9', UUID_B) }),
        );
        const body = await (res as Response).json();

        expect(body.items[0].overview).toBe(LONG_OVERVIEW);
    });
});

describe('GET /browse/genre/{name} — dependency down', () => {
    it('returns 503 when DB is null', async () => {
        mockGetDb.mockReturnValue(null);
        const res = await def.handlers.GET!(makeEvent() as RequestEvent, makeCtx());
        expect((res as Response).status).toBe(503);
    });
});
