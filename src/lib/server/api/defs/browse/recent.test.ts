// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/browse/recent.ts (GET /api/browse/recent) —
 * metadata-language overlay coverage (multilingual-media-metadata spec §5).
 *
 * This endpoint is explicitly NOT cached (per its module docblock), so unlike
 * browse/index.ts and browse/keywords.ts there is no shared-cache-mutation
 * hazard to pin — `recentlyAdded` is freshly built by `.map()` on every
 * request, so the overlay runs in place.
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

const mockGetFilteredRecentlyAddedMedia = vi.fn();
vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    getFilteredRecentlyAddedMedia: (...args: unknown[]) =>
        mockGetFilteredRecentlyAddedMedia(...args),
}));

vi.mock('$lib/server/utils/media-types.js', () => ({
    isMovie: (type: string) => type === 'movie',
}));

const mockBuildSearchAccessContext = vi.fn();
vi.mock('$lib/server/utils/search-access-context.js', async (importActual) => {
    const actual =
        await importActual<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        // Real `searchAccessBoundary` is kept (via ...actual) so the handler's
        // context -> boundary projection is exercised, not stubbed.
        buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    };
});

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

const { def } = await import('./recent.js');

const UNRESTRICTED_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: false,
};

function makeRow() {
    return {
        id: '123e4567-e89b-42d3-a456-426614174004',
        title: 'Awakening',
        media_type: 'movie',
        overview: 'Primary overview',
    };
}

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/browse/recent');
    return {
        url,
        locals: { user: { userId: 'usr-0001', username: 'alice' } },
    } as unknown as RequestEvent;
}

const CTX = {
    input: { query: { type: 'all', libraryGroupId: undefined, new: 'titles', q: undefined } },
} as unknown as ApiContext;

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
    mockGetFilteredRecentlyAddedMedia.mockResolvedValue([makeRow()]);
    mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
    mockGetPlaybackPreferences.mockResolvedValue(null);
    mockResolveMetadataLanguage.mockReturnValue({ titleLang: null, textLang: null });
});

describe('GET /api/browse/recent — metadata-language overlay (multilingual-media-metadata §5)', () => {
    it('overlays localized title/overview when the feature is enabled', async () => {
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
        expect(body.recentlyAdded[0].title).toBe('Lokalisierter Titel');
        expect(body.recentlyAdded[0].overview).toBe('Lokalisierte Beschreibung');
    });

    it('pays zero extra queries and skips the overlay when the feature is off', async () => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(mockGetPlaybackPreferences).not.toHaveBeenCalled();
        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
        expect(body.recentlyAdded[0].title).toBe('Awakening');
    });

    it('skips the overlay when both resolved languages are null', async () => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de'];
        mockGetPlaybackPreferences.mockResolvedValue({});
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: null, textLang: null });

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
        expect(body.recentlyAdded[0].title).toBe('Awakening');
    });
});

describe('GET /api/browse/recent — overview truncation', () => {
    /**
     * `overview` truncation (see truncate-overview.ts) is applied
     * unconditionally here — this def has NO /api/v1 mount
     * (`visibility: 'internal'`, see the module docblock), unlike
     * defs/browse/{index,az,genre-name}.ts, which gate the same trim on
     * `ctx.surface === 'internal'`. Pinned directly because no OTHER test in
     * this file uses an overview long enough to need truncation.
     */
    const LONG_OVERVIEW =
        'Awakening is a 2016 science fiction film. '.repeat(6) +
        'It is definitely over 150 characters long.';

    function makeLongOverviewRow() {
        return { ...makeRow(), overview: LONG_OVERVIEW };
    }

    it('trims recentlyAdded overview to <=150 chars ending with the ellipsis', async () => {
        mockGetFilteredRecentlyAddedMedia.mockResolvedValue([makeLongOverviewRow()]);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.recentlyAdded[0].overview.length).toBeLessThanOrEqual(150);
        expect(body.recentlyAdded[0].overview.endsWith('...')).toBe(true);
    });
});
