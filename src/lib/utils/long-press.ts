// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Svelte action: fires a `longpress` CustomEvent after the user holds for
 * `duration` ms without moving more than `moveThreshold` px.
 *
 * Usage:
 *   <div use:longPress={{ duration: 400, haptic: true }}
 *        onlongpress={(e) => openMenu(e.detail.x, e.detail.y)}>
 *
 * Implementation notes:
 * - On touch devices the gesture is detected via Touch events (touchstart /
 *   touchmove / touchend / touchcancel). iOS Safari delivers Touch events
 *   immediately and does not cancel them when a touch lands on a
 *   horizontally-scrollable ancestor — Pointer events on iOS are flaky in
 *   that situation, so they are NOT used for `pointerType === 'touch'`.
 * - On mouse and pen, Pointer events drive the gesture (we still need
 *   pointerdown for right-button checks, mid-button etc.).
 * - Multi-touch / second pointer: ignored while one is already tracked.
 * - Movement past `moveThreshold` / `touchMoveThreshold` cancels the timer —
 *   covers panning the page or carousel. We do not prevent touch scrolling;
 *   the detector observes the gesture and backs off when it becomes a swipe.
 * - Haptic: navigator.vibrate(10) on fire (Android only — iOS no-ops).
 * - The synthetic `click` after a touch long-press is suppressed globally
 *   once, because iOS can target that release click at the freshly-opened
 *   menu instead of the originating node.
 * - Native context menu (iOS callout, Android selection) is suppressed
 *   while a long-press is in flight or has fired.
 */

import type { Action } from 'svelte/action';

export interface LongPressOptions {
    /** Hold duration in ms before firing (default: 400) */
    duration?: number;
    /** Pointer movement in px that cancels the press (default: 10) */
    moveThreshold?: number;
    /** Touch movement in px that cancels the press (default: max(moveThreshold, 18)) */
    touchMoveThreshold?: number;
    /** Try haptic feedback on fire (default: true) */
    haptic?: boolean;
    /** Direct callback fired when the press commits. CustomEvent is also dispatched. */
    onPress?: (detail: { x: number; y: number }) => void;
    /** Ignore nested buttons/links/inputs (default: true). */
    ignoreInteractive?: boolean;
}

interface LongPressAttributes {
    onlongpress?: (e: CustomEvent<{ x: number; y: number }>) => void;
}

