// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/keywords
 *
 * Keyword-based ("You Like X") recommendation sections.
 * User- and access-scoped cache (5min L1 / 15min L2).
 *
 * Response: bare object { sections: KeywordSection[] }
 *
 * Sections contain canonical RecommendationItem-like shapes.
 * images{} hrefs replace flat posterUrl. type 'series' (not 'tv').
 * No success wrapper.
 *
 * NOTE: The internal representation uses a legacy PageSection structure.
 * We map it to canonical items here. For SDUI clients that need the full
 * PageSection shape, they should switch to the feed (SDUI) endpoint.
 *
 * DB unavailability → 503.
 * AI DB unavailability → 503 (embedding-based ranking requires it).
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    KeywordsResponseSchema,
    type ForYouKeywordSection,
} from '$lib/schemas/api-for-you-responses.js';
import { buildImagesFromUuid } from './item-mapper.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';

const QuerySchema = z.object({
    rows: z.coerce.number().int().min(1).max(5).optional().default(2),
    items: z.coerce.number().int().min(1).max(20).optional().default(8),
    watched: z.string().optional(),
    available: z
        .string()
        .optional()
        .transform((v) => v === 'true'),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event, ctx) => {
            const raw = {
                rows: event.url.searchParams.get('rows') ?? undefined,
                items: event.url.searchParams.get('items') ?? undefined,
                watched: event.url.searchParams.get('watched') ?? undefined,
                available: event.url.searchParams.get('available') ?? undefined,
            };
            const parsed = QuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const {
                rows: rowLimit,
                items: itemsLimit,
                watched: watchedParam,
                available: availableOnly,
            } = parsed.data;

            // Age-restricted profiles cannot access AI keyword recommendations
            if (event.locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'AI features are not available for age-restricted profiles',
                );
            }

            const { isFeedKindHidden } = await import('$lib/server/utils/feed-prefs-gate.js');
            if (await isFeedKindHidden(event.locals, 'you-like')) {
                return json({ sections: [] });
            }

            const { getDb } = await import('$lib/server/database/index.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { config } = await import('$lib/server/config.js');
            const { getEffectiveUser } = await import('$lib/server/dev-user.js');
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const { fetchKeywordBasedRecommendations } =
                await import('$lib/server/services/for-you.service.js');
            const { getTasteDamperService } =
                await import('$lib/server/services/taste-damper.service.js');
            const { buildYouLikeSections } = await import('$lib/server/utils/section-builder.js');
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
            const { buildSearchAccessContext, buildSearchAccessCacheKey, searchAccessBoundary } =
                await import('$lib/server/utils/search-access-context.js');
            const { getUserWatchedItems } = await import('$lib/server/utils/user-watch-history.js');
            const { parseMediaId } = await import('$lib/server/utils/media-key-parser.js');
            const { providerResolutionService } =
                await import('$lib/server/services/provider-resolution.service.js');
            const { isMovie, isSeries } = await import('$lib/server/utils/media-types.js');
            const { Logger } = await import('$lib/server/utils/logger.js');
            const { getLocale } = await import('$lib/paraglide/runtime.js');
            const logger = Logger.for('KeywordsDef');

            const effectiveUsername = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );

            // Parse watched items (provider:id:mediaType composite keys)
            async function parseWatchedItems(param: string): Promise<Array<WatchedMediaItem>> {
                if (!param) return [];
                // Parse + validate the CSV entries synchronously, then resolve
                // them to TMDB ids in parallel — each lookup is independent and
                // the result set is order-insensitive. A single failed (or
                // rejected) resolve must not kill the batch, so each entry is
                // guarded and contributes null on failure.
                const candidates = param
                    .split(',')
                    .map((key) => parseMediaId(key.trim()))
                    .filter(
                        (p) =>
                            p.type === 'composite' &&
                            !!p.provider &&
                            !!p.externalId &&
                            !!p.mediaType &&
                            (isMovie(p.mediaType) || isSeries(p.mediaType)),
                    );
                const resolved = await Promise.all(
                    candidates.map(async (p): Promise<WatchedMediaItem | null> => {
                        const provider = p.provider;
                        const externalId = p.externalId;
                        const mediaType = p.mediaType;
                        if (!provider || !externalId || !mediaType) return null;
                        // Normalise once. The filter above admits 'series' as
                        // well as 'tv', so asserting the raw token downstream
                        // would carry 'series' under the 'tv' type.
                        const canonicalType: 'movie' | 'tv' = isMovie(mediaType) ? 'movie' : 'tv';
                        try {
                            const resolution = await providerResolutionService.resolveToTmdb(
                                { [provider]: externalId },
                                canonicalType,
                            );
                            if (!resolution.success) return null;
                            return {
                                primary_ext_id: String(resolution.tmdbId),
                                media_type: canonicalType,
                            };
                        } catch {
                            return null;
                        }
                    }),
                );
                return resolved.filter((r): r is WatchedMediaItem => r !== null);
            }

            type WatchedMediaItem = { primary_ext_id: string; media_type: 'movie' | 'tv' };
            let watchedItems: WatchedMediaItem[] = watchedParam
                ? await parseWatchedItems(watchedParam)
                : [];
            if (watchedItems.length === 0 && effectiveUsername) {
                watchedItems = await getUserWatchedItems(effectiveUsername, 100);
            }
            if (watchedItems.length === 0) return json({ sections: [] });

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const accessSuffix = buildSearchAccessCacheKey(accessCtx);
            const effectiveUserId = await getUserIdByUsername(sql, effectiveUsername);
            const damper = effectiveUserId
                ? await getTasteDamperService(sql).getDamperContext(effectiveUserId)
                : null;

            const CACHE_ROWS = 5;
            const CACHE_ITEMS = 15;
            // v4: missing-embedding cosine default in the keyword scorer dropped
            // from 0.5 → 0 (unscored items no longer get a half-match freebie),
            // which reorders results — shed values cached under the v3 key.
            const cacheKey = `${getLocale()}:keywords:user:v4${accessSuffix ? ':' + accessSuffix : ''}:${damper?.hash ?? 'nd'}`;
            const keywordsCache = cacheManager.for(CACHE_NAMESPACES.forYouKeywords);

            type PageSectionLike = {
                id: string;
                title: string;
                type: string;
                keyword?: string;
                items: Array<{
                    id?: string;
                    title?: string;
                    mediaType?: string;
                    externalIds?: Record<string, string | null | undefined>;
                    isAvailable?: boolean;
                    canRequest?: boolean;
                    posterUrl?: string;
                    image?: string;
                    year?: number | null;
                }>;
            };

            let rawSections: PageSectionLike[];

            try {
                const cached = await keywordsCache.get<PageSectionLike[]>(
                    cacheKey,
                    effectiveUserId ?? undefined,
                );
                if (cached) {
                    rawSections = cached;
                } else {
                    // Single-flight the embedding-ranked keyword compute so a burst
                    // of concurrent cold-cache misses (this rail is on the home
                    // feed) runs the expensive query once. Query SHAPE untouched —
                    // only the miss path is wrapped. Raw Valkey key mirrors
                    // UnifiedCache.buildL2Key(cacheKey, effectiveUserId).
                    const { getOrComputeSingleFlight } =
                        await import('$lib/server/cache/single-flight.js');
                    const ns = CACHE_NAMESPACES.forYouKeywords;
                    const rawKey = effectiveUserId
                        ? `${ns.name}:${effectiveUserId}:${cacheKey}`
                        : `${ns.name}:${cacheKey}`;
                    const ttlSeconds = Math.floor(ns.l2TTL / 1000);
                    const jsonStr = await getOrComputeSingleFlight({
                        cacheKey: rawKey,
                        ttlSeconds,
                        compute: async () => {
                            const keywordRows = await fetchKeywordBasedRecommendations(
                                sql,
                                watchedItems,
                                { limit: CACHE_ROWS, itemsPerKeyword: CACHE_ITEMS },
                                effectiveUserId,
                                searchAccessBoundary(accessCtx),
                                { damper },
                            );
                            return JSON.stringify(buildYouLikeSections(keywordRows));
                        },
                    });
                    rawSections = JSON.parse(jsonStr) as PageSectionLike[];
                    // Populate L1 so subsequent in-process reads skip Valkey.
                    void keywordsCache.set(
                        cacheKey,
                        rawSections,
                        undefined,
                        effectiveUserId ?? undefined,
                    );
                }
            } catch (err) {
                logger.error('Failed to load keyword recommendations', err as Error, {
                    username: effectiveUsername,
                });
                return ApiProblem.dependencyUnavailable(
                    'Keyword recommendations temporarily unavailable',
                );
            }

            // Apply limits and availability filter
            let sections = rawSections.slice(0, rowLimit);

            if (availableOnly || !accessCtx.showUnavailableMedia) {
                sections = sections
                    .map((s) => ({
                        ...s,
                        items: s.items.filter((item) => item.isAvailable !== false),
                    }))
                    .filter((s) => s.items.length > 0);
            }

            sections = sections.map((s) => ({ ...s, items: s.items.slice(0, itemsLimit) }));

            // Map to canonical shape with images{} hrefs. Typed against the
            // canonical schema (z.infer<typeof ForYouKeywordSectionSchema>) so a
            // construction drift from the client contract is a compile error.
            const canonicalSections: ForYouKeywordSection[] = sections.map((s) => ({
                id: s.id,
                type: 'carousel',
                title: s.title,
                ...(s.keyword ? { keyword: s.keyword } : {}),
                items: s.items.flatMap((item) => {
                    // Drop rather than relabel a row whose internal media_type has
                    // no public representation, and rather than default an ABSENT
                    // type to 'movie' (the old `canonicalType(item.mediaType ??
                    // 'movie')`): `type` is what the client routes the Watch
                    // button off. Keyword rows come from `media_items` via
                    // `media_keywords`, which is movie/series-scoped, so this
                    // drops nothing in practice — it just stops the contract from
                    // depending on that.
                    const publicType = toPublicMediaType(item.mediaType);
                    if (!publicType) return [];

                    const internalId =
                        item.id ??
                        (item.externalIds
                            ? getExternalIdFor(item.externalIds, 'internal')
                            : undefined);
                    const ids: Record<string, string> = {};
                    if (item.externalIds) {
                        for (const [k, v] of Object.entries(item.externalIds)) {
                            if (v != null) ids[k] = String(v);
                        }
                    }
                    return [
                        {
                            id: internalId ?? '',
                            type: publicType,
                            title: item.title ?? '',
                            ...(item.year != null ? { year: item.year } : {}),
                            ids,
                            images: internalId
                                ? buildImagesFromUuid(internalId, ctx.surface)
                                : undefined,
                            // Carry availability so the client can gate the Watch button.
                            // Keyword rows interleave available + requestable (has_files=false)
                            // items; without this a request-only title renders as watchable.
                            isAvailable: item.isAvailable ?? true,
                            canRequest: item.canRequest ?? false,
                        },
                    ];
                }),
            }));

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved ONCE per request, applied AFTER the cached compute so
            // the shared Valkey/L1 payload stays language-neutral. Keyword sections
            // carry no `overview` field in their canonical shape — title only.
            const userId = event.locals.user?.userId;
            if (userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const { resolveMetadataLanguage } =
                    await import('$lib/server/utils/metadata-language-resolve.js');
                const { getPlaybackPreferences } =
                    await import('$lib/server/database/queries/user-preferences.queries.js');
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId }),
                );
                if (langs.titleLang || langs.textLang) {
                    const { applyTranslationOverlay } =
                        await import('$lib/server/utils/translation-overlay.js');
                    const allItems = canonicalSections.flatMap((s) => s.items);
                    await applyTranslationOverlay(sql, allItems, langs, {
                        id: (it) => it.id || null,
                        setTitle: (it, v) => {
                            it.title = v;
                        },
                    });
                }
            }

            // Parse-before-json gate: validate the response against the single
            // source of truth the client parses too, so server/client cannot
            // silently drift (mirrors the pattern in routes/api/recommendations).
            return json(KeywordsResponseSchema.parse({ sections: canonicalSections }));
        },
    },
});
