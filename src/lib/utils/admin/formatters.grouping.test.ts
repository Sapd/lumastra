// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Counts render grouped — "9,226 items", not "9226 items".
 *
 * These are the most-read numbers on the admin status lines, and preprod was
 * showing "Pending : 9226 items" and "1428 runs". An ungrouped five-digit
 * figure is harder to read at a glance, which is the entire job of a status
 * line.
 *
 * The load-bearing subtlety: the plural messages interpolate the SAME value
 * they select the plural from, so the grouped STRING has to survive
 * `Intl.PluralRules.select()`. It does — a separator only appears at >= 1000,
 * which is `other` in both locales, and "1" coerces to 1 — but that is an
 * accident of coercion rather than a designed contract, so both ends are
 * pinned here.
 */

import { describe, it, expect } from 'vitest';
import { formatCount } from './formatters.js';

describe('formatCount grouping', () => {
    it('groups thousands', () => {
        expect(formatCount(9226, 'items')).toContain('9,226');
        expect(formatCount(1428, 'runs')).toContain('1,428');
    });

    it('still picks the SINGULAR for exactly one', () => {
        // The coercion case: "1" must reach Intl.PluralRules as one.
        const one = formatCount(1, 'items');
        expect(one).toContain('1');
        expect(one.endsWith('items')).toBe(false);
    });

    it('picks the plural for a grouped value', () => {
        expect(formatCount(9226, 'items').endsWith('items')).toBe(true);
    });

    it('leaves small counts untouched', () => {
        expect(formatCount(0, 'runs')).toContain('0');
        expect(formatCount(42, 'tasks')).toContain('42');
        expect(formatCount(42, 'tasks')).not.toContain(',');
    });

    it('keeps the window suffix', () => {
        expect(formatCount(3098, 'runs', { hours: 12 })).toContain('3,098');
        expect(formatCount(3098, 'runs', { hours: 12 })).toContain('·');
    });
});
