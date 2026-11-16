// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { downloadSeasonNumber } from './season-number';

describe('downloadSeasonNumber', () => {
    test('takes the first defined candidate when it is a non-negative integer', () => {
        expect(downloadSeasonNumber(undefined, 3)).toBe(3);
        expect(downloadSeasonNumber(2, 5)).toBe(2);
        expect(downloadSeasonNumber(0)).toBe(0);
    });
    test('anything else hides the button (no silent season 0)', () => {
        expect(downloadSeasonNumber()).toBeUndefined();
        expect(downloadSeasonNumber(undefined, undefined)).toBeUndefined();
        expect(downloadSeasonNumber(Number.NaN)).toBeUndefined();
        expect(downloadSeasonNumber(1.5)).toBeUndefined();
        expect(downloadSeasonNumber(-1)).toBeUndefined();
        expect(downloadSeasonNumber('2')).toBeUndefined();
    });
});
