// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { certificationToAge, isUnratedCertification } from './certification-parser.js';
import { FALLBACK_AGE_RATING_COUNTRY } from '../../shared/age-rating-country.js';

/**
 * provider_metadata('tmdb') key stamped with the country a fetch looked the
 * certification up for (also when TMDB had none), so the age-rating backfill and a
 * later change of AGE_RATING_COUNTRY can tell which titles still need a lookup.
 */
export const CERTIFICATION_CHECKED_COUNTRY_KEY = 'age_rating_country_checked';

export interface TmdbCertification {
    certification: string;
    country: string;
}

function certsFor(
    results: Array<Record<string, unknown>>,
    mediaType: 'movie' | 'tv',
    country: string,
): string[] {
    const out: string[] = [];
    for (const r of results) {
        if (r['iso_3166_1'] !== country) continue;
        if (mediaType === 'movie') {
            const dates = Array.isArray(r['release_dates'])
                ? (r['release_dates'] as Array<{ certification?: unknown }>)
                : [];
            for (const d of dates) {
                if (typeof d.certification === 'string' && d.certification.trim()) {
                    out.push(d.certification.trim());
                }
            }
        } else if (typeof r['rating'] === 'string' && r['rating'].trim()) {
            out.push(r['rating'].trim());
        }
    }
    return out;
}

/**
 * Pick the certification TMDB reports for a country out of the
 * `release_dates` (movie) / `content_ratings` (TV) append_to_response blocks.
 *
 * The configured country wins, and within it the STRICTEST usable value across all
 * release types and entries. The United States is the fallback only when the
 * country has no rating at all or only explicit unrated markers ("NR"). A rating
 * present but unreadable yields null (the title stays unrated and hidden for
 * age-limited users), never another country's value.
 */
export function pickTmdbCertification(
    raw: unknown,
    mediaType: 'movie' | 'tv',
    country: string,
): TmdbCertification | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    const block = mediaType === 'movie' ? record['release_dates'] : record['content_ratings'];
    const results = (block as { results?: unknown } | undefined)?.results;
    if (!Array.isArray(results)) return null;

    const countries =
        country === FALLBACK_AGE_RATING_COUNTRY
            ? [country]
            : [country, FALLBACK_AGE_RATING_COUNTRY];
    for (const c of countries) {
        const certs = certsFor(results as Array<Record<string, unknown>>, mediaType, c);
        if (certs.length === 0) continue;
        // The STRICTEST usable value across every release type: a theatrical
        // FSK 16 must not hide an uncut disc release rated FSK 18.
        let best: { cert: string; age: number } | null = null;
        for (const cert of certs) {
            const age = certificationToAge(cert);
            if (age !== null && (best === null || age > best.age)) best = { cert, age };
        }
        if (best) return { certification: best.cert, country: c };
        // The country HAS a rating we cannot read: do not substitute another
        // country's. The title stays unrated (hidden from age-limited users).
        // Only an explicit unrated marker lets the US value stand in.
        if (certs.some((cert) => !isUnratedCertification(cert))) return null;
    }
    return null;
}
