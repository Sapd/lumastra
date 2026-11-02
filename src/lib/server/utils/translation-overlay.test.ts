// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetTranslationMapForItems } = vi.hoisted(() => ({
    mockGetTranslationMapForItems: vi.fn(),
}));

vi.mock('$lib/server/database/queries/media-translations.queries.js', () => ({
    getTranslationMapForItems: mockGetTranslationMapForItems,
}));

vi.mock('./logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

import { applyTranslationOverlay } from './translation-overlay.js';

interface FakeItem {
    id: string;
    title: string;
    overview: string;
    tagline?: string;
}

// The helper only forwards `sql` to `getTranslationMapForItems` (mocked
// above), so a bare marker object is enough to prove pass-through identity.
const fakeSql = { marker: 'sql' } as unknown as Parameters<typeof applyTranslationOverlay>[0];

function makeOpts() {
    return {
        id: (item: FakeItem) => item.id,
        setTitle: (item: FakeItem, v: string) => {
            item.title = v;
        },
        setOverview: (item: FakeItem, v: string) => {
            item.overview = v;
        },
        setTagline: (item: FakeItem, v: string) => {
            item.tagline = v;
        },
    };
}

describe('applyTranslationOverlay', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('no-ops when both langs are null (primary)', async () => {
        const items: FakeItem[] = [{ id: 'a', title: 'Original', overview: 'Orig overview' }];
        await applyTranslationOverlay(
            fakeSql,
            items,
            { titleLang: null, textLang: null },
            makeOpts(),
        );
        expect(mockGetTranslationMapForItems).not.toHaveBeenCalled();
        expect(items[0].title).toBe('Original');
        expect(items[0].overview).toBe('Orig overview');
    });

    it('no-ops (zero queries) when items is empty', async () => {
        await applyTranslationOverlay(fakeSql, [], { titleLang: 'de', textLang: 'ja' }, makeOpts());
        expect(mockGetTranslationMapForItems).not.toHaveBeenCalled();
    });

    it('overlays title from titleLang and overview from textLang independently', async () => {
        mockGetTranslationMapForItems.mockImplementation(
            async (_sql: unknown, _ids: string[], language: string) => {
                if (language === 'de') {
                    return new Map([
                        ['a', { title: 'Deutscher Titel', overview: null, tagline: null }],
                    ]);
                }
                if (language === 'ja') {
                    return new Map([
                        [
                            'a',
                            {
                                title: null,
                                overview: '日本語のあらすじ',
                                tagline: '日本語のタグライン',
                            },
                        ],
                    ]);
                }
                return new Map();
            },
        );

        const items: FakeItem[] = [
            {
                id: 'a',
                title: 'Original Title',
                overview: 'Original overview',
                tagline: 'Original tagline',
            },
        ];
        await applyTranslationOverlay(
            fakeSql,
            items,
            { titleLang: 'de', textLang: 'ja' },
            makeOpts(),
        );

        expect(items[0].title).toBe('Deutscher Titel');
        expect(items[0].overview).toBe('日本語のあらすじ');
        expect(items[0].tagline).toBe('日本語のタグライン');
        // One call per distinct language, batched via Promise.all.
        expect(mockGetTranslationMapForItems).toHaveBeenCalledTimes(2);
        expect(mockGetTranslationMapForItems).toHaveBeenCalledWith(fakeSql, ['a'], 'de');
        expect(mockGetTranslationMapForItems).toHaveBeenCalledWith(fakeSql, ['a'], 'ja');
    });

    it('dedupes the lookup when titleLang === textLang', async () => {
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([['a', { title: 'Titel', overview: 'Übersicht', tagline: null }]]),
        );

        const items: FakeItem[] = [{ id: 'a', title: 'Original', overview: 'Original overview' }];
        await applyTranslationOverlay(
            fakeSql,
            items,
            { titleLang: 'de', textLang: 'de' },
            makeOpts(),
        );

        expect(mockGetTranslationMapForItems).toHaveBeenCalledTimes(1);
        expect(items[0].title).toBe('Titel');
        expect(items[0].overview).toBe('Übersicht');
    });

    it('items without a resolvable id are left untouched', async () => {
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([['a', { title: 'Deutscher Titel', overview: null, tagline: null }]]),
        );

        const withId: FakeItem = { id: 'a', title: 'Original', overview: 'Overview' };
        const withoutId: FakeItem = { id: '', title: 'No Id Original', overview: 'No Id Overview' };
        const items = [withId, withoutId];

        await applyTranslationOverlay(
            fakeSql,
            items,
            { titleLang: 'de', textLang: null },
            makeOpts(),
        );

        expect(withId.title).toBe('Deutscher Titel');
        expect(withoutId.title).toBe('No Id Original');
        // Only the resolvable id is sent to the lookup.
        expect(mockGetTranslationMapForItems).toHaveBeenCalledWith(fakeSql, ['a'], 'de');
    });

    it('does not overwrite a field when the translation value is empty/missing', async () => {
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([['a', { title: null, overview: '', tagline: null }]]),
        );

        const items: FakeItem[] = [{ id: 'a', title: 'Kept Title', overview: 'Kept overview' }];
        await applyTranslationOverlay(
            fakeSql,
            items,
            { titleLang: 'de', textLang: 'de' },
            makeOpts(),
        );

        expect(items[0].title).toBe('Kept Title');
        expect(items[0].overview).toBe('Kept overview');
    });

    it('never throws when the lookup fails — items are left untouched', async () => {
        mockGetTranslationMapForItems.mockRejectedValue(new Error('db exploded'));

        const items: FakeItem[] = [{ id: 'a', title: 'Original', overview: 'Overview' }];
        await expect(
            applyTranslationOverlay(
                fakeSql,
                items,
                { titleLang: 'de', textLang: 'ja' },
                makeOpts(),
            ),
        ).resolves.toBeUndefined();

        expect(items[0].title).toBe('Original');
        expect(items[0].overview).toBe('Overview');
    });

    it('respects opts without setOverview/setTagline (title-only caller)', async () => {
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([
                [
                    'a',
                    {
                        title: 'Deutscher Titel',
                        overview: 'Sollte ignoriert werden',
                        tagline: null,
                    },
                ],
            ]),
        );

        const items: FakeItem[] = [{ id: 'a', title: 'Original', overview: 'Overview' }];
        await applyTranslationOverlay(
            fakeSql,
            items,
            { titleLang: 'de', textLang: 'de' },
            { id: (item: FakeItem) => item.id, setTitle: (item, v) => (item.title = v) },
        );

        expect(items[0].title).toBe('Deutscher Titel');
        expect(items[0].overview).toBe('Overview');
    });
});
