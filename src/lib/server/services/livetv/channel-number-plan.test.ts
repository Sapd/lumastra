// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    categoryBlock,
    nextFreeNumber,
    overflowingCategories,
    planChannelNumbers,
    planRenumber,
    type NumberCard,
    type NumberCategory,
    type NumberRow,
} from './channel-number-plan.js';

function card(
    key: string,
    categoryId: string | null,
    sortOrder: number,
    group = false,
): NumberCard {
    return {
        key,
        backupGroupId: group ? key : null,
        channelId: group ? `${key}-feed` : key,
        categoryId,
        sortOrder,
        name: key,
    };
}

function row(number: number, owner: string, extra: Partial<NumberRow> = {}): NumberRow {
    return {
        number,
        backupGroupId: null,
        channelId: owner,
        channelGroupId: null,
        pinned: false,
        ownerAlive: true,
        ...extra,
    };
}

const news: NumberCategory = { id: 'news', name: 'News', sortOrder: 0, numberStart: null };
const sport: NumberCategory = { id: 'sport', name: 'Sport', sortOrder: 1, numberStart: null };

describe('planChannelNumbers', () => {
    it('numbers a fresh lineup 1..N in display order (category order, then sort order)', () => {
        const plan = planChannelNumbers({
            cards: [card('arena', 'sport', 0), card('daily', 'news', 1), card('herald', 'news', 0)],
            rows: [],
            categories: [sport, news].map((c) => ({ ...c })),
            keepHidden: false,
        });
        expect(Object.fromEntries(plan.numbers)).toEqual({ herald: 1, daily: 2, arena: 3 });
        expect(plan.deletes).toEqual([]);
    });

    it('keeps numbers when channels or categories are reordered', () => {
        const plan = planChannelNumbers({
            // Sport now sorts first and the news channels swapped places.
            cards: [card('arena', 'sport', 0), card('herald', 'news', 1), card('daily', 'news', 0)],
            rows: [row(1, 'herald'), row(2, 'daily'), row(3, 'arena')],
            categories: [
                { ...sport, sortOrder: 0 },
                { ...news, sortOrder: 1 },
            ],
            keepHidden: false,
        });
        expect(Object.fromEntries(plan.numbers)).toEqual({ herald: 1, daily: 2, arena: 3 });
        expect(plan.inserts).toEqual([]);
        expect(plan.deletes).toEqual([]);
    });

    it('gives a new channel the number after the highest one, not a freed gap', () => {
        const plan = planChannelNumbers({
            cards: [card('herald', 'news', 0), card('arena', 'sport', 0), card('fresh', 'news', 5)],
            rows: [row(1, 'herald'), row(3, 'arena')],
            categories: [news, sport],
            keepHidden: false,
        });
        expect(plan.numbers.get('fresh')).toBe(4);
    });

    it('frees the number of a hidden channel by default and keeps it with keepHidden', () => {
        const input = {
            cards: [card('herald', 'news', 0)],
            rows: [row(1, 'herald'), row(2, 'quiet')],
            categories: [news],
        };
        expect(planChannelNumbers({ ...input, keepHidden: false }).deletes).toEqual([2]);
        expect(planChannelNumbers({ ...input, keepHidden: true }).deletes).toEqual([]);
    });

    it('never frees a pinned number of a hidden channel', () => {
        const plan = planChannelNumbers({
            cards: [],
            rows: [row(7, 'quiet', { pinned: true })],
            categories: [news],
            keepHidden: false,
        });
        expect(plan.deletes).toEqual([]);
    });

    it('frees the number of a channel that no longer exists, pinned or not', () => {
        const plan = planChannelNumbers({
            cards: [],
            rows: [
                row(4, 'gone', { ownerAlive: false, pinned: true }),
                row(5, 'x', { channelId: null, backupGroupId: null }),
            ],
            categories: [news],
            keepHidden: true,
        });
        expect(plan.deletes.sort()).toEqual([4, 5]);
    });

    it('a station whose two numbered channels became one group keeps the pinned, else the lowest', () => {
        const merged = card('station', 'news', 0, true);
        const lowest = planChannelNumbers({
            cards: [merged],
            rows: [
                row(9, 'feed-a', { channelGroupId: 'station' }),
                row(4, 'feed-b', { channelGroupId: 'station' }),
            ],
            categories: [news],
            keepHidden: false,
        });
        expect(lowest.numbers.get('station')).toBe(4);
        expect(lowest.deletes).toEqual([9]);
        // The kept row now names the group, so it survives that feed leaving.
        expect(lowest.claims).toEqual([{ number: 4, backupGroupId: 'station' }]);

        const pinned = planChannelNumbers({
            cards: [merged],
            rows: [
                row(9, 'feed-a', { channelGroupId: 'station', pinned: true }),
                row(4, 'feed-b', { channelGroupId: 'station' }),
            ],
            categories: [news],
            keepHidden: false,
        });
        expect(pinned.numbers.get('station')).toBe(9);
    });

    it('a dissolved group leaves the number with the feed it recorded', () => {
        const plan = planChannelNumbers({
            cards: [card('feed-a', 'news', 0)],
            // The group was deleted (FK nulled), the feed id is still there.
            rows: [row(6, 'feed-a', { backupGroupId: null })],
            categories: [news],
            keepHidden: false,
        });
        expect(plan.numbers.get('feed-a')).toBe(6);
        expect(plan.inserts).toEqual([]);
    });

    it('numbers a new channel inside its category block, after the block’s highest', () => {
        const categories = [
            { ...news, numberStart: 100 },
            { ...sport, numberStart: 200 },
        ];
        const plan = planChannelNumbers({
            cards: [card('herald', 'news', 0), card('daily', 'news', 1), card('arena', 'sport', 0)],
            rows: [row(100, 'herald'), row(250, 'arena')],
            categories,
            keepHidden: false,
        });
        expect(plan.numbers.get('daily')).toBe(101);
    });

    it('a full block sends the channel after the highest number in use', () => {
        const categories = [
            { ...news, numberStart: 1 },
            { ...sport, numberStart: 3 },
        ];
        const plan = planChannelNumbers({
            cards: [
                card('herald', 'news', 0),
                card('daily', 'news', 1),
                card('extra', 'news', 2),
                card('arena', 'sport', 0),
            ],
            rows: [row(1, 'herald'), row(2, 'daily'), row(3, 'arena')],
            categories,
            keepHidden: false,
        });
        expect(plan.numbers.get('extra')).toBe(4);
        expect(
            overflowingCategories([card('extra', 'news', 2)], plan.numbers, categories).get('news'),
        ).toBe(1);
    });

    it('an admin pin at 9999 does not send new channels into freed gaps', () => {
        const plan = planChannelNumbers({
            cards: [card('herald', 'news', 0), card('fresh', 'news', 1)],
            rows: [row(1, 'herald'), row(9999, 'quiet', { pinned: true })],
            categories: [news],
            keepHidden: false,
        });
        expect(plan.numbers.get('fresh')).toBe(2);
    });

    it('leaves a card without a number when 1..9999 are all taken', () => {
        const rows = Array.from({ length: 9999 }, (_, i) => row(i + 1, `c${i + 1}`));
        const cards = rows.map((r) => card(r.channelId as string, 'news', r.number));
        const plan = planChannelNumbers({
            cards: [...cards, card('one-too-many', 'news', 10_000)],
            rows,
            categories: [news],
            keepHidden: false,
        });
        expect(plan.numbers.has('one-too-many')).toBe(false);
        expect(plan.inserts).toEqual([]);
    });
});

