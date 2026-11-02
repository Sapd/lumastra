// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { MAX_TAG_TEXT_LENGTH, clampTagText } from './tag-text.js';

describe('clampTagText', () => {
    it('leaves ordinary text, including double spaces, untouched', () => {
        expect(clampTagText('Moon  Tide & Co')).toBe('Moon  Tide & Co');
        expect(clampTagText('')).toBe('');
    });

    it('collapses a padding run to one space', () => {
        expect(clampTagText(`A${' '.repeat(40_000)}B`)).toBe('A B');
        expect(clampTagText(`A${'\t \n'.repeat(1000)}B`)).toBe('A B');
    });

    it('cuts a long credit between names, not inside one', () => {
        const names = Array.from({ length: 2000 }, (_, i) => `Artist${i}`);
        const out = clampTagText(names.join('; '));
        expect(out.length).toBeLessThanOrEqual(MAX_TAG_TEXT_LENGTH);
        expect(out.length).toBeGreaterThan(MAX_TAG_TEXT_LENGTH / 2);
        const lastName = out.split('; ').pop()!;
        expect(names).toContain(lastName);
        expect(clampTagText(names.join(' & ')).endsWith('&')).toBe(false);
    });

    it('caps the length and never ends on half a surrogate pair', () => {
        const out = clampTagText('x'.repeat(MAX_TAG_TEXT_LENGTH - 1) + '\u{1F600}'.repeat(10));
        expect(out.length).toBeLessThanOrEqual(MAX_TAG_TEXT_LENGTH);
        const last = out.charCodeAt(out.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    });
});
