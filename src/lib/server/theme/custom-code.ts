// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin-provided custom CSS / custom JS injection.
 *
 * Reads `APPEARANCE_CUSTOM_CSS` / `APPEARANCE_CUSTOM_JS` from the config
 * service and builds the ready-to-inline `<style id="custom-css">` /
 * `<script id="custom-js">` tags the SSR hook injects into every page.
 *
 * SECURITY MODEL — deliberate admin trust: the content is executed/applied for
 * every user on every page with NO sanitization. The ONLY hardening applied is
 * STRUCTURAL: the payload must not be able to break out of its own element and
 * rewrite the surrounding document, so
 *   - CSS: every `</style` sequence (case-insensitive) is stripped, and
 *   - JS:  every `</script` sequence (case-insensitive) is rewritten to
 *     `<\/script` — a no-op inside JS string/regex literals (where a legit
 *     occurrence could live), and anything relying on a bare `</script` outside
 *     a literal was already broken HTML.
 * Everything else passes through verbatim. The generated tags are cached with
 * the same config-state signal + short-TTL scheme as getThemeTokensCss().
 */

import { get as getConfigValue, getConfigState } from '$lib/server/config/config.service.js';

// ============================================================================
// Pure hardening + tag builders (unit-tested; no config access)
// ============================================================================

/**
 * Strip every `</style` sequence (case-insensitive) so the CSS cannot close its
 * host `<style>` element. Looped to a fixed point because stripping can itself
 * splice a new `</style` together (e.g. `</sty</stylele`).
 */
export function neutralizeCustomCss(css: string): string {
    let out = css;
    let prev: string;
    do {
        prev = out;
        out = out.replace(/<\/style/gi, '');
    } while (out !== prev);
    return out;
}

/**
 * Rewrite every `</script` sequence (case-insensitive) to `<\/script` so the
 * JS cannot close its host `<script>` element. Inside a JS string or regex
 * literal `<\/` evaluates identically to `</`, so legitimate embedded markup
 * keeps working; a bare `</script` outside a literal was broken anyway. The
 * matched tag-name case is preserved. A single pass suffices: the inserted
 * `\` can never combine with surrounding text into a new `</script`.
 */
export function neutralizeCustomJs(js: string): string {
    return js.replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * Build the inline `<style id="custom-css">` tag for the given admin CSS, or
 * '' when there is no effective content (empty / whitespace-only).
 */
export function buildCustomCssTag(css: string): string {
    if (!css || css.trim() === '') return '';
    return `<style id="custom-css">${neutralizeCustomCss(css)}</style>`;
}

/**
 * Build the inline `<script id="custom-js">` tag for the given admin JS, or
 * '' when there is no effective content (empty / whitespace-only).
 */
export function buildCustomJsTag(js: string): string {
    if (!js || js.trim() === '') return '';
    return `<script id="custom-js">${neutralizeCustomJs(js)}</script>`;
}

// ============================================================================
// Cached config-backed getters (same scheme as getThemeTokensCss)
// ============================================================================

const CUSTOM_CODE_TTL_MS = 30_000;

interface CustomCodeCache {
    cssTag: string;
    jsTag: string;
    loadedAtMs: number;
    computedAt: number;
}
let customCodeCache: CustomCodeCache | null = null;

function getCustomCodeTags(): CustomCodeCache {
    const loadedAtMs = getConfigState()?.loadedAt.getTime() ?? 0;
    const now = Date.now();
    if (
        customCodeCache &&
        customCodeCache.loadedAtMs === loadedAtMs &&
        now - customCodeCache.computedAt < CUSTOM_CODE_TTL_MS
    ) {
        return customCodeCache;
    }
    const rawCss = getConfigValue<unknown>('APPEARANCE_CUSTOM_CSS');
    const rawJs = getConfigValue<unknown>('APPEARANCE_CUSTOM_JS');
    customCodeCache = {
        cssTag: buildCustomCssTag(typeof rawCss === 'string' ? rawCss : ''),
        jsTag: buildCustomJsTag(typeof rawJs === 'string' ? rawJs : ''),
        loadedAtMs,
        computedAt: now,
    };
    return customCodeCache;
}

/** The inline custom-CSS `<style>` tag for the current config ('' when unset). Cached. */
export function getCustomCssTag(): string {
    return getCustomCodeTags().cssTag;
}

/** The inline custom-JS `<script>` tag for the current config ('' when unset). Cached. */
export function getCustomJsTag(): string {
    return getCustomCodeTags().jsTag;
}

/** Test/hot-reload helper: drop the cached tags. */
export function _resetCustomCodeCache(): void {
    customCodeCache = null;
}
