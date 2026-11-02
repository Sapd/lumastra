// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Database queries for request status service
 */

import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import type { LocalAvailability } from './types.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import type { AgeRatingFilterParams } from '../../database/queries/builders/age-rating.builder.js';
import { buildLibraryAccessFilter } from '../../database/queries/builders/library-access.builder.js';

const logger = Logger.for('RequestStatus:DB');

/**
 * Check availability in our local database (synced every 5 minutes from Jellyfin)
 * Uses UUID-based tables: media_items + external_ids + library_availability
 *
 * Access filters scope the result to media the caller is allowed to see.
 * Without them, the request-status endpoint can be used to probe local
 * availability for restricted-library or over-age titles.
 *
 * `mediaType` is `movie` OR `tv`, so `mi` is a leaf row on one call and a
 * CONTAINER row on the other. The library predicate is therefore the shared
 * `buildLibraryAccessFilter`, which dispatches on `mi.media_type`: a `tv` row
 * is judged by its season -> episode descendants' files. The copy that used to
 * be inlined here asked only about files owned by `mi.id`, and no `tv` row owns
 * `media_file_items` (0 of 6,570 on production, 2026-09-15), so for
 * `mediaType = 'tv'` the library axis was a no-op and a restricted user could
 * still confirm a denied-library series is present.
 *
 * @param externalIds - External IDs for the media (provider-agnostic)
 * @param mediaType - Media type (movie or tv)
 * @param access - Caller's library + age boundary
 * @returns Availability status or null if not found / not accessible
 */
