// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The theme contract for plugin UI.
 *
 * Plugin widgets mount into the host document — no shadow DOM, no iframe — so
 * they already INHERIT every `:root` custom property. Passing a bag of values
 * into `mount()` is therefore mostly redundant transport; what was actually
 * missing is a statement of which tokens are stable contract and which are
 * host internals a plugin must not depend on.
 *
 * This list is that statement. Treat it as APPEND-ONLY: a plugin that styles
 * itself with `var(--color-surface-800)` breaks if that token disappears, and
 * removing or renaming an entry here is the one change in the UI surface that
 * would justify an ABI bump. Adding is free.
 *
 * Authors are told to use `var(--…)` directly. The bag stays available as
 * `ctx.theme` for the cases that need the computed value in JavaScript (canvas
 * drawing, a colour passed to a charting library) — and so the contract still
 * holds if a future surface ever does isolate plugin DOM.
 */
export const PLUGIN_THEME_TOKENS_V1 = [
    // Surfaces. The `-rgb` twins exist so a plugin can compose translucency
    // (`rgb(var(--color-surface-900-rgb) / 0.6)`) instead of parsing a hex
    // string at runtime, which is what the announcement widget does today.
    '--color-surface-950',
    '--color-surface-900',
    '--color-surface-800',
    '--color-surface-700',
    '--color-surface-600',
    '--color-surface-950-rgb',
    '--color-surface-900-rgb',
    '--color-surface-800-rgb',

    // Brand
    '--color-primary-400',
    '--color-primary-500',
    '--color-primary-600',
    '--color-secondary-500',
    '--color-tertiary-500',

    // Semantic. Distinct from brand on purpose — a plugin signalling an error
    // must not accidentally use the accent colour.
    '--color-success-500',
    '--color-warning-500',
    '--color-error-500',

    // Text + links
    '--text',
    '--text-hover',
    '--text-muted',
    '--link-color',
    '--link-color-hover',

    // Shape + type. Aliases defined for this contract so the underlying host
    // values can be retuned without breaking plugins.
    '--lum-radius-card',
    '--lum-radius-control',
    '--lum-font-body',
    '--lum-font-heading',
] as const;

export type PluginThemeToken = (typeof PLUGIN_THEME_TOKENS_V1)[number];

/** Resolve the contract tokens against the live document. Browser only. */
export function readPluginTheme(): Record<string, string> {
    const cs = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const token of PLUGIN_THEME_TOKENS_V1) {
        out[token] = cs.getPropertyValue(token).trim();
    }
    return out;
}
