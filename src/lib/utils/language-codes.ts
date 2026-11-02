// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isUnknownLanguage, normalizeLanguage } from '$lib/shared/language-codes';

export { localizedLanguageName } from '$lib/shared/language-codes';

const DISPLAY_CODE_TO_NAME: Record<string, string> = {
    EN: 'English',
    JA: 'Japanese',
    FR: 'French',
    DE: 'German',
    ES: 'Spanish',
    PT: 'Portuguese',
    IT: 'Italian',
    KO: 'Korean',
    ZH: 'Chinese',
    RU: 'Russian',
    AR: 'Arabic',
    HI: 'Hindi',
    TR: 'Turkish',
    PL: 'Polish',
    NL: 'Dutch',
    SV: 'Swedish',
    NO: 'Norwegian',
    DA: 'Danish',
    FI: 'Finnish',
    CS: 'Czech',
    HU: 'Hungarian',
    RO: 'Romanian',
    UK: 'Ukrainian',
    VI: 'Vietnamese',
    TH: 'Thai',
    HE: 'Hebrew',
    ID: 'Indonesian',
    MS: 'Malay',
    ML: 'Malayalam',
    '??': 'Unknown',
};

export function iso639ToDisplayCode(code: string): string {
    if (isUnknownLanguage(code)) return '??';
    const normalized = normalizeLanguage(code);
    return normalized.length === 2 ? normalized.toUpperCase() : code.slice(0, 2).toUpperCase();
}

export function iso639ToDisplayName(code: string): string {
    const display = iso639ToDisplayCode(code);
    return DISPLAY_CODE_TO_NAME[display] ?? display;
}

/**
 * Normalize an ffprobe/DB language tag (639-2/B, 639-2/T, or 639-1) to a single
 * lowercase ISO 639-1 code, or null for empty/undetermined/unmapped tags. Reuses
 * the shared language table so there is exactly one language table in the
 * codebase (`$lib/shared/language-codes`).
 *
 * This is NOT a plain alias for `normalizeLanguage` — it preserves its own
 * contract (null for empty/undetermined/unmapped-3-letter), which differs from
 * `normalizeLanguage` (returns the raw input lowercased; 'und' stays 'und').
 * `media-stream-summary.queries.ts` relies on undetermined tags NOT counting as
 * real languages in its rollup.
 */
export function normalizeToIso6391(raw: string | null | undefined): string | null {
    if (isUnknownLanguage(raw)) return null;
    const normalized = normalizeLanguage(raw);
    return normalized.length === 2 ? normalized : null;
}

function canonicalLanguageCode(value: string): string {
    const normalized = normalizeLanguage(value).split('-')[0];
    return normalized === '??' || isUnknownLanguage(normalized) ? '??' : normalized.toUpperCase();
}

/** Server primary, additional metadata languages, original language, then other codes. */
export function sortLanguageCodes(
    languages: readonly string[],
    preferred: readonly string[] = [],
    originalLanguage?: string,
): string[] {
    const priority = [
        ...new Set(
            [...preferred, ...(originalLanguage ? [originalLanguage] : [])].map(
                canonicalLanguageCode,
            ),
        ),
    ];
    return [...new Set(languages.map(canonicalLanguageCode))].sort((a, b) => {
        if (a === '??' || b === '??') return a === b ? 0 : a === '??' ? 1 : -1;
        const rankA = priority.indexOf(a);
        const rankB = priority.indexOf(b);
        return (
            (rankA < 0 ? priority.length : rankA) - (rankB < 0 ? priority.length : rankB) ||
            a.localeCompare(b)
        );
    });
}

/** Stable presentation order: preserve track indices, variants, and the source collection. */
export function sortByLanguage<T>(
    items: readonly T[],
    language: (item: T) => string | null | undefined,
    preferred: readonly string[] = [],
    originalLanguage?: string,
): T[] {
    const tagged = items.map((item) => ({
        item,
        code: canonicalLanguageCode(language(item) ?? 'und'),
    }));
    const order = new Map(
        sortLanguageCodes(
            tagged.map(({ code }) => code),
            preferred,
            originalLanguage,
        ).map((code, rank) => [code, rank]),
    );
    return tagged
        .sort((a, b) => (order.get(a.code) ?? order.size) - (order.get(b.code) ?? order.size))
        .map(({ item }) => item);
}
