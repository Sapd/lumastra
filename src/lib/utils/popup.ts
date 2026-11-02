// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Custom popup action - replacement for Skeleton's popup system
 * Uses floating-ui for positioning tooltips and dropdowns
 */
import {
    computePosition,
    autoUpdate,
    offset,
    shift,
    flip,
    size,
    type Placement,
} from '@floating-ui/dom';
import { navigating } from '$app/stores';

export interface PopupSettings {
    event: 'click' | 'hover' | 'focus-click' | 'focus-blur';
    target: string;
    placement?: Placement;
    middleware?: {
        offset?: number;
        shift?: boolean;
        flip?: boolean;
        arrow?: boolean;
    };
    /**
     * Click popups only: move focus to the first focusable element inside when
     * the popup opens (menus). Keyboard users otherwise had to Tab through the
     * whole page to reach a body-portalled popup.
     */
    focusOnOpen?: boolean;
}

// Track all active popups so we can close them on navigation
const activePopups = new Set<() => void>();

// Subscribe to navigation to close all popups when route changes
let navigationUnsubscribe: (() => void) | undefined;

function setupNavigationListener() {
    if (navigationUnsubscribe) return;

    if (typeof window !== 'undefined') {
        navigationUnsubscribe = navigating.subscribe((nav) => {
            if (nav) {
                // Navigation started - close all popups
                activePopups.forEach((hide) => hide());
            }
        });
    }
}

// Initialize navigation listener
setupNavigationListener();

/**
 * Popup action - attaches tooltip/dropdown behavior to an element
 *
 * Usage:
 * <button use:popup={settings}>Trigger</button>
 * <div data-popup="targetId">Content</div>
 */
export function popup(triggerNode: HTMLElement, args: PopupSettings) {
    const popupNode = document.querySelector(`[data-popup="${args.target}"]`) as HTMLElement;
    if (!popupNode) {
        console.warn(`Popup target "${args.target}" not found`);
        return {};
    }

    let cleanup: (() => void) | undefined;
    let isVisible = false;
    const isClick = args.event === 'click';

    // Screen readers were never told the trigger opens anything, or whether it
    // is open. Only set haspopup when the trigger has not declared its own.
    if (isClick) {
        if (!triggerNode.hasAttribute('aria-haspopup')) {
            triggerNode.setAttribute('aria-haspopup', 'true');
        }
        triggerNode.setAttribute('aria-expanded', 'false');
    }

    // Show popup
    function show() {
        if (isVisible) return;
        isVisible = true;
        popupNode.classList.add('popup-visible');
        if (isClick) triggerNode.setAttribute('aria-expanded', 'true');
        if (isClick && args.focusOnOpen) {
            // After the class flip has made the node visible and focusable.
            requestAnimationFrame(() => {
                popupNode
                    .querySelector<HTMLElement>(
                        'a[href], button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])',
                    )
                    ?.focus();
            });
        }

        // Position using floating-ui
        cleanup = autoUpdate(triggerNode, popupNode, () => {
            const middlewareList = [
                offset(args.middleware?.offset ?? 8),
                ...(args.middleware?.shift !== false ? [shift({ padding: 5 })] : []),
                ...(args.middleware?.flip !== false ? [flip({ padding: 50 })] : []),
                size({
                    padding: 16,
                    apply({ availableHeight, elements }) {
                        Object.assign(elements.floating.style, {
                            maxHeight: `${availableHeight}px`,
                            overflowY: 'auto',
                        });
                    },
                }),
            ];

            void computePosition(triggerNode, popupNode, {
                placement: args.placement ?? 'top',
                middleware: middlewareList,
            }).then(({ x, y }) => {
                Object.assign(popupNode.style, {
                    left: `${x}px`,
                    top: `${y}px`,
                    position: 'absolute',
                });
            });
        });
    }

    // Hide popup
    function hide() {
        if (!isVisible) return;
        isVisible = false;
        popupNode.classList.remove('popup-visible');
        if (isClick) triggerNode.setAttribute('aria-expanded', 'false');
        if (cleanup) {
            cleanup();
            cleanup = undefined;
        }
    }

    // Event handlers
    const handleClick = (e: Event) => {
        e.stopPropagation();
        if (isVisible) {
            hide();
        } else {
            show();
        }
    };

    const handleMouseEnter = () => show();
    const handleMouseLeave = () => hide();
    const handleFocus = () => show();
    const handleBlur = () => hide();

    // Click outside to close (for click events)
    const handleClickOutside = (e: MouseEvent) => {
        if (
            isVisible &&
            !triggerNode.contains(e.target as Node) &&
            !popupNode.contains(e.target as Node)
        ) {
            hide();
        }
    };

    // Escape closes a click popup and hands focus back to its trigger. It used
    // to do nothing — the menu stayed open until the next outside click.
    const handleKeydown = (e: KeyboardEvent) => {
        if (!isVisible || e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        const focusWasInside = popupNode.contains(document.activeElement);
        hide();
        if (focusWasInside || document.activeElement === document.body) triggerNode.focus();
    };

    // Tabbing out of a click popup closes it, so it never lingers open behind
    // the element that now has focus.
    const handleFocusOut = (e: FocusEvent) => {
        const next = e.relatedTarget as Node | null;
        if (!isVisible || !next) return;
        if (popupNode.contains(next) || triggerNode.contains(next)) return;
        hide();
    };

    // Attach event listeners based on event type
    if (args.event === 'click') {
        triggerNode.addEventListener('click', handleClick);
        document.addEventListener('click', handleClickOutside);
        document.addEventListener('keydown', handleKeydown);
        popupNode.addEventListener('focusout', handleFocusOut);
    } else if (args.event === 'hover') {
        triggerNode.addEventListener('mouseenter', handleMouseEnter);
        triggerNode.addEventListener('mouseleave', handleMouseLeave);
        popupNode.addEventListener('mouseenter', handleMouseEnter);
        popupNode.addEventListener('mouseleave', handleMouseLeave);
    } else if (args.event === 'focus-click') {
        triggerNode.addEventListener('focus', handleFocus);
        triggerNode.addEventListener('click', handleClick);
    } else if (args.event === 'focus-blur') {
        triggerNode.addEventListener('focus', handleFocus);
        triggerNode.addEventListener('blur', handleBlur);
    }

    // Ensure popup starts hidden (CSS handles this, but ensure class is removed)
    popupNode.classList.remove('popup-visible');

    // Register this popup's hide function for navigation cleanup
    activePopups.add(hide);

    // Cleanup function
    return {
        destroy() {
            hide();
            activePopups.delete(hide);
            if (args.event === 'click') {
                triggerNode.removeEventListener('click', handleClick);
                document.removeEventListener('click', handleClickOutside);
                document.removeEventListener('keydown', handleKeydown);
                popupNode.removeEventListener('focusout', handleFocusOut);
            } else if (args.event === 'hover') {
                triggerNode.removeEventListener('mouseenter', handleMouseEnter);
                triggerNode.removeEventListener('mouseleave', handleMouseLeave);
                popupNode.removeEventListener('mouseenter', handleMouseEnter);
                popupNode.removeEventListener('mouseleave', handleMouseLeave);
            } else if (args.event === 'focus-click') {
                triggerNode.removeEventListener('focus', handleFocus);
                triggerNode.removeEventListener('click', handleClick);
            } else if (args.event === 'focus-blur') {
                triggerNode.removeEventListener('focus', handleFocus);
                triggerNode.removeEventListener('blur', handleBlur);
            }
        },
    };
}

export type { Placement } from '@floating-ui/dom';
