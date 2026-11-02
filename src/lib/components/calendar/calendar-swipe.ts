// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure swipe gesture utilities for the calendar component.
 * Extracted from CustomCalendar.svelte to enable unit testing.
 */

/** Minimum horizontal pixel movement to be classified as a swipe */
export const SWIPE_THRESHOLD = 50;

/**
 * Determines the swipe direction from start to end coordinates.
 *
 * @returns 'prev' for right swipe, 'next' for left swipe, null if below threshold
 */
export function getSwipeDirection(
    startX: number,
    endX: number,
    threshold = SWIPE_THRESHOLD,
): 'prev' | 'next' | null {
    const deltaX = endX - startX;
    if (Math.abs(deltaX) <= threshold) return null;
    return deltaX > 0 ? 'prev' : 'next';
}

/**
 * Returns true if a vertical drag should cancel a horizontal swipe.
 * Vertical movement takes priority when it exceeds horizontal movement.
 */
export function isCancelledByVerticalScroll(deltaX: number, deltaY: number): boolean {
    return Math.abs(deltaY) > Math.abs(deltaX);
}

/** Sub-pixel slack so fractional scroll offsets still count as "at the edge". */
const SCROLL_EPSILON = 1;

/** The horizontal scroll geometry of a container, sampled at gesture start. */
export interface ScrollMetrics {
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
}

/**
 * Returns true if the container can still scroll horizontally in the given
 * swipe direction ('next' = swipe left = scrollLeft grows).
 *
 * Used to let the mobile week strip consume its own swipes: only once it sits
 * at the edge does a further swipe fall through to week navigation.
 */
export function canScrollFurther(metrics: ScrollMetrics, direction: 'prev' | 'next'): boolean {
    const maxScrollLeft = metrics.scrollWidth - metrics.clientWidth;
    if (maxScrollLeft <= SCROLL_EPSILON) return false;
    return direction === 'next'
        ? metrics.scrollLeft < maxScrollLeft - SCROLL_EPSILON
        : metrics.scrollLeft > SCROLL_EPSILON;
}

/**
 * Walks up from a touch target looking for a horizontally scrollable container,
 * stopping at (and excluding) `root` so page-level scrollers are never claimed.
 */
export function findHorizontalScroller(target: Element | null, root: Element): HTMLElement | null {
    let node: Element | null = target;
    while (node && node !== root) {
        if (node instanceof HTMLElement) {
            const overflowX = getComputedStyle(node).overflowX;
            if (
                (overflowX === 'auto' || overflowX === 'scroll') &&
                node.scrollWidth - node.clientWidth > SCROLL_EPSILON
            ) {
                return node;
            }
        }
        node = node.parentElement;
    }
    return null;
}
