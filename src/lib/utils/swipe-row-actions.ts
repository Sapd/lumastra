// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure swipe gesture utilities for the queue row swipe-to-reveal-actions
 * gesture. Extracted from QueueTrackItem.svelte to enable unit testing.
 */

/** px width of the fully-open action tray (like + dislike + remove buttons) — also the row's max translateX */
export const REVEAL_WIDTH = 132;
/** total px drag (beyond REVEAL_WIDTH) that auto-commits removal */
export const DELETE_WIDTH = REVEAL_WIDTH + 96;
/** minimum leftward drag on release for the tray to stay pinned open */
export const OPEN_COMMIT_WIDTH = 24;
/** minimum px movement on either axis before a direction is locked in */
export const AXIS_LOCK_THRESHOLD = 10;

export type SwipeRowStage = 'closed' | 'reveal' | 'armed';

/**
 * Classifies the *live* drag distance (0 = at rest, positive = dragged left)
 * into a visual stage for real-time feedback while the finger is down.
 */
export function getSwipeRowStage(dragDistance: number): SwipeRowStage {
    if (dragDistance > REVEAL_WIDTH) return 'armed';
    if (dragDistance > 0) return 'reveal';
    return 'closed';
}

export type SwipeRowRelease = 'close' | 'open' | 'delete';

/**
 * Determines what happens when the finger lifts, given the live drag distance.
 */
export function getSwipeRowRelease(dragDistance: number): SwipeRowRelease {
    if (dragDistance >= DELETE_WIDTH) return 'delete';
    if (dragDistance >= OPEN_COMMIT_WIDTH) return 'open';
    return 'close';
}

/**
 * Returns true if vertical movement dominates — used to bail out of a
 * horizontal swipe so list scrolling isn't hijacked.
 */
export function isCancelledByVerticalDrag(deltaX: number, deltaY: number): boolean {
    return Math.abs(deltaY) > Math.abs(deltaX);
}

/**
 * The row's own translateX while dragging: tracks the finger 1:1 until the
 * tray is fully open, then holds at REVEAL_WIDTH — further drag only grows
 * the delete affordance (see getArmProgress) instead of sliding the row further.
 */
export function getRowTranslate(dragDistance: number): number {
    return Math.min(Math.max(0, dragDistance), REVEAL_WIDTH);
}

/**
 * How "armed" the delete affordance is, from 0 (at REVEAL_WIDTH) to 1 (at
 * DELETE_WIDTH and beyond) — drives the remove button's scale-up animation.
 */
export function getArmProgress(dragDistance: number): number {
    if (dragDistance <= REVEAL_WIDTH) return 0;
    const span = DELETE_WIDTH - REVEAL_WIDTH;
    return Math.min(1, (dragDistance - REVEAL_WIDTH) / span);
}

/**
 * Clamps the raw drag distance: follows the finger 1:1 up to DELETE_WIDTH,
 * then rubber-bands past it so it's clear you've crossed the point of no
 * return without the value growing unbounded.
 */
export function clampDragDistance(rawDistance: number): number {
    if (rawDistance <= 0) return 0;
    if (rawDistance <= DELETE_WIDTH) return rawDistance;
    return DELETE_WIDTH + (rawDistance - DELETE_WIDTH) * 0.25;
}
