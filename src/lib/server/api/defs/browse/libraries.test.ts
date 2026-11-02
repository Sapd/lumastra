// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/browse/libraries.ts (GET /api/browse/libraries).
 *
 * Covers the tvOS-reported contract mismatch: `getAvailableLibraries` returns
 * the internal storage token `mediaType: 'tv'`, but `LibraryItemSchema`
 * (src/lib/schemas/api-browse-responses.ts) declares the public enum
 * `['movie', 'series', 'mixed']` — a strict OpenAPI-generated client (tvOS)
 * fails to decode the raw 'tv' value. The web client never noticed because
 * its Zod-validating fetch client applies `coerceLegacyTvToSeries` on
 * receipt; the wire response itself was never coerced.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('$lib/server/services/library-backdrop.service.js', () => ({
    getLibraryBackdropHash: async () => 'library-revision',
}));

import type { RequestEvent } from '@sveltejs/kit';

const mockGetDb = vi.fn();
const mockGetAvailableLibraries = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    getAvailableLibraries: (...args: unknown[]) => mockGetAvailableLibraries(...args),
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
    CACHE_NAMESPACES: { browseLibraries: 'browseLibraries' },
    cacheManager: {
        for: () => ({
            get: (...args: unknown[]) => mockCacheGet(...args),
            set: (...args: unknown[]) => mockCacheSet(...args),
        }),
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const { def } = await import('./libraries.js');

const CTX = { surface: 'internal' as const };

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/browse/libraries');
    return {
        url,
        params: {},
        route: { id: '/api/browse/libraries' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: 'usr-00000000-0000-0000-0000-000000000001',
                username: 'alice',
                groups: '',
                userGroups: ['viewer'],
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({ query: vi.fn() });
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockBuildSearchAccessContext.mockResolvedValue({
        username: 'alice',
        deniedGroupIds: null,
        ageRating: null,
        liveTvAllowed: false,
        showUnavailableMedia: false,
    });
});

describe('GET /api/browse/libraries — public mediaType contract', () => {
    it('maps the internal `tv` storage token to canonical `series`', async () => {
        mockGetAvailableLibraries.mockResolvedValue([
            { id: 'grp-1', name: 'Shows', itemCount: 12, mediaType: 'tv' },
            { id: 'grp-2', name: 'Films', itemCount: 34, mediaType: 'movie' },
            { id: 'grp-3', name: 'Everything', itemCount: 5, mediaType: 'mixed' },
        ]);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.libraries[0].images.primary.revision).toBe('library-revision');
        expect(body.libraries[0].images.backdrop.source).toBe('generated');
        expect(body.libraries.map((l: { mediaType: string }) => l.mediaType)).toEqual([
            'series',
            'movie',
            'mixed',
        ]);
    });

    it('maps `tv` → `series` on the cache-hit path too', async () => {
        mockCacheGet.mockResolvedValue({
            libraries: [{ id: 'grp-1', name: 'Shows', itemCount: 12, mediaType: 'tv' }],
            totalLibraries: 1,
        });

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.libraries[0].mediaType).toBe('series');
    });
});
