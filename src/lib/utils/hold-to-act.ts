// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hold-to-act pointer gesture: a quick press is a tap, a press held past
 * `thresholdMs` commits an alternate action IMMEDIATELY at the threshold
 * (release timing no longer matters). Dragging the pointer off the element
 * before the threshold cancels the interaction entirely.
 *
 * Built for the mini player's "tap to skip / hold to mix" button, but has no
 * player-specific knowledge. Bind ALL returned handlers onto the element:
 * pointerdown/pointerup/pointerleave(→handlePointerCancel)/pointercancel/
 * click/contextmenu. Do NOT also wire a separate onclick action — pointer
 * clicks are swallowed here and keyboard clicks (detail === 0) map to onTap,
 * so the button stays keyboard-accessible.
 */
export interface HoldToActOptions {
    thresholdMs: number;
    /** Quick press released before the threshold (also keyboard activation). */
    onTap: () => void;
    /** Hold reached the threshold — fires at the threshold, not at release. */
    onHoldCommit: () => void;
    /** Hold began (pointer down) — drive "ring filling" UI from this. */
    onHoldStart?: () => void;
    /** Hold aborted before the threshold (drag-away / pointercancel). */
    onHoldCancel?: () => void;
    /**
     * Fires after EVERY terminal transition of a press — tap, hold-commit,
     * and cancel — after the corresponding specific callback; use it to tear
     * down "ring filling" UI.
     */
    onHoldEnd?: () => void;
}

export interface HoldToActHandlers {
    handlePointerDown: (e: PointerEvent) => void;
    handlePointerUp: (e: PointerEvent) => void;
    /** Bind to BOTH pointerleave and pointercancel. */
    handlePointerCancel: (e: PointerEvent) => void;
    handleClick: (e: MouseEvent) => void;
    handleContextMenu: (e: Event) => void;
    /** Clear any pending timer (call on component destroy). */
    destroy: () => void;
}

export function createHoldToAct(opts: HoldToActOptions): HoldToActHandlers {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let holding = false;
    let committed = false;

    function clearTimer(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function handlePointerDown(e: PointerEvent): void {
        if (!e.isPrimary) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // Touch (and pen) pointers are implicitly captured on pointerdown,
        // which suppresses the boundary events (pointerleave) the drag-away
        // cancel relies on. Release the implicit capture so sliding off the
        // element cancels the hold, matching mouse behavior.
        if (e.pointerType !== 'mouse') {
            const target = e.target as Element | null;
            try {
                target?.releasePointerCapture?.(e.pointerId);
            } catch {
                /* not captured / detached — boundary events already flow */
            }
        }
        clearTimer();
        holding = true;
        committed = false;
        opts.onHoldStart?.();
        timer = setTimeout(() => {
            timer = null;
            if (!holding) return;
            holding = false;
            committed = true;
            opts.onHoldCommit();
            opts.onHoldEnd?.();
        }, opts.thresholdMs);
    }

    function handlePointerUp(e: PointerEvent): void {
        if (!e.isPrimary) return;
        clearTimer();
        if (committed) {
            // Action already fired at the threshold; the release is inert.
            committed = false;
            return;
        }
        if (!holding) return;
        holding = false;
        opts.onTap();
        opts.onHoldEnd?.();
    }

    function handlePointerCancel(e: PointerEvent): void {
        if (!e.isPrimary) return;
        if (!holding) return;
        holding = false;
        clearTimer();
        opts.onHoldCancel?.();
        opts.onHoldEnd?.();
    }

    function handleClick(e: MouseEvent): void {
        // Pointer-driven clicks (detail >= 1) were fully handled by the
        // pointer handlers — swallow them so a tap can't double-fire.
        // Keyboard activation (Enter/Space) synthesizes a click with
        // detail === 0; treat it as a tap for accessibility.
        if (e.detail === 0) {
            opts.onTap();
        }
    }

    function handleContextMenu(e: Event): void {
        // Keep the browser's long-press/right-click menu from interrupting an
        // active hold (mobile long-press opens a context menu otherwise).
        if (holding || committed) e.preventDefault();
    }

    function destroy(): void {
        clearTimer();
        holding = false;
        committed = false;
    }

    return {
        handlePointerDown,
        handlePointerUp,
        handlePointerCancel,
        handleClick,
        handleContextMenu,
        destroy,
    };
}
