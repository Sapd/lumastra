// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geometry for the episode hover panel, which docks in the dead gutter to the
 * right of the media modal.
 *
 * Pure by design: no DOM access, no window reads. Callers measure and pass rects
 * in. That keeps the only fiddly part of the feature unit-testable in the node
 * environment — note the structural input types rather than `DOMRect`, which does
 * not exist there. A real `DOMRect` satisfies them at the call site.
 */

/** Gap between the modal edge and the panel, and between the panel and the viewport edge. */
export const PANEL_MARGIN = 12;

/**
 * Narrowest panel worth showing. 280 rather than a rounder 320 is deliberate:
 * the visibility threshold is `1300 + 2 * (MIN_WIDTH + 2 * MARGIN)`, so 280 puts
 * it at 1908px and lets 1920px displays — the most common desktop width — qualify
 * with a 286px panel. At 320 the threshold would be 1988px and 1920 would miss.
 */
export const PANEL_MIN_WIDTH = 280;

/** Widest the panel grows on very wide displays; beyond this the line length hurts readability. */
export const PANEL_MAX_WIDTH = 420;

/** Minimum distance from the top and bottom viewport edges. */
export const PANEL_EDGE = 8;

export interface PanelPlacementInput {
    /**
     * Bounding rect of the `.modal-root` ancestor, or null when there is none —
     * `SeriesEpisodePicker` is also mounted in the search overlay, which has no
     * modal, and there the panel must not exist at all.
     */
    modalRect: { right: number } | null;
    /** Bounding rect of the hovered episode row. */
    anchorRect: { top: number };
    viewportWidth: number;
    viewportHeight: number;
    /** Measured height of the rendered panel. */
    panelHeight: number;
    /**
     * Space reserved at the bottom of the viewport — the music mini-player and
     * bottom nav. Mirrors the inset ModalContainer applies to its positioner.
     */
    bottomInset?: number;
}

export type PanelPlacement =
    { visible: false } | { visible: true; left: number; top: number; width: number };

const HIDDEN: PanelPlacement = { visible: false };

/**
 * Resolves a CSS length string (e.g. `"6.5rem"` or `"104px"`) to pixels, given
 * the root font size. `getComputedStyle().getPropertyValue()` on a custom
 * property returns its literal source text — `Number.parseFloat()` alone on
 * `"6.5rem"` silently yields `6.5`, not 104, if the caller forgets to resolve
 * the unit. Returns 0 for anything unparseable so an unset/garbage custom
 * property degrades to "no inset" instead of throwing.
 */
export function resolveCssLengthPx(raw: string, rootFontSizePx: number): number {
    const trimmed = raw.trim();
    const n = Number.parseFloat(trimmed);
    if (!Number.isFinite(n)) return 0;
    return trimmed.endsWith('rem') ? n * rootFontSizePx : n;
}

export function computePanelPlacement(input: PanelPlacementInput): PanelPlacement {
    const {
        modalRect,
        anchorRect,
        viewportWidth,
        viewportHeight,
        panelHeight,
        bottomInset = 0,
    } = input;

    // No modal ancestor (search overlay) — no gutter to dock into.
    if (modalRect === null) return HIDDEN;

    // Subtract BOTH margins: one between modal and panel, one between panel and
    // the viewport edge, so the panel never touches either.
    const available = viewportWidth - modalRect.right - 2 * PANEL_MARGIN;
    if (available < PANEL_MIN_WIDTH) return HIDDEN;

    // No lower clamp needed — the guard above already guarantees the minimum.
    const width = Math.min(available, PANEL_MAX_WIDTH);

    // Align to the anchor row, then clamp into the viewport. Math.max last so the
    // top edge wins when the panel is taller than the available vertical space.
    const maxTop = viewportHeight - bottomInset - panelHeight - PANEL_EDGE;
    const top = Math.max(PANEL_EDGE, Math.min(anchorRect.top, maxTop));

    return { visible: true, left: modalRect.right + PANEL_MARGIN, top, width };
}
