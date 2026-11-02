// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Age-rating backfill: re-derive `media_items.age_rating` from national
 * certifications for titles that were rated before the national certification
 * became the source of truth (MDBList-only ratings, certifications that were
 * stored in provider_metadata but never turned into an age).
 *
 * Two phases, both idempotent and safe to re-run:
 *
 *  A. {@link deriveFromStoredCertifications}: pure DB. Reads the `certification`
 *     already stored on the tmdb / jellyfin provider_metadata row and writes the
 *     age with national-wins precedence. No network.
 *
 *  B. {@link findCertificationLookupCandidates} + {@link lookupCertifications}: for
 *     titles whose TMDB row was never checked for the configured country (no
 *     certification yet, or a different country than the setting now says), fetch
 *     the TMDB detail (one request per title, release_dates / content_ratings are
 *     part of the existing append_to_response) and apply it. The `age_rating_country_checked`
 *     stamp on the tmdb row is what "marks" a title as done, so a run converges, a
 *     title TMDB has no certification for is not asked again, and changing the
 *     country setting makes every title a candidate again. Rate limiting is the
 *     caller's job (batch size + pacing in the task).
 */

import type postgres from 'postgres';
import { applyNationalAgeRating } from '../database/queries/age-rating-source.queries.js';
import { upsertProviderMetadataUnlessLocked } from '../database/queries/media-upsert.js';
import {
    CERTIFICATION_CHECKED_COUNTRY_KEY,
    pickTmdbCertification,
} from '../utils/tmdb-certification.js';

/** Failed lookups are not retried for this long, so a failing title cannot starve the queue. */
export const LOOKUP_RETRY_AFTER_HOURS = 24;
export const LOOKUP_ERROR_AT_KEY = 'age_rating_lookup_error_at';

export interface DeriveResult {
    scanned: number;
    written: number;
}

/**
 * Phase A. Top-level movie/tv rows whose rating is not (yet) national and that
 * carry a stored certification. TMDB's certification beats Jellyfin's, matching the
 * `certification` field authority of the aggregator.
 */
export async function deriveFromStoredCertifications(
    sql: postgres.Sql,
    options: { chunk?: number; shouldAbort?: () => boolean; country?: string } = {},
): Promise<DeriveResult> {
    const chunk = options.chunk ?? 500;
    // A TMDB certification looked up for another country is stale: ignore it until
    // phase B has re-checked the title. Rows without a recorded country are legacy
    // and still count.
    const country = options.country ?? null;
    let cursor = '00000000-0000-0000-0000-000000000000';
    let scanned = 0;
    let written = 0;
    for (;;) {
        if (options.shouldAbort?.()) break;
        // Maintenance job over all titles (not a user-facing listing): no access gate or has_files filter.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status
        const rows = await sql<Array<{ media_id: string; certification: string }>>`
            SELECT mi.id::text AS media_id,
                   COALESCE(NULLIF(btrim(CASE WHEN ${country}::text IS NULL OR (t.metadata->>'certification_country') IS NULL
                                                 OR (t.metadata->>'age_rating_country_checked') = ${country}::text
                                            THEN t.metadata->>'certification' END), ''),
                            NULLIF(btrim(j.metadata->>'certification'), '')) AS certification
            FROM media_items mi
            LEFT JOIN provider_metadata t ON t.media_id = mi.id AND t.provider = 'tmdb'
            LEFT JOIN provider_metadata j ON j.media_id = mi.id AND j.provider = 'jellyfin'
            WHERE mi.parent_id IS NULL
              AND mi.media_type IN ('movie', 'tv')
              AND mi.status = 'active'
              AND mi.age_rating_source IS DISTINCT FROM 'national'
              AND mi.id > ${cursor}::uuid
              AND COALESCE(NULLIF(btrim(CASE WHEN ${country}::text IS NULL OR (t.metadata->>'certification_country') IS NULL
                                                 OR (t.metadata->>'age_rating_country_checked') = ${country}::text
                                            THEN t.metadata->>'certification' END), ''),
                           NULLIF(btrim(j.metadata->>'certification'), '')) IS NOT NULL
            ORDER BY mi.id
            LIMIT ${chunk}
        `;
        if (rows.length === 0) break;
        for (const row of rows) {
            scanned++;
            if ((await applyNationalAgeRating(sql, row.media_id, row.certification)) !== null) {
                written++;
            }
        }
        cursor = rows[rows.length - 1].media_id;
    }
    return { scanned, written };
}

export interface LookupCandidate {
    media_id: string;
    external_id: string;
    media_type: 'movie' | 'tv';
    /** Country the stored certification was looked up for, when known. */
    prior_country: string | null;
}

/**
 * Phase B candidates: active top-level movie/tv titles with a TMDB id whose tmdb row
 * was not checked for `country`. Library titles first, unrated before rated.
 * `metadata_locked` titles are included: the age rating is safety data, not
 * user-edited metadata, and the stamp is written with `force` for the same reason.
 */
