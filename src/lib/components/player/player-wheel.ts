// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Keep native menu scrolling ahead of the player's wheel volume shortcut. */
export function playerWheelAction(
    node: HTMLElement,
    onWheel: (event: WheelEvent) => void,
): { destroy(): void } {
    const handler = (event: WheelEvent): void => {
        // Svelte delegates onwheel to an ancestor above this native listener.
        // Menu stopPropagation handlers run too late to undo preventDefault.
        if (
            event.defaultPrevented ||
            (event.target instanceof Element &&
                event.target.closest('.player-menu, .player-drawer'))
        ) {
            return;
        }
        onWheel(event);
    };
    node.addEventListener('wheel', handler, { passive: false });
    return {
        destroy(): void {
            node.removeEventListener('wheel', handler);
        },
    };
}
