// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';
import {
    reconcileCategoryChannels,
    planGroupMove,
    planMoveToCategory,
    planMoveToOwnEdge,
    changedChannelUpdates,
    withFullChannels,
    withHiddenFollowers,
} from './channel-reconcile.js';

function ch(id: string, name: string, categoryId?: string): AdminChannel {
    return { id, name, isVisible: true, categoryId } as AdminChannel;
}

function cat(id: string, channels: AdminChannel[]): AdminChannelCategory {
    return { id, name: id, sortOrder: 0, isVisible: true, channels };
}

const ids = (channels: AdminChannel[]): string[] => channels.map((c) => c.id);
const catIds = (categories: AdminChannelCategory[], id: string): string[] =>
    ids(categories.find((c) => c.id === id)?.channels ?? []);

describe('reconcileCategoryChannels', () => {
    describe('unfiltered (query = "")', () => {
        it('replaces the full list with the reordered payload', () => {
            const full = [ch('a', 'A'), ch('b', 'B'), ch('c', 'C')];
            const payload = [ch('c', 'C'), ch('a', 'A'), ch('b', 'B')];
            expect(ids(reconcileCategoryChannels(full, payload, ''))).toEqual(['c', 'a', 'b']);
        });

        it('adds a channel dragged in from another category', () => {
            const full = [ch('a', 'A'), ch('b', 'B')];
            const payload = [ch('a', 'A'), ch('x', 'X'), ch('b', 'B')]; // x dragged in
            expect(ids(reconcileCategoryChannels(full, payload, ''))).toEqual(['a', 'x', 'b']);
        });

        it('removes a channel dragged out (absent from payload)', () => {
            const full = [ch('a', 'A'), ch('b', 'B'), ch('c', 'C')];
            const payload = [ch('a', 'A'), ch('c', 'C')]; // b dragged out
            expect(ids(reconcileCategoryChannels(full, payload, ''))).toEqual(['a', 'c']);
        });

        it('dedupes by id, keeping the first occurrence', () => {
            const full = [ch('a', 'A')];
            const payload = [ch('a', 'A'), ch('a', 'A')];
            expect(ids(reconcileCategoryChannels(full, payload, ''))).toEqual(['a']);
        });
    });

    describe('filtered (some channels hidden by the pane search)', () => {
        // full: sport-1, news-1(hidden when query="sport"), sport-2, news-2(hidden), sport-3
        const full = [
            ch('s1', 'Sport One'),
            ch('n1', 'News One'),
            ch('s2', 'Sport Two'),
            ch('n2', 'News Two'),
            ch('s3', 'Sport Three'),
        ];

        it('preserves hidden channels while reordering visible ones', () => {
            // Visible (sport) reordered: s3, s1, s2. Hidden n1 anchored after s1, n2 after s2.
            const payload = [ch('s3', 'Sport Three'), ch('s1', 'Sport One'), ch('s2', 'Sport Two')];
            // n1 was preceded by s1 → follows s1; n2 preceded by s2 → follows s2.
            expect(ids(reconcileCategoryChannels(full, payload, 'sport'))).toEqual([
                's3',
                's1',
                'n1',
                's2',
                'n2',
            ]);
        });

        it('keeps hidden channels when a visible channel is dragged out', () => {
            const payload = [ch('s1', 'Sport One'), ch('s3', 'Sport Three')]; // s2 dragged out
            // n1 anchored after s1; n2 anchored after s2 (gone) → falls to front.
            const result = ids(reconcileCategoryChannels(full, payload, 'sport'));
            expect(result).toContain('n1');
            expect(result).toContain('n2');
            expect(result).not.toContain('s2');
            // n1 still trails s1
            expect(result.indexOf('n1')).toBe(result.indexOf('s1') + 1);
        });

        it('inserts a channel dragged in next to its visible drop neighbor, keeping hidden ones', () => {
            const payload = [
                ch('s1', 'Sport One'),
                ch('x', 'Sport X'), // dragged in
                ch('s2', 'Sport Two'),
                ch('s3', 'Sport Three'),
            ];
            const result = ids(reconcileCategoryChannels(full, payload, 'sport'));
            expect(result).toEqual(['s1', 'n1', 'x', 's2', 'n2', 's3']);
        });

        it('keeps a leading hidden channel at the front', () => {
            const fullLeadingHidden = [ch('n0', 'News Zero'), ch('s1', 'Sport One')];
            const payload = [ch('s1', 'Sport One')];
            expect(ids(reconcileCategoryChannels(fullLeadingHidden, payload, 'sport'))).toEqual([
                'n0',
                's1',
            ]);
        });
    });
});

