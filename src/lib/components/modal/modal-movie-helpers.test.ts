// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    buildPluginDetailItem,
    chapterWatchPath,
    classifySwipe,
    formatCustomMetadataValue,
    isPlainLeftClick,
    isTrailerShortcut,
    parseYear,
    shouldBulkToggleSeries,
} from './modal-movie-helpers';

describe('shouldBulkToggleSeries', () => {
    it('bulk-toggles only when no episode is in context', () => {
        expect(shouldBulkToggleSeries(undefined, undefined)).toBe(true);
        expect(shouldBulkToggleSeries(null, 3)).toBe(true);
        expect(shouldBulkToggleSeries(2, undefined)).toBe(true);
        expect(shouldBulkToggleSeries(2, 3)).toBe(false);
    });

    it('treats season 0 (specials) and episode 0 as a real episode in context', () => {
        expect(shouldBulkToggleSeries(0, 4)).toBe(false);
        expect(shouldBulkToggleSeries(1, 0)).toBe(false);
        expect(shouldBulkToggleSeries(0, 0)).toBe(false);
    });
});

describe('parseYear', () => {
    it('parses numeric strings and numbers', () => {
        expect(parseYear('2001')).toBe(2001);
        expect(parseYear(1999)).toBe(1999);
    });

    it('returns undefined instead of NaN for non-numeric values', () => {
        expect(parseYear('2020-05-01')).toBeUndefined();
        expect(parseYear('n/a')).toBeUndefined();
        expect(parseYear('')).toBeUndefined();
        expect(parseYear(null)).toBeUndefined();
        expect(parseYear(0)).toBeUndefined();
    });
});

describe('formatCustomMetadataValue', () => {
    const labels = { yes: 'Ja', no: 'Nein' };

    it('uses the localized yes/no labels for booleans', () => {
        expect(formatCustomMetadataValue(true, 'boolean', labels)).toBe('Ja');
        expect(formatCustomMetadataValue(false, 'boolean', labels)).toBe('Nein');
    });

    it('joins arrays, including non-string entries', () => {
        expect(formatCustomMetadataValue(['a', 'b'], 'tags', labels)).toBe('a, b');
        expect(formatCustomMetadataValue([1, 2], 'text', labels)).toBe('1, 2');
        expect(formatCustomMetadataValue(['a', null, ''], 'tags', labels)).toBe('a');
    });

    it('never renders "[object Object]"', () => {
        expect(formatCustomMetadataValue({ vol: 3 }, 'text', labels)).toBe('{"vol":3}');
        expect(formatCustomMetadataValue([{ a: 1 }], 'tags', labels)).toBe('{"a":1}');
    });

    it('stringifies scalars', () => {
        expect(formatCustomMetadataValue(42, 'number', labels)).toBe('42');
        expect(formatCustomMetadataValue('Marvel', 'text', labels)).toBe('Marvel');
    });
});

describe('classifySwipe', () => {
    const base = { startX: 200, dx: 0, dy: 0, hasHistory: true, scrollTopAtStart: 0 };

    it('stays undecided inside the dead zone', () => {
        expect(classifySwipe({ ...base, dx: 3, dy: 5 })).toBeNull();
    });

    it('classifies a downward drag that started at the top as swipe-down', () => {
        expect(classifySwipe({ ...base, dy: 40, dx: 5 })).toBe('down');
    });

    it('keeps a drag that started scrolled down as a scroll, even moving down', () => {
        expect(classifySwipe({ ...base, dy: 40, scrollTopAtStart: 300 })).toBe('none');
    });

    it('classifies a rightward drag from the left edge with history as swipe-back', () => {
        expect(classifySwipe({ ...base, startX: 10, dx: 40, dy: 5 })).toBe('back');
    });

    it('does not swipe back without history or away from the edge', () => {
        expect(classifySwipe({ ...base, startX: 10, dx: 40, hasHistory: false })).toBe('none');
        expect(classifySwipe({ ...base, startX: 100, dx: 40 })).toBe('none');
    });

    it('treats upward and diagonal-horizontal movement as a scroll', () => {
        expect(classifySwipe({ ...base, dy: -40 })).toBe('none');
        expect(classifySwipe({ ...base, dx: 40, dy: 10 })).toBe('none');
    });

    it('does not latch a scroll on a jittery first sample just past the dead zone', () => {
        expect(classifySwipe({ ...base, dx: 9, dy: -2 })).toBeNull();
        expect(classifySwipe({ ...base, startX: 10, dx: 2, dy: -9 })).toBeNull();
    });
});

