// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * List Sync Service
 *
 * Syncs curated lists from MDBList to the local database for fast access.
 * Lists are refreshed every 12 hours to keep content fresh.
 */

import type postgres from 'postgres';
import { Logger } from '../utils/logger.js';
import { mdblistApi } from '../services/mdblist-api.js';
import type { Database } from '../database/connection.js';
import { getPrimaryExternalIdProvider } from '../utils/provider-config.js';
import {
    buildProviderOrderUnsafe,
    buildProviderFilterUnsafe,
} from '../database/queries/builders/provider-metadata.builder.js';

const logger = Logger.for('ListSync');

/** Lazy-load and instantiate Database */
async function getDatabase(providedSql?: postgres.Sql | null): Promise<Database> {
    const { Database } = await import('../database/connection.js');
    return new Database(providedSql);
}

// Predefined popular lists to sync
export const CURATED_LISTS = [
    {
        list_id: 'trending-movies',
        name: '🔥 Trending Movies',
        description: 'Top watched movies this week globally',
        list_path: 'linaspurinis/top-watched-movies-of-the-week',
        media_type: 'movie',
    },
    {
        list_id: 'trending-shows',
        name: '🔥 Best New Shows',
        description: 'Best new TV shows released recently',
        list_path: 'linaspurinis/best-new-shows',
        media_type: 'tv',
    },
    {
        list_id: 'popular-movies',
        name: '⭐ Popular Movies',
        description: 'Most popular movies right now',
        list_path: 'linaspurinis/most-popular-movies-top-20',
        media_type: 'movie',
    },
    {
        list_id: 'popular-shows',
        name: '⭐ Popular Shows',
        description: 'Most popular TV shows right now',
        list_path: 'linaspurinis/most-popular-shows-top-50',
        media_type: 'tv',
    },
    {
        list_id: 'netflix-movies',
        name: '🔴 Netflix Movies',
        description: 'Movies available on Netflix',
        list_path: 'garycrawfordgc/netflix-movies',
        media_type: 'movie',
    },
    {
        list_id: 'netflix-shows',
        name: '🔴 Netflix Shows',
        description: 'TV shows available on Netflix',
        list_path: 'garycrawfordgc/netflix-shows',
        media_type: 'tv',
    },
    {
        list_id: 'disney-movies',
        name: '🏰 Disney+ Movies',
        description: 'Movies available on Disney+',
        list_path: 'garycrawfordgc/disney-movies',
        media_type: 'movie',
    },
    {
        list_id: 'disney-shows',
        name: '🏰 Disney+ Shows',
        description: 'TV shows available on Disney+',
        list_path: 'garycrawfordgc/disney-shows',
        media_type: 'tv',
    },
    {
        list_id: 'amazon-prime-movies',
        name: '📦 Prime Movies',
        description: 'Movies available on Amazon Prime Video',
        list_path: 'garycrawfordgc/amazon-prime-movies',
        media_type: 'movie',
    },
    {
        list_id: 'amazon-prime-shows',
        name: '📦 Prime Shows',
        description: 'TV shows available on Amazon Prime Video',
        list_path: 'garycrawfordgc/amazon-prime-shows',
        media_type: 'tv',
    },
    {
        list_id: 'hbo-shows',
        name: '🟣 HBO/Max Shows',
        description: 'TV shows available on HBO/Max',
        list_path: 'garycrawfordgc/hbo-shows',
        media_type: 'tv',
    },
    {
        list_id: 'apple-tv-movies',
        name: 'Apple TV+ Movies',
        description: 'Movies available on Apple TV+',
        list_path: 'slimshizn/apple-tv-movies',
        media_type: 'movie',
    },
    {
        list_id: 'apple-tv-all',
        name: 'Apple TV+ All',
        description: 'All content on Apple TV+',
        list_path: 'slimshizn/all-apple-tv-plus',
        media_type: 'mixed',
    },
    {
        list_id: 'certified-fresh',
        name: '🍅 Certified Fresh',
        description: 'Rotten Tomatoes Certified Fresh movies',
        list_path: 'linaspurinis/certified-fresh',
        media_type: 'movie',
    },
    {
        list_id: 'box-office',
        name: '🎬 Box Office Top 50',
        description: 'Current box office top performers',
        list_path: 'linaspurinis/box-office-50',
        media_type: 'movie',
    },
    {
        list_id: 'latest-anime',
        name: '🎌 Latest Anime',
        description: 'Recently released anime shows',
        list_path: 'iamscallywag/latest-anime',
        media_type: 'tv',
    },
    {
        list_id: 'latest-anime-movies',
        name: '🎌 Anime Movies',
        description: 'Recently released anime movies',
        list_path: 'iamscallywag/latest-anime-movies',
        media_type: 'movie',
    },
];

export interface CachedList {
    list_id: string;
    name: string;
    description: string;
    source: string;
    list_path: string;
    item_count: number;
    last_synced_at: Date | null;
}

