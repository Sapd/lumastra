// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/search/episodes — metadata-language overlay cache-safety coverage.
 *
 * CRITICAL regression pin (multilingual-media-metadata spec §5, Task 8): the
 * episode-search cache key has NO user component, and UnifiedCache L1
 * returns/stores the LIVE object reference. The overlay must therefore run on
 * shallow clones — an in-place mutation of the cached `results` array would
 * write user A's language INTO the shared cache entry and leak it to every
 * other user hitting the same key within the TTL.
 *
 * The cache mock below stores live references (exactly like L1) so these
 * tests fail if the handler ever goes back to mutating the cached array.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockGetDb = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: vi.fn().mockResolvedValue(null),
    toLibraryAccessUser: (u: unknown) => u,
}));

// Mutable config: overlay gate off by default (matches real config default).
const mockConfig: Record<string, unknown> = {
    UNRATED_CONTENT_VISIBLE: false,
    METADATA_ADDITIONAL_LANGUAGES: [] as string[],
};
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

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
    CACHE_NAMESPACES: { search: { name: 'search' } },
}));

const mockSearchEpisodes = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/episode-search.queries.js', () => ({
    searchEpisodes: (...args: unknown[]) => mockSearchEpisodes(...args),
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

// Overlay mock that exercises the caller-provided accessors/setters exactly
// like the real helper: swaps title/overview in place on whatever array the
// handler hands it. If the handler passes the cached array instead of clones,
// the cache entry gets poisoned and the assertions below catch it.
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

const { def } = await import('./episodes.js');

const EPISODE_ROW = () => ({
    id: '5b3a2c1d-0000-4000-8000-000000000001',
    title: 'Primary Title',
    overview: 'Primary overview',
    seasonNumber: 1,
    episodeNumber: 2,
});

function makeEvent(userId: string): RequestEvent {
    const url = new URL('http://localhost/api/search/episodes?q=primary');
    return {
        url,
        locals: { user: { userId, username: 'u-' + userId } },
    } as unknown as RequestEvent;
}

async function callGet(
    userId: string,
): Promise<{ status: number; items: Array<{ id: string; title: string; overview?: string }> }> {
    const handler = def.handlers.GET;
    if (!handler) throw new Error('GET handler missing');
    const res = await handler(makeEvent(userId), {} as ApiContext);
    const body = (await res.json()) as {
        items: Array<{ id: string; title: string; overview?: string }>;
    };
    return { status: res.status, items: body.items };
}

describe('GET /api/search/episodes — overlay cache safety (CRITICAL pin)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cacheStore.clear();
        mockGetDb.mockReturnValue({});
        mockSearchEpisodes.mockResolvedValue([EPISODE_ROW()]);
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de'];
        mockGetPlaybackPreferences.mockResolvedValue({
            metadata_language: 'de',
            metadata_title_language: 'de',
        });
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: 'de', textLang: 'de' });
    });

    afterEach(() => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
    });

    it('serves localized items to the requesting user WITHOUT mutating the shared cache entry', async () => {
        const { status, items } = await callGet('user-de');
        expect(status).toBe(200);
        expect(items[0].title).toBe('Lokalisierter Titel');
        expect(items[0].overview).toBe('Lokalisierte Beschreibung');

        // The object stored in the (user-agnostic) cache must still be the
        // primary-language original — the overlay must have operated on clones.
        expect(cacheStore.size).toBe(1);
        const cached = [...cacheStore.values()][0] as Array<{ title: string; overview: string }>;
        expect(cached[0].title).toBe('Primary Title');
        expect(cached[0].overview).toBe('Primary overview');
    });

    it('a primary-language user hitting the same cache key after an overlaid request gets primary titles', async () => {
        await callGet('user-de'); // seeds + overlays (on clones)

        // Second user resolves to primary (both langs null) — served straight
        // from the shared cache entry, which must not have been localized.
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: null, textLang: null });
        const { items } = await callGet('user-en');

        expect(mockSearchEpisodes).toHaveBeenCalledTimes(1); // cache hit
        expect(items[0].title).toBe('Primary Title');
        expect(items[0].overview).toBe('Primary overview');
    });

    it('pays zero extra queries and no overlay when the feature is off', async () => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];

        const { items } = await callGet('user-de');

        expect(mockGetPlaybackPreferences).not.toHaveBeenCalled();
        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
        expect(items[0].title).toBe('Primary Title');
    });
});
