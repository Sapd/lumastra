// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Theme CSS generation.
 *
 * Turns the three admin "knobs" of each {@link ThemeDefinition} (accent seed,
 * surface-tint seed, starfield flag) into a `<style>` body that overrides the
 * Tailwind v4 `--color-surface-*` / `--color-primary-*` custom properties per
 * `[data-theme='<id>']`.
 *
 * Design:
 * - The CURRENT app.css ramps (warp) are treated as CANONICAL LADDERS: we
 *   convert each to OKLCH once (at module load, from the hardcoded hex arrays
 *   below) and keep the resulting Lightness (L) and Chroma (C) per step. When
 *   generating a new ramp from a seed we KEEP the ladder's L per step, take the
 *   HUE from the seed, and SCALE the ladder's chroma by how saturated the seed
 *   is relative to the ladder's own 500-step. A neutral (near-achromatic) seed
 *   therefore collapses the whole ramp toward grey; a vivid seed keeps roughly
 *   the ladder's saturation profile (capped so it can't blow out).
 * - Everything is dependency-free (no color libs): a ~60-line sRGB↔OKLCH
 *   converter using the standard Björn Ottosson matrices.
 * - `warp` emits NOTHING — the app.css `:root` block already IS warp, so
 *   existing installs get a byte-for-byte zero diff.
 */

import { isValidThemeId, type ThemeDefinition } from '$lib/shared/theme/theme-model';

// ============================================================================
// sRGB <-> OKLCH converter (Björn Ottosson matrices; standard sRGB gamma)
// ============================================================================

/** OKLCH triple: Lightness [0..1], Chroma [0..~0.4], hue in degrees [0..360). */
export interface Oklch {
    L: number;
    C: number;
    h: number;
}

