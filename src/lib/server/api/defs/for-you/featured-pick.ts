// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/featured-pick
 *
 * A single prominently featured item that rotates daily through criteria.
 * When no candidate exists, returns { pick: null } (not an error).
 * When AI DB is unavailable, returns { pick: null } (treated as soft dep).
 * DB unavailability → { pick: null } (non-critical strip; avoids 503 cascade).
 *
 * Response: bare object { pick: FeaturedPickItem | null, criteria: string | null }
 *
 * Migrated from { success: true, item: PageSection } to new contract:
 * - No success wrapper
 * - images{} hrefs (not flat posterUrl)
 * - canonical type 'series' (not 'tv')
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import { entityImageUrl, type ApiSurface } from '$lib/shared/api-urls.js';

const QuerySchema = z.object({
    nocache: z
        .string()
        .optional()
        .transform((v) => v === '1'),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event, ctx) => {
            const raw = { nocache: event.url.searchParams.get('nocache') ?? undefined };
            const parsed = QuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { nocache } = parsed.data;

            if (event.locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'AI features are not available for age-restricted profiles',
                );
            }

            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const { aiDbService } = await import('$lib/server/services/database.service.js');
            const { Logger } = await import('$lib/server/utils/logger.js');
            const logger = Logger.for('FeaturedPickDef');

            const sqlOrNull = await aiDbService.getSql();
            if (!sqlOrNull) {
                logger.warn('AI database not available for featured pick');
                return json({ pick: null, criteria: null });
            }
            // Re-bind to a non-nullable const: closures below (overlayPick) capture
            // this and TS does not retain the null-check narrowing of `sqlOrNull`
            // across a nested function declaration.
            const sql = sqlOrNull;

            const { buildSearchAccessContext, scopedCacheKey } =
                await import('$lib/server/utils/search-access-context.js');
            const { getTasteDamperService } =
                await import('$lib/server/services/taste-damper.service.js');
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
            const { fetchFeaturedPickByCriteria } =
                await import('$lib/server/database/queries/featured-pick.queries.js');
            const { restrictedAccess } =
                await import('$lib/server/database/queries/builders/media-access-boundary.js');
            const { getActiveFlagTargets, setFlag } =
                await import('$lib/server/database/queries/user-media-flags.queries.js');
            const { getExternalIdFor } = await import('$lib/utils/external-ids.js');

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);

            // Access boundary for the featured-pick queries.
            //
            // NOT `searchAccessBoundary(accessCtx)`: that projects
            // `accessCtx.ageRating` onto `age: { kind: 'limit' }`, but this route's
            // queries have never applied an age predicate — the age gate here is
            // the `isAgeRestricted` 403 above, which is a DIFFERENT predicate from
            // `buildSearchAccessContext`'s `user.maxAgeRating != null`. A user with
            // maxAgeRating set but isAgeRestricted false passes the 403 today and
            // sees age-unfiltered picks; mapping to `limit` would change which rows
            // that user gets, which this refactor must not do. That mismatch is a
            // real pre-existing gap — tracked separately, deliberately not folded
            // in here. Hence an explicit, greppable `age: any`.
            const access = restrictedAccess({
                deniedGroupIds: accessCtx.deniedGroupIds ?? [],
                maxAgeRating: null,
                allowUnrated: false,
            });

            const damper = await getTasteDamperService(sql).getDamperContext(userId);

            const { shouldSuppressContent } =
                await import('$lib/server/services/content-affinity.service.js');
            const { kids: suppressKidsContent, anime: suppressAnimeContent } =
                await shouldSuppressContent(sql, {
                    userId,
                    isAgeRestricted: event.locals.user?.isAgeRestricted ?? false,
                    moodKey: null,
                });

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved ONCE per request, applied to the pick AFTER every cache
            // read/write path below (cache hit, fresh compute) so the shared
            // aiSuggestions cache entry stays language-neutral. Feature-off
            // installs pay ZERO extra queries: the admin-language check is a
            // free synchronous config read, so it gates the getPlaybackPreferences
            // query up front.
            const { config: overlayConfig } = await import('$lib/server/config.js');
            let langs: { titleLang: string | null; textLang: string | null } = {
                titleLang: null,
                textLang: null,
            };
            if (overlayConfig.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const { resolveMetadataLanguage } =
                    await import('$lib/server/utils/metadata-language-resolve.js');
                const { getPlaybackPreferences } =
                    await import('$lib/server/database/queries/user-preferences.queries.js');
                langs = resolveMetadataLanguage(await getPlaybackPreferences.one(sql, { userId }));
            }
            async function overlayPick(
                pick: ReturnType<typeof candidateToPickItem>,
            ): Promise<ReturnType<typeof candidateToPickItem>> {
                const { enrichSeriesEpisodeCounts } =
                    await import('$lib/server/services/series-episode-counts.service.js');
                await enrichSeriesEpisodeCounts(sql, [pick], userId, access);
                if (!langs.titleLang && !langs.textLang) return pick;
                const { applyTranslationOverlay } =
                    await import('$lib/server/utils/translation-overlay.js');
                await applyTranslationOverlay(sql, [pick], langs, {
                    id: (it) => it.id || null,
                    setTitle: (it, v) => {
                        it.title = v;
                    },
                    setOverview: (it, v) => {
                        it.overview = v;
                    },
                });
                return pick;
            }

            const featuredPickCache = cacheManager.for(CACHE_NAMESPACES.aiSuggestions);
            const cacheKey = scopedCacheKey(
                `featured-pick:v3:${userId}:${damper?.hash ?? 'nd'}:supK${suppressKidsContent ? 1 : 0}A${suppressAnimeContent ? 1 : 0}`,
                accessCtx,
            );

            type FeaturedCandidate = Awaited<ReturnType<typeof fetchFeaturedPickByCriteria>>;
            type CachedPick = { candidate: NonNullable<FeaturedCandidate>; criteria: string };

            const CRITERIA_ORDER = [
                'hidden-gem',
                'fresh-for-you',
                'perfect-match',
                'overlooked-classic',
                'buzzing-now',
            ] as const;
            type FeaturedPickCriteria = (typeof CRITERIA_ORDER)[number];

            function getTodaysCriteria(): FeaturedPickCriteria {
                const dayOfYear = Math.floor(Date.now() / 86400000);
                return CRITERIA_ORDER[dayOfYear % CRITERIA_ORDER.length];
            }

            if (!nocache) {
                const cached = await featuredPickCache.get<CachedPick>(cacheKey);
                if (cached) {
                    logger.debug('Featured pick cache HIT', { userId, criteria: cached.criteria });
                    return json({
                        pick: await overlayPick(candidateToPickItem(cached.candidate, ctx.surface)),
                        criteria: cached.criteria,
                    });
                }
            }

            let excludeMediaIds: string[] = [];
            try {
                excludeMediaIds = await getActiveFlagTargets(sql, {
                    userId,
                    flagType: 'featured_pick_shown',
                });
            } catch (err) {
                logger.warn(
                    'Failed to load featured-pick shown set; serving without exclude',
                    { userId },
                    err as Error,
                );
            }

            const primaryCriteria = getTodaysCriteria();
            let candidate: FeaturedCandidate | null = null;
            let usedCriteria: FeaturedPickCriteria = primaryCriteria;

            for (let i = 0; i < CRITERIA_ORDER.length && !candidate; i++) {
                const idx = (CRITERIA_ORDER.indexOf(primaryCriteria) + i) % CRITERIA_ORDER.length;
                const criteria = CRITERIA_ORDER[idx];
                const result = await fetchFeaturedPickByCriteria(
                    sql,
                    criteria,
                    userId,
                    excludeMediaIds,
                    access,
                    50,
                    suppressKidsContent,
                    suppressAnimeContent,
                    damper,
                );
                // Library-only filter: always-on server-config gate. Discard a
                // file-less discovery candidate and fall through to the next
                // criteria rather than surfacing an unrequestable pick.
                if (result && !accessCtx.showUnavailableMedia && !result.isAvailable) {
                    continue;
                }
                candidate = result;
                if (candidate) {
                    usedCriteria = criteria;
                }
            }

            if (!candidate) {
                logger.info('No featured pick candidate found', { userId });
                return json({ pick: null, criteria: null });
            }

            // Record the shown pick before caching (non-fatal on failure)
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            try {
                await setFlag.execute(sql, {
                    userId,
                    targetId: candidate.mediaId,
                    targetType: candidate.mediaType,
                    flagType: 'featured_pick_shown',
                    expiresAt,
                });
            } catch (err) {
                logger.warn(
                    'Failed to record featured_pick_shown flag',
                    { userId, mediaId: candidate.mediaId },
                    err as Error,
                );
            }

            await featuredPickCache.set(cacheKey, {
                candidate,
                criteria: usedCriteria,
            } satisfies CachedPick);

            logger.info('Featured pick found', {
                userId,
                criteria: usedCriteria,
                title: candidate.title,
                mediaId: getExternalIdFor(candidate.externalIds, 'internal'),
            });

            return json({
                pick: await overlayPick(candidateToPickItem(candidate, ctx.surface)),
                criteria: usedCriteria,
            });
        },
    },
});

