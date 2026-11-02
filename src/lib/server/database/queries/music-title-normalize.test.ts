// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isVersionTagged } from './music-title-normalize.js';

describe('isVersionTagged', () => {
    it('detects a bracketed radio edit', () => {
        expect(isVersionTagged('Song (Radio Edit)')).toBe(true);
    });

    it('detects a dash-suffixed extended mix', () => {
        expect(isVersionTagged('Song - Extended Mix')).toBe(true);
    });

    it('detects a bracketed live tag', () => {
        expect(isVersionTagged('Song (Live)')).toBe(true);
    });

    it('detects a bracketed remix tag', () => {
        expect(isVersionTagged('Song (X Remix)')).toBe(true);
    });

    it('detects a bracketed remaster tag with a year', () => {
        expect(isVersionTagged('Song (Remastered 2011)')).toBe(true);
    });

    it('returns false for a plain title', () => {
        expect(isVersionTagged('Song')).toBe(false);
    });

    it('returns false for a bracketed featuring credit', () => {
        expect(isVersionTagged('Song (feat. Artist)')).toBe(false);
    });

    it('returns false for a dash-suffixed featuring credit', () => {
        expect(isVersionTagged('Song - feat. Artist')).toBe(false);
    });

    it('does not false-positive on a keyword embedded in a word', () => {
        // "Mixed" contains "mix" but is not a bracket/dash-suffixed variant tag.
        expect(isVersionTagged('Mixed Feelings')).toBe(false);
    });

    it('does not false-positive on a leading word that happens to match a keyword', () => {
        // BARE_REMIX_SUFFIX_REGEX is end-anchored, so a variant keyword must be
        // the trailing word to count — "Live" here is the leading word of the
        // title, not a suffix tag, so this is treated as an unrelated title.
        expect(isVersionTagged('Live and Let Die')).toBe(false);
    });

    // --- A1: feat-strip must remove only the feat PHRASE, not the whole tag ---

    it('detects the version marker co-located with a bracketed feat credit', () => {
        // "(Radio Edit feat. Artist)" strips to "(Radio Edit " (phrase-only),
        // which still carries the "Edit" version marker.
        expect(isVersionTagged('Song (Radio Edit feat. Artist)')).toBe(true);
    });

    it('detects the version marker co-located with a dash-suffixed feat credit', () => {
        // "Song - Radio Edit feat. Artist" strips to "Song - Radio Edit ".
        expect(isVersionTagged('Song - Radio Edit feat. Artist')).toBe(true);
    });

    // --- A3: a title that IS exactly a bare version keyword ---

    it('detects a whole title that is exactly a bare version keyword', () => {
        expect(isVersionTagged('Remix')).toBe(true);
        expect(isVersionTagged('Live')).toBe(true);
        expect(isVersionTagged('Acoustic')).toBe(true);
    });

    // --- A2: word boundaries — keyword must be its own word, not a substring ---

    it('does not false-positive on "edit" embedded in "Edition"', () => {
        expect(isVersionTagged('Song (Special Edition)')).toBe(false);
        expect(isVersionTagged('Song (Anniversary Edition)')).toBe(false);
    });

    it('does not false-positive on "edit" embedded in "Credit"', () => {
        // "Credit" is outside the bracket entirely here, but this also proves
        // the word-boundary guard: "credit" alone is never a version marker.
        expect(isVersionTagged('Credit (From Movie)')).toBe(false);
    });

    it('does not false-positive on "mix" embedded in "Mixtape"', () => {
        // Deliberate: with word boundaries, "mix" must NOT match inside
        // "Mixtape" — a mixtape is not a remix/version tag.
        expect(isVersionTagged('Song (Mixtape)')).toBe(false);
    });
});
