// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    FEED_SECTION_KINDS,
    ESSENTIAL_FEED_KINDS,
    sectionKind,
    isSectionVisible,
    isSectionIdVisible,
    isFeedSectionKind,
    sanitizeHiddenKinds,
    normalizeSectionKind,
    DEFAULT_FEED_PREFS,
    type FeedPrefs,
} from './feed-section-kinds';

describe('sectionKind', () => {
    // Pins each dynamic id prefix to its kind. These prefixes are produced in
    // section-builder.ts (server) and foryou-loader.ts (client) — if either
    // changes its id construction without updating sectionKind, this fails.
    it('collapses dynamic "because-{id}" ids to because-you-watched', () => {
        expect(sectionKind('because-tt0468569')).toBe('because-you-watched');
        expect(sectionKind('because-tmdb:550:movie:because')).toBe('because-you-watched');
    });

    it('collapses dynamic "youlike-{keyword}" ids to you-like', () => {
        expect(sectionKind('youlike-Action')).toBe('you-like');
        expect(sectionKind('youlike-Time Travel')).toBe('you-like');
    });

    it('collapses dynamic music ids', () => {
        expect(sectionKind('music-because-abc123')).toBe('music-because');
        expect(sectionKind('music-mood-energetic')).toBe('music-mood');
    });

    it('collapses mood-recommendations (with or without a mood suffix)', () => {
        expect(sectionKind('mood-recommendations')).toBe('mood-recommendations');
        expect(sectionKind('mood-recommendations-cozy')).toBe('mood-recommendations');
    });

    it('passes stable ids through unchanged (id is its own kind)', () => {
        for (const stable of [
            'continue-watching',
            'fulfilled-requests',
            'trending',
            'anime',
            'short-movies',
            'explore-keywords',
            'featured-pick',
        ]) {
            expect(sectionKind(stable)).toBe(stable);
        }
    });

    // Guard against the music-because / music-mood prefixes being shadowed by a
    // hypothetical broader "music-" rule.
    it('does not misclassify music-quick-picks as music-because/mood', () => {
        expect(sectionKind('music-quick-picks')).toBe('music-quick-picks');
        expect(sectionKind('music-recently-played')).toBe('music-recently-played');
    });
});

describe('registry invariants', () => {
    it('every stable kind round-trips through sectionKind', () => {
        for (const kind of FEED_SECTION_KINDS) {
            // Dynamic families are represented by a single kind token in the
            // registry; the token itself must map to itself.
            expect(sectionKind(kind)).toBe(kind);
        }
    });

    it('essentials are part of the registry', () => {
        for (const k of ESSENTIAL_FEED_KINDS) {
            expect(isFeedSectionKind(k)).toBe(true);
        }
    });
});

describe('isSectionVisible', () => {
    const minimal: FeedPrefs = { mode: 'minimal', hiddenKinds: [] };
    const customHideBecause: FeedPrefs = {
        mode: 'custom',
        hiddenKinds: ['because-you-watched', 'trending'],
    };

    it('full mode (and no prefs) shows everything', () => {
        for (const kind of FEED_SECTION_KINDS) {
            expect(isSectionVisible(kind, DEFAULT_FEED_PREFS)).toBe(true);
            expect(isSectionVisible(kind, null)).toBe(true);
            expect(isSectionVisible(kind, undefined)).toBe(true);
        }
    });

    it('minimal mode shows only the essentials', () => {
        expect(isSectionVisible('continue-watching', minimal)).toBe(true);
        expect(isSectionVisible('fulfilled-requests', minimal)).toBe(true);
        expect(isSectionVisible('trending', minimal)).toBe(false);
        expect(isSectionVisible('because-you-watched', minimal)).toBe(false);
        expect(isSectionVisible('taste', minimal)).toBe(false);
    });

    it('minimal mode hides brand-new (unknown) kinds too (inverse allowlist)', () => {
        expect(isSectionVisible('a-future-kind', minimal)).toBe(false);
    });

    it('custom mode hides listed kinds but keeps the rest', () => {
        expect(isSectionVisible('because-you-watched', customHideBecause)).toBe(false);
        expect(isSectionVisible('trending', customHideBecause)).toBe(false);
        expect(isSectionVisible('anime', customHideBecause)).toBe(true);
    });

    it('custom mode can never hide an essential (un-hideable)', () => {
        const hostile: FeedPrefs = {
            mode: 'custom',
            hiddenKinds: ['continue-watching', 'fulfilled-requests'],
        };
        expect(isSectionVisible('continue-watching', hostile)).toBe(true);
        expect(isSectionVisible('fulfilled-requests', hostile)).toBe(true);
    });

    it('resolves visibility straight from a dynamic id', () => {
        // The friend's need (a): hiding the kind collapses every dynamic instance.
        expect(isSectionIdVisible('because-tt123', customHideBecause)).toBe(false);
        expect(isSectionIdVisible('because-tt999', customHideBecause)).toBe(false);
    });
});