describe('planGroupMove', () => {
    it('moves a group between categories, inserting as a block at the leader drop slot', () => {
        const categories = [
            cat('sports', [ch('a', 'A', 'sports'), ch('b', 'B', 'sports'), ch('c', 'C', 'sports')]),
            cat('news', [ch('x', 'X', 'news'), ch('y', 'Y', 'news')]),
        ];
        // Group {a, c} (leader a) dropped between x and y in news.
        const result = planGroupMove(
            categories,
            ['a', 'c'],
            'a',
            'news',
            [ch('x', 'X', 'news'), ch('a', 'A', 'sports'), ch('y', 'Y', 'news')],
            '',
            'uncategorized',
        );
        expect(catIds(result, 'sports')).toEqual(['b']);
        expect(catIds(result, 'news')).toEqual(['x', 'a', 'c', 'y']);
        // Moved channels are restamped to the destination category.
        const moved = result.find((c) => c.id === 'news')?.channels.find((c) => c.id === 'a');
        expect(moved?.categoryId).toBe('news');
    });

    it('moves a SINGLE channel within its category (cross-pane same-category drop)', () => {
        // Regression: in split view with the same category shown in both panes, dragging a
        // channel across panes is committed once on the landing zone as a group-of-one. The
        // channel must survive (it previously vanished when the source zone clobbered it).
        const categories = [cat('x', [ch('a', 'A', 'x'), ch('b', 'B', 'x'), ch('c', 'C', 'x')])];
        // 'b' dropped at the front of the destination pane's view.
        const result = planGroupMove(
            categories,
            ['b'],
            'b',
            'x',
            [ch('b', 'B', 'x'), ch('a', 'A', 'x'), ch('c', 'C', 'x')],
            '',
            'uncategorized',
        );
        expect(catIds(result, 'x')).toEqual(['b', 'a', 'c']);
    });

    it('reorders a group within the same category', () => {
        const categories = [
            cat('sports', [ch('a', 'A', 'sports'), ch('b', 'B', 'sports'), ch('c', 'C', 'sports')]),
        ];
        // Group {a, b} (leader a) dropped after c.
        const result = planGroupMove(
            categories,
            ['a', 'b'],
            'a',
            'sports',
            [ch('c', 'C', 'sports'), ch('a', 'A', 'sports')],
            '',
            'uncategorized',
        );
        expect(catIds(result, 'sports')).toEqual(['c', 'a', 'b']);
    });

    it('gathers a group spanning multiple source categories', () => {
        const categories = [
            cat('sports', [ch('a', 'A', 'sports'), ch('b', 'B', 'sports')]),
            cat('news', [ch('x', 'X', 'news')]),
            cat('movies', [ch('m', 'M', 'movies')]),
        ];
        // Group {a (sports), x (news)} (leader a) → movies.
        const result = planGroupMove(
            categories,
            ['a', 'x'],
            'a',
            'movies',
            [ch('m', 'M', 'movies'), ch('a', 'A', 'sports')],
            '',
            'uncategorized',
        );
        expect(catIds(result, 'sports')).toEqual(['b']);
        expect(catIds(result, 'news')).toEqual([]);
        expect(catIds(result, 'movies')).toEqual(['m', 'a', 'x']);
    });

    it('moves a group to uncategorized (categoryId becomes undefined)', () => {
        const categories = [
            cat('sports', [ch('a', 'A', 'sports'), ch('b', 'B', 'sports')]),
            cat('uncategorized', [ch('u', 'U')]),
        ];
        const result = planGroupMove(
            categories,
            ['a', 'b'],
            'a',
            'uncategorized',
            [ch('u', 'U'), ch('a', 'A', 'sports')],
            '',
            'uncategorized',
        );
        expect(catIds(result, 'sports')).toEqual([]);
        expect(catIds(result, 'uncategorized')).toEqual(['u', 'a', 'b']);
        const moved = result
            .find((c) => c.id === 'uncategorized')
            ?.channels.find((c) => c.id === 'a');
        expect(moved?.categoryId).toBeUndefined();
    });

    it('preserves hidden channels in a filtered destination', () => {
        const categories = [
            cat('sports', [ch('a', 'Sport A', 'sports')]),
            cat('news', [ch('n1', 'News One', 'news'), ch('s9', 'Sport Nine', 'news')]),
        ];
        // News pane filtered to "sport" shows only s9; drop group {a} before s9.
        const result = planGroupMove(
            categories,
            ['a'],
            'a',
            'news',
            [ch('a', 'Sport A', 'sports'), ch('s9', 'Sport Nine', 'news')],
            'sport',
            'uncategorized',
        );
        // Hidden n1 stays; a inserted; s9 kept.
        expect(catIds(result, 'news')).toEqual(['n1', 'a', 's9']);
        expect(catIds(result, 'sports')).toEqual([]);
    });
});

