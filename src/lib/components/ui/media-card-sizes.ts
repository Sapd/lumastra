// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `sizes` per card layout.
 *
 * Grid cards get a responsive string -- the grid's own CSS breakpoints
 * change how many columns fit, so the card's rendered width genuinely
 * varies by viewport. Carousel cards render at a single, FIXED Tailwind
 * width class (see StandardSection.svelte's `resolvedCardWidth`) that never
 * changes across breakpoints, so a carousel card's `sizes` should declare
 * that one width directly rather than reusing the grid's (much larger)
 * responsive string.
 *
 * The carousel card's width class is not always `w-32` -- e.g. a
 * square-item carousel resolves to `w-36`, and a section can override it via
 * `cardWidthClass` / `meta.cardWidthOverride`. A binary carousel/grid flag
 * that ignored this would under-declare for any width wider than 128px --
 * the dangerous, blurry direction. So the functions below take the actual
 * resolved width class and look up its px value.
 *
 * `WIDTH_CLASS_PX` must stay in lockstep with StandardSection.svelte's
 * `multiRowColumnWidth` map (~line 736): both enumerate the same fixed
 * Tailwind width classes the card system uses (w-20 through w-48). If a
 * class is missing here, `posterSizesFor` / `backdropSizesFor` fall back to
 * the wider grid string rather than guessing -- again, the safe direction
 * (only wastes bytes; never blurry).
 */
export type CardSizeVariant = 'carousel' | 'grid';

const WIDTH_CLASS_PX: Record<string, number> = {
    'w-20': 80,
    'w-24': 96,
    'w-28': 112,
    'w-32': 128,
    'w-36': 144,
    'w-40': 160,
    'w-44': 176,
    'w-48': 192,
};

const GRID_POSTER_SIZES = '(max-width: 640px) 120px, (max-width: 1024px) 176px, 220px';
const GRID_BACKDROP_SIZES = '(max-width: 640px) 160px, (max-width: 1024px) 220px, 320px';

function exactWidthOrGridFallback(
    variant: CardSizeVariant,
    widthClass: string | undefined,
    gridSizes: string,
): string {
    if (variant === 'carousel' && widthClass) {
        const px = WIDTH_CLASS_PX[widthClass];
        if (px !== undefined) return `${px}px`;
    }
    return gridSizes;
}

export function posterSizesFor(variant: CardSizeVariant, widthClass?: string): string {
    return exactWidthOrGridFallback(variant, widthClass, GRID_POSTER_SIZES);
}

export function backdropSizesFor(variant: CardSizeVariant, widthClass?: string): string {
    return exactWidthOrGridFallback(variant, widthClass, GRID_BACKDROP_SIZES);
}
