// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FulfilledRequestsStrategy — surfaces items the user requested that are now available.
 *
 * Collapses (§rename-map):
 *   for-you/fulfilled-requests → recommendations?type=fulfilled-requests
 */

import type {
    RecommenderStrategy,
    AccessContext,
    RecommenderOptions,
    RecommenderResult,
    RecommendationItem,
    RecommendedMediaRef,
} from '../recommender.js';
import { Logger } from '$lib/server/utils/logger.js';
import { DependencyUnavailableError, isDependencyUnavailable } from '$lib/server/api/problem.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import type { ExternalIds } from '$lib/types/api-common.js';
import { resolveMediaRefId } from '../../for-you/item-mapper.js';
import { m } from '$lib/paraglide/messages.js';

const logger = Logger.for('FulfilledRequestsStrategy');

/** Release year from an ISO date (`2019-07-12`); undefined when absent or malformed. */
function releaseYear(releaseDate: string | undefined): number | undefined {
    const match = /^(\d{4})(?:-|$)/.exec(releaseDate ?? '');
    return match ? Number(match[1]) : undefined;
}

export class FulfilledRequestsStrategy implements RecommenderStrategy {
    readonly id = 'fulfilled-requests';
    readonly label = m.settings_feed_kind_fulfilled_requests;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                // DB DOWN — signal dependency-down (NOT genuine-empty).
                throw new DependencyUnavailableError('Database unavailable', 'postgres');
            }

            const { restrictedAccess } =
                await import('$lib/server/database/queries/builders/media-access-boundary.js');
            const { fetchFulfilledRequests } =
                await import('$lib/server/services/for-you.service.js');

            // Access boundary built directly from the request's REAL access facts
            // (`ctx.deniedGroupIds` etc, resolved once in `buildAccessContext`).
            const access = restrictedAccess({
                deniedGroupIds: ctx.deniedGroupIds ?? [],
                maxAgeRating: ctx.maxAgeRating,
                allowUnrated: ctx.allowUnrated,
            });

            // This call site was MISALIGNED before the boundary migration:
            //   fetchFulfilledRequests(sql, ctx.userId, fetchLimit, accessCtx)
            // against (sql, username: string, options = {}, access). `ctx.userId`
            // is a UUID being passed as `username` straight into
            // jellyseerrClient.getFulfilledRequestsForUser (so this rail could
            // only ever return empty), and `fetchLimit` — a number — landed on the
            // `{dismissedMediaIds?}` options slot. The access argument only
            // arrived intact because SearchAccessContext was structurally a
            // superset of the inline access type. None of it was caught because
            // the repo has no working typecheck gate.
            //
            // Fixed here: real username, an empty options object (behaviour-
            // identical — `fetchLimit` never had a readable property on it), and
            // an explicit boundary. The `fetchLimit` local is gone with it — it
            // was never read anywhere else (fetchFulfilledRequests has no limit
            // parameter, and the hasMore sentinel below compares against
            // opts.limit directly).
            //
            // Cached as pre-map service rows (never the mapped items — see the
            // overlay invariant on RecommenderStrategy), in the same namespace as
            // for-you/fulfilled-requests.ts. Uncached, this rail cost a Seerr
            // round-trip plus catalogue lookups on every home load (~400 ms).
            // The rows are access-filtered, so the key carries every access fact.
            // An empty list is never cached: a Seerr failure also reads as [].
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
            const cache = cacheManager.for(CACHE_NAMESPACES.fulfilledRequests);
            const accessToken = [
                [...(ctx.deniedGroupIds ?? [])].sort().join(','),
                ctx.maxAgeRating ?? 'any',
                ctx.allowUnrated ? 'u1' : 'u0',
            ].join(';');
            const cacheKey = `strategy:v1:${ctx.username.toLowerCase()}:${accessToken}`;
            type Rows = Awaited<ReturnType<typeof fetchFulfilledRequests>>;
            let rawItems = opts.refresh ? null : await cache.get<Rows>(cacheKey).catch(() => null);
            if (rawItems === null) {
                rawItems = await fetchFulfilledRequests(sql, ctx.username, {}, access);
                if (rawItems.length > 0) await cache.set(cacheKey, rawItems).catch(() => undefined);
            }

            if (!ctx.showUnavailableMedia || opts.availableOnly) {
                rawItems = rawItems.filter((item) => item.isAvailable);
            }
            const hasMore = rawItems.length > opts.limit;
            const page = rawItems.slice(0, opts.limit);

            const items: RecommendationItem[] = page.flatMap((item): RecommendationItem[] => {
                const extIds = (item.externalIds ?? {}) as ExternalIds;
                // A type with no public representation is DROPPED, never
                // relabelled (the old `?? item.mediaType ?? 'movie'` leaked the
                // raw storage token into the public discriminator).
                const canonical = toPublicMediaType(item.mediaType);
                if (!canonical) return [];

                const idsRecord: Record<string, string> = {};
                for (const [k, v] of Object.entries(extIds)) {
                    if (v != null) idsRecord[k] = String(v);
                }

                // A fulfilled Jellyseerr request whose file hasn't been scanned
                // into the catalogue yet has no internal UUID. This used to emit
                // `id: ''` — unresolvable, and an empty string collides as a list
                // key across every such item on the page. Fall back to a valid
                // composite, and drop the item only if even that is impossible.
                const mediaId = resolveMediaRefId(extIds, canonical);
                if (!mediaId) return [];

                const year = releaseYear(item.releaseDate);
                const media: RecommendedMediaRef = {
                    id: mediaId,
                    type: canonical,
                    title: item.title ?? 'Unknown',
                    ...(year !== undefined ? { year } : {}),
                    ids: idsRecord,
                };

                // No `reason.label`: the client renders it as the card subtitle,
                // and a made-up token there reads as a bug. The release year is
                // the subtitle every other movie/series rail shows.
                return [{ media }];
            });

            return { items, hasMore };
        } catch (err) {
            // Propagate dependency-down so the caller can return 503 / drop the section.
            if (isDependencyUnavailable(err)) throw err;
            logger.error('FulfilledRequestsStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const fulfilledRequestsStrategy = new FulfilledRequestsStrategy();