describe('planMoveToCategory', () => {
    it('appends moved channels at the bottom of the destination, restamping categoryId', () => {
        const categories = [
            cat('sports', [ch('a', 'A', 'sports'), ch('b', 'B', 'sports')]),
            cat('news', [ch('x', 'X', 'news')]),
        ];
        const result = planMoveToCategory(categories, ['a'], 'news', 'bottom', 'uncategorized');
        expect(catIds(result, 'sports')).toEqual(['b']);
        expect(catIds(result, 'news')).toEqual(['x', 'a']);
        expect(result.find((c) => c.id === 'news')?.channels.at(-1)?.categoryId).toBe('news');
    });

    it('inserts at the top when position is "top"', () => {
        const categories = [
            cat('sports', [ch('a', 'A', 'sports')]),
            cat('news', [ch('x', 'X', 'news')]),
        ];
        const result = planMoveToCategory(categories, ['a'], 'news', 'top', 'uncategorized');
        expect(catIds(result, 'news')).toEqual(['a', 'x']);
    });
});

describe('planMoveToOwnEdge', () => {
    it('moves selected channels to the top of their OWN categories (no category change)', () => {
        const categories = [
            cat('sports', [ch('a', 'A', 'sports'), ch('b', 'B', 'sports'), ch('c', 'C', 'sports')]),
            cat('news', [ch('x', 'X', 'news'), ch('y', 'Y', 'news')]),
        ];
        // Select c (sports) and y (news); move to top — each goes to the top of its own category.
        const result = planMoveToOwnEdge(categories, ['c', 'y'], 'top');
        expect(catIds(result, 'sports')).toEqual(['c', 'a', 'b']);
        expect(catIds(result, 'news')).toEqual(['y', 'x']);
        // categoryId is unchanged.
        expect(result.find((c) => c.id === 'sports')?.channels[0].categoryId).toBe('sports');
    });

    it('moves selected channels to the bottom, preserving their relative order', () => {
        const categories = [
            cat('sports', [ch('a', 'A', 'sports'), ch('b', 'B', 'sports'), ch('c', 'C', 'sports')]),
        ];
        const result = planMoveToOwnEdge(categories, ['a', 'b'], 'bottom');
        expect(catIds(result, 'sports')).toEqual(['c', 'a', 'b']);
    });

    it('leaves categories without selected channels untouched (same reference)', () => {
        const newsChannels = [ch('x', 'X', 'news')];
        const categories = [cat('sports', [ch('a', 'A', 'sports')]), cat('news', newsChannels)];
        const result = planMoveToOwnEdge(categories, ['a'], 'top');
        expect(result.find((c) => c.id === 'news')?.channels).toBe(newsChannels);
    });
});

describe('hidden channels left out of the pane', () => {
    const hidden = (id: string, name: string): AdminChannel =>
        ({ id, name, isVisible: false }) as AdminChannel;
    const filter = { query: '', hideHidden: true };

    it('moves a hidden feed along with the visible channel before it', () => {
        // Premiere, Premiere² (hidden), Action, Action² (hidden): drag Action to the top.
        const full = [
            ch('p', 'Premiere HDraw'),
            hidden('p2', 'Premiere HDraw²'),
            ch('a', 'Action HDraw'),
            hidden('a2', 'Action HDraw²'),
        ];
        const payload = [ch('a', 'Action HDraw'), ch('p', 'Premiere HDraw')];
        expect(ids(reconcileCategoryChannels(full, payload, filter))).toEqual([
            'a',
            'a2',
            'p',
            'p2',
        ]);
    });

    it('with a plain search a hidden channel is in view, so leaving it out moves it out', () => {
        const full = [ch('p', 'Premiere'), hidden('p2', 'Premiere²')];
        expect(ids(reconcileCategoryChannels(full, [ch('p', 'Premiere')], 'premiere'))).toEqual([
            'p',
        ]);
    });
});

