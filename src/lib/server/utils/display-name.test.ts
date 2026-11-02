// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { sanitizeDisplayName, MAX_DISPLAY_NAME_LENGTH } from './display-name.js';

describe('sanitizeDisplayName', () => {
    it('leaves an ordinary label alone', () => {
        expect(sanitizeDisplayName('Fernseher im Wohnzimmer')).toBe('Fernseher im Wohnzimmer');
    });

    it('keeps non-ASCII text intact', () => {
        // Stripping is about invisible/control characters, not about ASCII-only.
        expect(sanitizeDisplayName('Wohnzimmer – Übung 日本語')).toBe('Wohnzimmer – Übung 日本語');
    });

    it('strips control characters', () => {
        const out = sanitizeDisplayName('Living\x00Room\x1F TV');
        // eslint-disable-next-line no-control-regex -- asserting they are gone
        expect(out).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
        expect(out).toBe('LivingRoom TV');
    });

    it('strips bidi overrides used to disguise one label as another', () => {
        const out = sanitizeDisplayName('Evil‮moorgnivil');
        expect(out).not.toMatch(/[‪-‮⁦-⁩‎‏]/);
    });

    it('strips zero-width padding so two labels cannot render identically', () => {
        expect(sanitizeDisplayName('Apple TV​')).toBe(sanitizeDisplayName('Apple TV'));
    });

    it('collapses whitespace runs used to push content out of view', () => {
        expect(sanitizeDisplayName('TV          hidden')).toBe('TV hidden');
    });

    it('trims', () => {
        expect(sanitizeDisplayName('  padded  ')).toBe('padded');
    });

    it('caps at the default length and marks the truncation', () => {
        const out = sanitizeDisplayName('A'.repeat(5000));
        expect(out.length).toBe(MAX_DISPLAY_NAME_LENGTH + 1);
        expect(out.endsWith('…')).toBe(true);
    });

    it('honours a caller-specific cap', () => {
        expect(sanitizeDisplayName('A'.repeat(500), 10)).toBe('A'.repeat(10) + '…');
    });

    it('returns empty for input that sanitises away entirely', () => {
        // Callers decide whether that means reject or fall back to a default.
        expect(sanitizeDisplayName('​‮ \x00')).toBe('');
    });

    it('leaves markup as inert literal text', () => {
        // The sinks escape; this must not silently rewrite what the user typed.
        expect(sanitizeDisplayName('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
    });
});

describe('truncation is grapheme-safe', () => {
    it('does not split an emoji into a replacement character', () => {
        // A UTF-16 slice at the cap can land mid-surrogate-pair, and the lone
        // surrogate becomes U+FFFD on its way to the database — silent corruption
        // rather than clean truncation.
        const out = sanitizeDisplayName('A' + '\u{1F600}'.repeat(40), 64);
        expect(out).not.toContain('\uFFFD');
        expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
    });

    it('decomposes a ZWJ emoji sequence — the joiner is a spoofing vector', () => {
        // U+200D sits in the zero-width range this sanitiser strips, so 👨‍👩‍👧
        // becomes three separate emoji. That is the intended trade: removing
        // zero-width characters matters more than rendering a family emoji.
        const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
        const out = sanitizeDisplayName(family, 64);
        expect(out).toBe('\u{1F468}\u{1F469}\u{1F467}');
        expect(out).not.toContain('\u200D');
    });

    it('truncates the decomposed emoji cleanly, without corrupting one', () => {
        const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
        // 60 emoji after decomposition; a code-unit slice at 5 would cut mid-pair.
        const out = sanitizeDisplayName(family.repeat(20), 5);
        expect(out).toBe('\u{1F468}\u{1F469}\u{1F467}\u{1F468}\u{1F469}' + '…');
        expect(out).not.toContain('\uFFFD');
    });

    it('counts graphemes, not code units, against the cap', () => {
        // 10 emoji = 20 code units but 10 user-perceived characters. A cap of 15 is
        // chosen so the two measures disagree: counting code units truncates (and
        // corrupts), counting graphemes leaves the name alone.
        const ten = '\u{1F600}'.repeat(10);
        expect(sanitizeDisplayName(ten, 15)).toBe(ten);
    });

    it('still truncates plain text at the cap with an ellipsis', () => {
        const out = sanitizeDisplayName('A'.repeat(100), 10);
        expect(out).toBe('A'.repeat(10) + '…');
    });
});
