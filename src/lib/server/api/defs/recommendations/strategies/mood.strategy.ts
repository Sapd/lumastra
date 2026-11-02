// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MoodStrategy — wraps mood-based keyword/vector recommendations.
 *
 * Collapses (§rename-map):
 *   mood-recommendations           → recommendations?type=mood
 *   mood-recommendations/suggestions → same (P0: was missing requireAuth — fixed by mount)
 *
 * P0 auth fix: the old `mood-recommendations/suggestions` had NO requireAuth guard.
 * This strategy is always called through mount() which enforces { kind: 'user' }.
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
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { DependencyUnavailableError, isDependencyUnavailable } from '$lib/server/api/problem.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import type { ExternalIds } from '$lib/types/api-common.js';
import type { SearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { hydrateRailMetadata } from '../../for-you/item-mapper.js';
import { m } from '$lib/paraglide/messages.js';

const logger = Logger.for('MoodStrategy');

export class MoodStrategy implements RecommenderStrategy {
    readonly id = 'mood';
    readonly label = m.section_matches_your_mood;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            // mood is required for this strategy; guard here so the service call
            // never receives undefined and potentially returns unfiltered results.
            if (!opts.mood) {
                logger.warn('MoodStrategy: called without opts.mood — returning empty');
                return { items: [], hasMore: false };
            }

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                // DB DOWN — signal dependency-down (NOT genuine-empty).
                throw new DependencyUnavailableError('Database unavailable', 'postgres');
            }

            // Lazy-import the mood recommendations service to avoid build errors
            // when the AI system is not configured.
            const { getMoodRecommendations } =
                await import('$lib/server/services/mood-recommendations.service.js').catch(() => ({
                    getMoodRecommendations: null,
                }));

            if (!getMoodRecommendations) {
                logger.warn('MoodStrategy: mood-recommendations service not available');
                return { items: [], hasMore: false };
            }

            // The access context handed to `getMoodRecommendations` feeds BOTH
            // its DB query boundary AND its own internal cache key (see
            // `mood-recommendations.service.ts`), so it must carry this
            // request's REAL access facts. Previously this reconstructed a
            // partial user object (no userGroups/isAdmin) and re-derived
            // deniedGroupIds from it — that lookup silently collapses to
            // "member of zero groups", over-restricting every restricted
            // caller. `ctx.deniedGroupIds` is already the correct value,
            // resolved once in `buildAccessContext`.
            const accessCtx: SearchAccessContext = {
                username: ctx.username,
                deniedGroupIds: ctx.deniedGroupIds,
                ageRating:
                    ctx.maxAgeRating != null
                        ? { maxAgeRating: ctx.maxAgeRating, allowUnrated: ctx.allowUnrated }
                        : null,
                liveTvAllowed: false,
                showUnavailableMedia: ctx.showUnavailableMedia,
            };

            const fetchLimit = opts.limit + 1;
            const rawItems = await getMoodRecommendations(sql, {
                userId: ctx.userId,
                mood: opts.mood,
                mediaType: opts.mediaType === 'series' ? 'tv' : opts.mediaType,
                limit: fetchLimit,
                genre: opts.genre,
                accessCtx,
                isAgeRestricted: ctx.isAgeRestricted,
                // `?refresh=true` must reach the service cache, not just skip
                // any strategy-local state — the expensive work lives there.
                refresh: opts.refresh,
            });

            if (!rawItems || rawItems.length === 0) {
                return { items: [], hasMore: false };
            }

            // Library-only filter: always-on server-config gate
            let filteredItems = rawItems;
            if (!ctx.showUnavailableMedia) {
                filteredItems = filteredItems.filter((item) => item.isAvailable);
            }

            const hasMore = filteredItems.length > opts.limit;
            const page = filteredItems.slice(0, opts.limit);

            const items: RecommendationItem[] = page.flatMap((item): RecommendationItem[] => {
                const extIds = (item.externalIds ?? {}) as ExternalIds;
                const internalId = getExternalIdFor(extIds, 'internal') ?? item.media_id ?? '';

                // A type with no public representation is DROPPED, never
                // relabelled: the old `?? item.mediaType ?? 'movie'` leaked the raw
                // storage token (or silently published a typeless row as a movie)
                // into the discriminator the client routes playback off.
                const publicType = toPublicMediaType(item.mediaType);
                if (!publicType) return [];

                const idsRecord: Record<string, string> = {};
                for (const [k, v] of Object.entries(extIds)) {
                    if (v != null) idsRecord[k] = String(v);
                }

                const media: RecommendedMediaRef = {
                    id: internalId,
                    type: publicType,
                    title: item.title ?? 'Unknown',
                    year: item.year ?? null,
                    ids: idsRecord,
                };

                return [
                    {
                        media,
                        score: item.similarity != null ? Math.min(item.similarity, 1) : undefined,
                        // Mood results include requestable (has_files=false) items; carry
                        // availability so the client gates the Watch button.
                        isAvailable: item.isAvailable,
                        canRequest: item.canRequest,
                        reason: {
                            kind: 'mood',
                            label: opts.mood ?? undefined,
                        },
                    },
                ];
            });

            await hydrateRailMetadata(sql, items);
            return { items, hasMore };
        } catch (err) {
            // Propagate dependency-down so the caller can return 503 / drop the section.
            if (isDependencyUnavailable(err)) throw err;
            logger.error('MoodStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const moodStrategy = new MoodStrategy();
