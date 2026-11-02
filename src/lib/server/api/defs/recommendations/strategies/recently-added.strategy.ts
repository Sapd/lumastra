// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RecentlyAddedStrategy — recently scanned library items.
 *
 * Folds the legacy `GET /api/for-you/recently-added` rail. Backed by
 * `getRecentlyAddedItems` (onboarding.queries) — pure library media, NO TMDB
 * service and NO seed. Scope-scoped cache; reason kind 'recently-added', no
 * score. DB DOWN → DependencyUnavailableError.
 */

import type {
    RecommenderStrategy,
    AccessContext,
    RecommenderOptions,
    RecommenderResult,
} from '../recommender.js';
import { Logger } from '$lib/server/utils/logger.js';
import { DependencyUnavailableError, isDependencyUnavailable } from '$lib/server/api/problem.js';
import {
    mapBatch,
    libraryRowsToItems,
    hydrateRailMetadata,
    type GenericForYouItem,
} from '../../for-you/item-mapper.js';
import { m } from '$lib/paraglide/messages.js';

const logger = Logger.for('RecentlyAddedStrategy');

export class RecentlyAddedStrategy implements RecommenderStrategy {
    readonly id = 'recently-added';
    readonly label = m.section_recently_added;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) throw new DependencyUnavailableError('Database unavailable', 'postgres');

            const { CACHE_NAMESPACES, searchScopedCacheWithBoundary } =
                await import('$lib/server/cache/index.js');
            const { buildSearchAccessContext, searchAccessBoundary } =
                await import('$lib/server/utils/search-access-context.js');
            const { getRecentlyAddedItems } =
                await import('$lib/server/database/queries/onboarding.queries.js');

            const fakeUser = {
                userId: ctx.userId,
                username: ctx.username,
                maxAgeRating: ctx.maxAgeRating,
                isAgeRestricted: ctx.isAgeRestricted,
            };
            const searchCtx = await buildSearchAccessContext(
                sql,
                fakeUser as Parameters<typeof buildSearchAccessContext>[1],
            );

            // ONE boundary value feeds BOTH the SQL predicate and the cache key
            // below. Previously those were two independent derivations of the same
            // access fact (the key from `searchCtx`, the predicate from two fields
            // pulled out of it), which is exactly how a key and its payload drift
            // apart.
            const access = searchAccessBoundary(searchCtx);

            // Recently-added rows are limit-independent after reshaping: a page is
            // just a prefix of the same recency ordering (getRecentlyAddedItems
            // orders deterministically, then mapBatch slices to `limit`). So cache
            // ONE fixed max-size list per access scope and slice per request —
            // different limits share a single entry instead of each warming its
            // own. This is the reuse the old code's own comment promised but never
            // delivered (it keyed on opts.limit).
            //
            // v4: cache key no longer carries `:${opts.limit}` (see above). v3
            // stored the GenericForYouItem shape per-limit; the payload shape is
            // unchanged, only the key. Old v3 entries are simply ignored.
            const CACHE_FETCH_SIZE = 60;

            // A request larger than the cached window can't be satisfied from it
            // (would under-return + report the wrong hasMore), so fall back to a
            // direct, correctly-sized fetch. In practice recommendation limits are
            // well under CACHE_FETCH_SIZE, so this path is rarely taken.
            if (opts.limit + 1 > CACHE_FETCH_SIZE) {
                const rawItems = await getRecentlyAddedItems(sql, opts.limit + 1, access);
                const result = mapBatch(
                    libraryRowsToItems(rawItems),
                    opts.limit,
                    'recently-added',
                    opts.surface,
                );
                await hydrateRailMetadata(sql, result.items);
                return result;
            }

            // v5: the key carries a boundary token appended to the scoped suffix.
            // `scopedCacheKey` contributes NOTHING for an unrestricted caller, so
            // every unrestricted caller shares one bare entry — and any boundary
            // state it does not inspect (notably `denyAll`, which is inexpressible
            // in the legacy pair it reads) would land on that same shared entry and
            // be served the full library. `boundaryCacheKey` emits a distinct token
            // for EVERY variant, so `all`, `denyGroups` and `denyAll` can never
            // collide. Appending rather than replacing keeps the locale / livetv /
            // lib-only dimensions the scoped key already partitioned on: this only
            // ever splits keys further, never merges two callers' entries.
            //
            // `searchScopedCacheWithBoundary` binds the cache to BOTH the search
            // context AND the query boundary; the wrapper folds both into the key
            // internally — byte-identical to the previous
            // `${scopedCacheKey(...)}|${boundaryCacheKey(access)}` hand-concat.
            // There is no method here that accepts a pre-formed key, so the access
            // token cannot be dropped by accident.
            const recentlyAddedCache = searchScopedCacheWithBoundary(
                CACHE_NAMESPACES.browseRecentlyAdded,
                searchCtx,
                access,
            );
            const cacheBase = 'for-you-recently-added:v5:max';

            const cached = await recentlyAddedCache.get<GenericForYouItem[]>(cacheBase);
            if (cached) {
                const result = mapBatch(cached, opts.limit, 'recently-added', opts.surface);
                await hydrateRailMetadata(sql, result.items);
                return result;
            }

            const rawItems = await getRecentlyAddedItems(sql, CACHE_FETCH_SIZE, access);

            // Reshape { id, media_type } → GenericForYouItem (externalIds.internal) so
            // the mapper can build catalog hrefs + a unique media id. Cache the
            // reshaped rows (the full max-size list) so it's reusable across limits.
            const rows = libraryRowsToItems(rawItems);
            await recentlyAddedCache.set(cacheBase, rows);

            const result = mapBatch(rows, opts.limit, 'recently-added', opts.surface);
            await hydrateRailMetadata(sql, result.items);
            return result;
        } catch (err) {
            if (isDependencyUnavailable(err)) throw err;
            logger.error('RecentlyAddedStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const recentlyAddedStrategy = new RecentlyAddedStrategy();
