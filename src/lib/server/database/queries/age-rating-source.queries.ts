// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { certificationToAge } from '../../utils/certification-parser.js';

/**
 * Drop the in-process age-rating cache entry so the next request re-reads the
 * updated value. Import is lazy to avoid circular dependencies.
 */
export async function invalidateAgeCache(mediaId: string): Promise<void> {
    try {
        const { invalidateMediaAgeCache } = await import('../../middleware/media-access.js');
        invalidateMediaAgeCache(mediaId);
    } catch {
        // Non-critical — cache will expire naturally via TTL
    }
}

/**
 * Write the age rating derived from a NATIONAL certification (TMDB release
 * dates / content ratings in the configured country, Jellyfin `OfficialRating`,
 * NFO `<mpaa>`). It wins over MDBList: it replaces whatever MDBList wrote and
 * marks the row `age_rating_source = 'national'` so MDBList cannot take it back.
 *
 * A certification that does not parse to an age ("NR", "Unrated", garbage) is a
 * no-op. It must never clear a rating that MDBList supplied, and it must never
 * invent 0.
 *
 * Same lock policy as `updateMediaAgeRating` (media-upsert.ts): not gated on `metadata_locked`.
 *
 * `onlyFill` is for weaker national sources (an NFO sidecar): it replaces MDBList or
 * nothing, but never a rating that already came from a national certification, so a
 * rescan cannot flip a TMDB-derived rating back and forth.
 *
 * @returns the age written, or null when the certification was not usable.
 */
export async function applyNationalAgeRating(
    sql: postgres.Sql,
    mediaId: string,
    certification: string | null | undefined,
    options: { onlyFill?: boolean } = {},
): Promise<number | null> {
    const age = certificationToAge(certification);
    if (age === null) return null;
    const onlyFill = options.onlyFill === true;
    await sql`
        UPDATE media_items
        SET age_rating = ${age}, age_rating_source = 'national'
        WHERE id = ${mediaId}
          -- Access control judges seasons and episodes by their SERIES' rating, so a
          -- rating stored on them would be ignored at best and misleading at worst.
          AND media_type IN ('movie', 'tv', 'series', 'audiobook')
          AND (age_rating IS DISTINCT FROM ${age}
               OR age_rating_source IS DISTINCT FROM 'national')
          AND (NOT ${onlyFill} OR age_rating_source IS DISTINCT FROM 'national')
    `;
    await invalidateAgeCache(mediaId);
    return age;
}

export interface UnratedTitleCount {
    /** Active library movies and series without an age rating. */
    unrated: number;
    /** All active library movies and series. */
    total: number;
}

/**
 * How many active library titles (top-level movies and series with files) have no
 * age rating. An age-limited user sees none of them unless UNRATED_CONTENT_VISIBLE
 * is on, so this is the number an admin needs when a kid profile looks empty.
 */
export async function countUnratedLibraryTitles(sql: postgres.Sql): Promise<UnratedTitleCount> {
    // Admin-only aggregate over all library titles; no per-user access decision applies.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [row] = await sql<Array<{ unrated: number; total: number }>>`
        SELECT count(*) FILTER (WHERE age_rating IS NULL)::int AS unrated,
               count(*)::int AS total
        FROM media_items
        WHERE parent_id IS NULL
          AND media_type IN ('movie', 'tv')
          AND status = 'active'
          AND has_files = true
          AND NOT is_dismissed
    `;
    return { unrated: row?.unrated ?? 0, total: row?.total ?? 0 };
}
