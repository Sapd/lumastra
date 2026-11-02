// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parsePersonHandle, formatPersonHandle } from './person-handle.js';

describe('person handles', () => {
    it.each(['123', '0123', 'tmdb:123', 'tmdb:00123'])('canonicalises %s', (raw) => {
        expect(parsePersonHandle(raw)).toEqual({ ok: true, handle: 'tmdb:123', numericId: 123 });
    });
    it.each(['123junk', 'other:123', '0', '-1', '', 'tmdb:', 'tmdb:0', '1.5', '+1',
        ' 123', '123 ', 'tmdb:123:movie', '1e2', '9007199254740992'])('rejects %s', (raw) => {
        expect(parsePersonHandle(raw)).toEqual({ ok: false });
    });
    it('uses the configured primary provider', () => {
        expect(parsePersonHandle('0123', 'other')).toEqual({ ok: true, handle: 'other:123', numericId: 123 });
        expect(parsePersonHandle('other:123', 'other').ok).toBe(true);
        expect(parsePersonHandle('tmdb:123', 'other').ok).toBe(false);
    });
    it('formats only positive safe integers', () => {
        expect(formatPersonHandle(123)).toBe('tmdb:123');
        for (const n of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => formatPersonHandle(n)).toThrow(RangeError);
        }
    });
});
