// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `Accept-Language` negotiation against an explicit candidate set.
 *
 * Deliberately NOT Paraglide's `extractLocaleFromHeader`: that one validates
 * against the UI locale set (en/de), whereas metadata languages are whatever
 * the admin enabled (TMDB_LANGUAGE + METADATA_ADDITIONAL_LANGUAGES) and may
 * include tags the UI has no strings for. Using the UI negotiator here would
 * silently gate the media catalog by the UI string catalog.
 *
 * Always returns the ENABLED set's spelling, because that is the key
 * `media_item_translations` rows are stored under — returning the client's
 * spelling (`de` when rows are written under `de-DE`) would look up nothing.
 */

import { normalizeLanguageTag, splitLanguageTag } from './metadata-language.js';

interface Candidate {
    tag: string;
    q: number;
}

/** Parse a header into q-ordered candidates. Malformed entries are dropped. */
function parseCandidates(header: string): Candidate[] {
    const parsed: Candidate[] = [];

    for (const part of header.split(',')) {
        const [rawTag, ...params] = part.trim().split(';');
        const tag = rawTag?.trim();
        if (!tag || tag === '*') continue;

        let q = 1;
        const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        if (qParam) {
            const parsedQ = Number(qParam.slice(2));
            // A malformed q is dropped rather than defaulted to 1, so garbage
            // cannot outrank a well-formed preference.
            if (!Number.isFinite(parsedQ)) continue;
            q = parsedQ;
        }
        if (q <= 0) continue;

        parsed.push({ tag, q });
    }

    // Array.prototype.sort is stable, so equal-q entries keep header order.
    return parsed.sort((a, b) => b.q - a.q);
}

/** Find an enabled entry sharing `tag`'s bare language; returns the ENABLED spelling. */
function bareFallback(tag: string, enabled: Set<string>): string | null {
    const bare = splitLanguageTag(tag).lang;
    for (const candidate of enabled) {
        if (splitLanguageTag(candidate).lang === bare) return candidate;
    }
    return null;
}

/**
 * Negotiate the best `enabled` language for an `Accept-Language` header.
 * Returns the enabled set's spelling, or null when nothing matches.
 * Never throws.
 */
export function negotiateLanguage(
    header: string | null | undefined,
    enabled: Set<string>,
): string | null {
    if (!header || enabled.size === 0) return null;

    for (const { tag } of parseCandidates(header)) {
        const normalized = normalizeLanguageTag(tag);
        if (!normalized) continue;
        if (enabled.has(normalized)) return normalized;
        const fallback = bareFallback(normalized, enabled);
        if (fallback) return fallback;
    }
    return null;
}
