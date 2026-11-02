// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Watch History Utilities
 *
 * Provides centralized access to user's watched items from the database.
 * Used by for-you endpoints to avoid requiring clients to pass watch history.
 *
 * Reads from user_media_state (is_watched = true) — the single source of truth.
 */

import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';

import { Logger } from './logger.js';
import { isSeries } from './media-types.js';
import { getPrimaryExternalIdProvider } from './provider-config.js';

const logger = Logger.for('UserWatchHistory');

export interface WatchedItem {
    primary_ext_id: string;
    media_type: 'movie' | 'tv';
}

/**
 * Get user's watched items from user_media_state table (UUID-based).
 * Returns items with both TMDB ID and media type for proper identification.
 *
 * @param username - The user's username
 * @param limit - Maximum number of items to return (default: 100)
 * @returns Array of watched items with tmdb_id and media_type
 */
export async function getUserWatchedItems(
    username: string,
    limit: number = 100,
): Promise<WatchedItem[]> {
    if (!username) return [];

    try {
        const { getDb } = await import('$lib/server/database/connection.js');
        const sql = getDb();
        if (!sql) return [];

        // user_media_state.user_id is now uuid REFERENCES users(id) (mig 16.46.0):
        // resolve the username → users.id UUID before binding. No such user → empty.
        const uid = await getUserIdByUsername(sql, username);
        if (!uid) return [];

        const dbWatched = await sql<{ primary_ext_id: string; media_type: string }[]>`
			SELECT ei.external_id as primary_ext_id, ei.media_type
			FROM user_media_state uws
			JOIN external_ids ei ON ei.media_id = uws.media_id
				AND ei.provider = ${getPrimaryExternalIdProvider()}
			WHERE uws.user_id = ${uid}::uuid
			  AND uws.is_watched = true
			ORDER BY uws.last_watched_at DESC NULLS LAST
			LIMIT ${limit}
		`;

        const items: WatchedItem[] = dbWatched.map((row) => ({
            primary_ext_id: row.primary_ext_id,
            media_type: isSeries(row.media_type) ? ('tv' as const) : ('movie' as const),
        }));

        if (items.length > 0) {
            logger.debug('Fetched user watch history', {
                username,
                count: items.length,
            });
        }

        return items;
    } catch (error) {
        logger.warn('Failed to fetch user watch history', error as Error);
        return [];
    }
}

/**
 * Get just TMDB IDs of user's watched items (for exclusion lists).
 *
 * Note: This loses media_type information, which can cause issues with
 * TMDB ID collisions (same ID for different movie/tv). Use getUserWatchedItems
 * when you need precise identification.
 *
 * @param username - The user's username
 * @param limit - Maximum number of items to return (default: 500)
 * @returns Array of TMDB IDs
 */
export async function getUserWatchedTmdbIds(
    username: string,
    limit: number = 500,
): Promise<string[]> {
    if (!username) return [];

    try {
        const { getDb } = await import('$lib/server/database/connection.js');
        const sql = getDb();
        if (!sql) return [];

        // user_media_state.user_id is now uuid REFERENCES users(id) (mig 16.46.0):
        // resolve the username → users.id UUID before binding. No such user → empty.
        const uid = await getUserIdByUsername(sql, username);
        if (!uid) return [];

        const dbWatched = await sql<{ primary_ext_id: string }[]>`
			SELECT ei.external_id as primary_ext_id
			FROM user_media_state uws
			JOIN external_ids ei ON ei.media_id = uws.media_id
				AND ei.provider = ${getPrimaryExternalIdProvider()}
			WHERE uws.user_id = ${uid}::uuid
			  AND uws.is_watched = true
			LIMIT ${limit}
		`;

        const ids = dbWatched.map((row) => row.primary_ext_id);

        if (ids.length > 0) {
            logger.debug('Fetched user watched IDs', {
                username,
                count: ids.length,
            });
        }

        return ids;
    } catch (error) {
        logger.warn('Failed to fetch user watched IDs', error as Error);
        return [];
    }
}
