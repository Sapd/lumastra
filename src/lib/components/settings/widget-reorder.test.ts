// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { moveUp, moveDown } from './widget-reorder';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('widget-reorder', () => {
    test('moveUp swaps with the previous item', () => {
        expect(moveUp(items, 'b').map((i) => i.id)).toEqual(['b', 'a', 'c']);
    });

    test('moveUp at the top is a no-op (new array)', () => {
        const out = moveUp(items, 'a');
        expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c']);
        expect(out).not.toBe(items);
    });

    test('moveDown swaps with the next item', () => {
        expect(moveDown(items, 'b').map((i) => i.id)).toEqual(['a', 'c', 'b']);
    });

    test('moveDown at the bottom is a no-op', () => {
        expect(moveDown(items, 'c').map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    test('unknown id returns an unchanged copy', () => {
        expect(moveUp(items, 'zzz').map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });
});
