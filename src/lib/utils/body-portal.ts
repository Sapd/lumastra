// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Svelte action that moves a node to document.body so it escapes any ancestor
 * stacking context. Use for popups/menus whose `z-index` would otherwise be
 * trapped beneath a fixed-position chrome (navbar, etc.) because an ancestor
 * created a stacking context with a lower z-index.
 *
 * The node is removed from body on destroy. We do NOT restore it to its
 * original DOM position — Svelte 5's {#if} cleanup may have already cleared
 * the anchor range by the time the action's destroy() runs, which would
 * orphan the node with nothing left to remove it.
 */
export function bodyPortal(node: HTMLElement): { destroy(): void } {
    document.body.appendChild(node);
    return {
        destroy() {
            node.remove();
        },
    };
}