describe('sanitizeHiddenKinds', () => {
    it('drops unknown kinds', () => {
        expect(sanitizeHiddenKinds(['trending', 'not-a-kind', 'anime'])).toEqual([
            'trending',
            'anime',
        ]);
    });

    it('always strips essentials so a user can never blank their home', () => {
        expect(
            sanitizeHiddenKinds(['continue-watching', 'fulfilled-requests', 'trending']),
        ).toEqual(['trending']);
    });

    it('de-duplicates while preserving first-seen order', () => {
        expect(sanitizeHiddenKinds(['anime', 'trending', 'anime'])).toEqual(['anime', 'trending']);
    });

    it('returns empty for an all-invalid list', () => {
        expect(sanitizeHiddenKinds(['continue-watching', 'bogus'])).toEqual([]);
    });
});

describe("legacy 'ai-suggestions' → 'taste' pref migration (read-time alias)", () => {
    it('normalizeSectionKind maps the legacy token and passes canonical tokens through', () => {
        expect(normalizeSectionKind('ai-suggestions')).toBe('taste');
        expect(normalizeSectionKind('taste')).toBe('taste');
        expect(normalizeSectionKind('trending')).toBe('trending');
    });

    it("a stored legacy hidden 'ai-suggestions' still hides the taste rail", () => {
        const legacyPrefs: FeedPrefs = { mode: 'custom', hiddenKinds: ['ai-suggestions'] };
        expect(isSectionVisible('taste', legacyPrefs)).toBe(false);
        // …and the section-id convenience path agrees (the rail's id is 'taste').
        expect(isSectionIdVisible('taste', legacyPrefs)).toBe(false);
        // Other kinds are unaffected by the legacy token.
        expect(isSectionVisible('trending', legacyPrefs)).toBe(true);
    });

    it('fresh prefs default the taste rail to visible', () => {
        expect(isSectionVisible('taste', DEFAULT_FEED_PREFS)).toBe(true);
        expect(isSectionVisible('taste', null)).toBe(true);
        expect(isSectionVisible('taste', { mode: 'custom', hiddenKinds: [] })).toBe(true);
    });

    it('sanitizeHiddenKinds rewrites the legacy token so the next save persists the canonical kind', () => {
        expect(sanitizeHiddenKinds(['ai-suggestions'])).toEqual(['taste']);
        // Legacy + canonical de-duplicate to a single canonical entry.
        expect(sanitizeHiddenKinds(['ai-suggestions', 'taste'])).toEqual(['taste']);
    });

    it("the legacy token itself is no longer a registered kind (registry only carries 'taste')", () => {
        expect(isFeedSectionKind('ai-suggestions')).toBe(false);
        expect(isFeedSectionKind('taste')).toBe(true);
        expect(FEED_SECTION_KINDS).not.toContain('ai-suggestions');
    });
});