export async function checkLocalAvailability(
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv',
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<LocalAvailability | null> {
    const db = getDb();
    if (!db) return null;

    const primaryId = getExternalIdFor(externalIds, getPrimaryExternalIdProvider());
    if (!primaryId) {
        logger.debug('No primary provider ID in externalIds, cannot check availability', {
            externalIds,
            mediaType,
        });
        return null;
    }

    try {
        const denied = access.deniedGroupIds;
        const age = access.ageRating;
        const result = await db<
            {
                internal_id: string;
                is_available: boolean;
            }[]
        >`
            SELECT
                mi.id AS internal_id,
                mi.has_files AS is_available
            FROM media_items mi
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
                AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                AND primary_ext.external_id = ${primaryId}
                AND primary_ext.media_type = ${mediaType}
            WHERE mi.status = 'active'
              ${buildLibraryAccessFilter(db, denied, 'mi')}
              ${
                  age && age.maxAgeRating !== null
                      ? db`AND (
                  (mi.age_rating IS NULL AND ${age.allowUnrated}::boolean)
                  OR mi.age_rating <= ${age.maxAgeRating}
              )`
                      : db``
              }
            LIMIT 1
        `;

        if (result.length > 0) {
            return {
                internalId: result[0].internal_id,
                isAvailable: result[0].is_available === true,
            };
        }
        return null;
    } catch (error) {
        logger.warn('Failed to check local availability', { primaryId, mediaType }, error as Error);
        return null;
    }
}

/**
 * Check if user has watched this content
 * Uses UUID-based user_watch_history + external_ids tables
 *
 * @param userId - User **UUID**, not a login name. `user_media_state.user_id` is
 *   a uuid column, so a username here makes Postgres throw `invalid input syntax
 *   for type uuid` — which the catch below swallows into `false`, silently
 *   reporting everything as unwatched. Resolve names with `getUserIdByUsername`
 *   before calling.
 * @param externalIds - External IDs for the media (provider-agnostic)
 * @param mediaType - Media type (movie or tv)
 * @returns True if user has watched this content
 */
export async function checkIfWatched(
    userId: string,
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv',
): Promise<boolean> {
    const db = getDb();
    if (!db) return false;

    const primaryId = getExternalIdFor(externalIds, getPrimaryExternalIdProvider());
    if (!primaryId) {
        logger.debug('No primary provider ID in externalIds, cannot check watch history', {
            externalIds,
            mediaType,
        });
        return false;
    }

    try {
        const result = await db`
            SELECT 1
            FROM user_media_state uwh
            JOIN external_ids ei ON ei.media_id = uwh.media_id AND ei.provider = ${getPrimaryExternalIdProvider()}
            WHERE uwh.user_id = ${userId}
              AND ei.external_id = ${primaryId}
              AND ei.media_type = ${mediaType}
              AND uwh.is_watched = true
            LIMIT 1
        `;

        return result.length > 0;
    } catch (error) {
        logger.warn(
            'Failed to check watch history',
            { userId, primaryId, mediaType },
            error as Error,
        );
        return false;
    }
}

/**
 * Check if a specific season is available (has files on disk)
 *
 * Access filters scope the result to media the caller is allowed to see,
 * mirroring `checkLocalAvailability`. Without them, the request-status endpoint
 * can be used to probe season-level availability for restricted-library or
 * over-age titles.
 *
 * The row returned is the SEASON, a container: it owns no `media_file_items`
 * of its own (0 of 4,806 season rows do on production, 2026-09-15), so the
 * predicate that used to be inlined here — "no files owned by `season.id`" —
 * was always satisfied and the library axis did nothing. The shared
 * `buildLibraryAccessFilter` judges a `season` row by its EPISODES' files
 * instead, keeping the fail-open for a season that genuinely has none.
 *
 * @param primaryId - Primary-provider external ID of the parent series
 * @param seasonNumber - Season number to check
 * @param access - Caller's library + age boundary
 */
export async function checkSeasonAvailability(
    primaryId: string,
    seasonNumber: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<{ isAvailable: boolean; isCaughtUp: boolean } | null> {
    const db = getDb();
    if (!db) return null;

    try {
        const denied = access.deniedGroupIds;
        const age = access.ageRating;
        const seasonResult = await db<
            {
                is_available: boolean;
                is_caught_up: boolean;
            }[]
        >`
            SELECT
                (season.has_files AND EXISTS (
                    SELECT 1 FROM media_items episode
                    WHERE episode.parent_id = season.id
                      AND episode.media_type = 'episode' AND episode.status = 'active'
                ) AND NOT EXISTS (
                    SELECT 1 FROM media_items episode
                    WHERE episode.parent_id = season.id
                      AND episode.media_type = 'episode' AND episode.status = 'active'
                      AND episode.has_files IS NOT TRUE
                )) AS is_available,
                -- Every episode that has already aired has its file, and at least
                -- one does; the rest are still unaired (or undated), so there is
                -- nothing more to download yet.
                (EXISTS (
                    SELECT 1 FROM media_items episode
                    WHERE episode.parent_id = season.id
                      AND episode.media_type = 'episode' AND episode.status = 'active'
                      AND episode.has_files IS TRUE
                ) AND NOT EXISTS (
                    SELECT 1 FROM media_items episode
                    WHERE episode.parent_id = season.id
                      AND episode.media_type = 'episode' AND episode.status = 'active'
                      AND episode.has_files IS NOT TRUE
                      AND episode.premiere_date IS NOT NULL
                      AND episode.premiere_date <= CURRENT_DATE
                )) AS is_caught_up
            FROM media_items season
            JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
            JOIN external_ids ei ON ei.media_id = series.id AND ei.provider = ${getPrimaryExternalIdProvider()}
            WHERE season.media_type = 'season'
              AND season.status = 'active'
              AND series.status = 'active'
              AND season.season_number = ${seasonNumber}
              AND ei.external_id = ${primaryId}
              ${buildLibraryAccessFilter(db, denied, 'season')}
              ${
                  age && age.maxAgeRating !== null
                      ? db`AND (
                  (season.age_rating IS NULL AND ${age.allowUnrated}::boolean)
                  OR season.age_rating <= ${age.maxAgeRating}
              )`
                      : db``
              }
            LIMIT 1
        `;

        if (seasonResult.length > 0) {
            return {
                isAvailable: seasonResult[0].is_available === true,
                isCaughtUp: seasonResult[0].is_caught_up === true,
            };
        }

        return null;
    } catch (error) {
        logger.warn(
            'Failed to check season availability',
            { primaryId, seasonNumber },
            error as Error,
        );
        return null;
    }
}