export interface CachedListItem {
    list_id: string;
    rank: number;
    internal_id: string; // UUID from media_items
    primary_ext_id: string;
    imdb_id: string | null;
    media_type: string;
    title: string;
    release_year: number | null;
    score: number | null;
    poster_path: string | null;
    overview: string | null;
}

export interface ListSyncResult {
    success: boolean;
    list_id: string;
    items_synced: number;
    error?: string;
}

/**
 * Sync a single list from MDBList to the database
 */
export async function syncList(
    listConfig: (typeof CURATED_LISTS)[0],
    limit = 50,
    providedSql?: postgres.Sql | null,
): Promise<ListSyncResult> {
    // No key, no MDBList: the curated lists are an opt-in provider feature, and a
    // keyless install must not contact mdblist.com (checked before any DB work so
    // the For You rails don't warn "No items returned" on every request).
    if (!mdblistApi.isAvailable()) {
        return {
            success: false,
            list_id: listConfig.list_id,
            items_synced: 0,
            error: 'MDBList API key not configured',
        };
    }

    const db = await getDatabase(providedSql);

    try {
        logger.debug('Syncing list', {
            list_id: listConfig.list_id,
            list_path: listConfig.list_path,
        });

        // Fetch list from MDBList
        const items = await mdblistApi.getList(listConfig.list_path, limit);

        if (!items || items.length === 0) {
            logger.warn('No items returned from MDBList', {
                list_id: listConfig.list_id,
            });
            return {
                success: false,
                list_id: listConfig.list_id,
                items_synced: 0,
                error: 'No items returned',
            };
        }

        logger.debug('Fetched items from MDBList', {
            list_id: listConfig.list_id,
            count: items.length,
        });

        // Upsert the list metadata
        const sql = db.getSql();
        await sql`
            INSERT INTO cached_lists (list_id, name, description, source, list_path, item_count, last_synced_at, updated_at)
            VALUES (${listConfig.list_id}, ${listConfig.name}, ${listConfig.description}, 'mdblist', ${listConfig.list_path}, ${items.length}, NOW(), NOW())
            ON CONFLICT (list_id) DO UPDATE SET
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                list_path = EXCLUDED.list_path,
                item_count = EXCLUDED.item_count,
                last_synced_at = NOW(),
                updated_at = NOW()
        `;

        // Delete old items for this list (use UUID-based table)
        await sql`DELETE FROM cached_list_items WHERE list_id = ${listConfig.list_id}`;

        // Insert new items (use UUID-based table with media_id lookup)
        let insertedCount = 0;
        let unresolvedCount = 0;
        for (const item of items) {
            try {
                // Determine media type - prefer MDBList's item.mediatype if available
                // as it's more accurate than the list config (which is just a hint)
                let mediaType: string;
                if (item.mediatype) {
                    // MDBList provides mediatype as 'show' or 'movie'
                    // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- MDBList's mediatype field uses the external 'show' alias.
                    mediaType = item.mediatype === 'show' ? 'tv' : 'movie';
                } else {
                    // Fall back to list config
                    mediaType = listConfig.media_type === 'mixed' ? 'movie' : listConfig.media_type;
                }

                // Note: item.id IS the TMDB ID in MDBList list responses
                const tmdbId = item.id;

                // Resolve TMDB ID to media_id UUID and insert into cached_list_items
                // Uses INSERT ... SELECT to handle the TMDB ID to UUID resolution
                const provider = getPrimaryExternalIdProvider();
                // `INSERT ... SELECT` matches zero rows when this TMDB id isn't in
                // the local catalog yet — that is NOT an error, so it never throws.
                // Counting it as inserted reports "Synced N items" for items that
                // never landed a row. Trust the affected-row count, not the absence
                // of an exception.
                const insertResult = await sql`
                    INSERT INTO cached_list_items (list_id, media_id, rank, added_at)
                    SELECT ${listConfig.list_id}, ei.media_id, ${item.rank}, NOW()
                    FROM external_ids ei
                    WHERE ei.provider = ${provider}
                        AND ei.external_id = ${String(tmdbId)}
                        AND ei.media_type = ${mediaType}
                    ON CONFLICT (list_id, media_id) DO UPDATE SET
                        rank = EXCLUDED.rank
                `;
                if (insertResult.count > 0) {
                    insertedCount++;
                } else {
                    unresolvedCount++;
                }
            } catch (itemError) {
                logger.warn(
                    'Failed to insert list item',
                    { list_id: listConfig.list_id, item: item.title },
                    itemError as Error,
                );
            }
        }

        logger.debug('List sync completed', {
            list_id: listConfig.list_id,
            items_synced: insertedCount,
            // Items MDBList listed that aren't in the local catalog. Expected to be
            // non-zero (upstream lists cover media we don't hold) — but a list that
            // resolves NOTHING means the ids or media_type are wrong, not that the
            // list is empty. Logged so that distinction is visible.
            items_unresolved: unresolvedCount,
        });
        if (insertedCount === 0 && unresolvedCount > 0) {
            // Not a fault: a small personal library normally holds none of the
            // global trending/popular titles, so a fresh install resolves nothing
            // for these lists. Only a genuinely failed fetch/insert warns.
            logger.debug(
                'List sync resolved no items — none of the listed ids are in the catalog',
                {
                    list_id: listConfig.list_id,
                    items_unresolved: unresolvedCount,
                },
            );
        }

        return {
            success: true,
            list_id: listConfig.list_id,
            items_synced: insertedCount,
        };
    } catch (error) {
        logger.error('Failed to sync list', error as Error, {
            list_id: listConfig.list_id,
        });
        return {
            success: false,
            list_id: listConfig.list_id,
            items_synced: 0,
            error: (error as Error).message,
        };
    }
}

