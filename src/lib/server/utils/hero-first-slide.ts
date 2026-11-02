// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Server-side hero first-slide resolver.
 *
 * The homepage hero renders slide 0 in the initial HTML so the most-engaging
 * pixel paints with first byte. Two branches:
 *
 *  1. Personalized — reuse the top Next Up row the Continue-Watching SSR path
 *     ALREADY fetched (no extra query). The reused row is the already
 *     overlay-applied / dedup'd / access-vetted `ContinueWatchingItem` from
 *     `effectiveWatchingFor`, so it inherits that path's access scoping.
 *  2. Generic fallback — one access-scoped library item, cached under an
 *     access-scoped key so two users with different access never share a slide.
 *
 * NEVER throws to the page: every failure returns null so the page degrades to
 * the client building the hero on mount.
 *
 * NOTE ON THE REUSED TYPE: the design brief assumed `effectiveWatchingFor`
 * returns raw `NextUpRow[]`, but it actually returns mapped
 * `ContinueWatchingItem[]` (post overlay + access vetting). Reusing the mapped
 * item is strictly better — it is the access-filtered, deduped row, and it
 * already carries `externalIds.internal = episode media_id` (set by the
 * service's `nextUpRowToItem`), which is exactly the reconciliation key the
 * client hero transform expects. Plumbing a second raw `getNextUp` would
 * violate the "reuse, don't re-query" requirement, so we map from the item.
 */

import type postgres from 'postgres';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import type { ContinueWatchingItem } from '$lib/server/utils/section-builder.js';
import type { HeroFirstSlide } from '$lib/schemas/hero.js';
import { getHeroFallbackItem } from '$lib/server/database/queries/hero-fallback.queries.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import {
    scopedCacheKey,
    searchAccessBoundary,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context.js';
import type { ResolvedMetadataLanguages } from '$lib/server/utils/metadata-language-resolve.js';
import {
    overlayHeroMediaItems,
    heroLangCacheToken,
} from '$lib/server/utils/hero-item-translation.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('HeroFirstSlide');

export interface ResolveHeroFirstSlideArgs {
    /** DB handle for the generic-fallback query. Null disables the fallback branch. */
    sql: postgres.Sql | null;
    /**
     * Top Next Up row reused from the watching SSR path (already access-vetted).
     * When present, the personalized slide is built from it with no DB access.
     */
    topNextUp: ContinueWatchingItem | null;
    /** True for age-restricted viewers — they only ever get the GENERIC slide. */
    isAgeRestricted: boolean;
    /**
     * Full access context. SINGLE source for BOTH the fallback cache key and the
     * fallback query's access boundary.
     *
     * There used to be a separate `access` field holding the boundary while the
     * cache key came from `accessCtx`, with nothing tying the two together — a
     * cache-poisoning shape (diverge them and a restricted viewer's slide gets
     * stored under a permissive key), plus a live permissive-default bug: the
     * guard below checked `accessCtx` but not `access`, and the read was
     * `args.access?.deniedGroupIds ?? null`, so a null `access` alongside a
     * non-null `accessCtx` reached the DB completely unfiltered. Deriving the
     * boundary here via `searchAccessBoundary` makes both impossible by
     * construction. Null → no fallback slide at all (see the guard).
     */
    accessCtx: SearchAccessContext | null;
    /**
     * Viewer's metadata-language overlay. The personalized branch reuses a
     * `topNextUp` that was ALREADY localized upstream (effectiveWatchingFor), so
     * only the GENERIC fallback slide is overlaid here — keyed on its media_id,
     * with the language folded into the cache key so per-language slides don't
     * collide. Omit / no-overlay result → primary-language title (zero queries).
     */
    langs?: ResolvedMetadataLanguages;
}

function readExternalId(
    ids: ContinueWatchingItem['externalIds'],
    key: 'internal' | 'tmdb',
): string | undefined {
    const value = (ids as Record<string, string | undefined> | null | undefined)?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Map a reused watching Next Up item to the hero first slide. For episodes
 * `externalIds.internal` is the episode's own media_id (already set upstream),
 * which matches the client transform; `seriesId` is carried separately for
 * logo/backdrop resolution.
 */
function nextUpItemToHeroSlide(item: ContinueWatchingItem): HeroFirstSlide {
    const internal = readExternalId(item.externalIds, 'internal') ?? item.id;
    const seriesId = item.seriesId;
    return {
        title: item.seriesName ?? item.title,
        mediaType: item.mediaType,
        overview: item.overview ?? undefined,
        customMetadata: item.customMetadata,
        externalIds: {
            internal,
            tmdb: readExternalId(item.externalIds, 'tmdb'),
        },
        seriesId,
        backdropBlurhash: item.backdropBlurhash ?? undefined,
        progress:
            typeof item.resumeRatio === 'number'
                ? item.resumeRatio
                : item.watchProgress > 0
                  ? item.watchProgress / 100
                  : undefined,
        runtimeMinutes:
            typeof item.duration === 'number' && item.duration > 0
                ? Math.round(item.duration / 60)
                : undefined,
        // Carry the live-overlay playing state so the SSR hero can paint the
        // "Playing now" treatment on the first byte. Only true when a fresh
        // active session is playing this item (see live-watching-overlay).
        isPlaying: item.livePlaybackState === 'playing' ? true : undefined,
    };
}

/**
 * Resolve the SSR hero first slide. Personalized branch reuses the
 * already-fetched top Next Up (no extra query). Generic fallback is
 * access-scoped cached. Never throws — returns null on any failure.
 */
export async function resolveHeroFirstSlide(
    args: ResolveHeroFirstSlideArgs,
): Promise<HeroFirstSlide | null> {
    try {
        // Personalized branch — only for non-age-restricted viewers.
        if (!args.isAgeRestricted && args.topNextUp) {
            return nextUpItemToHeroSlide(args.topNextUp);
        }

        // Generic fallback branch — needs a DB handle and an access context to
        // build a correctly-scoped cache key. Without the context we cannot
        // guarantee isolation, so we bail (the client builds the hero instead).
        if (!args.sql || !args.accessCtx) return null;

        const cache = cacheManager.for(CACHE_NAMESPACES.heroFirstSlide);
        // Fold the viewer's language into the key so per-language generic slides
        // never collide (the cached payload is already localized). Empty token
        // when no overlay applies, so feature-off keys stay unchanged.
        const langs = args.langs ?? { titleLang: null, textLang: null };
        // NOTE: `scopedCacheKey`/`buildSearchAccessCacheKey` cannot yet express a
        // denyAll boundary — `all` and `denyAll` would collide on the same empty
        // suffix. That is safe HERE because the boundary below is derived from
        // this same `accessCtx` via `searchAccessBoundary`, which constructs the
        // boundary with `restrictedAccess` and provably never yields denyAll. Do not hand this
        // resolver a boundary from any other source until the key builder gains a
        // denyAll token (tracked in the access-boundary migration spec).
        // `v2`: slides no longer carry a Jellyfin id.
        const key = `${scopedCacheKey('generic:v2', args.accessCtx)}${heroLangCacheToken(langs)}`;
        const cached = await cache.get<HeroFirstSlide>(key);
        if (cached) {
            const fresh = structuredClone(cached);
            const { enrichSeriesEpisodeCounts } =
                await import('$lib/server/services/series-episode-counts.service.js');
            const mediaId = getExternalIdFor(fresh.externalIds, 'internal');
            if (!mediaId) return fresh;
            const target = { ...fresh, id: mediaId };
            await enrichSeriesEpisodeCounts(
                args.sql,
                [target],
                null,
                searchAccessBoundary(args.accessCtx),
            );
            return {
                ...fresh,
                seasonCount: target.seasonCount,
                episodeCount: target.episodeCount,
                availableEpisodeCount: target.availableEpisodeCount,
                watchedEpisodeCount: target.watchedEpisodeCount,
                unwatchedEpisodeCount: target.unwatchedEpisodeCount,
            };
        }

        const row = await getHeroFallbackItem(args.sql, {
            source: config.HERO_FALLBACK_SOURCE === 'random' ? 'random' : 'trending',
            // Same `accessCtx` the cache key above was scoped with — key and
            // predicate can no longer drift apart.
            access: searchAccessBoundary(args.accessCtx),
        });
        if (!row) return null;

        const slide: HeroFirstSlide = {
            title: row.title,
            mediaType: row.media_type,
            overview: row.overview ?? undefined,
            externalIds: {
                internal: row.media_id,
                tmdb: row.tmdb_id ?? undefined,
            },
            backdropBlurhash: row.backdrop_blurhash ?? undefined,
        };
        // Localize the generic slide (keyed on row.media_id via externalIds.
        // internal) before caching so the no-history hero paints in the viewer's
        // language on first byte, matching the client type=movies fallback.
        await overlayHeroMediaItems(args.sql, [slide as unknown as Record<string, unknown>], langs);
        await cache.set(key, slide);
        const { enrichSeriesEpisodeCounts } =
            await import('$lib/server/services/series-episode-counts.service.js');
        const mediaId = getExternalIdFor(slide.externalIds, 'internal');
        if (!mediaId) return slide;
        const target = { ...slide, id: mediaId };
        await enrichSeriesEpisodeCounts(
            args.sql,
            [target],
            null,
            searchAccessBoundary(args.accessCtx),
        );
        return {
            ...slide,
            seasonCount: target.seasonCount,
            episodeCount: target.episodeCount,
            availableEpisodeCount: target.availableEpisodeCount,
            watchedEpisodeCount: target.watchedEpisodeCount,
            unwatchedEpisodeCount: target.unwatchedEpisodeCount,
        };
    } catch (err) {
        logger.warn(
            'hero first-slide resolve failed; client will build hero on mount',
            err instanceof Error ? err : undefined,
        );
        return null;
    }
}