describe('isTrailerShortcut', () => {
    const key = (over: Partial<Parameters<typeof isTrailerShortcut>[0]>) => ({
        key: 't',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        repeat: false,
        defaultPrevented: false,
        ...over,
    });

    it('accepts a bare t / T', () => {
        expect(isTrailerShortcut(key({}))).toBe(true);
        expect(isTrailerShortcut(key({ key: 'T' }))).toBe(true);
    });

    it('leaves browser/OS shortcuts, auto-repeat and handled presses alone', () => {
        expect(isTrailerShortcut(key({ metaKey: true }))).toBe(false);
        expect(isTrailerShortcut(key({ ctrlKey: true }))).toBe(false);
        expect(isTrailerShortcut(key({ altKey: true }))).toBe(false);
        expect(isTrailerShortcut(key({ repeat: true }))).toBe(false);
        expect(isTrailerShortcut(key({ defaultPrevented: true }))).toBe(false);
        expect(isTrailerShortcut(key({ key: 'r' }))).toBe(false);
    });
});

describe('buildPluginDetailItem', () => {
    const input = {
        internalId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        mediaType: 'MOVIE',
        title: 'Haze',
        year: '1995',
        externalIds: { tmdb: 949, imdb: 'tt0113277', tvdb: undefined },
    };

    it('tolerates a missing media type', () => {
        expect(buildPluginDetailItem({ ...input, mediaType: undefined })?.mediaType).toBe('');
    });

    it('is null without an internal id', () => {
        expect(buildPluginDetailItem({ ...input, internalId: undefined })).toBeNull();
    });

    it('hands plugins the public media type vocabulary of forMediaTypes', () => {
        expect(buildPluginDetailItem(input)?.mediaType).toBe('movie');
        expect(buildPluginDetailItem({ ...input, mediaType: 'TV' })?.mediaType).toBe('series');
        expect(buildPluginDetailItem({ ...input, mediaType: 'EPISODE' })?.mediaType).toBe(
            'episode',
        );
    });

    it('coerces year and ids', () => {
        expect(buildPluginDetailItem(input)).toEqual({
            id: input.internalId,
            mediaType: 'movie',
            title: 'Haze',
            year: 1995,
            externalIds: { tmdb: '949', imdb: 'tt0113277', tvdb: undefined },
        });
        expect(buildPluginDetailItem({ ...input, year: 'n/a' })?.year).toBeNull();
    });
});

describe('chapterWatchPath', () => {
    it('matches the navigateToWatch URL shape and floors the start', () => {
        expect(chapterWatchPath('tmdb:550:movie', 61.8)).toBe('/watch/tmdb:550:movie?t=61');
        expect(chapterWatchPath('a3f5e8c7-uuid', -3)).toBe('/watch/a3f5e8c7-uuid?t=0');
    });
});

describe('isPlainLeftClick', () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

    it('is true only for an unmodified primary click', () => {
        expect(isPlainLeftClick(click)).toBe(true);
        expect(isPlainLeftClick({ ...click, metaKey: true })).toBe(false);
        expect(isPlainLeftClick({ ...click, ctrlKey: true })).toBe(false);
        expect(isPlainLeftClick({ ...click, shiftKey: true })).toBe(false);
        expect(isPlainLeftClick({ ...click, button: 1 })).toBe(false);
    });
});