export async function findCertificationLookupCandidates(
    sql: postgres.Sql,
    country: string,
    limit: number,
): Promise<LookupCandidate[]> {
    // Maintenance job, not a user-facing listing: no per-user access decision applies.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return await sql<LookupCandidate[]>`
        SELECT mi.id::text AS media_id, pe.external_id AS external_id, mi.media_type,
               (t.metadata->>'certification_country') AS prior_country
        FROM media_items mi
        JOIN external_ids pe
          ON pe.media_id = mi.id AND pe.provider = 'tmdb' AND pe.media_type = mi.media_type
        LEFT JOIN provider_metadata t ON t.media_id = mi.id AND t.provider = 'tmdb'
        WHERE mi.parent_id IS NULL
          AND mi.media_type IN ('movie', 'tv')
          AND mi.status = 'active'
          AND (t.metadata->>${CERTIFICATION_CHECKED_COUNTRY_KEY}::text) IS DISTINCT FROM ${country}::text
          AND (
              (t.metadata->>${LOOKUP_ERROR_AT_KEY}::text) IS NULL
              OR pg_input_is_valid(t.metadata->>${LOOKUP_ERROR_AT_KEY}::text, 'timestamp with time zone') IS NOT TRUE
              OR (t.metadata->>${LOOKUP_ERROR_AT_KEY}::text)::timestamptz
                   < now() - make_interval(hours => ${LOOKUP_RETRY_AFTER_HOURS}::int)
          )
        ORDER BY mi.has_files DESC, (mi.age_rating IS NULL) DESC, mi.id
        LIMIT ${limit}
    `;
}

export interface LookupResult {
    /** National certification found and applied. */
    written: number;
    /** TMDB answered but has no usable certification for the country or the US. */
    noCertification: number;
    /** The id no longer exists at TMDB. */
    notFound: number;
    /** The fetch failed; retried after {@link LOOKUP_RETRY_AFTER_HOURS}. */
    failed: number;
    /** Ids whose provider row gained a certification (re-aggregate these). */
    touchedIds: string[];
}

/**
 * Phase B for one batch. `fetchDetail` returns the raw TMDB detail (with
 * release_dates / content_ratings); `isNotFound` classifies its errors; `pace` is
 * awaited between requests (rate limit).
 */
export async function lookupCertifications(
    sql: postgres.Sql,
    candidates: LookupCandidate[],
    country: string,
    deps: {
        fetchDetail: (candidate: LookupCandidate) => Promise<unknown>;
        isNotFound: (err: unknown) => boolean;
        pace?: () => Promise<void>;
        shouldAbort?: () => boolean;
        onError?: (candidate: LookupCandidate, err: unknown) => void;
    },
): Promise<LookupResult> {
    const result: LookupResult = {
        written: 0,
        noCertification: 0,
        notFound: 0,
        failed: 0,
        touchedIds: [],
    };
    for (const [i, candidate] of candidates.entries()) {
        if (deps.shouldAbort?.()) break;
        try {
            const detail = await deps.fetchDetail(candidate);
            const pick = pickTmdbCertification(detail, candidate.media_type, country);
            if (pick) {
                await applyNationalAgeRating(sql, candidate.media_id, pick.certification);
            }
            // A rating that came from ANOTHER country's lookup is stale when the new
            // country and the US have nothing: let MDBList fill again and drop the
            // stale certification so phase A does not re-derive it.
            const stale = !pick && candidate.prior_country !== null && candidate.prior_country !== country;
            if (stale) {
                await sql`
                    UPDATE media_items SET age_rating_source = NULL
                    WHERE id = ${candidate.media_id} AND age_rating_source = 'national'
                `;
            }
            await upsertProviderMetadataUnlessLocked(
                sql,
                candidate.media_id,
                'tmdb',
                {
                    ...(pick
                        ? { certification: pick.certification, certification_country: pick.country }
                        : stale
                          ? { certification: null, certification_country: null }
                          : {}),
                    [CERTIFICATION_CHECKED_COUNTRY_KEY]: country,
                },
                { force: true },
            );
            if (pick) {
                result.written++;
                result.touchedIds.push(candidate.media_id);
            } else {
                result.noCertification++;
            }
        } catch (err) {
            if (deps.isNotFound(err)) {
                // Deleted upstream: a definitive answer, do not ask again.
                await upsertProviderMetadataUnlessLocked(
                    sql,
                    candidate.media_id,
                    'tmdb',
                    { [CERTIFICATION_CHECKED_COUNTRY_KEY]: country },
                    { force: true },
                );
                result.notFound++;
            } else {
                deps.onError?.(candidate, err);
                await upsertProviderMetadataUnlessLocked(
                    sql,
                    candidate.media_id,
                    'tmdb',
                    { [LOOKUP_ERROR_AT_KEY]: new Date().toISOString() },
                    { force: true },
                ).catch(() => 0);
                result.failed++;
            }
        }
        if (deps.pace && i < candidates.length - 1) await deps.pace();
    }
    return result;
}
