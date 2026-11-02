// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Action } from 'svelte/action';

export interface SwipeToCloseOptions {
    onClose: () => void | Promise<void>;
    threshold?: number;
    enabled?: boolean;
}

const AXIS_LOCK_THRESHOLD = 10;
const DEFAULT_CLOSE_THRESHOLD = 80;

/**
 * Svelte action: swipe-down-to-close on a scrollable container.
 *
 * Engages only when the container is at scrollTop === 0 and the gesture is
 * vertical-dominant and downward. While active, translates the node with the
 * finger and owns the gesture (preventDefault) so iOS rubber-band doesn't
 * compete. On release past `threshold` (default 80px) calls `onClose`;
 * otherwise the node snaps back.
 *
 * Usage: <div use:swipeToClose={{ onClose: handleClose }}>
 */
export const swipeToClose: Action<HTMLElement, SwipeToCloseOptions> = (node, options) => {
    let opts = options;
    let startX = 0;
    let startY = 0;
    let deltaY = 0;
    let dragging = false;
    let atTop = true;
    let multiTouch = false;

    const prevOverscroll = node.style.overscrollBehavior;
    node.style.overscrollBehavior = 'contain';

    function onScroll(): void {
        atTop = node.scrollTop <= 0;
    }

    function onTouchStart(e: TouchEvent): void {
        multiTouch = e.touches.length > 1;
        if (opts.enabled === false || multiTouch || !atTop) {
            dragging = false;
            return;
        }
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        deltaY = 0;
        dragging = false;
    }

    function onTouchMove(e: TouchEvent): void {
        if (opts.enabled === false || multiTouch || !atTop) return;
        if (e.touches.length !== 1) return;
        const dy = e.touches[0].clientY - startY;
        const dx = e.touches[0].clientX - startX;

        if (!dragging) {
            // Wait for meaningful movement, and require downward vertical dominance.
            if (Math.abs(dy) < AXIS_LOCK_THRESHOLD && Math.abs(dx) < AXIS_LOCK_THRESHOLD) {
                return;
            }
            if (Math.abs(dx) > Math.abs(dy) || dy <= 0) return;
            dragging = true;
        }

        deltaY = dy;
        if (dy > 0) {
            // Own the gesture to prevent iOS rubber-band competing with drag.
            if (e.cancelable) e.preventDefault();
            node.style.transform = `translateY(${Math.min(dy, 200)}px)`;
            node.style.transition = 'none';
        } else {
            node.style.transform = '';
        }
    }

    async function settle(shouldClose: boolean): Promise<void> {
        const hadTransform = node.style.transform !== '';
        dragging = false;
        deltaY = 0;
        multiTouch = false;
        if (hadTransform) {
            node.style.transition = 'transform 0.25s ease';
            node.style.transform = '';
            window.setTimeout(() => {
                node.style.transition = '';
            }, 280);
        } else {
            node.style.transition = '';
        }
        if (shouldClose) await opts.onClose();
    }

    async function onTouchEnd(): Promise<void> {
        const threshold = opts.threshold ?? DEFAULT_CLOSE_THRESHOLD;
        await settle(dragging && deltaY >= threshold);
    }

    async function onTouchCancel(): Promise<void> {
        await settle(false);
    }

    node.addEventListener('scroll', onScroll);
    node.addEventListener('touchstart', onTouchStart, { passive: true });
    // Non-passive so preventDefault works during active drag.
    node.addEventListener('touchmove', onTouchMove);
    node.addEventListener('touchend', onTouchEnd);
    node.addEventListener('touchcancel', onTouchCancel);

    return {
        update(newOptions: SwipeToCloseOptions): void {
            opts = newOptions;
        },
        destroy(): void {
            node.style.overscrollBehavior = prevOverscroll;
            node.style.transform = '';
            node.style.transition = '';
            node.removeEventListener('scroll', onScroll);
            node.removeEventListener('touchstart', onTouchStart);
            node.removeEventListener('touchmove', onTouchMove);
            node.removeEventListener('touchend', onTouchEnd);
            node.removeEventListener('touchcancel', onTouchCancel);
        },
    };
};
