// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { dragDirection, dragProgress, dragTransform, resolveCommit } from './swipe-math';
import type { SwipeDirection } from './swipe-math';

/**
 * Svelte action: makes a card draggable via pointer events (covers mouse +
 * touch + pen). Ported from the swipeable() action in
 * src/lib/components/RatingMode.svelte:220-316, generalized with a
 * velocity-based commit (a quick flick commits even below the distance
 * threshold) and an onprogress callback so callers can drive overlay labels
 * (e.g. "LIKE" / "SKIP") during the drag instead of only on release.
 *
 * Usage:
 * <div use:swipeCard={{ enabled, onprogress, oncommit, onrelease }}>
 */

export interface SwipeCardParams {
    enabled: boolean;
    onprogress: (dir: SwipeDirection | null, progress: number, transform: string) => void;
    oncommit: (dir: SwipeDirection) => void;
    /** Spring-back: fired on release when the commit threshold was not reached. */
    onrelease: () => void;
}

// Exponential moving average window (ms) for velocity smoothing — short
// enough to react to a flick, long enough to ignore single-sample jitter.
const VELOCITY_EMA_WINDOW_MS = 100;

export function swipeCard(
    node: HTMLElement,
    params: SwipeCardParams,
): { update(p: SwipeCardParams): void; destroy(): void } {
    let opts = params;

    let startX = 0;
    let startY = 0;
    let dragX = 0;
    let dragY = 0;
    let vx = 0;
    let vy = 0;
    let lastMoveX = 0;
    let lastMoveY = 0;
    let lastMoveTime = 0;
    let activePointer: number | null = null;
    let dragging = false;

    function reset(): void {
        if (activePointer !== null && node.hasPointerCapture?.(activePointer)) {
            node.releasePointerCapture?.(activePointer);
        }
        dragging = false;
        dragX = 0;
        dragY = 0;
        vx = 0;
        vy = 0;
        activePointer = null;
    }

    /**
     * Reset triggered from outside the pointer stream (enabled→false in
     * update(), or destroy() mid-drag). Unlike RatingMode — where $state
     * drove the transform and zeroing it snapped the card back on its own —
     * the consumer here only knows what we tell it, so fire onrelease plus a
     * zeroed onprogress or the card stays visually frozen at the last drag
     * offset.
     */
    function abortDrag(): void {
        if (!dragging) return;
        reset();
        opts.onrelease();
        opts.onprogress(null, 0, '');
    }

    function onPointerDown(event: PointerEvent): void {
        // A second concurrent pointer (e.g. a stray touch alongside the mouse,
        // or two fingers) must not hijack/reset the drag already in progress.
        if (dragging) return;
        if (!opts.enabled) return;
        // Ignore drags that start on an interactive control (buttons, links,
        // form controls) so they keep their own behavior.
        const target = event.target as HTMLElement | null;
        if (target && target.closest('button, a, input, select, textarea, [role="button"]')) {
            return;
        }
        activePointer = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        lastMoveX = event.clientX;
        lastMoveY = event.clientY;
        lastMoveTime = event.timeStamp;
        vx = 0;
        vy = 0;
        dragging = true;
        node.setPointerCapture?.(event.pointerId);
    }

    function onPointerMove(event: PointerEvent): void {
        if (!dragging || event.pointerId !== activePointer) return;
        dragX = event.clientX - startX;
        dragY = event.clientY - startY;

        const dt = event.timeStamp - lastMoveTime;
        if (dt > 0) {
            const instantVx = (event.clientX - lastMoveX) / dt;
            const instantVy = (event.clientY - lastMoveY) / dt;
            // Exponential moving average: alpha rises toward 1 as dt grows
            // relative to the smoothing window, so slow samples track closely
            // while fast/jittery samples get smoothed.
            const alpha = 1 - Math.exp(-dt / VELOCITY_EMA_WINDOW_MS);
            vx = alpha * instantVx + (1 - alpha) * vx;
            vy = alpha * instantVy + (1 - alpha) * vy;
            lastMoveX = event.clientX;
            lastMoveY = event.clientY;
            lastMoveTime = event.timeStamp;
        }

        opts.onprogress(
            dragDirection(dragX, dragY),
            dragProgress(dragX, dragY),
            dragTransform(dragX, dragY),
        );
    }

    function onPointerUp(event: PointerEvent): void {
        if (!dragging || event.pointerId !== activePointer) return;
        const commit = resolveCommit({ dx: dragX, dy: dragY, vx, vy });
        reset();
        if (commit) {
            opts.oncommit(commit);
        } else {
            opts.onrelease();
        }
    }

    /**
     * pointercancel (browser aborted the gesture — e.g. a system gesture took
     * over, or a scroll interrupted it) and lostpointercapture (capture was
     * involuntarily released, which would otherwise freeze the card mid-drag
     * with no further pointermove events ever arriving) both mean the drag is
     * over unconditionally. Unlike pointerup, this must NEVER evaluate
     * resolveCommit()/oncommit() — an aborted gesture is not a swipe.
     */
    function onPointerCanceled(event: PointerEvent): void {
        if (event.pointerId !== activePointer) return;
        abortDrag();
    }

    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('pointercancel', onPointerCanceled);
    node.addEventListener('lostpointercapture', onPointerCanceled);

    return {
        update(p: SwipeCardParams): void {
            opts = p;
            if (!opts.enabled) abortDrag();
        },
        destroy(): void {
            abortDrag();
            node.removeEventListener('pointerdown', onPointerDown);
            node.removeEventListener('pointermove', onPointerMove);
            node.removeEventListener('pointerup', onPointerUp);
            node.removeEventListener('pointercancel', onPointerCanceled);
            node.removeEventListener('lostpointercapture', onPointerCanceled);
        },
    };
}
