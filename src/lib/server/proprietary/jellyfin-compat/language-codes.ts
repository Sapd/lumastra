// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Language codes for the `/Items` `AudioLanguages` / `SubtitleLanguages`
 * filters. Stream languages are stored as the file has them (ffprobe: mostly
 * ISO 639-2/B like `ger`, sometimes /T `deu` or 639-1 `de`), and clients send
 * whatever their culture list gives them. A requested code therefore matches
 * every spelling of the same language.
 */

import { ISO_639_2 } from './localization-data';

let equivalents: Map<string, readonly string[]> | null = null;

function table(): Map<string, readonly string[]> {
    if (equivalents) return equivalents;
    const map = new Map<string, readonly string[]>();
    for (const row of ISO_639_2) {
        const [t, b, alpha2] = row.split('|');
        const codes = [t, b, alpha2].filter((c): c is string => !!c);
        for (const code of codes) map.set(code, codes);
    }
    equivalents = map;
    return map;
}

/**
 * Lower-cased codes to match for a CSV of requested languages: each code
 * plus its other ISO spellings. Unknown codes are kept as sent (`und` included,
 * which the query treats as "no language").
 */
export function expandLanguageCodes(values: readonly string[]): string[] {
    const out = new Set<string>();
    for (const raw of values) {
        const code = raw.trim().toLowerCase();
        if (!code) continue;
        out.add(code);
        for (const alt of table().get(code) ?? []) out.add(alt);
    }
    return [...out];
}
