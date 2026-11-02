// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    computePanelPlacement,
    resolveCssLengthPx,
    PANEL_MARGIN,
    PANEL_MIN_WIDTH,
    PANEL_MAX_WIDTH,
} from './hover-panel-placement';

/**
 * Mirrors ModalMovie's sizing: `width: 95vw; max-width: 1300px`, centred.
 * Returns the modal's right edge in viewport coordinates.
 */
function centredModalRight(viewportWidth: number): number {
    const modalWidth = Math.min(viewportWidth * 0.95, 1300);
    return (viewportWidth + modalWidth) / 2;
}

function placeAt(viewportWidth: number) {
    return computePanelPlacement({
        modalRect: { right: centredModalRight(viewportWidth) },
        anchorRect: { top: 200 },
        viewportWidth,
        viewportHeight: 1080,
        panelHeight: 400,
        bottomInset: 0,
    });
}

describe('computePanelPlacement — horizontal gating', () => {
    it.each([
        [1280, 'hidden'],
        [1440, 'hidden'],
        [1680, 'hidden'],
    ])('hides the panel at %ipx (gutter too small)', (viewportWidth) => {
        expect(placeAt(viewportWidth).visible).toBe(false);
    });

    it('shows a 286px panel at 1920px, the marginal case', () => {
        const result = placeAt(1920);
        expect(result).toEqual({
            visible: true,
            left: centredModalRight(1920) + PANEL_MARGIN,
            top: 200,
            width: 286,
        });
    });

    it('respects the right viewport margin at the marginal width', () => {
        const result = placeAt(1920);
        if (!result.visible) throw new Error('expected visible');
        expect(result.left + result.width).toBe(1920 - PANEL_MARGIN);
    });

    it.each([2560, 3440])('caps the panel at MAX_WIDTH on %ipx displays', (viewportWidth) => {
        const result = placeAt(viewportWidth);
        if (!result.visible) throw new Error('expected visible');
        expect(result.width).toBe(PANEL_MAX_WIDTH);
    });
});

describe('computePanelPlacement — the 1908px threshold', () => {
    it('is visible exactly at 1908px', () => {
        const result = placeAt(1908);
        if (!result.visible) throw new Error('expected visible');
        expect(result.width).toBe(PANEL_MIN_WIDTH);
    });

    it('is hidden one pixel below, at 1907px', () => {
        expect(placeAt(1907).visible).toBe(false);
    });
});

describe('computePanelPlacement — vertical clamping', () => {
    function placeAtTop(anchorTop: number, bottomInset = 0) {
        return computePanelPlacement({
            modalRect: { right: centredModalRight(2560) },
            anchorRect: { top: anchorTop },
            viewportWidth: 2560,
            viewportHeight: 1080,
            panelHeight: 400,
            bottomInset,
        });
    }

    it('aligns to the anchor when it fits', () => {
        const result = placeAtTop(200);
        if (!result.visible) throw new Error('expected visible');
        expect(result.top).toBe(200);
    });

    it('clamps to the top edge for an anchor scrolled above the viewport', () => {
        const result = placeAtTop(-50);
        if (!result.visible) throw new Error('expected visible');
        expect(result.top).toBe(8);
    });

    it('clamps to the bottom edge for an anchor near the viewport floor', () => {
        const result = placeAtTop(900);
        if (!result.visible) throw new Error('expected visible');
        expect(result.top).toBe(1080 - 400 - 8);
    });

    it('lifts the bottom clamp by bottomInset so the mini-player is cleared', () => {
        const result = placeAtTop(900, 80);
        if (!result.visible) throw new Error('expected visible');
        expect(result.top).toBe(1080 - 80 - 400 - 8);
    });

    it('prefers the top edge when the panel is taller than the viewport', () => {
        const result = computePanelPlacement({
            modalRect: { right: centredModalRight(2560) },
            anchorRect: { top: 400 },
            viewportWidth: 2560,
            viewportHeight: 600,
            panelHeight: 900,
            bottomInset: 0,
        });
        if (!result.visible) throw new Error('expected visible');
        expect(result.top).toBe(8);
    });
});

describe('resolveCssLengthPx', () => {
    it('converts a rem value using the root font size', () => {
        expect(resolveCssLengthPx('6.5rem', 16)).toBe(104);
    });

    it('passes a px value through unchanged, ignoring the unit', () => {
        expect(resolveCssLengthPx('104px', 16)).toBe(104);
    });

    it('treats a unitless number as already being pixels', () => {
        expect(resolveCssLengthPx('104', 16)).toBe(104);
    });

    it('returns 0 for an empty string (custom property unset)', () => {
        expect(resolveCssLengthPx('', 16)).toBe(0);
    });

    it('returns 0 for a non-numeric value', () => {
        expect(resolveCssLengthPx('auto', 16)).toBe(0);
    });

    it('respects a non-default root font size when resolving rem', () => {
        expect(resolveCssLengthPx('2rem', 20)).toBe(40);
    });
});

describe('computePanelPlacement — surfaces with no modal', () => {
    it('hides when modalRect is null (the search overlay mounts the picker with no .modal-root)', () => {
        expect(
            computePanelPlacement({
                modalRect: null,
                anchorRect: { top: 200 },
                viewportWidth: 2560,
                viewportHeight: 1080,
                panelHeight: 400,
                bottomInset: 0,
            }).visible,
        ).toBe(false);
    });

    it('hides in page mode, where the modal spans the full viewport', () => {
        expect(
            computePanelPlacement({
                modalRect: { right: 1920 },
                anchorRect: { top: 200 },
                viewportWidth: 1920,
                viewportHeight: 700,
                panelHeight: 400,
                bottomInset: 0,
            }).visible,
        ).toBe(false);
    });

    it('treats a missing bottomInset as zero', () => {
        const result = computePanelPlacement({
            modalRect: { right: centredModalRight(2560) },
            anchorRect: { top: 900 },
            viewportWidth: 2560,
            viewportHeight: 1080,
            panelHeight: 400,
        });
        if (!result.visible) throw new Error('expected visible');
        expect(result.top).toBe(1080 - 400 - 8);
    });
});