export const longPress: Action<HTMLElement, LongPressOptions | undefined, LongPressAttributes> = (
    node,
    opts,
) => {
    let duration = opts?.duration ?? 400;
    let moveThreshold = opts?.moveThreshold ?? 10;
    let touchMoveThreshold = opts?.touchMoveThreshold ?? Math.max(18, moveThreshold);
    let haptic = opts?.haptic ?? true;
    let onPress = opts?.onPress;
    let ignoreInteractive = opts?.ignoreInteractive ?? true;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let activePointerId: number | null = null;
    let activeTouchId: number | null = null;
    let startX = 0;
    let startY = 0;
    let triggered = false;

    function isInteractiveDescendant(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) return false;
        if (target === node) return false;
        return Boolean(target.closest('button, a, input, select, textarea'));
    }

    function clear(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        activePointerId = null;
        activeTouchId = null;
        triggered = false;
    }

    function fireTimer(): void {
        timer = null;
        triggered = true;
        if (haptic && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            try {
                navigator.vibrate(10);
            } catch {
                /* expected: some browsers throw on user-gesture requirements */
            }
        }
        const detail = { x: startX, y: startY };
        onPress?.(detail);
        node.dispatchEvent(
            new CustomEvent('longpress', {
                detail,
                bubbles: true,
            }),
        );
    }

    function startTimer(x: number, y: number): void {
        startX = x;
        startY = y;
        triggered = false;
        timer = setTimeout(fireTimer, duration);
    }

    /**
     * Suppress the synthetic `click` that fires after a long-press release.
     * Touch uses a longer global guard because iOS can target the click at the
     * newly-opened menu instead of the original card.
     */
    function suppressNextClick(options?: { global?: boolean; duration?: number }): void {
        const global = options?.global ?? false;
        const duration = options?.duration ?? 120;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const cleanup = (): void => {
            window.removeEventListener('click', handler, { capture: true });
            if (timeout !== null) {
                clearTimeout(timeout);
                timeout = null;
            }
        };
        const handler = (ev: MouseEvent): void => {
            if (global || node.contains(ev.target as Node)) {
                ev.preventDefault();
                ev.stopImmediatePropagation();
                ev.stopPropagation();
                cleanup();
                return;
            }
        };
        window.addEventListener('click', handler, { capture: true });
        timeout = setTimeout(cleanup, duration);
    }

    // ===== Touch path (primary on touchscreens) =====

    function findTouch(list: TouchList, id: number): Touch | null {
        for (let i = 0; i < list.length; i++) {
            if (list[i].identifier === id) return list[i];
        }
        return null;
    }

    function onTouchStart(e: TouchEvent): void {
        if (activeTouchId !== null || activePointerId !== null) return;
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (ignoreInteractive && isInteractiveDescendant(t.target)) return;
        activeTouchId = t.identifier;
        startTimer(t.clientX, t.clientY);
    }

    function onTouchMove(e: TouchEvent): void {
        if (activeTouchId === null || triggered) return;
        const t = findTouch(e.touches, activeTouchId);
        if (!t) return;
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (dx * dx + dy * dy > touchMoveThreshold * touchMoveThreshold) {
            clear();
        }
    }

    function onTouchEnd(e: TouchEvent): void {
        if (activeTouchId === null) return;
        // Only react when the tracked touch is the one that ended.
        if (findTouch(e.touches, activeTouchId)) return;
        const wasTriggered = triggered;
        clear();
        // Touch path uses a global guard because iOS can target the synthetic
        // click at the newly-opened menu instead of the original card.
        if (wasTriggered) suppressNextClick({ global: true });
    }

    function onTouchCancel(e: TouchEvent): void {
        if (activeTouchId === null) return;
        if (findTouch(e.touches, activeTouchId)) return;
        // If the long-press already fired, suppress the synthetic click that
        // the browser may still deliver after a system-initiated cancel
        // (notification overlay, alert). Mirrors onTouchEnd behavior.
        const wasTriggered = triggered;
        clear();
        if (wasTriggered) suppressNextClick({ global: true });
    }

    // ===== Pointer path (mouse / pen) =====

    function onPointerDown(e: PointerEvent): void {
        // Touch is handled by the Touch events above. iOS Pointer events
        // are unreliable when the touch starts inside a scrollable
        // ancestor (cancelled before the timer can fire).
        if (e.pointerType === 'touch') return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (activePointerId !== null || activeTouchId !== null) return;
        if (ignoreInteractive && isInteractiveDescendant(e.target)) return;
        activePointerId = e.pointerId;
        startTimer(e.clientX, e.clientY);
    }

    function onPointerMove(e: PointerEvent): void {
        if (activePointerId !== e.pointerId || timer === null) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (dx * dx + dy * dy > moveThreshold * moveThreshold) {
            clear();
        }
    }

    function onPointerUp(e: PointerEvent): void {
        if (activePointerId !== e.pointerId) return;
        const wasTriggered = triggered;
        clear();
        if (wasTriggered) suppressNextClick();
    }

    function onPointerCancel(e: PointerEvent): void {
        if (activePointerId !== e.pointerId) return;
        clear();
    }

    /**
     * Backup cleanup for pointerup/pointercancel that never reach `node`
     * (release happened off-card, or stopPropagation upstream). Without
     * this, activePointerId could stay set forever.
     */
    function onWindowPointerEnd(e: PointerEvent): void {
        if (activePointerId !== e.pointerId) return;
        if (node.contains(e.target as Node)) return;
        clear();
    }

    function onContextMenu(e: Event): void {
        if (triggered || timer !== null) {
            e.preventDefault();
        }
    }

    node.addEventListener('touchstart', onTouchStart, {
        passive: true,
        capture: true,
    });
    node.addEventListener('touchmove', onTouchMove, {
        passive: true,
        capture: true,
    });
    node.addEventListener('touchend', onTouchEnd, { capture: true });
    node.addEventListener('touchcancel', onTouchCancel, { capture: true });
    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('pointercancel', onPointerCancel);
    node.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('pointerup', onWindowPointerEnd);
    window.addEventListener('pointercancel', onWindowPointerEnd);

    return {
        update(newOpts) {
            duration = newOpts?.duration ?? 400;
            moveThreshold = newOpts?.moveThreshold ?? 10;
            touchMoveThreshold = newOpts?.touchMoveThreshold ?? Math.max(18, moveThreshold);
            haptic = newOpts?.haptic ?? true;
            onPress = newOpts?.onPress;
            ignoreInteractive = newOpts?.ignoreInteractive ?? true;
        },
        destroy() {
            clear();
            node.removeEventListener('touchstart', onTouchStart, {
                capture: true,
            });
            node.removeEventListener('touchmove', onTouchMove, {
                capture: true,
            });
            node.removeEventListener('touchend', onTouchEnd, {
                capture: true,
            });
            node.removeEventListener('touchcancel', onTouchCancel, {
                capture: true,
            });
            node.removeEventListener('pointerdown', onPointerDown);
            node.removeEventListener('pointermove', onPointerMove);
            node.removeEventListener('pointerup', onPointerUp);
            node.removeEventListener('pointercancel', onPointerCancel);
            node.removeEventListener('contextmenu', onContextMenu);
            window.removeEventListener('pointerup', onWindowPointerEnd);
            window.removeEventListener('pointercancel', onWindowPointerEnd);
        },
    };
};