function srgbChannelToLinear(c8: number): number {
    const c = c8 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearChannelToSrgb8(c: number): number {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function hexToRgb8(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [
        Number.parseInt(h.slice(0, 2), 16),
        Number.parseInt(h.slice(2, 4), 16),
        Number.parseInt(h.slice(4, 6), 16),
    ];
}

function rgb8ToHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Convert a 6-digit hex color to OKLCH. */
export function hexToOklch(hex: string): Oklch {
    const [R, G, B] = hexToRgb8(hex);
    const r = srgbChannelToLinear(R);
    const g = srgbChannelToLinear(G);
    const b = srgbChannelToLinear(B);

    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);

    const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
    const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
    const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

    const C = Math.sqrt(a * a + bb * bb);
    let h = (Math.atan2(bb, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { L, C, h };
}

/** Convert an OKLCH triple back to a 6-digit hex color (clamped to sRGB gamut). */
export function oklchToHex(L: number, C: number, h: number): string {
    const hr = (h * Math.PI) / 180;
    const a = C * Math.cos(hr);
    const bb = C * Math.sin(hr);

    const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
    const s_ = L - 0.0894841775 * a - 1.291485548 * bb;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

    return rgb8ToHex(linearChannelToSrgb8(r), linearChannelToSrgb8(g), linearChannelToSrgb8(b));
}

// ============================================================================
// Canonical ladders — derived from the CURRENT app.css ramps (= warp theme)
// ============================================================================

/** The 11 Tailwind ramp steps, in order. */
export const RAMP_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export type RampStep = (typeof RAMP_STEPS)[number];

// The exact hexes from src/app.css @theme (primary = indigo, surface = blue-tinted).
// These are the source of truth for the ladders below.
const PRIMARY_HEXES: Record<RampStep, string> = {
    50: '#eef2ff',
    100: '#e0e7ff',
    200: '#c7d2fe',
    300: '#a5b4fc',
    400: '#818cf8',
    500: '#6366f1',
    600: '#4f46e5',
    700: '#4338ca',
    800: '#3730a3',
    900: '#312e81',
    950: '#1e1b4b',
};

const SURFACE_HEXES: Record<RampStep, string> = {
    50: '#f1f3f9',
    100: '#dee3f1',
    200: '#c0c9e0',
    300: '#9eabcc',
    400: '#7180a8',
    500: '#4f5e8a',
    600: '#3c4971',
    700: '#313d61',
    800: '#2c3656',
    900: '#242c46',
    950: '#171d30',
};

/**
 * A canonical color ladder: per-step Lightness and Chroma extracted from a
 * reference ramp. Hue is intentionally NOT stored — it comes from the seed at
 * generation time.
 */
export interface ColorLadder {
    steps: readonly RampStep[];
    /** OKLCH Lightness per step (kept verbatim when regenerating). */
    L: readonly number[];
    /** OKLCH Chroma per step (scaled by seed saturation when regenerating). */
    C: readonly number[];
}

function deriveLadder(hexes: Record<RampStep, string>): ColorLadder {
    const L: number[] = [];
    const C: number[] = [];
    for (const step of RAMP_STEPS) {
        const { L: l, C: c } = hexToOklch(hexes[step]);
        L.push(l);
        C.push(c);
    }
    return { steps: RAMP_STEPS, L, C };
}

/**
 * PRIMARY (indigo) ladder — derived once from PRIMARY_HEXES.
 *   L: 0.9619, 0.9299, 0.8699, 0.7853, 0.6801, 0.5854, 0.5106, 0.4568, 0.3984, 0.3588, 0.2573
 *   C: 0.0179, 0.0334, 0.0622, 0.1041, 0.1583, 0.2041, 0.2301, 0.2146, 0.1773, 0.1354, 0.0861
 */
export const PRIMARY_LADDER: ColorLadder = deriveLadder(PRIMARY_HEXES);

/**
 * SURFACE (blue-tinted) ladder — derived once from SURFACE_HEXES.
 *   L: 0.9643, 0.9162, 0.8362, 0.7423, 0.6031, 0.4885, 0.4128, 0.3669, 0.3395, 0.2986, 0.2348
 *   C: 0.0083, 0.0198, 0.0336, 0.0499, 0.0637, 0.0734, 0.0693, 0.0643, 0.0581, 0.0487, 0.0379
 */
export const SURFACE_LADDER: ColorLadder = deriveLadder(SURFACE_HEXES);

/**
 * Tailwind v4's default `gray` palette. It is BLUE-tinted (hue ~230-260,
 * chroma up to ~0.03) — enough to read as navy next to a neutral graphite
 * theme. The app uses `gray-*` fills widely (e.g. the shared `.card-glass`
 * utility on settings cards), so non-warp themes override `--color-gray-*`
 * with a ramp re-hued to the theme's surfaceTint (Tailwind v4 utilities
 * resolve through the var, so every `bg-gray-800/50` follows automatically).
 */
const GRAY_HEXES: Record<RampStep, string> = {
    50: '#f9fafb',
    100: '#f3f4f6',
    200: '#e5e7eb',
    300: '#d1d5db',
    400: '#9ca3af',
    500: '#6b7280',
    600: '#4b5563',
    700: '#374151',
    800: '#1f2937',
    900: '#111827',
    950: '#030712',
};

/** GRAY (Tailwind default) ladder — derived once from GRAY_HEXES. */
export const GRAY_LADDER: ColorLadder = deriveLadder(GRAY_HEXES);

/** Index of the 500 step in RAMP_STEPS — the ladder's chroma reference point. */
const STEP_500_INDEX = RAMP_STEPS.indexOf(500);

// ============================================================================
// Ramp generation
// ============================================================================

/**
 * Generate an 11-step hex ramp from a single seed color, following a canonical
 * ladder.
 *
 * - Lightness per step is taken verbatim from the ladder (preserving the exact
 *   perceptual light/dark structure the app was designed around).
 * - Hue is the seed's hue, applied uniformly to every step.
 * - Chroma per step is the ladder's chroma SCALED by `seedC / referenceC500`
 *   (default: the ladder's own C@500), so the seed's own saturation sets the
 *   overall vividness. The scale is CLAMPED per step to `[0, ladderC * 1.15]`:
 *   a near-neutral seed (seedC ≈ 0) drives the whole ramp's chroma toward 0
 *   (a genuinely neutral grey scale), while a very vivid seed can't push any
 *   step beyond 115% of the reference chroma (avoids gamut-clipped mush at
 *   the saturated mid-steps).
 *
 * `referenceC500` matters for NEAR-NEUTRAL ladders like Tailwind's gray:
 * dividing a subtle seed's chroma by the gray ladder's own tiny C@500 yields
 * a scale near 1 and re-amplifies the ladder's blue cast. Pass the SURFACE
 * ladder's C@500 instead so "how saturated is this seed" is always judged
 * against the surface norm, and a graphite seed produces a truly neutral gray.
 */
export function generateRamp(
    seed: string,
    ladder: ColorLadder,
    referenceC500 = ladder.C[STEP_500_INDEX],
): Record<RampStep, string> {
    const seedOklch = hexToOklch(seed);
    // Guard against a degenerate reference (C@500 === 0); fall back to no scaling.
    const scale = referenceC500 > 0 ? seedOklch.C / referenceC500 : 0;

    const ramp = {} as Record<RampStep, string>;
    ladder.steps.forEach((step, i) => {
        const ladderC = ladder.C[i];
        const chroma = Math.max(0, Math.min(ladderC * scale, ladderC * 1.15));
        ramp[step] = oklchToHex(ladder.L[i], chroma, seedOklch.h);
    });
    return ramp;
}

// ============================================================================
// Full theme stylesheet
// ============================================================================

/**
 * Steps that also have a space-separated `--color-*-rgb` triplet twin in
 * app.css (used by `rgb(var(--…-rgb) / α)` translucency patterns across the
 * app). These MUST be overridden per theme too, or every translucent surface
 * (nav bar, cards, hero buttons) keeps mixing from the base indigo palette.
 * Surface has all 11 steps; primary's base set stops at 900.
 */
const PRIMARY_RGB_STEPS = RAMP_STEPS.filter((s) => s !== 950);

/** `#rrggbb` → `R G B` (CSS Color Level 4 space-separated triplet). */
function hexToTriplet(hex: string): string {
    return `${parseInt(hex.slice(1, 3), 16)} ${parseInt(hex.slice(3, 5), 16)} ${parseInt(hex.slice(5, 7), 16)}`;
}

/**
 * Emit the `--color-*` custom-property declarations for a single theme:
 * 22 hex vars plus their `-rgb` triplet twins (11 surface + 10 primary).
 */
function emitThemeVars(theme: ThemeDefinition): string {
    const surface = generateRamp(theme.surfaceTint, SURFACE_LADDER);
    const primary = generateRamp(theme.accent, PRIMARY_LADDER);
    const gray = generateRamp(theme.surfaceTint, GRAY_LADDER, SURFACE_LADDER.C[STEP_500_INDEX]);
    const lines: string[] = [];
    for (const step of RAMP_STEPS) {
        lines.push(`--color-surface-${step}: ${surface[step]};`);
    }
    for (const step of RAMP_STEPS) {
        lines.push(`--color-primary-${step}: ${primary[step]};`);
    }
    for (const step of RAMP_STEPS) {
        lines.push(`--color-gray-${step}: ${gray[step]};`);
    }
    for (const step of RAMP_STEPS) {
        lines.push(`--color-surface-${step}-rgb: ${hexToTriplet(surface[step])};`);
    }
    for (const step of PRIMARY_RGB_STEPS) {
        lines.push(`--color-primary-${step}-rgb: ${hexToTriplet(primary[step])};`);
    }
    return lines.join(' ');
}

/**
 * Generate the full theme stylesheet for the given themes.
 *
 * For every theme EXCEPT `warp` (and skipping any with an invalid id):
 *   `html[data-theme='<id>'] { ...--color vars + -rgb triplets... }`
 * plus, only when `starfield === false`:
 *   `html[data-theme='<id>'] .app-starfield { display: none; }`
 *
 * The selector MUST be `html[data-theme]`, not bare `[data-theme]`: the hex
 * vars in app.css live in Tailwind's `@layer theme` (unlayered rules always
 * win over those), but the `-rgb` triplet twins sit in a plain unlayered
 * `:root` block — specificity (0,1,0) ties a bare attribute selector and
 * then SOURCE ORDER decides, which flips between dev (vite appends app.css
 * after the SSR style tag) and prod. `html[data-theme]` is (0,1,1) and wins
 * everywhere unconditionally.
 *
 * `warp` deliberately emits nothing (app.css `:root` already is warp → zero
 * diff for existing users). The returned string is safe to inline verbatim into
 * a `<style>` element: ids are validated against the CSS-safe id charset, and
 * every color is a `#rrggbb` literal or space-separated RGB triplet.
 */
export function generateThemeCss(themes: ThemeDefinition[]): string {
    const blocks: string[] = [];
    for (const theme of themes) {
        if (theme.id === 'warp') continue; // app.css :root IS warp
        if (!isValidThemeId(theme.id)) continue; // skip malformed ids (defensive)

        blocks.push(`html[data-theme='${theme.id}'] { ${emitThemeVars(theme)} }`);
        if (theme.starfield === false) {
            blocks.push(`html[data-theme='${theme.id}'] .app-starfield { display: none; }`);
        }
    }
    return blocks.join('\n');
}
