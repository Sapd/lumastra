// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/fulfilled-requests
 *
 * User's requests that are now available in the library.
 *
 * NOT folded into the shared recommender dispatch (`getRailItems`) — this def
 * intentionally keeps its own pipeline. The `fulfilledRequestsStrategy`
 * (served at `/recommendations?type=fulfilled-requests`) is NOT
 * response-shape-compatible with this public URL and cannot be substituted
 * without breaking the contract:
 *   - The strategy builds `media` by hand WITHOUT the `images{}` catalog hrefs
 *     this def emits via `mapBatch` (folding it in would drop every poster).
 *   - The strategy omits `media.year` and `score`, and labels items with
 *     `reason.kind = 'for-you'` where this URL returns `reason.kind = 'upcoming'`.
 *   - The strategy calls `fetchFulfilledRequests` with a different signature than
 *     this def (which passes the effective username + `dismissedMediaIds`
 *     anti-join + explicit access scope). That service is owned by a concurrent
 *     task and is mid-refactor, so delegating here would couple this public URL
 *     to unverifiable in-flight code.
 * Per the compat contract, this rail stays on its own pipeline until the
 * strategy is brought to shape parity (see Task 9 report).
 *
 * Response: paginate(RecommendationItem[], page)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { paginate, ApiProblem } from '$lib/server/api/problem.js';
import { buildAccessContext } from '../recommendations/recommender.js';
import { mapBatch, hydrateRailMetadata } from './item-mapper.js';

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).optional().default(10),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event, ctx) => {
            const raw = { limit: event.url.searchParams.get('limit') ?? undefined };
            const parsed = QuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { limit } = parsed.data;

            const accessCtx = await buildAccessContext(event);
            if (!accessCtx) return ApiProblem.unauthorized();

            // Age-restricted users cannot access Jellyseerr-sourced request data
            if (event.locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'Fulfilled requests are not available for age-restricted profiles',
                );
            }

            const { getDb } = await import('$lib/server/database/index.js');
            const dbSql = getDb();
            if (!dbSql) return ApiProblem.dependencyUnavailable('Database not available');
            // Re-bind to a non-nullable const: closures below (overlayItems) capture
            // this and TS does not retain the null-check narrowing of `dbSql`
            // across a nested function declaration.
            const sql = dbSql;

            const { config } = await import('$lib/server/config.js');
            const { getEffectiveUser } = await import('$lib/server/dev-user.js');
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const { fetchFulfilledRequests } =
                await import('$lib/server/services/for-you.service.js');
            const { getActiveFlagTargets } =
                await import('$lib/server/database/queries/user-media-flags.queries.js');
            const { buildSearchAccessContext, searchAccessBoundary } =
                await import('$lib/server/utils/search-access-context.js');
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
            const { getLocale } = await import('$lib/paraglide/runtime.js');
            const { Logger } = await import('$lib/server/utils/logger.js');
            const logger = Logger.for('FulfilledRequestsDef');

            const effectiveUsername = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );

            const effectiveUserId = await getUserIdByUsername(sql, effectiveUsername);
            const cache = cacheManager.for(CACHE_NAMESPACES.fulfilledRequests);
            const cacheKey = `${getLocale()}:fulfilled-requests:v2:${effectiveUserId ?? effectiveUsername}`;

            // Rail display metadata (overview/rating/genres/runtime/quality tiers)
            // is NOT part of the fulfilled-requests fetch/cache path above —
            // `mapBatch` builds `media` from bare externalIds/title/type, so every
            // item lands here with none of it, and MediaHoverCard's popup
            // (overview paragraph, ⭐/RT rating badges, runtime, genre tags — all
            // gated on the corresponding `currentItem.*` field) renders none of
            // them. `hydrateRailMetadata` (item-mapper.ts) is the shared fix for
            // this, centralised there so every rail that calls `mapBatch` can
            // opt in with one line instead of re-deriving it per def.

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): reuses the langs already resolved ONCE per request by
            // buildAccessContext (accessCtx.langs) instead of issuing a second
            // getPlaybackPreferences query. Applied AFTER every cache read/write
            // path below, and only ever to the freshly-mapped `mapBatch` output
            // (never the cached rows), so the shared fulfilledRequests cache
            // stays language-neutral.
            async function overlayItems(
                items: ReturnType<typeof mapBatch>['items'],
            ): Promise<void> {
                const langs = accessCtx!.langs;
                if (!langs || (!langs.titleLang && !langs.textLang)) return;
                const { applyTranslationOverlay } =
                    await import('$lib/server/utils/translation-overlay.js');
                await applyTranslationOverlay(sql, items, langs, {
                    id: (it) => it.media.id || null,
                    setTitle: (it, v) => {
                        it.media.title = v;
                    },
                    setOverview: (it, v) => {
                        it.media.overview = v;
                    },
                });
            }

            type CachedPayload = { items: Awaited<ReturnType<typeof fetchFulfilledRequests>> };
            const cachedPayload = await cache.get<CachedPayload>(cacheKey).catch(() => null);
            if (cachedPayload !== null) {
                const { items, hasMore } = mapBatch(
                    cachedPayload.items.filter(
                        (item) => accessCtx.showUnavailableMedia || item.isAvailable,
                    ) as Array<{
                        externalIds: (typeof cachedPayload.items)[0]['externalIds'];
                        mediaType: string;
                        title: string;
                    }>,
                    limit,
                    'upcoming',
                    ctx.surface,
                );
                await hydrateRailMetadata(sql, items);
                await overlayItems(items);
                return json(paginate(items, { limit, offset: 0, hasMore }));
            }

            let dismissedMediaIds: ReadonlySet<string> = new Set();
            try {
                if (!effectiveUserId) throw new Error('no local user for flags');
                const ids = await getActiveFlagTargets(sql, {
                    userId: effectiveUserId,
                    flagType: 'request_dismissed',
                });
                dismissedMediaIds = new Set(ids);
            } catch (error) {
                logger.warn(
                    'Failed to load request_dismissed flags; serving without anti-join',
                    {
                        username: effectiveUsername,
                    },
                    error as Error,
                );
            }

            const searchCtx = await buildSearchAccessContext(sql, event.locals.user);
            const fulfilledRequests = await fetchFulfilledRequests(
                sql,
                effectiveUsername,
                { dismissedMediaIds },
                searchAccessBoundary(searchCtx),
            );

            await cache
                .set(cacheKey, { items: fulfilledRequests } satisfies CachedPayload)
                .catch(() => {});

            const { items, hasMore } = mapBatch(
                fulfilledRequests.filter(
                    (item) => accessCtx.showUnavailableMedia || item.isAvailable,
                ) as Array<{
                    externalIds: (typeof fulfilledRequests)[0]['externalIds'];
                    mediaType: string;
                    title: string;
                }>,
                limit,
                'upcoming',
                ctx.surface,
            );
            await hydrateRailMetadata(sql, items);
            await overlayItems(items);
            return json(paginate(items, { limit, offset: 0, hasMore }));
        },
    },
});
