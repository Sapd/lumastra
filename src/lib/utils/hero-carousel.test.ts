// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
    nextIndex,
    prevIndex,
    clampIndex,
    shouldAutoplay,
    resumeLabel,
    resizeBoolArray,
    resizePlayerArray,
    slideKeysEqual,
    heroImageSlots,
} from './hero-carousel';

describe('hero-carousel index math', () => {
    it('wraps forward and backward', () => {
        expect(nextIndex(2, 3)).toBe(0);
        expect(nextIndex(0, 3)).toBe(1);
        expect(prevIndex(0, 3)).toBe(2);
    });
    it('is safe for 0 and 1 item', () => {
        expect(nextIndex(0, 0)).toBe(0);
        expect(nextIndex(0, 1)).toBe(0);
        expect(clampIndex(5, 3)).toBe(2);
        expect(clampIndex(-1, 3)).toBe(0);
    });
    it('only autoplays with >1 item, enabled, and motion allowed', () => {
        expect(shouldAutoplay(3, true, false)).toBe(true);
        expect(shouldAutoplay(1, true, false)).toBe(false);
        expect(shouldAutoplay(3, false, false)).toBe(false);
        expect(shouldAutoplay(3, true, true)).toBe(false);
    });
});

describe('resumeLabel', () => {
    it('computes minutes left from progress and runtime', () => {
        expect(resumeLabel(0.5, 60)).toBe('30 min left');
        expect(resumeLabel(0.9, 100)).toBe('10 min left');
    });
    it('returns null when data is insufficient', () => {
        expect(resumeLabel(undefined, 60)).toBeNull();
        expect(resumeLabel(0.5, undefined)).toBeNull();
        expect(resumeLabel(0, 60)).toBeNull();
    });
});

describe('resizeBoolArray', () => {
    it('grows an empty array to the target length with the fill value', () => {
        // The bug: init ran while items was empty/seed, so arrays stayed length 0
        // and videoLoaded[movieIdx] was undefined → trailer {#if} never true.
        expect(resizeBoolArray([], 5, true)).toEqual([true, true, true, true, true]);
        expect(resizeBoolArray([], 5, false)).toEqual([false, false, false, false, false]);
    });
    it('preserves existing entries when growing (loaded slides stay loaded)', () => {
        // videoLoaded grows seed(1) → full(5): slide 0 stays true, new slides false.
        expect(resizeBoolArray([true], 5, false)).toEqual([true, false, false, false, false]);
        // A slide marked false (errored/unavailable) is preserved across re-sync.
        expect(resizeBoolArray([true, false], 4, true)).toEqual([true, false, true, true]);
    });
    it('truncates when the list shrinks', () => {
        expect(resizeBoolArray([true, true, true], 1, false)).toEqual([true]);
    });
    it('is a no-op shape for equal length', () => {
        expect(resizeBoolArray([true, false, true], 3, false)).toEqual([true, false, true]);
    });
});

describe('resizePlayerArray', () => {
    it('grows an empty/undefined players array to items length, null-filled', () => {
        // The smoking gun: videoPlayers.length === 0. Re-syncing to items.length
        // gives a slot per slide so loadSingleTrailer can attach a player.
        expect(resizePlayerArray<object>([], 5)).toEqual([null, null, null, null, null]);
        expect(resizePlayerArray<object>(undefined, 3)).toEqual([null, null, null]);
    });
    it('preserves already-constructed players for slides that still exist', () => {
        const p0 = { id: 0 };
        const p1 = { id: 1 };
        expect(resizePlayerArray([p0, p1], 4)).toEqual([p0, p1, null, null]);
    });
    it('truncates extra players when the list shrinks', () => {
        const p0 = { id: 0 };
        const p1 = { id: 1 };
        expect(resizePlayerArray([p0, p1], 1)).toEqual([p0]);
    });
});

describe('slideKeysEqual', () => {
    it('returns true for the same reference', () => {
        const keys = ['a', 'b', 'c'];
        expect(slideKeysEqual(keys, keys)).toBe(true);
    });

    it('returns true for content-equal lists with different references', () => {
        // A stale-while-revalidate refresh that returns the identical slides
        // must be treated as a no-op so the active trailer is not dropped.
        expect(slideKeysEqual(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true);
    });

    it('returns false when lengths differ (SSR seed -> full list)', () => {
        expect(slideKeysEqual(['a'], ['a', 'b', 'c'])).toBe(false);
    });

    it('returns false when slides are reordered (real reconcile needed)', () => {
        expect(slideKeysEqual(['a', 'b', 'c'], ['a', 'c', 'b'])).toBe(false);
    });

    it('returns false when the set of slides changes', () => {
        expect(slideKeysEqual(['a', 'b', 'c'], ['a', 'b', 'd'])).toBe(false);
    });

    it('treats two empty lists as equal', () => {
        expect(slideKeysEqual([], [])).toBe(true);
    });
});

describe('heroImageSlots', () => {
    it('returns all indices when there are 3 or fewer slides', () => {
        expect(heroImageSlots(0, 0)).toEqual([]);
        expect(heroImageSlots(0, 1)).toEqual([0]);
        expect(heroImageSlots(0, 2)).toEqual([0, 1]);
        expect(heroImageSlots(1, 2)).toEqual([0, 1]);
        expect(heroImageSlots(0, 3)).toEqual([0, 1, 2]);
    });

    it('returns all 3 indices from every active position at len 3 (the boundary where prev/active/next stop colliding)', () => {
        expect(heroImageSlots(0, 3)).toEqual([0, 1, 2]);
        expect(heroImageSlots(1, 3)).toEqual([0, 1, 2]);
        expect(heroImageSlots(2, 3)).toEqual([0, 1, 2]);
    });

    it('never returns duplicate indices, for every active position at len 1 through 8', () => {
        // Regression pin: correctness is currently guaranteed by construction
        // (a Set dedupes prev/active/next before sorting). A future refactor
        // away from Set-based dedupe — e.g. back to a plain array literal —
        // would silently reintroduce duplicate <img> renders for small len,
        // and nothing else here would catch it.
        for (let len = 1; len <= 8; len++) {
            for (let index = 0; index < len; index++) {
                const slots = heroImageSlots(index, len);
                expect(
                    new Set(slots).size,
                    `len=${len} index=${index} slots=${JSON.stringify(slots)}`,
                ).toBe(slots.length);
            }
        }
    });

    it('returns the active slide plus its two neighbours, sorted ascending', () => {
        expect(heroImageSlots(2, 5)).toEqual([1, 2, 3]);
    });

    it('wraps at the ends like the carousel itself does', () => {
        // active = 0: prev neighbour is the LAST slide, not -1.
        expect(heroImageSlots(0, 5)).toEqual([0, 1, 4]);
        // active = last: next neighbour is the FIRST slide, not len.
        expect(heroImageSlots(4, 5)).toEqual([0, 3, 4]);
    });

    it('clamps an out-of-range index like the other slot helpers (clampIndex)', () => {
        expect(heroImageSlots(99, 5)).toEqual([0, 3, 4]);
        expect(heroImageSlots(-1, 5)).toEqual([0, 1, 4]);
    });
});
