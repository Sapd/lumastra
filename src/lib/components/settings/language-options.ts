// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Options for the default audio / subtitle language pickers.
 *
 * Both used to be free-text inputs asking for an ISO code ("e.g. eng or jpn"),
 * which nobody outside a media-server forum knows. The stored value stays an
 * ISO 639-2/B code — the form track tags use, and what `languagesMatch()`
 * already understands — so switching the control changes nothing downstream.
 */

import { localizedLanguageName, normalizeLanguage, toIso6392B } from '$lib/shared/language-codes';

/** The languages most libraries actually carry tracks in. */
export const COMMON_TRACK_LANGUAGES = [
    'eng',
    'ger',
    'jpn',
    'fre',
    'spa',
    'ita',
    'por',
    'dut',
    'rus',
    'pol',
    'swe',
    'nor',
    'dan',
    'fin',
    'cze',
    'hun',
    'gre',
    'tur',
    'ara',
    'heb',
    'hin',
    'tha',
    'vie',
    'chi',
    'kor',
] as const;

export interface LanguageOption {
    value: string;
    label: string;
}

/**
 * Sorted, localized options. A saved value that is not in the common list (a
 * code typed into the old text field) is kept as its own option, so opening the
 * page never silently changes someone's preference.
 */
export function languagePreferenceOptions(
    locale: string,
    current: string | null | undefined,
): LanguageOption[] {
    const options: LanguageOption[] = COMMON_TRACK_LANGUAGES.map((code) => ({
        value: code,
        label: localizedLanguageName(code, locale) || code,
    }));
    const saved = current?.trim();
    if (saved && !options.some((o) => o.value === matchingOptionValue(saved))) {
        options.push({ value: saved, label: localizedLanguageName(saved, locale) || saved });
    }
    return options.sort((a, b) => a.label.localeCompare(b.label, locale));
}

/**
 * The option a saved value selects: "de", "deu" and "ger" all mean German and
 * should show German as chosen rather than an unknown entry.
 */
export function matchingOptionValue(saved: string | null | undefined): string {
    const raw = saved?.trim();
    if (!raw) return '';
    const b = toIso6392B(raw);
    if (b && (COMMON_TRACK_LANGUAGES as readonly string[]).includes(b)) return b;
    const normalized = normalizeLanguage(raw);
    const hit = COMMON_TRACK_LANGUAGES.find((c) => normalizeLanguage(c) === normalized);
    return hit ?? raw;
}
