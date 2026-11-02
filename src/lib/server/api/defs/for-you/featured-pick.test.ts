// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/featured-pick — SHOW_UNAVAILABLE_MEDIA gate coverage.
 *
 * `accessCtx.showUnavailableMedia` is the always-on server-config gate for
 * discovery-sourced (has_files=false) items. The candidate-selection loop
 * must discard a file-less candidate and fall through to the next criteria
 * when the gate is off, and accept it when the gate is on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

vi.mock('$lib/utils/external-ids.js', () => ({
    getExternalIdFor: (ids: Record<string, string | null | undefined>, provider: string) =>
        ids[provider] ?? undefined,
}));

vi.mock('$lib/server/utils/media-types.js', () => ({
    // Mirrors toMovieOrSeries: 'movie'/'tv' only, null for everything else.
    // Returning `t` unchanged for an unknown type (as this mock used to) would let
    // the test pass while production dropped the item.
    toMovieOrSeries: (t: string) => (t === 'tv' ? 'series' : t === 'movie' ? 'movie' : null),
}));

const mockGetSql = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: {
        getSql: (...args: unknown[]) => mockGetSql(...args),
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

const mockBuildSearchAccessContext = vi.hoisted(() => vi.fn());
const mockScopedCacheKey = vi.hoisted(() => vi.fn().mockReturnValue('fp-key'));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    scopedCacheKey: (...args: unknown[]) => mockScopedCacheKey(...args),
}));

vi.mock('$lib/server/services/taste-damper.service.js', () => ({
    getTasteDamperService: vi.fn().mockReturnValue({
        getDamperContext: vi.fn().mockResolvedValue(null),
    }),
}));

const mockCacheGet = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockCacheSet = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: vi.fn().mockReturnValue({
            get: (...args: unknown[]) => mockCacheGet(...args),
            set: (...args: unknown[]) => mockCacheSet(...args),
        }),
    },
    CACHE_NAMESPACES: {
        aiSuggestions: { name: 'ai-suggestions', l2TTL: 300_000 },
    },
}));

const mockFetchFeaturedPickByCriteria = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/featured-pick.queries.js', () => ({
    fetchFeaturedPickByCriteria: (...args: unknown[]) => mockFetchFeaturedPickByCriteria(...args),
}));

vi.mock('$lib/server/database/queries/user-media-flags.queries.js', () => ({
    getActiveFlagTargets: vi.fn().mockResolvedValue([]),
    setFlag: { execute: vi.fn().mockResolvedValue(undefined) },
}));

const mockGetPlaybackPreferences = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: { one: (...args: unknown[]) => mockGetPlaybackPreferences(...args) },
}));

const mockResolveMetadataLanguage = vi.hoisted(() =>
    vi.fn().mockReturnValue({ titleLang: null, textLang: null }),
);
vi.mock('$lib/server/utils/metadata-language-resolve.js', () => ({
    resolveMetadataLanguage: (...args: unknown[]) => mockResolveMetadataLanguage(...args),
}));

const mockApplyTranslationOverlay = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('$lib/server/utils/translation-overlay.js', () => ({
    applyTranslationOverlay: (...args: unknown[]) => mockApplyTranslationOverlay(...args),
}));

// Mutable config object so tests can flip the metadata-language overlay gate.
// Empty by default so existing (non-overlay) tests pay zero extra
// getPlaybackPreferences calls, matching real config's default.
const mockConfig: Record<string, unknown> = {
    METADATA_ADDITIONAL_LANGUAGES: [] as string[],
};
vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
}));

const { def } = await import('./featured-pick.js');

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/for-you/featured-pick');
    return {
        url,
        locals: { user: { userId: 'user-1', username: 'alice', isAgeRestricted: false } },
    } as unknown as RequestEvent;
}

async function callGet(): Promise<Response> {
    const handler = def.handlers.GET;
    if (!handler) throw new Error('GET handler missing');
    return handler(makeEvent(), {} as ApiContext);
}

const UNAVAILABLE_CANDIDATE = {
    mediaId: 'media-unavailable',
    mediaType: 'movie' as const,
    title: 'Unavailable Movie',
    externalIds: { internal: 'media-unavailable' },
    isAvailable: false,
    canRequest: true,
};

const AVAILABLE_CANDIDATE = {
    mediaId: 'media-available',
    mediaType: 'movie' as const,
    title: 'Available Movie',
    externalIds: { internal: 'media-available' },
    isAvailable: true,
    canRequest: false,
};

describe('featured-pick — SHOW_UNAVAILABLE_MEDIA gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockCacheGet.mockResolvedValue(null);
        // First criteria yields a file-less candidate; second yields an
        // available one.
        mockFetchFeaturedPickByCriteria
            .mockResolvedValueOnce(UNAVAILABLE_CANDIDATE)
            .mockResolvedValueOnce(AVAILABLE_CANDIDATE)
            .mockResolvedValue(null);
    });

    it('discards a file-less candidate and falls through when the gate is off', async () => {
        mockBuildSearchAccessContext.mockResolvedValue({ showUnavailableMedia: false });

        const res = await callGet();
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pick: { id: string; isAvailable: boolean } | null };

        expect(body.pick?.id).toBe('media-available');
        expect(body.pick?.isAvailable).toBe(true);
        expect(mockFetchFeaturedPickByCriteria).toHaveBeenCalledTimes(2);
    });

    it('accepts a file-less candidate when the gate is on', async () => {
        mockBuildSearchAccessContext.mockResolvedValue({ showUnavailableMedia: true });

        const res = await callGet();
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pick: { id: string; isAvailable: boolean } | null };

        expect(body.pick?.id).toBe('media-unavailable');
        expect(body.pick?.isAvailable).toBe(false);
        expect(mockFetchFeaturedPickByCriteria).toHaveBeenCalledTimes(1);
    });
});

describe('featured-pick — metadata-language overlay', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockCacheGet.mockResolvedValue(null);
        mockFetchFeaturedPickByCriteria
            .mockResolvedValueOnce(AVAILABLE_CANDIDATE)
            .mockResolvedValue(null);
        mockBuildSearchAccessContext.mockResolvedValue({ showUnavailableMedia: true });
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de'];
    });

    afterEach(() => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
    });

    it('overlays the localized title/overview when a language resolves', async () => {
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: 'de', textLang: 'de' });
        mockApplyTranslationOverlay.mockImplementation(
            async (
                _sql: unknown,
                items: Array<{ id: string; title: string; overview?: string }>,
            ) => {
                for (const item of items) {
                    if (item.id === 'media-available') {
                        item.title = 'Verfügbarer Film';
                        item.overview = 'Localisierte Beschreibung';
                    }
                }
            },
        );

        const res = await callGet();
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            pick: { id: string; title: string; overview?: string } | null;
        };

        expect(mockApplyTranslationOverlay).toHaveBeenCalledTimes(1);
        expect(body.pick?.title).toBe('Verfügbarer Film');
        expect(body.pick?.overview).toBe('Localisierte Beschreibung');
    });

    it('does not call the overlay when both languages resolve to primary (null)', async () => {
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: null, textLang: null });

        const res = await callGet();
        expect(res.status).toBe(200);
        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
    });

    it('pays zero extra queries when no admin-additional language is configured', async () => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: 'de', textLang: 'de' });

        const res = await callGet();
        expect(res.status).toBe(200);
        expect(mockGetPlaybackPreferences).not.toHaveBeenCalled();
        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
    });
});