/**
 * Sync all curated lists
 */
export async function syncAllLists(limit = 50): Promise<{
    success: boolean;
    results: ListSyncResult[];
    total_synced: number;
}> {
    logger.info('Starting sync of all curated lists', {
        list_count: CURATED_LISTS.length,
    });

    const results: ListSyncResult[] = [];
    let total_synced = 0;

    for (const listConfig of CURATED_LISTS) {
        const result = await syncList(listConfig, limit);
        results.push(result);
        total_synced += result.items_synced;

        // Small delay between lists to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const successCount = results.filter((r) => r.success).length;
    logger.info('All lists sync completed', {
        total_lists: CURATED_LISTS.length,
        successful: successCount,
        total_items: total_synced,
    });

    return {
        success: successCount > 0,
        results,
        total_synced,
    };
}

/**
 * Get all available cached lists
 */
export async function getCachedLists(): Promise<CachedList[]> {
    const db = await getDatabase();
    const sql = db.getSql();

    try {
        return await sql<CachedList[]>`
            SELECT list_id, name, description, source, list_path, item_count, last_synced_at
            FROM cached_lists
            ORDER BY name ASC
        `;
    } catch (error) {
        logger.error('Failed to get cached lists', error as Error);
        return [];
    }
}

/**
 * Get items from a cached list (using UUID-based table with joins)
 */
export async function getCachedListItems(listId: string, limit = 20): Promise<CachedListItem[]> {
    const db = await getDatabase();
    const sql = db.getSql();
    const provider = getPrimaryExternalIdProvider();
    const providerFilter = sql.unsafe(buildProviderFilterUnsafe());
    const providerOrder = sql.unsafe(buildProviderOrderUnsafe());

    try {
        // Use subquery with LIMIT 1 for external_ids to prevent duplicates
        return await sql<CachedListItem[]>`
            SELECT
                cli.list_id,
                cli.rank,
                mi.id as internal_id,
                (SELECT external_id FROM external_ids
                 WHERE media_id = mi.id AND provider = ${provider} LIMIT 1) as primary_ext_id,
                (SELECT external_id FROM external_ids
                 WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) as imdb_id,
                mi.media_type,
                mi.title,
                mi.year as release_year,
                (pm.metadata->>'mdblist_score')::smallint as score,
                pm.metadata->>'poster_path' as poster_path,
                pm.metadata->>'overview' as overview
            FROM cached_list_items cli
            JOIN media_items mi ON mi.id = cli.media_id
            LEFT JOIN LATERAL (
                SELECT metadata FROM provider_metadata
                WHERE media_id = mi.id AND ${providerFilter}
                ORDER BY ${providerOrder}
                LIMIT 1
            ) pm ON true
            WHERE cli.list_id = ${listId}
            ORDER BY cli.rank ASC
            LIMIT ${limit}
        `;
    } catch (error) {
        logger.error('Failed to get cached list items', error as Error, {
            listId,
        });
        return [];
    }
}

/**
 * Check if lists need to be refreshed (older than 12 hours)
 */
export async function shouldRefreshLists(): Promise<boolean> {
    const db = await getDatabase();
    const sql = db.getSql();

    try {
        const result = await sql<{ total: string; fresh: string }[]>`
            SELECT COUNT(*) as total,
                   COUNT(CASE WHEN last_synced_at > NOW() - INTERVAL '12 hours' THEN 1 END) as fresh
            FROM cached_lists
        `;

        const { total, fresh } = result[0];

        // Refresh if no lists exist or if any are stale
        if (Number.parseInt(total, 10) === 0) return true;
        if (Number.parseInt(fresh, 10) < CURATED_LISTS.length) return true;

        return false;
    } catch (error) {
        logger.error('Failed to check list freshness', error as Error);
        return true; // Refresh on error
    }
}

/**
 * Get list definitions (without fetching from DB)
 */
export function getListDefinitions(): typeof CURATED_LISTS {
    return CURATED_LISTS;
}
