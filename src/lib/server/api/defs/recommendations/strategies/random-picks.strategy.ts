// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RandomPicksStrategy — random library items for discovery.
 *
 * Folds the legacy `GET /api/for-you/random-picks` rail. Backed by
 * `getRandomPickItems` (onboarding.queries); NO cache (randomised each call);
 * reason kind 'editorial', no score. DB DOWN → DependencyUnavailableError.
 *
 * NOTE: because results are non-deterministic and uncached, offset paging and
 * `refresh` are meaningless here — every call re-randomises. Clients should
 * treat the response as a fresh shuffle, not a stable page.
 */

import type {
    RecommenderStrategy,
    AccessContext,
    RecommenderOptions,
    RecommenderResult,
} from '../recommender.js';
import { Logger } from '$lib/server/utils/logger.js';
import { DependencyUnavailableError, isDependencyUnavailable } from '$lib/server/api/problem.js';
import { mapBatch, libraryRowsToItems, hydrateRailMetadata } from '../../for-you/item-mapper.js';
import { m } from '$lib/paraglide/messages.js';

const logger = Logger.for('RandomPicksStrategy');

export class RandomPicksStrategy implements RecommenderStrategy {
    readonly id = 'random-picks';
    readonly label = m.section_random_picks;
    readonly mediaTypeFiltering = 'native' as const;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) throw new DependencyUnavailableError('Database unavailable', 'postgres');

            const { restrictedAccess } =
                await import('$lib/server/database/queries/builders/media-access-boundary.js');
            const { getRandomPickItems } =
                await import('$lib/server/database/queries/onboarding.queries.js');

            // Access boundary built directly from the request's REAL access facts
            // (`ctx.deniedGroupIds` etc, resolved once in `buildAccessContext`),
            // replacing the old positional `(ageRating, deniedGroupIds)` pair —
            // two independently-omittable, independently-swappable args.
            const access = restrictedAccess({
                deniedGroupIds: ctx.deniedGroupIds ?? [],
                maxAgeRating: ctx.maxAgeRating,
                allowUnrated: ctx.allowUnrated,
            });

            // Random order is intentionally regenerated per request, so shared
            // prefix expansion is not valid for this strategy. Push the public
            // allow-list into the one randomized query instead. Offset remains
            // a no-op by design: each call is a fresh shuffle.
            const databaseTypes = opts.mediaTypes
                ? [
                      ...(opts.mediaTypes.has('movie') ? (['movie'] as const) : []),
                      ...(opts.mediaTypes.has('series') ? (['tv'] as const) : []),
                  ]
                : null;
            if (databaseTypes?.length === 0) return { items: [], hasMore: false, total: 0 };

            // Over-fetch by 1 for hasMore detection.
            const rawItems = await getRandomPickItems(sql, opts.limit + 1, access, databaseTypes);

            const result = mapBatch(
                libraryRowsToItems(rawItems),
                opts.limit,
                'editorial',
                opts.surface,
            );
            await hydrateRailMetadata(sql, result.items);
            return result;
        } catch (err) {
            if (isDependencyUnavailable(err)) throw err;
            logger.error('RandomPicksStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const randomPicksStrategy = new RandomPicksStrategy();
