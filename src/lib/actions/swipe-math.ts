// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure gesture math for the swipe-card action (src/lib/actions/swipe-card.ts).
 * No DOM access here so it's testable in isolation — see swipe-math.test.ts.
 * Ported from src/lib/components/RatingMode.svelte:220-316.
 */

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

export interface SwipeState {
    dx: number;
    dy: number;
    vx: number;
    vy: number;
}

/** Distance (px) past which a release commits the swipe, from RatingMode. */
export const SWIPE_THRESHOLD = 90;

/** Velocity (px/ms) past which a quick flick commits below the distance threshold. */
export const VELOCITY_THRESHOLD = 0.6;

/** Below this drag distance (px) the gesture is considered a dead zone (no direction yet). */
const DEAD_ZONE_THRESHOLD = 24;

/**
 * Direction the drag currently points at (for overlay labels).
 * Returns null while inside the dead zone (< 24px in every axis).
 */
export function dragDirection(dx: number, dy: number): SwipeDirection | null {
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (Math.max(absX, absY) < DEAD_ZONE_THRESHOLD) {
        return null;
    }
    if (absX >= absY) {
        return dx > 0 ? 'right' : 'left';
    }
    return dy < 0 ? 'up' : 'down';
}

/** 0..1 progress toward commit, for overlay opacity. */
export function dragProgress(dx: number, dy: number): number {
    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    return Math.min(1, Math.max(0, distance / SWIPE_THRESHOLD));
}

/**
 * Commit decision on release: direction if the distance OR velocity threshold
 * was met, else null (spring back).
 */
export function resolveCommit(state: SwipeState): SwipeDirection | null {
    // Intentional: the 24px dead zone also bounds the velocity path — a
    // sub-24px flick never commits, no matter how fast, because dragDirection
    // returns null and we bail before the velocity check. This keeps twitchy
    // micro-gestures (and accidental taps with jitter) from rating a card.
    const direction = dragDirection(state.dx, state.dy);
    if (!direction) {
        return null;
    }
    const distance = Math.max(Math.abs(state.dx), Math.abs(state.dy));
    const velocity = Math.max(Math.abs(state.vx), Math.abs(state.vy));
    if (distance >= SWIPE_THRESHOLD || velocity >= VELOCITY_THRESHOLD) {
        return direction;
    }
    return null;
}

/** Card transform string for the current drag (translate + rotate dx*0.05deg), from RatingMode. */
export function dragTransform(dx: number, dy: number): string {
    return `translate(${dx}px, ${dy}px) rotate(${dx * 0.05}deg)`;
}
