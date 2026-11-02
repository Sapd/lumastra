// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Action } from 'svelte/action';

/**
 * Svelte action that fires a callback when a click lands outside `node`.
 *
 * Usage: `<div use:clickOutside={handleClose}>`
 *
 * The document-level listener is attached on the next tick so the same
 * click that mounted the element (typical flow: clicking a trigger button
 * sets `open = true` and reactively renders a popover using this action)
 * does not immediately bubble into the listener and close it. Without the
 * deferral the popover appears to "flash" open for a few frames as the
 * opening transition starts and is immediately reversed.
 */
export const clickOutside: Action<HTMLElement, () => void> = (node, callback) => {
    let currentCallback = callback;

    const handleClick = (event: MouseEvent) => {
        if (!node.contains(event.target as Node)) {
            currentCallback?.();
        }
    };

    const armTimer = setTimeout(() => {
        document.addEventListener('click', handleClick);
    }, 0);

    return {
        update(newCallback) {
            currentCallback = newCallback;
        },
        destroy() {
            clearTimeout(armTimer);
            document.removeEventListener('click', handleClick);
        },
    };
};
