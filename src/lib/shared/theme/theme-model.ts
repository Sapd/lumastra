// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Theme model — shared between client and server.
 *
 * SINGLE SOURCE OF TRUTH for the theming-engine data contract. This module has
 * NO server-only imports (no `fs`, no `$lib/server/*`) so it can be imported
 * from client components (theme pickers) and from server code (SSR wiring,
 * CSS generation) alike.
 *
 * The runtime-validation Zod schema for admin-supplied theme definitions lives
 * in `$lib/schemas/theme` (repo convention: schemas are the validation source
 * of truth). The plain interfaces below are the ambient TypeScript contract
 * other modules build against; the schema's inferred type is asserted to match
 * them at compile time in that file.
 */

/**
 * The three admin-tunable "knobs" that define a theme's look. Everything else
 * (the full 11-step surface + primary OKLCH ramps) is DERIVED from these seeds
 * by the server CSS generator — admins never hand-pick 22 hex values.
 */
export interface ThemeKnobs {
    /** Accent seed color (hex) — generates the primary-50..950 ramp. */
    accent: string;
    /** Surface tint seed (hex) — sets the hue/chroma character of the surface-50..950 ramp. */
    surfaceTint: string;
    /**
     * Whether the decorative starfield background is shown FOR THIS THEME.
     *
     * This is per-theme INTENT, not a global switch. It composes with the
     * existing global admin kill-switch `FEATURE_STARS_BACKGROUND`
     * (config schema ~`section: 'homepage'`, default true; exposed to the
     * client as `appConfig.starsBackground`):
     *
     *   effective starfield visibility = FEATURE_STARS_BACKGROUND && theme.starfield
     *
     * The two are enforced by DIFFERENT mechanisms and are intentionally NOT
     * code-coupled:
     *   - `FEATURE_STARS_BACKGROUND === false` → the `.app-starfield` element is
     *     not rendered at all (the global admin kill-switch).
     *   - `theme.starfield === false` → the element still renders, but the
     *     generated stylesheet emits
     *     `[data-theme='<id>'] .app-starfield { display: none }`, hiding it only
     *     while that theme is active.
     *
     * So a theme that wants stars (`starfield: true`) still shows nothing when
     * the operator has globally disabled the background; and a theme that
     * suppresses stars (`starfield: false`) hides them even when the global
     * flag is on. No runtime coupling is required — just this composition.
     */
    starfield: boolean;
}

/**
 * A complete, addressable theme = the knobs plus identity metadata. The `id`
 * is used verbatim as the `data-theme` attribute value on `<html>` and inside
 * the generated CSS attribute selectors, so it is constrained to a CSS-safe,
 * URL-safe character set (see {@link isValidThemeId}).
 */
export interface ThemeDefinition extends ThemeKnobs {
    /** kebab-case, `[a-z0-9-]{1,32}` — used as the `data-theme` attribute value. */
    id: string;
    /** Human-readable display name shown in theme pickers. */
    name: string;
    /** True for the shipped built-in themes; admins cannot override these ids. */
    builtin?: boolean;
}

/**
 * The built-in themes shipped with the app.
 *
 * `warp` MUST match the `:root` values in `src/app.css` exactly (accent =
 * primary-500 #6366f1, surfaceTint = surface-500 #4f5e8a, starfield on). The
 * CSS generator emits NOTHING for `warp` — the app.css `:root` block already
 * IS the warp theme, giving existing installs a byte-for-byte zero-diff
 * default.
 *
 * `marquee` is a graphite/gold alternate with the starfield suppressed.
 */
export const BUILTIN_THEMES: ThemeDefinition[] = [
    {
        id: 'warp',
        name: 'Warp',
        accent: '#6366f1',
        surfaceTint: '#4f5e8a',
        starfield: true,
        builtin: true,
    },
    // marquee's surfaceTint is EXACTLY neutral (#171717): any hue in the seed
    // tints the whole surface/gray ramp — the original #16181d (hue ~265)
    // left every panel reading faintly blue, which users clocked immediately.
    {
        id: 'marquee',
        name: 'Marquee',
        accent: '#e8a33d',
        surfaceTint: '#171717',
        starfield: false,
        builtin: true,
    },
];

/** The id served when no cookie / configured default resolves to an enabled theme. */
export const DEFAULT_THEME_ID = 'warp';

/** Name of the cookie carrying the user's selected theme id. */
export const THEME_COOKIE = 'lumastra_theme';

/**
 * Allowed shape of a theme id: lowercase kebab-case, 1–32 chars. This set is
 * safe to interpolate directly into a `[data-theme='<id>']` CSS selector and a
 * `data-theme="<id>"` HTML attribute without escaping (no quotes, angle
 * brackets, backslashes, or whitespace are possible).
 */
export const THEME_ID_REGEX = /^[a-z0-9-]{1,32}$/;

/** Whether `id` is a valid, CSS/attribute-safe theme id. */
export function isValidThemeId(id: string): boolean {
    return THEME_ID_REGEX.test(id);
}
