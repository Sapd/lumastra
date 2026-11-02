// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Countries whose age-rating systems the certification parser understands
 * (`certificationToAge`): FSK (DE), MPAA / TV Parental Guidelines (US), BBFC
 * (GB), classification (AU), Kijkwijzer (NL), CNC (FR), ICAA (ES).
 */
export const AGE_RATING_COUNTRIES = ['US', 'DE', 'GB', 'AU', 'NL', 'FR', 'ES'] as const;
export type AgeRatingCountry = (typeof AGE_RATING_COUNTRIES)[number];

/** Settings value meaning "derive the country from the metadata language". */
export const AGE_RATING_COUNTRY_AUTO = 'auto';

export const FALLBACK_AGE_RATING_COUNTRY: AgeRatingCountry = 'US';

const SUPPORTED = new Set<string>(AGE_RATING_COUNTRIES);

/** Bare language (no region) → the country whose rating system that audience uses. */
const LANGUAGE_COUNTRY: Record<string, AgeRatingCountry> = {
    en: 'US',
    de: 'DE',
    fr: 'FR',
    nl: 'NL',
    es: 'ES',
};

/** Regions that share a neighbour's system (Austria and Switzerland use FSK). */
const REGION_ALIAS: Record<string, AgeRatingCountry> = {
    AT: 'DE',
    CH: 'DE',
    UK: 'GB',
    NZ: 'AU',
};

/**
 * Default age-rating country for a BCP 47 metadata language tag:
 * de-DE → DE (FSK), en-US → US (MPAA), en-GB → GB (BBFC), en-AU → AU, fr-FR → FR…
 * A region we have no system for (ja-JP) falls back to US.
 */
export function defaultAgeRatingCountry(languageTag: string | null | undefined): AgeRatingCountry {
    const parts = (languageTag ?? '').trim().replace(/_/g, '-').split('-');
    const language = (parts[0] ?? '').toLowerCase();
    const region = parts.find((p, i) => i > 0 && /^[A-Za-z]{2}$/.test(p))?.toUpperCase();

    if (region) {
        if (SUPPORTED.has(region)) return region as AgeRatingCountry;
        const alias = REGION_ALIAS[region];
        if (alias) return alias;
    }
    return LANGUAGE_COUNTRY[language] ?? FALLBACK_AGE_RATING_COUNTRY;
}

/** The effective country for a setting value ('auto' or a code) and the metadata language. */
export function resolveAgeRatingCountry(
    setting: string | null | undefined,
    languageTag: string | null | undefined,
): AgeRatingCountry {
    const value = (setting ?? '').trim().toUpperCase();
    if (SUPPORTED.has(value)) return value as AgeRatingCountry;
    return defaultAgeRatingCountry(languageTag);
}
