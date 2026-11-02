// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/search/available-categories.ts — GET /api/search/available-categories
 *
 * Returns which search categories have content available.
 * Used to dynamically show/hide category chips in the search UI.
 *
 * Contract: bare flat object — AvailableCategoriesResponse.
 * Cached for 1 hour (L1 in-memory + L2 Valkey).
 *
 * No auth required at the HTTP level, but every boundary-gated probe runs under
 * a required MediaAccessBoundary — anonymous and degraded requests resolve to an
 * explicit denyAll rather than proceeding unscoped.
 *
 * Auth: public.
 */

import { json } from '@sveltejs/kit';
import type { Sql } from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { LibraryType } from '$lib/server/plugins/kavita/types.js';
import { AvailableCategoriesResponseSchema } from '$lib/schemas/api-content-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { getActiveNonEntertainmentLibraries } from '$lib/server/database/queries/library-types.queries.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { buildAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import {
    boundaryCacheKey,
    denyAllAccess,
    deniesEverything,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import type { UserContext } from '$lib/server/types.js';

const logger = Logger.for('AvailableCategoriesDef');

const cache = cacheManager.for(CACHE_NAMESPACES.searchCategories);

export type AvailableCategories = {
    book: boolean;
    manga: boolean;
    comic: boolean;
    audiobook: boolean;
    anfragen: boolean;
    tvchannel: boolean;
    music?: boolean;
    home_video?: boolean;
    training?: boolean;
    educational?: boolean;
    personal?: boolean;
};

/**
 * Categories derived purely from deployment feature flags plus the caller's
 * Live TV permission. None of these are gated by the media access boundary:
 * Kavita / Audiobookshelf / Jellyseerr are separate systems with their own
 * access model, and Live TV is gated by `hasLiveTvPermission` directly.
 */
function featureDerivedCategories(hasLiveTvPermission: boolean): AvailableCategories {
    return {
        book: false,
        manga: false,
        comic: false,
        audiobook: features.audiobooks,
        anfragen: features.requests,
        tvchannel: features.liveTV && hasLiveTvPermission,
        music: false,
    };
}

/**
 * Resolve which search categories have content available for a caller.
 *
 * `access` is REQUIRED and has no permissive default. Every boundary-gated probe
 * below (the music existence check, the non-entertainment library list) routes
 * through it, so there is no longer a code path that reports availability
 * without having stated a boundary.
 *
 * A `denyAll` boundary yields `music: false` and no non-entertainment
 * categories — the previously inexpressible state that the old `accessCtx:
 * null` value stood in for, and which it enforced inconsistently: it fail-CLOSED
 * for music (probe skipped) while fail-OPENING for non-entertainment libraries
 * (empty denied Set let every library through).
 */
export async function resolveAvailableCategories(
    sql: Sql | null,
    access: MediaAccessBoundary,
    hasLiveTvPermission: boolean,
): Promise<AvailableCategories> {
    const categories = featureDerivedCategories(hasLiveTvPermission);

    // Check Kavita libraries
    if (features.kavita) {
        try {
            const { getLibraries } = await import('$lib/server/plugins/kavita');
            const libraries = await getLibraries();

            for (const library of libraries) {
                switch (library.type) {
                    case LibraryType.Book:
                    case LibraryType.LightNovel:
                        categories.book = true;
                        break;
                    case LibraryType.Manga:
                        categories.manga = true;
                        break;
                    case LibraryType.Comic:
                    case LibraryType.ComicVine:
                        categories.comic = true;
                        break;
                }
            }
        } catch (error) {
            logger.warn('Failed to fetch Kavita libraries', error as Error);
        }
    }

    // Check music library. Music rows are stored in media_items with
    // media_type 'artist' | 'album' | 'track' — there is no 'music'
    // media_type — so probe those. 'artist' is the top-level row that
    // exists whenever any music is present.
    //
    // Short-circuit on a deny-everything boundary rather than emitting the
    // builders' `AND false`: the answer is known and the round trip is waste.
    if (sql && !deniesEverything(access)) {
        try {
            const result = await sql<[{ exists: boolean }]>`SELECT EXISTS(
              SELECT 1 FROM media_items mi
              WHERE mi.media_type IN ('artist', 'album', 'track')
                ${buildLibraryAccessFilter(sql, access.library)}
                ${buildAgeRatingFilter(sql, access.age)}
              LIMIT 1
            ) AS exists`;
            if (result[0]?.exists) {
                categories.music = true;
            }
        } catch (error) {
            logger.warn('Failed to check music library', error as Error);
        }
    }

    // Check non-entertainment libraries. The boundary is enforced inside the
    // query module (see getActiveNonEntertainmentLibraries) so the library axis
    // has exactly one JS enforcement site instead of a hand-rolled Set here.
    if (sql) {
        try {
            const nonEntLibs = await getActiveNonEntertainmentLibraries(sql, access);
            for (const lib of nonEntLibs) {
                const key = lib.media_type as keyof AvailableCategories;
                if (
                    key === 'home_video' ||
                    key === 'training' ||
                    key === 'educational' ||
                    key === 'personal'
                ) {
                    categories[key] = true;
                }
            }
        } catch (error) {
            logger.warn('Failed to check non-entertainment libraries', error as Error);
        }
    }

    return categories;
}

/**
 * Build this request's access boundary.
 *
 * Closed by default. The previous implementation swallowed any
 * `buildSearchAccessContext` failure and proceeded with `accessCtx = null`,
 * i.e. entirely UNSCOPED — and that path was reachable, not theoretical: the
 * endpoint is public, `buildSearchAccessContext` dereferences `user.maxAgeRating`
 * unguarded, and `locals.user` is typed non-optional so TypeScript never flagged
 * the anonymous case. Both the no-user and the throw case now resolve to an
 * explicit deny-everything boundary.
 */
async function resolveRequestBoundary(
    sql: Sql | null,
    user: UserContext | undefined,
): Promise<MediaAccessBoundary> {
    if (!sql || !user) return denyAllAccess();
    try {
        return searchAccessBoundary(await buildSearchAccessContext(sql, user));
    } catch (error) {
        logger.warn('Failed to build access context; denying all media-gated categories', {
            error: error instanceof Error ? error.message : String(error),
        });
        return denyAllAccess();
    }
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    // The categories endpoint is unauthenticated at the HTTP level — the UI
    // calls it on every search load regardless of login state. Authentication is
    // therefore not what protects it: the per-request MediaAccessBoundary is. An
    // anonymous caller resolves to denyAll and sees no boundary-gated category.
    // The boundary partitions the cache key AND gates the probes; it used to do
    // only the former, which is why an anonymous request could be served the
    // operator's full non-entertainment library list.
    auth: { kind: 'public' },
    visibility: 'internal',
    handlers: {
        GET: async (event, _ctx) => {
            const { locals } = event;
            // `locals.user` is declared non-optional in app.d.ts but this endpoint
            // is public, so an anonymous request genuinely arrives with none.
            const user = locals.user as UserContext | undefined;
            const hasLiveTvPermission = user?.hasLiveTvPermission ?? false;

            const sql = getDb();
            const access = await resolveRequestBoundary(sql, user);

            // Cache key. Versioned (`v2:`) because the boundary reshape changes
            // what a given key means — without the bump, up to an hour of entries
            // written by the old fail-open path (every non-entertainment library
            // reported available, under a BARE key that an unrestricted user also
            // produced) would survive the deploy and be served as if legitimate.
            //
            // boundaryCacheKey emits a token for EVERY variant including `all`/`any`,
            // so an unrestricted caller and a denyAll caller can never collide the
            // way they did under scopedCacheKey's empty-suffix-for-unrestricted rule.
            // No locale dimension: this payload is booleans only, no localized text.
            const cacheKey = `v2:available:${hasLiveTvPermission ? 'livetv' : 'no-livetv'}|${boundaryCacheKey(access)}`;

            try {
                const cached = await cache.get<AvailableCategories>(cacheKey);
                if (cached) {
                    logger.debug('Returning cached available categories', { hasLiveTvPermission });
                    return json(AvailableCategoriesResponseSchema.parse(cached));
                }

                logger.info('Fetching available search categories', { hasLiveTvPermission });

                const categories = await resolveAvailableCategories(
                    sql,
                    access,
                    hasLiveTvPermission,
                );

                await cache.set(cacheKey, categories);
                logger.info('Available categories determined', categories);

                return json(AvailableCategoriesResponseSchema.parse(categories));
            } catch (error) {
                logger.error('Failed to get available categories', error as Error);
                // Fail-safe response. This used to return EVERY category `true`
                // "to avoid hiding categories", which bypassed the boundary
                // completely and disclosed the existence of music and of the
                // operator's non-entertainment libraries to a caller entitled to
                // neither. The trade is now split by what each flag actually
                // reveals: deployment-level integration flags stay permissive
                // (they are not boundary-gated and are already visible to any
                // authenticated caller), while the two boundary-gated axes —
                // music and the non-entertainment libraries — stay closed.
                return json(
                    AvailableCategoriesResponseSchema.parse({
                        ...featureDerivedCategories(hasLiveTvPermission),
                        // Kavita library enumeration is what failed, so fall back
                        // to "the integration is configured" rather than hiding
                        // all three chips. Kavita has its own access model and is
                        // not gated by this boundary, so nothing leaks.
                        book: features.kavita,
                        manga: features.kavita,
                        comic: features.kavita,
                    }),
                );
            }
        },
    },
});