describe('changedChannelUpdates', () => {
    // A baseline as loaded: stored sortOrder equals the list position.
    const at = (c: AdminChannel, sortOrder: number): AdminChannel => ({ ...c, sortOrder });

    it('sends only channels whose position or category changed', () => {
        const before = [
            cat('a', [at(ch('1', 'One'), 0), at(ch('2', 'Two'), 1), at(ch('3', 'Three'), 2)]),
            cat('b', [at(ch('4', 'Four'), 0)]),
        ];
        const after = [
            cat('a', [ch('2', 'Two'), ch('1', 'One'), ch('3', 'Three')]),
            cat('b', [ch('4', 'Four')]),
        ];
        expect(changedChannelUpdates(before, after, 'uncategorized')).toEqual([
            { id: '2', sortOrder: 0, categoryId: 'a' },
            { id: '1', sortOrder: 1, categoryId: 'a' },
        ]);
    });

    it('also sends a channel that stayed put when its stored sortOrder differs (gapped import)', () => {
        const before = [
            cat('a', [at(ch('1', 'One'), 0), at(ch('2', 'Two'), 5), at(ch('3', 'Three'), 9)]),
        ];
        const after = [cat('a', [ch('1', 'One'), ch('3', 'Three'), ch('2', 'Two')])];
        expect(changedChannelUpdates(before, after, 'uncategorized')).toEqual([
            { id: '3', sortOrder: 1, categoryId: 'a' },
            { id: '2', sortOrder: 2, categoryId: 'a' },
        ]);
        // '1' kept index 0 with stored sortOrder 0: not sent. A gapped row that kept
        // its index is sent so the stored order matches the list again.
        const gapped = [cat('a', [at(ch('1', 'One'), 3), at(ch('2', 'Two'), 5)])];
        expect(changedChannelUpdates(gapped, gapped, 'uncategorized')).toEqual([
            { id: '1', sortOrder: 0, categoryId: 'a' },
            { id: '2', sortOrder: 1, categoryId: 'a' },
        ]);
    });

    it('sends everything without a baseline and maps uncategorized to null', () => {
        const after = [cat('uncategorized', [ch('1', 'One')])];
        expect(changedChannelUpdates(null, after, 'uncategorized')).toEqual([
            { id: '1', sortOrder: 0, categoryId: null },
        ]);
    });
});

describe('withFullChannels', () => {
    it('keeps the full channel lists of reordered (filtered) categories', () => {
        const full = [cat('a', [ch('1', 'One'), ch('2', 'Two')]), cat('b', [ch('3', 'Three')])];
        const filtered = [cat('b', []), cat('a', [ch('1', 'One')])];
        const result = withFullChannels(full, filtered);
        expect(result.map((c) => c.id)).toEqual(['b', 'a']);
        expect(catIds(result, 'a')).toEqual(['1', '2']);
    });
});

describe('withHiddenFollowers', () => {
    const hidden = (id: string): AdminChannel =>
        ({ id, name: id, isVisible: false }) as AdminChannel;
    const categories = [
        cat('a', [ch('p', 'P'), hidden('p2'), hidden('p3'), ch('q', 'Q'), hidden('q2')]),
        cat('b', [ch('r', 'R'), ch('s', 'S'), hidden('s2')]),
    ];

    it('adds the hidden channels right after each id, in list order', () => {
        expect(withHiddenFollowers(categories, ['s', 'p'])).toEqual(['s', 's2', 'p', 'p2', 'p3']);
    });

    it('stops at the next visible channel and leaves ids without followers alone', () => {
        expect(withHiddenFollowers(categories, ['r'])).toEqual(['r']);
        expect(withHiddenFollowers(categories, ['q'])).toEqual(['q', 'q2']);
    });

    it('never lists a channel twice when a hidden one is selected itself', () => {
        // p2 is an id of its own (and p3 follows it), not a follower of p.
        expect(withHiddenFollowers(categories, ['p', 'p2'])).toEqual(['p', 'p2', 'p3']);
    });
});
