// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { LiveTvCategory, LiveTvStation } from '$lib/schemas/livetv.js';
import { buildGenreChips, filterByGenre, genreSlug } from './livetv-genres';

const cat = (id: string, name: string, sortOrder: number): LiveTvCategory => ({
    id,
    name,
    sortOrder,
    isVisible: true,
});
const ch = (id: string, categoryId?: string): LiveTvStation =>
    ({ id, feedId: id, name: id, categoryId, images: {} }) as LiveTvStation;

const categories = [
    cat('s', 'Sports', 1),
    cat('n', 'News', 0),
    cat('e', 'Live Events', 2),
    cat('x', 'Empty', 3),
];
const channels = [ch('a', 's'), ch('b', 's'), ch('c', 'n'), ch('d', 'e'), ch('z')];

describe('genreSlug', () => {
    it('makes URL-safe slugs', () => {
        expect(genreSlug('Live Events')).toBe('live-events');
        expect(genreSlug('24/7')).toBe('24-7');
        expect(genreSlug('Dokumentation Ü')).toBe('dokumentation-u');
        expect(genreSlug('Детские')).toBe('детские');
    });
});

describe('buildGenreChips', () => {
    it('lists categories with channels, in category order, with counts', () => {
        expect(buildGenreChips(channels, categories)).toEqual([
            { slug: 'news', name: 'News', count: 1 },
            { slug: 'sports', name: 'Sports', count: 2 },
            { slug: 'live-events', name: 'Live Events', count: 1 },
        ]);
    });
});

describe('buildGenreChips with names that slug alike', () => {
    it('merges them into one chip and filters them together', () => {
        const cats = [cat('a', 'Orb', 0), cat('b', 'ORB', 1)];
        const chans = [ch('1', 'a'), ch('2', 'b'), ch('3', 'b')];
        expect(buildGenreChips(chans, cats)).toEqual([{ slug: 'orb', name: 'Orb', count: 3 }]);
        expect(filterByGenre(chans, cats, 'orb').channels).toHaveLength(3);
    });
});

describe('filterByGenre', () => {
    it('narrows to one category', () => {
        const r = filterByGenre(channels, categories, 'sports');
        expect(r.active).toBe(true);
        expect(r.channels.map((c) => c.id)).toEqual(['a', 'b']);
        expect(r.categories.map((c) => c.id)).toEqual(['s']);
    });

    it('returns everything for no or an unknown slug', () => {
        expect(filterByGenre(channels, categories, null)).toMatchObject({
            active: false,
            channels,
        });
        expect(filterByGenre(channels, categories, 'gone')).toMatchObject({
            active: false,
            channels,
        });
    });
});

describe('chip logos', () => {
    it('takes only same-origin proxy paths, never a provider URL', () => {
        const cats = [cat('a', 'A', 0), cat('b', 'B', 1)];
        const chans = [
            {
                id: '1',
                feedId: '1',
                name: '1',
                categoryId: 'a',
                images: {
                    primary: { href: 'https://cdn.example/x.png', revision: '0', source: 'self' },
                },
            },
            {
                id: '2',
                feedId: '2',
                name: '2',
                categoryId: 'a',
                images: { primary: { href: '//cdn.example/y.png', revision: '0', source: 'self' } },
            },
            {
                id: '3',
                feedId: '3',
                name: '3',
                categoryId: 'b',
                images: {
                    primary: {
                        href: '/api/media/3/images/poster?size=thumb',
                        revision: '0',
                        source: 'self',
                    },
                },
            },
        ] as LiveTvStation[];
        const chips = buildGenreChips(chans, cats);
        expect(chips.find((c) => c.slug === 'a')?.imageUrl).toBeUndefined();
        expect(chips.find((c) => c.slug === 'b')?.imageUrl).toBe(
            '/api/media/3/images/poster?size=thumb',
        );
    });
});
