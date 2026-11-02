// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fixed language sets for the /browse A-Z audio/subtitle filter.
 *
 * Codes are the normalized 2-letter form stored in `media_item_languages`
 * (see the SQL `normalize_track_language()` function — the single source of
 * normalization). This module holds ONLY the selectable set, labels, and the
 * API CSV parser; it does NOT normalize raw track codes.
 */
export const AUDIO_FILTER_LANGUAGES = ['de', 'en', 'ja', 'ko'] as const;
export const SUBTITLE_FILTER_LANGUAGES = ['de', 'en'] as const;

export type AudioFilterLang = (typeof AUDIO_FILTER_LANGUAGES)[number];
export type SubtitleFilterLang = (typeof SUBTITLE_FILTER_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<AudioFilterLang, string> = {
    de: 'German',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
};

/**
 * Parse a comma-separated language list from a query param, keeping only the
 * allowed tokens (lowercased, deduped, order-preserving). Unknown tokens are
 * silently dropped.
 */
export function parseLangCsv<T extends string>(
    raw: string | undefined,
    allowed: readonly T[],
): T[] {
    if (!raw) return [];
    const allowedSet = new Set<string>(allowed);
    const out: T[] = [];
    for (const token of raw.split(',')) {
        const t = token.trim().toLowerCase();
        if (allowedSet.has(t) && !out.includes(t as T)) out.push(t as T);
    }
    return out;
}
