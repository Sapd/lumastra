// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BCP-47-ish language tag utilities shared between the server config
 * (METADATA_ADDITIONAL_LANGUAGES) and client-side settings UI validation.
 */

const TAG_RE = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|[0-9]{3}))?$/i;

/** Default region to prefer per language when the admin code has no region. */
export const REGION_PREFERENCE: Record<string, string> = {
    de: 'DE',
    fr: 'FR',
    es: 'ES',
    pt: 'BR',
    zh: 'CN',
    ja: 'JP',
    en: 'US',
    it: 'IT',
    nl: 'NL',
};

/**
 * Normalizes a raw language tag to canonical case (`de`, `pt-BR`).
 * Accepts a two/three-letter language, optional four-letter script and optional
 * two-letter or three-digit region (e.g. zh-Hans-CN, es-419).
 */
export function normalizeLanguageTag(raw: string): string | null {
    const m = TAG_RE.exec(raw.trim());
    if (!m) return null;
    const lang = m[1].toLowerCase();
    const script = m[2] ? `${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}` : null;
    const region = m[3]?.toUpperCase();
    return [lang, script, region].filter(Boolean).join('-');
}

export function splitLanguageTag(tag: string): { lang: string; region: string | null } {
    const parts = TAG_RE.exec(tag.trim());
    return {
        lang: (parts?.[1] ?? tag.split('-')[0]).toLowerCase(),
        region: parts?.[3]?.toUpperCase() ?? null,
    };
}

/**
 * True when `tag` (an already-NORMALIZED tag — see {@link normalizeLanguageTag})
 * denotes the primary metadata language `primaryTag` (the raw TMDB_LANGUAGE
 * value), matching either its full normalized form (`en-US`) or its bare
 * language part (`en`).
 *
 * This is the ONE shared definition of "counts as the primary language" for
 * the METADATA_ADDITIONAL_LANGUAGES pipeline. Every consumer that reasons
 * about the EFFECTIVE additional-language set must use it, or the consumers
 * drift apart (the exact bug this fixed: the runtime getter excluded
 * primary-equal entries, but the settings-save diff in config.service.ts
 * didn't — so saving 'de, en' with TMDB_LANGUAGE='en-US' fired a
 * whole-catalog re-enroll for an "added" language that the effective config
 * never gained). Same "primary" semantics as
 * `metadata-language-resolve.ts`'s `isPrimaryLanguage()` and
 * `playback-preferences.ts`'s allowed-set construction — those two build a
 * {bare, full} set from server config directly; this parameterized form
 * exists because this module is client-shared and cannot import
 * `$lib/server/config`.
 */
export function isPrimaryLanguageTag(tag: string, primaryTag: string | null | undefined): boolean {
    if (!primaryTag) return false;
    return tag === normalizeLanguageTag(primaryTag) || tag === splitLanguageTag(primaryTag).lang;
}

interface TranslationLike {
    iso_639_1?: string;
    iso_3166_1?: string;
    data?: { overview?: string };
}

/** Deterministic variant selection per spec §1. */
export function pickTranslationEntry<T extends TranslationLike>(
    entries: T[],
    adminCode: string,
): T | null {
    const { lang, region } = splitLanguageTag(adminCode);
    const candidates = entries.filter((e) => e.iso_639_1?.toLowerCase() === lang);
    if (candidates.length === 0) return null;
    if (region) {
        return candidates.find((e) => e.iso_3166_1?.toUpperCase() === region) ?? null;
    }
    const preferred = REGION_PREFERENCE[lang];
    const score = (e: T): number =>
        (e.data?.overview?.trim() ? 2 : 0) + (e.iso_3166_1?.toUpperCase() === preferred ? 1 : 0);
    return [...candidates].sort((a, b) => score(b) - score(a))[0] ?? null;
}
