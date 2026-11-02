// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { posterSizesFor, backdropSizesFor } from './media-card-sizes';

/** Largest declared SIZE in a `sizes` string — ignores media-query breakpoints. */
function widestPx(sizes: string): number {
    return Math.max(
        ...sizes.split(',').map((clause) => {
            const m = clause.trim().match(/(\d+)px$/);
            return m ? Number(m[1]) : 0;
        }),
    );
}

const GRID_POSTER_SIZES = '(max-width: 640px) 120px, (max-width: 1024px) 176px, 220px';
const GRID_BACKDROP_SIZES = '(max-width: 640px) 160px, (max-width: 1024px) 220px, 320px';

describe('card sizes', () => {
    it('widestPx reads sizes, not media-query breakpoints', () => {
        expect(widestPx('(max-width: 1024px) 96px, 128px')).toBe(128);
    });

    it('declares the exact width for a known carousel width class (w-32 poster)', () => {
        expect(posterSizesFor('carousel', 'w-32')).toBe('128px');
    });

    it('declares the exact width for a square-item carousel card (w-36), not the w-32 default', () => {
        // Regression pin: StandardSection resolves square-item carousel cards to
        // w-36 (144px), not the plain w-32 default (128px). A binary
        // carousel/grid flag that ignores the resolved width class would
        // declare 128px here -- an UNDER-declaration, the dangerous, blurry
        // direction we're specifically trying to avoid.
        expect(posterSizesFor('carousel', 'w-36')).toBe('144px');
    });

    it('declares the exact width for a carousel backdrop tile (w-44)', () => {
        expect(backdropSizesFor('carousel', 'w-44')).toBe('176px');
    });

    it('falls back to the responsive grid string when the width class is unknown or missing', () => {
        expect(posterSizesFor('carousel', 'w-96')).toBe(GRID_POSTER_SIZES);
        expect(posterSizesFor('carousel', undefined)).toBe(GRID_POSTER_SIZES);
        expect(backdropSizesFor('carousel', undefined)).toBe(GRID_BACKDROP_SIZES);
    });

    it('leaves the grid layout untouched regardless of widthClass', () => {
        expect(posterSizesFor('grid')).toBe(GRID_POSTER_SIZES);
        expect(posterSizesFor('grid', 'w-32')).toBe(GRID_POSTER_SIZES);
        expect(backdropSizesFor('grid', 'w-44')).toBe(GRID_BACKDROP_SIZES);
    });
});
