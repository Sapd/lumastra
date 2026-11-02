// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Action } from 'svelte/action';

/**
 * Svelte action that traps keyboard focus inside a container and returns focus
 * to the previously focused element when the container is destroyed.
 *
 * Usage:
 *   <div use:trapFocus>
 *       ...
 *       <button data-autofocus>Cancel</button>
 *   </div>
 *
 * Behavior:
 * - On mount, focuses the first element matching `[data-autofocus]` inside
 *   the node, or falls back to the first tabbable descendant.
 * - Intercepts `Tab` and `Shift+Tab` so focus cycles within the container
 *   instead of leaking to the underlying page.
 * - On destroy, returns focus to whichever element was focused when the
 *   action first ran (typically the trigger button that opened the modal).
 *
 * The action captures `document.activeElement` at mount to restore focus on
 * destroy. Callers must ensure the trigger has focus (usually automatic on
 * user click) before the node mounts; programmatic mounts without prior focus
 * may restore to `<body>`.
 *
 * If multiple elements carry `data-autofocus`, the first in document order
 * wins. Callers supplying child content with their own `data-autofocus`
 * should be aware that an inner value overrides the outer default.
 *
 * Use this for modal dialogs, drawers, and any overlay where focus must stay
 * within the overlay until it is dismissed.
 */
const FOCUSABLE_SELECTOR =
    'a[href], button, input:not([type="hidden"]), select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

export const trapFocus: Action<HTMLElement> = (node) => {
    const previouslyFocused =
        typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

    function isAvailable(el: HTMLElement): boolean {
        if (
            el.matches(':disabled') ||
            (el.hasAttribute('tabindex') && el.tabIndex < 0) ||
            el.closest('[hidden], [inert], [aria-hidden="true"]')
        )
            return false;
        // Responsive panels can remain mounted but be hidden by a media query.
        // Do not use geometry here: display:contents parents have no box.
        for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse'
            )
                return false;
            if (
                parent instanceof HTMLDetailsElement &&
                !parent.open &&
                !parent.querySelector('summary')?.contains(el)
            )
                return false;
            if (parent === node) break;
        }
        return true;
    }

    function getFocusables(): HTMLElement[] {
        return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
            isAvailable,
        );
    }

    // Defer autofocus to a microtask so the transition/render can finish
    // before we move focus. Without this, the browser sometimes keeps focus
    // on the previously focused element when the overlay mounts synchronously.
    queueMicrotask(() => {
        if (!node.isConnected) return;
        const explicit = node.querySelector<HTMLElement>('[data-autofocus]');
        const target = explicit && isAvailable(explicit) ? explicit : (getFocusables()[0] ?? node);
        target.focus();
    });

    function onKeydown(e: KeyboardEvent): void {
        if (e.key !== 'Tab' || e.defaultPrevented) return;
        // Native modal dialogs own their focus trap, even when rendered inside
        // this settings/drawer container rather than portalled to the body.
        const nativeDialog = e.target instanceof Element ? e.target.closest('dialog[open]') : null;
        if (nativeDialog && nativeDialog !== node) return;
        const list = getFocusables();
        if (list.length === 0) {
            // Nothing tabbable — prevent focus from escaping the container.
            e.preventDefault();
            return;
        }
        const first = list[0];
        const last = list[list.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const activeIndex = active ? list.indexOf(active) : -1;
        // Treat out-of-list focus (e.g. element disabled between Tab presses)
        // as being at the boundary so wrap-around still fires correctly.
        if (e.shiftKey && (active === first || activeIndex === -1 || !node.contains(active))) {
            e.preventDefault();
            e.stopPropagation();
            last.focus();
        } else if (
            !e.shiftKey &&
            (active === last || activeIndex === -1 || !node.contains(active))
        ) {
            e.preventDefault();
            e.stopPropagation();
            first.focus();
        }
    }

    node.addEventListener('keydown', onKeydown);

    return {
        destroy() {
            node.removeEventListener('keydown', onKeydown);
            // Restore focus to the trigger so keyboard users land where they
            // left off. Guarded because the previously-focused element may
            // have been removed from the DOM while the overlay was open.
            if (
                previouslyFocused &&
                typeof previouslyFocused.focus === 'function' &&
                document.contains(previouslyFocused)
            ) {
                previouslyFocused.focus();
            }
        },
    };
};