function candidateToPickItem(
    candidate: {
        mediaId: string;
        mediaType: string;
        title: string;
        year?: number | null;
        externalIds: Record<string, string | null | undefined>;
        rating?: number | null;
        overview?: string | null;
        isAvailable?: boolean;
        canRequest?: boolean;
    },
    surface: ApiSurface,
) {
    const internalId = getExternalIdFor(candidate.externalIds, 'internal') ?? candidate.mediaId;
    const ids: Record<string, string> = {};
    for (const [k, v] of Object.entries(candidate.externalIds)) {
        if (v != null) ids[k] = String(v);
    }
    const rawType = candidate.mediaType?.toLowerCase() ?? 'movie';
    // fetchFeaturedPickByCriteria's FeaturedCandidate.mediaType is typed
    // 'movie' | 'tv', and every criteria query filters `mi.media_type IN
    // ('movie', 'tv')` — this can never be anything else.
    // eslint-disable-next-line callback-safety/no-inline-media-type-default -- featured candidates are movie/TV-only.
    const canonicalType = toMovieOrSeries(rawType) ?? 'movie';
    return {
        id: internalId,
        type: canonicalType,
        title: candidate.title,
        ...(candidate.year != null ? { year: candidate.year } : {}),
        ...(candidate.overview ? { overview: candidate.overview } : {}),
        ...(candidate.rating != null ? { rating: candidate.rating } : {}),
        images: {
            poster: { href: entityImageUrl(internalId, 'poster', surface) },
            backdrop: { href: entityImageUrl(internalId, 'backdrop', surface) },
            logo: { href: entityImageUrl(internalId, 'logo', surface) },
        },
        ids,
        // The candidate queries join library + discovery with no has_files filter
        // in SQL; the selection loop above discards file-less candidates when
        // showUnavailableMedia is off, but with the gate on a pick can still be
        // request-only. Carry availability so the client gates the Watch button
        // instead of rendering a /watch/<uuid> link that 404s.
        isAvailable: candidate.isAvailable ?? true,
        canRequest: candidate.canRequest ?? false,
    };
}
