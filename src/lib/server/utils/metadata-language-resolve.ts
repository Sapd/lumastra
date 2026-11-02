// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read-path language resolution for the per-user metadata translation
 * overlay (spec §2). Turns a user's stored preferences into a concrete
 * language tag per field, or `null` when the primary (TMDB_LANGUAGE) copy
 * already stored on the base row should be served as-is — `null` always
 * means "skip the translation overlay for this field".
 */

import type postgres from 'postgres';
import { getLocale } from '$lib/paraglide/runtime.js';
import { config } from '$lib/server/config.js';
import { getRequestLanguageHint } from '$lib/server/utils/request-language-context.js';
import { negotiateLanguage } from '$lib/shared/accept-language.js';
import { normalizeLanguageTag, splitLanguageTag } from '$lib/shared/metadata-language.js';
import type { UserId } from '$lib/shared/user-id.js';

/** The two persisted per-user language preference columns. */
export interface MetadataLanguagePrefs {
    metadata_language: string | null;
    metadata_title_language: string | null;
}

/** Resolved overlay languages — `null` means "primary; skip overlay". */
export interface ResolvedMetadataLanguages {
    titleLang: string | null;
    textLang: string | null;
}

/** Bare (`en`) and full (`en-US`) forms of the configured primary language. */
function primaryTags(): { bare: string | null; full: string | null } {
    const raw = config.TMDB_LANGUAGE;
    if (!raw) return { bare: null, full: null };
    return { bare: splitLanguageTag(raw).lang, full: normalizeLanguageTag(raw) };
}

/** Admin-enabled language set: primary (bare + full) union additional languages. */
function adminEnabledLanguages(): Set<string> {
    const { bare, full } = primaryTags();
    const set = new Set<string>();
    if (bare) set.add(bare);
    if (full) set.add(full);
    for (const lang of config.METADATA_ADDITIONAL_LANGUAGES) set.add(lang);
    return set;
}

function isPrimaryLanguage(lang: string): boolean {
    const { bare, full } = primaryTags();
    return lang === bare || lang === full;
}

/** Current UI locale, or `null` if unavailable — never throws. */
function currentUiLocale(): string | null {
    try {
        return getLocale();
    } catch {
        return null;
    }
}

/**
 * Bare-language fallback used ONLY for the locale (null-pref) path: finds an
 * admin-enabled entry that shares the same bare language as `tag` (e.g. tag
 * `'de'`, enabled `['de-DE']` → `'de-DE'`; symmetric via `splitLanguageTag`
 * on both sides, so tag `'de-DE'` against enabled `['de']` also matches — the
 * Paraglide locale is always bare in practice, but this guards the reverse
 * direction too). Returns the ENABLED entry itself (the storage/lookup key),
 * never `tag` — a translation lookup must query by a language that rows were
 * actually written under.
 */
function bareLanguageFallback(tag: string, enabled: Set<string>): string | null {
    const bare = splitLanguageTag(tag).lang;
    for (const candidate of enabled) {
        if (splitLanguageTag(candidate).lang === bare) return candidate;
    }
    return null;
}

/**
 * Ambient (non-preference) resolution: cookie, then Accept-Language, then the
 * legacy UI locale when there is no request context at all.
 *
 * Branches on cookie PRESENCE, never on the cookie's result. A cookie that
 * resolves to primary and a cookie that resolves to nothing both end the chain
 * — neither falls through to the header. Falling through would override an
 * explicit UI-English choice with an ambient header, and for an unsatisfiable
 * cookie it could serve a THIRD language the user never chose (cookie 'de',
 * header 'fr', 'fr' enabled → French metadata under a German UI). Primary is
 * the correct answer for an unsatisfiable explicit choice, and it is also the
 * pre-existing behavior.
 */
function resolveAmbient(enabled: Set<string>): string | null {
    const hint = getRequestLanguageHint();

    if (hint) {
        if (hint.cookieLocale) {
            const normalized = normalizeLanguageTag(hint.cookieLocale);
            if (!normalized) return null;
            if (enabled.has(normalized)) return normalized;
            return bareLanguageFallback(normalized, enabled);
        }
        return negotiateLanguage(hint.acceptLanguage, enabled);
    }

    // No request context (background tasks, cache warming, direct unit calls):
    // keep the pre-existing UI-locale behavior exactly.
    const locale = currentUiLocale();
    const normalizedLocale = locale ? normalizeLanguageTag(locale) : null;
    if (!normalizedLocale) return null;
    if (enabled.has(normalizedLocale)) return normalizedLocale;
    return bareLanguageFallback(normalizedLocale, enabled);
}

/**
 * Resolves one field's preference value: an explicit value is used only if
 * still admin-enabled (exact match — no bare-language fallback: an explicit
 * user choice of 'de' must not silently promote to a 'de-DE' the user never
 * picked). A null value follows {@link resolveAmbient} (request-scoped
 * cookie/header hint, or the legacy UI locale outside a request). Either way,
 * a result equal to the primary language collapses to `null` (primary is
 * served from the base row, not overlaid).
 */
function resolveField(prefValue: string | null, enabled: Set<string>): string | null {
    let resolved: string | null;
    if (prefValue) {
        const normalized = normalizeLanguageTag(prefValue);
        resolved = normalized && enabled.has(normalized) ? normalized : null;
    } else {
        resolved = resolveAmbient(enabled);
    }
    return resolved && !isPrimaryLanguage(resolved) ? resolved : null;
}

/**
 * Resolves a user's stored metadata-language preferences into overlay
 * languages for title vs. text (overview/tagline). Never throws.
 */
export function resolveMetadataLanguage(
    prefs: MetadataLanguagePrefs | null,
): ResolvedMetadataLanguages {
    const enabled = adminEnabledLanguages();
    return {
        titleLang: resolveField(prefs?.metadata_title_language ?? null, enabled),
        textLang: resolveField(prefs?.metadata_language ?? null, enabled),
    };
}

/** No-overlay result — both fields primary. Shared constant to avoid re-alloc. */
const NO_OVERLAY: ResolvedMetadataLanguages = { titleLang: null, textLang: null };

/**
 * Async companion to {@link resolveMetadataLanguage}: loads the viewer's stored
 * language preferences (one indexed query) and resolves them, or the UI-locale
 * fallback when the user has none. Used by the surfaces that build media items
 * from raw watch-state rows (home hero + Continue Watching strip, the
 * `/api/recommendations` hero paths, the Active Streams widget) so they overlay
 * the same viewer-preferred title/overview the media modal already applies.
 *
 * Gated on `config.METADATA_ADDITIONAL_LANGUAGES` — a free synchronous config
 * read — so installs without additional languages issue ZERO queries and return
 * the no-overlay result. Never throws: a prefs read failure degrades to the
 * UI-locale fallback (`resolveMetadataLanguage(null)`), never blocking the page.
 */
export async function resolveViewerMetadataLanguages(
    sql: postgres.Sql | null | undefined,
    userId: UserId | null | undefined,
): Promise<ResolvedMetadataLanguages> {
    if (config.METADATA_ADDITIONAL_LANGUAGES.length === 0) return NO_OVERLAY;
    if (!sql || !userId) return resolveMetadataLanguage(null);
    try {
        const { getPlaybackPreferences } =
            await import('$lib/server/database/queries/user-preferences.queries.js');
        const prefs = await getPlaybackPreferences.one(sql, { userId });
        return resolveMetadataLanguage(prefs);
    } catch {
        // Prefs read failed — fall back to the UI locale rather than dropping
        // the overlay entirely (a German-UI user still gets German).
        return resolveMetadataLanguage(null);
    }
}
