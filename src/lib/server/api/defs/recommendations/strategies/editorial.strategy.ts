// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EditorialStrategy — curated thematic recommendations.
 *
 * Collapses (§rename-map):
 *   recommendations/holiday → recommendations?type=editorial&theme=holiday
 *
 * The `theme` is supplied via `opts.extra.theme` (forwarded from the `?theme=`
 * query param by the recommendations multiplexer).
 *
 * Currently the only implemented theme is `holiday`, which delegates to
 * `getHolidayRecommendations` from the holiday plugin.  When no active holiday
 * exists the strategy returns an empty result — it does NOT error, so the /feed
 * SDUI compositor can silently omit the section.
 *
 * Future themes (e.g. `awards-season`, `new-year`) can be added as additional
 * branches in `fetch()` without changing the public API surface.
 */

import type {
    RecommenderStrategy,
    AccessContext,
    RecommenderOptions,
    RecommenderResult,
    RecommendationItem,
} from '../recommender.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { isDependencyUnavailable } from '$lib/server/api/problem.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import { resolveMediaRefId, hydrateRailMetadata } from '../../for-you/item-mapper.js';
import { m } from '$lib/paraglide/messages.js';
import { features } from '$lib/server/config.js';

const logger = Logger.for('EditorialStrategy');

export class EditorialStrategy implements RecommenderStrategy {
    readonly id = 'editorial';
    readonly label = m.section_featured;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        const theme = (opts.extra?.theme as string | undefined) ?? 'holiday';

        if (theme === 'holiday') {
            return this.#fetchHoliday(ctx, opts);
        }

        // Unrecognised theme — return empty rather than error.
        logger.debug(`EditorialStrategy: unsupported theme '${theme}' — returning empty`);
        return { items: [], hasMore: false };
    }

    async #fetchHoliday(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        // Admin setting, off by default: no holiday rail at all.
        if (!features.holidays) return { items: [], hasMore: false };
        // Same gate as /api/recommendations/holiday, which 403s these profiles.
        if (ctx.isAgeRestricted) return { items: [], hasMore: false };

        try {
            const { getHolidayRecommendations } =
                await import('$lib/server/plugins/holidays/plugin.js');

            // Over-fetch so the strategy can compute hasMore accurately.
            const fetchLimit = opts.limit + 1;
            // Pass the caller's boundary in the same shape the endpoint builds,
            // so library discovery, availability and the `internal` ids the
            // plugin emits are all scoped to this user.
            const response = await getHolidayRecommendations(ctx.username, {
                limit: fetchLimit,
                refresh: opts.refresh,
                access: {
                    username: ctx.username,
                    deniedGroupIds: ctx.deniedGroupIds,
                    ageRating:
                        ctx.maxAgeRating != null
                            ? { maxAgeRating: ctx.maxAgeRating, allowUnrated: ctx.allowUnrated }
                            : null,
                    liveTvAllowed: false,
                    showUnavailableMedia: ctx.showUnavailableMedia,
                },
            });

            if (!response.active || response.items.length === 0) {
                return { items: [], hasMore: false };
            }

            const hasMore = response.items.length > opts.limit;
            const page = response.items.slice(0, opts.limit);

            const items: RecommendationItem[] = page.flatMap((item): RecommendationItem[] => {
                const primaryProvider = getPrimaryExternalIdProvider();
                const primaryId = getExternalIdFor(item.externalIds, primaryProvider);
                // Without a configured primary external ID we can't build a stable reference — skip.
                if (!primaryId) return [];

                const idsRecord: Record<string, string> = {};
                for (const [k, v] of Object.entries(item.externalIds ?? {})) {
                    if (v != null) idsRecord[k] = String(v);
                }

                // getHolidayRecommendations' items are typed `mediaType: 'movie'
                // | 'tv'` (TMDB movie/tv discover results) — never anything else.
                // eslint-disable-next-line callback-safety/no-inline-media-type-default -- editorial candidates are movie/TV-only.
                const canonicalType = toMovieOrSeries(item.mediaType) ?? 'movie';

                const rating = item.rating;
                const score = Number.isFinite(rating) && rating > 0 ? rating / 10 : undefined;

                // `media.id` is the internal catalogue UUID (set by the plugin
                // only for items available inside the boundary passed above),
                // else a VALID 3-part composite. A bare Jellyfin GUID fails
                // parseMediaId, so it is never used here.
                const mediaId = resolveMediaRefId(item.externalIds, canonicalType);
                if (!mediaId) return [];

                return [
                    {
                        media: {
                            id: mediaId,
                            type: canonicalType,
                            title: item.title,
                            ids: idsRecord,
                        },
                        score,
                        // Available = matched to a library item this user may play;
                        // carry it so the client gates the Watch button.
                        isAvailable: item.isAvailable,
                        canRequest: item.canRequest,
                        reason: {
                            kind: 'editorial',
                            label: response.holiday?.name ?? 'holiday',
                        },
                    },
                ];
            });

            // The holiday rail works fine without a DB (it's TMDB-sourced), so
            // only attempt hydration when one is actually configured.
            // `hydrateRailMetadata` swallows its own failures (a query error
            // must not tip an otherwise-healthy rail into an error) — this
            // guard only skips the call outright when `getDb()` returns null
            // (DATABASE_URL unset), not a substitute for that try/catch.
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (sql) await hydrateRailMetadata(sql, items);

            return { items, hasMore };
        } catch (err) {
            // Propagate dependency-down so the caller can return 503 / drop the section.
            if (isDependencyUnavailable(err)) throw err;
            logger.error('EditorialStrategy(holiday) fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const editorialStrategy = new EditorialStrategy();
