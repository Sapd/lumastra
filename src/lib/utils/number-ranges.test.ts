// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatNumberRanges } from './number-ranges';

describe('formatNumberRanges', () => {
    it('compresses consecutive runs', () => {
        expect(formatNumberRanges([1, 2, 3, 5, 7, 8])).toBe('1–3, 5, 7–8');
        expect(formatNumberRanges([4])).toBe('4');
        expect(formatNumberRanges([])).toBe('');
    });

    it('sorts and dedupes its input', () => {
        expect(formatNumberRanges([3, 1, 2, 2, 9])).toBe('1–3, 9');
    });

    it('applies the formatter to each bound', () => {
        expect(formatNumberRanges([15, 16, 17], (n) => `E${n}`)).toBe('E15–E17');
    });
});
