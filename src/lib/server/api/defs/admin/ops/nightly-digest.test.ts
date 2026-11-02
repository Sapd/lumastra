// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parseWindowHours, windowCoversWholeInstall } from './nightly-digest.js';

describe('windowCoversWholeInstall', () => {
    const since = new Date('2026-09-27T00:00:00Z');

    it('is true when the first run started inside the window (young install)', () => {
        expect(windowCoversWholeInstall(new Date('2026-09-27T11:35:00Z'), since)).toBe(true);
    });

    it('is false when runs predate the window', () => {
        expect(windowCoversWholeInstall(new Date('2026-09-20T00:00:00Z'), since)).toBe(false);
    });

    it('is false with no runs at all', () => {
        expect(windowCoversWholeInstall(null, since)).toBe(false);
    });
});

describe('parseWindowHours', () => {
    it('defaults to 12 hours when no value is given', () => {
        expect(parseWindowHours(null)).toBe(12);
    });

    it('accepts an in-range value', () => {
        expect(parseWindowHours('6')).toBe(6);
    });

    it('clamps below the 1-hour floor', () => {
        expect(parseWindowHours('0')).toBe(1);
        expect(parseWindowHours('-5')).toBe(1);
    });

    it('clamps above the 48-hour ceiling', () => {
        expect(parseWindowHours('1000')).toBe(48);
    });

    it('falls back to the default on garbage input', () => {
        expect(parseWindowHours('not-a-number')).toBe(12);
    });
});
