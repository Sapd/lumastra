// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/browse/keywords.ts (GET /api/browse/keywords) —
 * metadata-language overlay cache-safety coverage (multilingual-media-
 * metadata spec §5).
 *
 * CRITICAL regression pin: the keywords cache key has no per-request
 * component beyond access scope, and UnifiedCache L1 returns/stores the LIVE
 * object reference (both `sections` and each section's `items` array). The
 * overlay must therefore run on a deep-enough clone — an in-place mutation
 * would write one user's language INTO the shared cache entry and leak it to
 * every other user hitting the same key (mirrors search/episodes.test.ts).
 *
 * Also pins: the `internalId` field added to `BrowseKeywordItem` for the
 * overlay lookup is internal-only and must never reach the wire response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

const mockBuildBrowseKeywordSections = vi.fn();
vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    buildBrowseKeywordSections: (...args: unknown[]) => mockBuildBrowseKeywordSections(...args),
}));

const mockBuildSearchAccessContext = vi.fn();
vi.mock('$lib/server/utils/search-access-context.js', async (importActual) => {
    const actual =
        await importActual<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    };
});

// Live-reference cache mock — get() hands back the exact object set() stored,
// mirroring UnifiedCache's L1 behavior (unified-cache.ts).
const cacheStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({
            get: async (key: string) => cacheStore.get(key) ?? null,
            set: async (key: string, value: unknown) => {
                cacheStore.set(key, value);
            },
        }),
    },
    CACHE_NAMESPACES: { browseKeywords: { name: 'browseKeywords', l2TTL: 900_000 } },
}));

// compute() runs through directly — no lock/leader semantics needed for these tests.
vi.mock('$lib/server/cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async (opts: { compute: () => Promise<string> }) => opts.compute(),
}));

// Mutable config: overlay gate off by default (matches real config default).
const mockConfig: Record<string, unknown> = {
    METADATA_ADDITIONAL_LANGUAGES: [] as string[],
};
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

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

// Overlay mock that exercises the caller-provided accessors/setters exactly
// like the real helper.
const mockApplyTranslationOverlay = vi.hoisted(() =>
    vi.fn(
        async (
            _sql: unknown,
            items: unknown[],
            _langs: unknown,
            opts: {
                id: (it: unknown) => string | null | undefined;
                setTitle?: (it: unknown, v: string) => void;
                setOverview?: (it: unknown, v: string) => void;
            },
        ) => {
            for (const item of items) {
                if (!opts.id(item)) continue;
                opts.setTitle?.(item, 'Lokalisierter Titel');
                opts.setOverview?.(item, 'Lokalisierte Beschreibung');
            }
        },
    ),
);
vi.mock('$lib/server/utils/translation-overlay.js', () => ({
    applyTranslationOverlay: (...args: unknown[]) =>
        mockApplyTranslationOverlay(...(args as Parameters<typeof mockApplyTranslationOverlay>)),
}));

const { def } = await import('./keywords.js');

const UNRESTRICTED_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: false,
};

function makeKeywordSections() {
    return {
        sections: [
            {
                keyword: 'Space Opera',
                keywordId: 161176,
                items: [
                    {
                        id: 550,
                        internalId: '123e4567-e89b-42d3-a456-426614174003',
                        externalIds: { tmdb: '550' },
                        name: 'Quiet Orbit',
                        type: 'movie' as const,
                        overview: 'Primary overview',
                        isAvailable: true,
                    },
                ],
            },
        ],
        availableKeywords: [{ id: 161176, name: 'Space Opera' }],
        totalKeywords: 30,
        hasMore: true,
        nextOffset: 1,
    };
}

function makeEvent(userId = 'usr-0001'): RequestEvent {
    const url = new URL('http://localhost/api/browse/keywords');
    return {
        url,
        locals: {
            user: {
                userId,
                username: 'alice',
                isAgeRestricted: false,
            },
        },
    } as unknown as RequestEvent;
}

const CTX = { input: { query: { type: 'all', limit: 5, offset: 0 } } } as unknown as ApiContext;

beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    mockGetDb.mockReturnValue({});
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
    mockBuildBrowseKeywordSections.mockResolvedValue(makeKeywordSections());
    mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
    mockGetPlaybackPreferences.mockResolvedValue(null);
    mockResolveMetadataLanguage.mockReturnValue({ titleLang: null, textLang: null });
});

describe('GET /api/browse/keywords — metadata-language overlay (CRITICAL cache-safety pin)', () => {
    it('serves localized items without mutating the shared cache entry', async () => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de'];
        mockGetPlaybackPreferences.mockResolvedValue({
            metadata_language: 'de',
            metadata_title_language: 'de',
        });
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: 'de', textLang: 'de' });

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(res.status).toBe(200);
        expect(body.items[0].items[0].title).toBe('Lokalisierter Titel');
        expect(body.items[0].items[0].overview).toBe('Lokalisierte Beschreibung');

        // The object stored in the (user-agnostic) cache must still hold the
        // primary-language original — the overlay must have operated on clones.
        expect(cacheStore.size).toBe(1);
        const cached = [...cacheStore.values()][0] as {
            sections: Array<{ items: Array<{ name: string; overview: string }> }>;
        };
        expect(cached.sections[0].items[0].name).toBe('Quiet Orbit');
        expect(cached.sections[0].items[0].overview).toBe('Primary overview');
    });

    it('a primary-language user hitting the same cache key after an overlaid request gets primary titles', async () => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de'];
        mockGetPlaybackPreferences.mockResolvedValue({
            metadata_language: 'de',
            metadata_title_language: 'de',
        });
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: 'de', textLang: 'de' });

        const handler = def.handlers.GET!;
        await handler(makeEvent('usr-de'), CTX); // seeds + overlays (on clones)

        mockResolveMetadataLanguage.mockReturnValue({ titleLang: null, textLang: null });
        const res = await handler(makeEvent('usr-en'), CTX);
        const body = await res.clone().json();

        expect(mockBuildBrowseKeywordSections).toHaveBeenCalledTimes(1); // cache hit
        expect(body.items[0].items[0].title).toBe('Quiet Orbit');
        expect(body.items[0].items[0].overview).toBe('Primary overview');
    });

    it('pays zero extra queries and no overlay when the feature is off', async () => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(mockGetPlaybackPreferences).not.toHaveBeenCalled();
        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
        expect(body.items[0].items[0].title).toBe('Quiet Orbit');
    });

    it('never leaks the internal-only `internalId` overlay-lookup field onto the wire response', async () => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de'];
        mockGetPlaybackPreferences.mockResolvedValue({
            metadata_language: 'de',
            metadata_title_language: 'de',
        });
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: 'de', textLang: 'de' });

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.items[0].items[0]).not.toHaveProperty('internalId');
    });
});

describe('GET /api/browse/keywords — overview truncation', () => {
    /**
     * `overview` truncation (see truncate-overview.ts) is applied
     * unconditionally here — this def has NO /api/v1 mount
     * (`visibility: 'internal'`, see the module docblock), unlike
     * defs/browse/{index,az,genre-name}.ts, which gate the same trim on
     * `ctx.surface === 'internal'`. Pinned directly because no OTHER test in
     * this file uses an overview long enough to need truncation.
     */
    const LONG_OVERVIEW =
        'Quiet Orbit is a 1999 film about an underground quiet orbit. '.repeat(3) +
        'It is definitely over 150 characters long.';

    function makeLongOverviewSections() {
        const sections = makeKeywordSections();
        sections.sections[0].items[0].overview = LONG_OVERVIEW;
        return sections;
    }

    it('trims item overview to <=150 chars ending with the ellipsis', async () => {
        mockBuildBrowseKeywordSections.mockResolvedValue(makeLongOverviewSections());

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.items[0].items[0].overview.length).toBeLessThanOrEqual(150);
        expect(body.items[0].items[0].overview.endsWith('...')).toBe(true);
    });
});
