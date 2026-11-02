// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConfig, mockGetPlaybackPreferencesOne, mockGetTranslationMapForItems } = vi.hoisted(
    () => ({
        mockConfig: {
            TMDB_LANGUAGE: 'en-US',
            METADATA_ADDITIONAL_LANGUAGES: ['de-DE'] as string[],
        },
        mockGetPlaybackPreferencesOne: vi.fn(),
        mockGetTranslationMapForItems: vi.fn(),
    }),
);

vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: { one: mockGetPlaybackPreferencesOne },
}));

vi.mock('$lib/server/database/queries/media-translations.queries.js', () => ({
    getTranslationMapForItems: mockGetTranslationMapForItems,
}));

import { applyJellyfinContentLanguage } from './content-language.js';
import { runWithRequestLanguage } from '$lib/server/utils/request-language-context.js';
import { toUserId } from '$lib/shared/user-id';
import type { MediaItemForSerialization } from './serializers/base-item';

const fakeSql = {} as unknown as Parameters<typeof applyJellyfinContentLanguage>[0];
const userId = toUserId('00000000-0000-0000-0000-000000000001');

function makeItem(): MediaItemForSerialization {
    return {
        id: 'item-1',
        title: 'Original Title',
        media_type: 'movie',
        overview: 'Original overview',
    };
}

describe('applyJellyfinContentLanguage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.TMDB_LANGUAGE = 'en-US';
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de-DE'];
    });

    it('overlays title/overview from an explicit stored metadata_language pref', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: 'de-DE',
            metadata_title_language: 'de-DE',
        });
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([
                [
                    'item-1',
                    { title: 'Deutscher Titel', overview: 'Deutsche Übersicht', tagline: null },
                ],
            ]),
        );

        const items = [makeItem()];
        await applyJellyfinContentLanguage(fakeSql, userId, items);

        expect(items[0].title).toBe('Deutscher Titel');
        expect(items[0].overview).toBe('Deutsche Übersicht');
    });

    it('overlays from the ambient Accept-Language header when the user has no stored pref', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: null,
            metadata_title_language: null,
        });
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([
                [
                    'item-1',
                    { title: 'Deutscher Titel', overview: 'Deutsche Übersicht', tagline: null },
                ],
            ]),
        );

        const items = [makeItem()];
        await runWithRequestLanguage(
            { cookieLocale: null, acceptLanguage: 'de-DE,de;q=0.9,en;q=0.5' },
            () => applyJellyfinContentLanguage(fakeSql, userId, items),
        );

        expect(items[0].title).toBe('Deutscher Titel');
        expect(items[0].overview).toBe('Deutsche Übersicht');
    });

    it('leaves items unchanged when there is no pref, no header, and no translation to apply', async () => {
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_language: null,
            metadata_title_language: null,
        });

        const items = [makeItem()];
        await applyJellyfinContentLanguage(fakeSql, userId, items);

        expect(items[0].title).toBe('Original Title');
        expect(items[0].overview).toBe('Original overview');
        expect(mockGetTranslationMapForItems).not.toHaveBeenCalled();
    });

    it('issues zero queries when no additional languages are admin-enabled', async () => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];

        const items = [makeItem()];
        await applyJellyfinContentLanguage(fakeSql, userId, items);

        expect(mockGetPlaybackPreferencesOne).not.toHaveBeenCalled();
        expect(items[0].title).toBe('Original Title');
    });

    it('no-ops when userId is missing', async () => {
        const items = [makeItem()];
        await applyJellyfinContentLanguage(fakeSql, null, items);

        expect(mockGetPlaybackPreferencesOne).not.toHaveBeenCalled();
        expect(items[0].title).toBe('Original Title');
    });
});
