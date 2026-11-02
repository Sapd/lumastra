// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/catalog/media-id-similar.ts (GET media/{id}/similar).
 *
 * File-less candidates are discovery/request rows. The endpoint used to return
 * them whatever SHOW_UNAVAILABLE_MEDIA said and derived `isAvailable` from the
 * library EMBEDDING instead of `has_files`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const SOURCE_ID = '00000000-0000-4000-a000-000000000001';

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));
vi.mock('./resolve-id.js', () => ({ resolveCatalogInternalId: async () => SOURCE_ID }));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: async () => true }));

const mockBuildSearchAccessContext = vi.fn();
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    scopedCacheKey: (key: string) => key,
}));

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: { for: () => ({ get: async () => null, set: async () => undefined }) },
    CACHE_NAMESPACES: { similarModalContent: { name: 'similarModalContent' } },
}));
vi.mock('$lib/server/cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async (opts: { compute: () => Promise<string> }) => opts.compute(),
}));
vi.mock('$lib/server/caches/similar-source-media.js', () => ({
    getSimilarSourceMedia: async () => ({
        media_type: 'movie',
        title: 'Source',
        primary_ext_id: '1',
        embedding: '[0.1]',
    }),
}));
vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));
vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: async () => new Map(),
}));
vi.mock('$lib/server/config.js', () => ({ config: { METADATA_ADDITIONAL_LANGUAGES: [] } }));
vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    getUserRatingsForMedia: { all: async () => [] },
}));

const mockFindSimilarMediaDual = vi.fn();
vi.mock('$lib/server/database/queries/suggestion-search.queries.js', () => ({
    findSimilarMediaDual: (...args: unknown[]) => mockFindSimilarMediaDual(...args),
}));

// Echo the items the handler built so the test can assert on them directly.
vi.mock('$lib/server/services/media-preview.service.js', () => ({
    buildMediaPreviews: async (_sql: unknown, _surface: unknown, items: unknown[]) => items,
}));

const { def } = await import('./media-id-similar.js');

function candidate(id: string, ext: string, hasFiles: boolean) {
    return {
        media_uuid: id,
        primary_ext_id: ext,
        media_type: 'movie',
        title: `Title ${ext}`,
        release_year: 2020,
        overview: null,
        combined_score: 0.9,
        // The library embedding is deliberately TRUE for the file-less row:
        // availability must come from has_files, not from embeddings.
        has_library_embedding: true,
        has_discovery_embedding: true,
        is_available: hasFiles,
        can_request: !hasFiles,
    };
}

async function get(): Promise<Array<{ title: string; isAvailable: boolean; canRequest: boolean }>> {
    const url = new URL(`http://localhost/api/v1/media/${SOURCE_ID}/similar`);
    const event = {
        url,
        params: { id: SOURCE_ID },
        request: new Request(url),
        locals: { user: { userId: 'u1', username: 'alice', isAgeRestricted: false } },
    } as unknown as RequestEvent;
    const response = (await def.handlers.GET!(event, {
        surface: 'v1',
        input: { query: { limit: 20, minSimilarity: 0.5 } },
    } as unknown as ApiContext)) as Response;
    return (await response.json()).items;
}

describe('GET /media/{id}/similar availability gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockFindSimilarMediaDual.mockResolvedValue([
            candidate('00000000-0000-4000-a000-0000000000a1', '10', true),
            candidate('00000000-0000-4000-a000-0000000000a2', '20', false),
        ]);
    });

    it('asks the similarity query for available rows only when unavailable media is hidden', async () => {
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: null,
            showUnavailableMedia: false,
        });
        mockFindSimilarMediaDual.mockResolvedValue([
            candidate('00000000-0000-4000-a000-0000000000a1', '10', true),
        ]);
        const items = await get();
        // Filter is pushed into the query so the limit applies after it.
        expect(mockFindSimilarMediaDual.mock.calls[0][2]).toMatchObject({ availableOnly: true });
        expect(items.map((i) => i.title)).toEqual(['Title 10']);
        expect(items[0]).toMatchObject({ isAvailable: true, canRequest: false });
    });

    it('never returns the seed itself, even when its provider id differs', async () => {
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: null,
            showUnavailableMedia: true,
        });
        mockFindSimilarMediaDual.mockResolvedValue([
            candidate(SOURCE_ID, '999', true),
            candidate('00000000-0000-4000-a000-0000000000a1', '10', true),
        ]);
        const items = await get();
        expect(items.map((i) => i.title)).toEqual(['Title 10']);
    });

    it('keeps file-less candidates flagged isAvailable:false when visible', async () => {
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: null,
            showUnavailableMedia: true,
        });
        const items = await get();
        expect(mockFindSimilarMediaDual.mock.calls[0][2]).toMatchObject({ availableOnly: false });
        expect(items.map((i) => [i.title, i.isAvailable, i.canRequest])).toEqual([
            ['Title 10', true, false],
            ['Title 20', false, true],
        ]);
    });
});