describe('planRenumber', () => {
    it('renumbers 1..N in current order and skips pinned numbers', () => {
        const plan = planRenumber({
            cards: [card('herald', 'news', 0), card('daily', 'news', 1), card('arena', 'sport', 0)],
            rows: [row(40, 'herald'), row(2, 'arena', { pinned: true }), row(77, 'quiet')],
            categories: [news, sport],
        });
        expect(Object.fromEntries(plan.numbers)).toEqual({ herald: 1, daily: 3, arena: 2 });
        // Unpinned numbers (including the hidden channel's) are given up.
        expect(plan.deletes.sort((a, b) => a - b)).toEqual([40, 77]);
    });

    it('starts each category at its "Numbers start at", others continue after the one before', () => {
        const kids: NumberCategory = { id: 'kids', name: 'Kids', sortOrder: 2, numberStart: null };
        const plan = planRenumber({
            cards: [
                card('herald', 'news', 0),
                card('arena', 'sport', 0),
                card('court', 'sport', 1),
                card('toons', 'kids', 0),
            ],
            rows: [],
            categories: [news, { ...sport, numberStart: 200 }, kids],
        });
        expect(Object.fromEntries(plan.numbers)).toEqual({
            herald: 1,
            arena: 200,
            court: 201,
            toons: 202,
        });
    });

    it('with keepHidden, a hidden channel keeps its number through a renumber', () => {
        const plan = planRenumber({
            cards: [card('herald', 'news', 0), card('daily', 'news', 1)],
            rows: [row(5, 'herald'), row(1, 'quiet')],
            categories: [news],
            keepHidden: true,
        });
        expect(plan.deletes).toEqual([5]);
        expect(Object.fromEntries(plan.numbers)).toEqual({ herald: 2, daily: 3 });
    });

    it('keeps a pinned number of a hidden channel', () => {
        const plan = planRenumber({
            cards: [card('herald', 'news', 0)],
            rows: [row(1, 'quiet', { pinned: true })],
            categories: [news],
        });
        expect(plan.deletes).toEqual([]);
        expect(plan.numbers.get('herald')).toBe(2);
    });
});

describe('helpers', () => {
    it('nextFreeNumber goes after the highest taken, then fills the lowest gap', () => {
        expect(nextFreeNumber(new Set([1, 2, 5]), 1, 9)).toBe(6);
        expect(nextFreeNumber(new Set([1, 9]), 1, 9)).toBe(2);
        expect(nextFreeNumber(new Set([1, 2]), 1, 2)).toBeNull();
    });

    it('categoryBlock ends before the next higher start', () => {
        const categories = [
            { ...news, numberStart: 100 },
            { ...sport, numberStart: 300 },
        ];
        expect(categoryBlock('news', categories)).toEqual({ from: 100, to: 299 });
        expect(categoryBlock('sport', categories)).toEqual({ from: 300, to: 9999 });
        expect(categoryBlock('other', categories)).toBeNull();
    });
});
