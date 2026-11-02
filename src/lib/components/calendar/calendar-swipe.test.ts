// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, afterEach } from 'vitest';
import {
    SWIPE_THRESHOLD,
    getSwipeDirection,
    isCancelledByVerticalScroll,
    canScrollFurther,
    findHorizontalScroller,
} from './calendar-swipe';

describe('getSwipeDirection', () => {
    it('returns null when movement is exactly at threshold', () => {
        expect(getSwipeDirection(0, SWIPE_THRESHOLD)).toBeNull();
        expect(getSwipeDirection(0, -SWIPE_THRESHOLD)).toBeNull();
    });

    it('returns null when movement is below threshold', () => {
        expect(getSwipeDirection(100, 140)).toBeNull(); // delta = 40
        expect(getSwipeDirection(100, 60)).toBeNull(); // delta = -40
    });

    it('returns prev for right swipe (positive delta)', () => {
        expect(getSwipeDirection(0, SWIPE_THRESHOLD + 1)).toBe('prev');
        expect(getSwipeDirection(100, 200)).toBe('prev');
    });

    it('returns next for left swipe (negative delta)', () => {
        expect(getSwipeDirection(0, -(SWIPE_THRESHOLD + 1))).toBe('next');
        expect(getSwipeDirection(200, 100)).toBe('next');
    });

    it('respects a custom threshold', () => {
        expect(getSwipeDirection(0, 30, 20)).toBe('prev'); // exceeds custom threshold of 20
        expect(getSwipeDirection(0, 30, 40)).toBeNull(); // below custom threshold of 40
    });
});

describe('isCancelledByVerticalScroll', () => {
    it('cancels when vertical movement exceeds horizontal', () => {
        expect(isCancelledByVerticalScroll(10, 20)).toBe(true);
        expect(isCancelledByVerticalScroll(-10, 30)).toBe(true);
    });

    it('does not cancel when horizontal movement exceeds vertical', () => {
        expect(isCancelledByVerticalScroll(30, 10)).toBe(false);
        expect(isCancelledByVerticalScroll(-30, 10)).toBe(false);
    });

    it('does not cancel when movements are equal', () => {
        // Equal movement: horizontal is not strictly less, so vertical does not dominate
        expect(isCancelledByVerticalScroll(20, 20)).toBe(false);
    });
});

describe('canScrollFurther', () => {
    // The mobile week strip: 700px of day cards inside a 300px viewport.
    const strip = (scrollLeft: number) => ({ scrollLeft, scrollWidth: 700, clientWidth: 300 });

    it('reports room to scroll left-to-right from the start edge', () => {
        expect(canScrollFurther(strip(0), 'next')).toBe(true);
        expect(canScrollFurther(strip(0), 'prev')).toBe(false);
    });

    it('reports room in both directions from the middle', () => {
        expect(canScrollFurther(strip(200), 'next')).toBe(true);
        expect(canScrollFurther(strip(200), 'prev')).toBe(true);
    });

    it('reports no further room at the end edge', () => {
        expect(canScrollFurther(strip(400), 'next')).toBe(false);
        expect(canScrollFurther(strip(400), 'prev')).toBe(true);
    });

    it('tolerates sub-pixel rounding at either edge', () => {
        expect(canScrollFurther(strip(0.4), 'prev')).toBe(false);
        expect(canScrollFurther(strip(399.6), 'next')).toBe(false);
    });

    it('reports no room when content fits the viewport', () => {
        const fits = { scrollLeft: 0, scrollWidth: 300, clientWidth: 300 };
        expect(canScrollFurther(fits, 'next')).toBe(false);
        expect(canScrollFurther(fits, 'prev')).toBe(false);
    });
});

describe('findHorizontalScroller', () => {
    // happy-dom only resolves getComputedStyle for attached nodes, so every
    // fixture below is mounted into the document (as real touch targets are).
    afterEach(() => {
        document.body.innerHTML = '';
    });

    /** Builds an element whose scroll geometry happy-dom does not compute on its own. */
    function makeEl(
        tag: string,
        opts: { overflowX?: string; scrollWidth?: number; clientWidth?: number } = {},
    ): HTMLElement {
        const el = document.createElement(tag);
        if (opts.overflowX) el.style.overflowX = opts.overflowX;
        Object.defineProperty(el, 'scrollWidth', { value: opts.scrollWidth ?? 0 });
        Object.defineProperty(el, 'clientWidth', { value: opts.clientWidth ?? 0 });
        return el;
    }

    it('finds a scrolling ancestor between the touch target and the root', () => {
        const root = makeEl('div');
        const rail = makeEl('div', { overflowX: 'auto', scrollWidth: 700, clientWidth: 300 });
        const thumb = makeEl('button');
        rail.appendChild(thumb);
        root.appendChild(rail);
        document.body.appendChild(root);

        expect(findHorizontalScroller(thumb, root)).toBe(rail);
    });

    it('returns null when the ancestor does not overflow', () => {
        const root = makeEl('div');
        const rail = makeEl('div', { overflowX: 'auto', scrollWidth: 300, clientWidth: 300 });
        const thumb = makeEl('button');
        rail.appendChild(thumb);
        root.appendChild(rail);
        document.body.appendChild(root);

        expect(findHorizontalScroller(thumb, root)).toBeNull();
    });

    it('returns null when overflow is not scrollable despite wide content', () => {
        const root = makeEl('div');
        const rail = makeEl('div', { overflowX: 'visible', scrollWidth: 700, clientWidth: 300 });
        const thumb = makeEl('button');
        rail.appendChild(thumb);
        root.appendChild(rail);
        document.body.appendChild(root);

        expect(findHorizontalScroller(thumb, root)).toBeNull();
    });

    it('stops at the root and never escapes to outer page scrollers', () => {
        const outer = makeEl('div', { overflowX: 'auto', scrollWidth: 900, clientWidth: 300 });
        const root = makeEl('div');
        const cell = makeEl('div');
        root.appendChild(cell);
        outer.appendChild(root);
        document.body.appendChild(outer);

        expect(findHorizontalScroller(cell, root)).toBeNull();
    });

    it('returns null for a null target', () => {
        expect(findHorizontalScroller(null, makeEl('div'))).toBeNull();
    });
});
