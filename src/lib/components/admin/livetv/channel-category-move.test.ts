// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';
import { orderCategoriesByIds, planCategoryMove } from './channel-reconcile.js';

const cat = (id: string, channels: string[] = []): AdminChannelCategory => ({
    id,
    name: id,
    sortOrder: 0,
    isVisible: true,
    channels: channels.map((c) => ({ id: c, name: c, isVisible: true }) as AdminChannel),
});
const ids = (cats: AdminChannelCategory[]): string[] => cats.map((c) => c.id);
const cats = [cat('news', ['n1', 'n2']), cat('sport', ['s1']), cat('kids'), cat('music')];

describe('planCategoryMove', () => {
    it('moves one place up or down', () => {
        expect(ids(planCategoryMove(cats, 'kids', 'up'))).toEqual([
            'news',
            'kids',
            'sport',
            'music',
        ]);
        expect(ids(planCategoryMove(cats, 'news', 'down'))).toEqual([
            'sport',
            'news',
            'kids',
            'music',
        ]);
    });

    it('moves to the top or the bottom', () => {
        expect(ids(planCategoryMove(cats, 'music', 'top'))).toEqual([
            'music',
            'news',
            'sport',
            'kids',
        ]);
        expect(ids(planCategoryMove(cats, 'news', 'bottom'))).toEqual([
            'sport',
            'kids',
            'music',
            'news',
        ]);
    });

    it('returns the same array when nothing moves', () => {
        expect(planCategoryMove(cats, 'news', 'up')).toBe(cats);
        expect(planCategoryMove(cats, 'music', 'bottom')).toBe(cats);
        expect(planCategoryMove(cats, 'nope', 'top')).toBe(cats);
    });

    it('keeps every channel with its category', () => {
        const moved = planCategoryMove(cats, 'news', 'bottom');
        expect(moved.find((c) => c.id === 'news')?.channels.map((c) => c.id)).toEqual(['n1', 'n2']);
    });
});

describe('orderCategoriesByIds', () => {
    it('follows the given order and keeps unlisted categories after it', () => {
        expect(ids(orderCategoriesByIds(cats, ['kids', 'news']))).toEqual([
            'kids',
            'news',
            'sport',
            'music',
        ]);
    });

    it('ignores unknown ids', () => {
        expect(ids(orderCategoriesByIds(cats, ['x', 'music']))).toEqual([
            'music',
            'news',
            'sport',
            'kids',
        ]);
    });
});
