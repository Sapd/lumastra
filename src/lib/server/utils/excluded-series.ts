// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Excluded Series Utility
 *
 * Provides cached access to a user's mutes as id sets (see
 * `excluded-series-match.ts` for the matching rules). Uses an L1/L2 cache
 * (10min L1 / 1hr L2) to avoid repeated database queries.
 *
 * Usage:
 *   import { getExcludedSeriesKeys } from '$lib/server/utils/excluded-series';
 *   const exclusions = await getExcludedSeriesKeys(username);
 *   rows.filter((row) => !isCalendarRowExcluded(exclusions, row));
 */

import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { getDb } from '$lib/server/database/index.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries';
import { loadSeriesExclusionsForUser } from '$lib/server/services/series-interest.service';
import {
    NO_EXCLUSIONS,
    deserializeExclusions,
    serializeExclusions,
    type SeriesExclusions,
    type SerializedSeriesExclusions,
} from '$lib/server/utils/excluded-series-match';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('ExcludedSeries');
const excludedSeriesCache = cacheManager.for(CACHE_NAMESPACES.excludedSeries);

/** Bumped when the cached shape or the resolution logic changes. */
const KEYS_CACHE_KEY = 'v6:keys';

/** Per-user cache key of the `GET /api/upcoming/exclude` list. */
export const EXCLUDED_SERIES_LIST_CACHE_KEY = 'v3:list';

/**
 * A TMDB mute on a title that is not in the catalog yet resolves to nothing.
 * Cache such a set briefly, so the mute reaches the catalog item soon after the
 * title is ingested.
 */
const UNRESOLVED_TMDB_TTL_MS = 5 * 60 * 1000;

/**
 * Get a user's mutes (with caching).
 *
 * Cache strategy:
 *  1. Check username-keyed L1 cache to skip the username→UUID DB round-trip entirely.
 *  2. On cache miss, resolve username → UUID, then check UUID-keyed L1/L2 cache.
 *  3. Only hit the DB when both cache layers miss.
 *
 * Fails open: a lookup error returns no exclusions rather than hiding the
 * whole calendar.
 */
export async function getExcludedSeriesKeys(username: string): Promise<SeriesExclusions> {
    if (!username) {
        return NO_EXCLUSIONS;
    }

    try {
        const cachedByUsername = await excludedSeriesCache.get<SerializedSeriesExclusions>(
            KEYS_CACHE_KEY,
            username,
        );
        if (cachedByUsername) {
            return deserializeExclusions(cachedByUsername);
        }

        const sql = getDb();
        if (!sql) {
            return NO_EXCLUSIONS;
        }

        const uid = await getUserIdByUsername(sql, username);
        if (!uid) {
            return NO_EXCLUSIONS;
        }

        // UUID-keyed cache survives username renames
        const cachedByUuid = await excludedSeriesCache.get<SerializedSeriesExclusions>(
            KEYS_CACHE_KEY,
            uid,
        );
        if (cachedByUuid) {
            // Same lifetime as the uid entry, or the backfill outlives a short TTL.
            const backfillTtl = cachedByUuid.unresolvedTmdb ? UNRESOLVED_TMDB_TTL_MS : undefined;
            await excludedSeriesCache.set(KEYS_CACHE_KEY, cachedByUuid, backfillTtl, username);
            return deserializeExclusions(cachedByUuid);
        }

        const exclusions = await loadSeriesExclusionsForUser(sql, uid);
        const serialized = serializeExclusions(exclusions);
        // Short-lived only while a TMDB mute has no catalog item yet: the loader
        // also adds the TMDB ids of muted catalog items, which need no refresh.
        const ttl = exclusions.unresolvedTmdb ? UNRESOLVED_TMDB_TTL_MS : undefined;

        await excludedSeriesCache.set(KEYS_CACHE_KEY, serialized, ttl, uid);
        await excludedSeriesCache.set(KEYS_CACHE_KEY, serialized, ttl, username);

        return exclusions;
    } catch (error) {
        logger.warn('Failed to load excluded series', { username }, error as Error);
        return NO_EXCLUSIONS;
    }
}

/**
 * Invalidate excluded series cache for a user.
 *
 * Both the UUID-keyed entries AND the username-keyed fast-path entry must be
 * cleared, otherwise a stale username-keyed set (TTL up to 10min) keeps
 * filtering with the old list — e.g. a just-excluded series stays on the calendar
 * until the TTL expires.
 *
 * @param userId - The stable users.id UUID (not a username).
 * @param username - The acting user's username; clears the username-keyed fast-path entry.
 */
export async function invalidateExcludedSeriesCache(
    userId: string,
    username?: string,
): Promise<void> {
    await excludedSeriesCache.delete(KEYS_CACHE_KEY, userId);
    await excludedSeriesCache.delete(EXCLUDED_SERIES_LIST_CACHE_KEY, userId);
    if (username) {
        await excludedSeriesCache.delete(KEYS_CACHE_KEY, username);
    }
}
