// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { firstFeaturedPickVideoItem, isFeaturedPickVideoItem } from './featured-pick-eligibility';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';

function item(id: string, mediaType: string): UniversalMediaItem {
    return { id, mediaType, title: id } as UniversalMediaItem;
}

describe('isFeaturedPickVideoItem', () => {
    for (const mediaType of ['movie', 'series', 'tv', 'episode']) {
        it(`allows video mediaType='${mediaType}'`, () => {
            expect(isFeaturedPickVideoItem({ mediaType })).toBe(true);
        });
    }

    for (const mediaType of ['audiobook', 'AudioBook', 'track', 'album', 'artist', 'tvchannel']) {
        it(`refuses non-video mediaType='${mediaType}'`, () => {
            expect(isFeaturedPickVideoItem({ mediaType })).toBe(false);
        });
    }
});

describe('firstFeaturedPickVideoItem', () => {
    it('returns null when a future strategy sends only an audiobook', () => {
        expect(firstFeaturedPickVideoItem([item('book', 'audiobook')])).toBeNull();
    });

    it('skips non-video rows and keeps the first video row', () => {
        expect(
            firstFeaturedPickVideoItem([
                item('book', 'audiobook'),
                item('movie', 'movie'),
                item('series', 'series'),
            ])?.id,
        ).toBe('movie');
    });
});
