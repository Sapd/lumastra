// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/catalog/movie-details.ts (GET movie-details/{id}).
 *
 * Covers a translation-lazy-fill gap: this endpoint applies the per-user
 * metadata-language overlay (title/overview swap) but, unlike
 * `catalog/media-id.ts` (ModalMovie's read path), never enqueued a
 * translations backfill when the viewer's preferred language had no
 * translation row yet. A movie opened ONLY via the in-player MovieSidebar
 * (this endpoint) could never self-heal a missing translation. These tests
 * prove the shared `triggerMetadataTranslationLazyFill` helper is now
 * invoked with the same movie/series-only, per-request-resolved languages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetDb = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockResolveCatalogInternalId = vi.fn();
const mockGetPlaybackPreferencesOne = vi.fn();
const mockApplyTranslationOverlay = vi.fn().mockResolvedValue(undefined);
const mockTriggerLazyFill = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

vi.mock('./resolve-id.js', () => ({
    resolveCatalogInternalId: (...args: unknown[]) => mockResolveCatalogInternalId(...args),
}));

vi.mock('$lib/server/services/genre.service.js', () => ({
    GenreService: {
        normalizeGenres: () => [],
        getGenreNames: () => [],
    },
}));

vi.mock('$lib/server/services/image-descriptor/index.js', async () => {
    const { buildImageSet } = await import('$lib/shared/image-descriptor.js');
    const imageSet = (surface: 'internal' | 'v1', id: string, mediaType?: string) =>
        buildImageSet(
            surface,
            mediaType === 'episode'
                ? { thumb: { ownerId: id } }
                : { poster: { ownerId: id }, backdrop: { ownerId: id } },
        );
    return {
        resolveImageSet: vi.fn(
            async (_sql: unknown, surface: 'internal' | 'v1', id: string, mediaType?: string) =>
                imageSet(surface, id, mediaType),
        ),
        resolveImageSets: vi.fn(
            async (
                _sql: unknown,
                surface: 'internal' | 'v1',
                items: { id: string; mediaType?: string }[],
            ) => new Map(items.map((item) => [item.id, imageSet(surface, item.id, item.mediaType)])),
        ),
    };
});

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: {
        one: (...args: unknown[]) => mockGetPlaybackPreferencesOne(...args),
    },
}));

vi.mock('$lib/server/utils/translation-overlay.js', () => ({
    applyTranslationOverlay: (...args: unknown[]) => mockApplyTranslationOverlay(...args),
}));

vi.mock('$lib/server/utils/metadata-translation-lazy-fill.js', () => ({
    triggerMetadataTranslationLazyFill: (...args: unknown[]) => mockTriggerLazyFill(...args),
}));

const { config } = await import('$lib/server/config.js');
const { def } = await import('./movie-details.js');

const INTERNAL_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = 'usr_00000000-0000-0000-0000-000000000001';

/** sql stub callable as a tagged template; every query resolves to the
 * movie row on the first call and empty external-ids/user rows after. */
function makeSql() {
    const movieRow = {
        id: INTERNAL_ID,
        title: 'Intertidal',
        media_type: 'movie',
        overview: 'A team travels through a wormhole.',
        premiere_date: '2014-11-07',
        runtime_seconds: 10140,
        metadata: {},
        has_file: true,
    };
    const calls = [[movieRow], [], []];
    let i = 0;
    return vi.fn(() => Promise.resolve(calls[Math.min(i++, calls.length - 1)]));
}

function makeEvent(): RequestEvent {
    return {
        params: { id: INTERNAL_ID },
        locals: {
            user: {
                userId: USER_ID,
                username: 'alice',
                userGroups: [],
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
        },
    } as unknown as RequestEvent;
}

const CTX = { surface: 'internal' as const };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue(makeSql());
    mockCheckMediaAccess.mockResolvedValue(true);
    mockResolveCatalogInternalId.mockResolvedValue(INTERNAL_ID);
    mockApplyTranslationOverlay.mockResolvedValue(undefined);
});

describe('GET /movie-details/{id} — translation lazy-fill wiring', () => {
    it('triggers the shared lazy-fill helper with the resolved languages when a language preference resolves', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de']);
        try {
            mockGetPlaybackPreferencesOne.mockResolvedValue({
                metadata_title_language: 'de',
                metadata_language: 'de',
            });

            const res = await def.handlers.GET!(makeEvent(), CTX);
            expect(res.status).toBe(200);

            expect(mockTriggerLazyFill).toHaveBeenCalledTimes(1);
            expect(mockTriggerLazyFill).toHaveBeenCalledWith(
                expect.anything(),
                INTERNAL_ID,
                'movie',
                USER_ID,
                expect.objectContaining({ titleLang: 'de', textLang: 'de' }),
                expect.objectContaining({ sourceRoute: expect.any(String) }),
            );
        } finally {
            langSpy.mockRestore();
        }
    });

    it('does not trigger lazy-fill when no admin-additional language is configured', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue([]);
        try {
            const res = await def.handlers.GET!(makeEvent(), CTX);
            expect(res.status).toBe(200);

            expect(mockTriggerLazyFill).not.toHaveBeenCalled();
            expect(mockGetPlaybackPreferencesOne).not.toHaveBeenCalled();
        } finally {
            langSpy.mockRestore();
        }
    });

    it('still calls the lazy-fill helper with null/null when resolved languages are both primary — the no-op guard lives in the shared helper, not duplicated per call site', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de']);
        try {
            // Explicit primary-language prefs — resolves deterministically to
            // null without falling through to ambient (cookie/header) resolution.
            mockGetPlaybackPreferencesOne.mockResolvedValue({
                metadata_title_language: 'en-US',
                metadata_language: 'en-US',
            });

            const res = await def.handlers.GET!(makeEvent(), CTX);
            expect(res.status).toBe(200);

            expect(mockTriggerLazyFill).toHaveBeenCalledWith(
                expect.anything(),
                INTERNAL_ID,
                'movie',
                USER_ID,
                expect.objectContaining({ titleLang: null, textLang: null }),
                expect.anything(),
            );
        } finally {
            langSpy.mockRestore();
        }
    });
});
