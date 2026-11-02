// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Enabled-theme resolution + cached theme stylesheet.
 *
 * Bridges the config layer (built-in themes + admin-supplied
 * `APPEARANCE_CUSTOM_THEMES`, `APPEARANCE_DEFAULT_THEME`) and the pure CSS
 * generator in {@link ./theme-css}. Also owns the small module-level cache the
 * SSR hook uses so the (cheap but not free) OKLCH ramp generation runs once per
 * config state rather than per request.
 */

import { config } from '$lib/server/config.js';
import { get as getConfigValue, getConfigState } from '$lib/server/config/config.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    BUILTIN_THEMES,
    DEFAULT_THEME_ID,
    isValidThemeId,
    type ThemeDefinition,
} from '$lib/shared/theme/theme-model';
import { ThemeDefinitionSchema } from '$lib/schemas/theme';
import { generateThemeCss } from './theme-css.js';

const logger = Logger.for('Theme');

/** Built-in ids customs may never shadow. */
const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id));

/**
 * Resolve + validate the admin-supplied custom themes.
 *
 * Reads `APPEARANCE_CUSTOM_THEMES` (a JSON array of theme definitions) from the
 * config service, validates each entry with {@link ThemeDefinitionSchema}, and
 * drops invalid ones — and any that collide with a built-in id or duplicate an
 * earlier custom id — with a logged warning. Never throws.
 */
function getValidatedCustomThemes(): ThemeDefinition[] {
    const raw = getConfigValue<unknown>('APPEARANCE_CUSTOM_THEMES');
    if (!Array.isArray(raw)) return [];

    const out: ThemeDefinition[] = [];
    const seen = new Set<string>(BUILTIN_IDS);
    for (const entry of raw) {
        const parsed = ThemeDefinitionSchema.safeParse(entry);
        if (!parsed.success) {
            logger.warn('Dropping invalid custom theme', {
                error: parsed.error.issues
                    .map((i) => `${i.path.join('.')}: ${i.message}`)
                    .join('; '),
            });
            continue;
        }
        const theme = parsed.data;
        if (seen.has(theme.id)) {
            logger.warn('Dropping custom theme with reserved/duplicate id', { id: theme.id });
            continue;
        }
        seen.add(theme.id);
        // Customs are never builtin, regardless of what the JSON claimed.
        out.push({ ...theme, builtin: false });
    }
    return out;
}

/**
 * The full set of themes available on this install: the built-ins followed by
 * the valid admin customs. Customs may NOT override built-in ids (enforced in
 * {@link getValidatedCustomThemes}).
 */
export function getEnabledThemes(): ThemeDefinition[] {
    return [...BUILTIN_THEMES, ...getValidatedCustomThemes()];
}

/**
 * Resolve the active theme id for a request.
 *
 * Precedence: a cookie value that names an enabled theme → the configured
 * `APPEARANCE_DEFAULT_THEME` (when it names an enabled theme) → `warp`.
 */
export function resolveActiveThemeId(
    cookieValue: string | undefined,
    themes: ThemeDefinition[] = getEnabledThemes(),
): string {
    const enabledIds = new Set(themes.map((t) => t.id));

    if (cookieValue && isValidThemeId(cookieValue) && enabledIds.has(cookieValue)) {
        return cookieValue;
    }
    const configured = config.APPEARANCE_DEFAULT_THEME;
    if (configured && enabledIds.has(configured)) {
        return configured;
    }
    return DEFAULT_THEME_ID;
}

// ============================================================================
// Cached stylesheet
// ============================================================================
//
// The generated CSS only changes when the theme config changes. The config
// service updates `configState.loadedAt` on every save / cross-replica reload,
// so we key the cache on that timestamp (primary invalidation signal) with a
// short TTL as a belt-and-braces fallback in case a state mutation ever bypasses
// loadedAt.

const THEME_CSS_TTL_MS = 30_000;

interface ThemeCssCache {
    css: string;
    loadedAtMs: number;
    computedAt: number;
}
let themeCssCache: ThemeCssCache | null = null;

/**
 * The generated theme stylesheet for all enabled themes (cached). Recomputes
 * when the config state's `loadedAt` changes or the TTL lapses.
 */
export function getThemeTokensCss(): string {
    const loadedAtMs = getConfigState()?.loadedAt.getTime() ?? 0;
    const now = Date.now();
    if (
        themeCssCache &&
        themeCssCache.loadedAtMs === loadedAtMs &&
        now - themeCssCache.computedAt < THEME_CSS_TTL_MS
    ) {
        return themeCssCache.css;
    }
    const css = generateThemeCss(getEnabledThemes());
    themeCssCache = { css, loadedAtMs, computedAt: now };
    return css;
}

/** Test/hot-reload helper: drop the cached stylesheet. */
export function _resetThemeCssCache(): void {
    themeCssCache = null;
}
