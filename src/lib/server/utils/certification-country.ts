// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { certificationToAge, COUNTRY_PREFIXES, SYSTEM_PREFIXES } from './certification-parser.js';
import { FALLBACK_AGE_RATING_COUNTRY } from '../../shared/age-rating-country.js';

interface Segment {
    country: string | null;
    rating: string;
}

function parseSegment(raw: string): Segment | null {
    const text = raw.trim();
    if (!text) return null;
    const prefixed = text.match(/^([A-Za-z][A-Za-z .]*?)\s*:\s*(.+)$/);
    if (prefixed) {
        const country = COUNTRY_PREFIXES[prefixed[1]!.trim().toLowerCase()];
        // "FSK: 12" and "Rated: R" name a system, not a country: keep the whole segment.
        if (country) return { country, rating: prefixed[2]!.trim() };
        // "Sweden:15": another country's system we cannot judge; not ours to read.
        if (!SYSTEM_PREFIXES.has(prefixed[1]!.trim().toLowerCase())) return null;
    }
    return { country: null, rating: text };
}

/**
 * Choose one certification out of an NFO-style value that may list several
 * countries ("US:PG-13 / Germany:FSK 12", "Rated R").
 *
 * Order: the configured country's segment, then a segment that names no country
 * ("PG-13", "FSK 12": the author's own rating), then the US segment, then any
 * other. Only segments `certificationToAge` understands are considered.
 */
export function pickCertificationForCountry(
    raw: string | null | undefined,
    country: string,
): string | null {
    if (!raw) return null;
    const segments = raw
        .split(/\s+\/\s+|\s*\|\s*|\s*;\s*/)
        .map(parseSegment)
        .filter((s): s is Segment => s !== null && certificationToAge(s.rating) !== null);
    if (segments.length === 0) return null;

    return (
        segments.find((s) => s.country === country) ??
        segments.find((s) => s.country === null) ??
        segments.find((s) => s.country === FALLBACK_AGE_RATING_COUNTRY) ??
        segments[0]!
    ).rating;
}
