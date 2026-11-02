// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { recommendationPreviews } from '$lib/server/services/media-preview.service.js';

/**
 * feed-byw-sections.ts — fan the user's top-N recent video seeds into N
 * "Because you watched X" carousel sections. Each section reuses the shared
 * because-you-watched strategy (via getRailItems) anchored on one seed, so the
 * items are identical to the Tier-2 endpoint the section's source.href points at.
 */

import type { AccessContext } from './recommender.js';
import type { MediaCarouselSection } from '$lib/schemas/api-feed-responses.js';
import { Logger } from '$lib/server/utils/logger.js';
import { m } from '$lib/paraglide/messages.js';
import type { Locale } from '$lib/paraglide/runtime.js';
import { overlaySeedTitles } from './seed-title-overlay.js';
import { type ApiSurface } from '$lib/shared/api-urls.js';

const logger = Logger.for('FeedBywSections');

export async function selectRecentVideoSeeds(
    ctx: AccessContext,
    count: number,
): Promise<Array<{ id: string; title: string; mediaType: 'movie' | 'tv' }>> {
    const { getDb } = await import('$lib/server/database/connection.js');
    const sql = getDb();
    if (!sql) return [];

    const { getRecentWatchedMoviesWithEmbeddings, getRecentWatchedTvWithEmbeddings } =
        await import('$lib/server/database/queries/index.js');
    const { restrictedAccess } =
        await import('$lib/server/database/queries/builders/media-access-boundary.js');

    const boundary = restrictedAccess({
        deniedGroupIds: ctx.deniedGroupIds ?? [],
        maxAgeRating: ctx.maxAgeRating,
        allowUnrated: ctx.allowUnrated,
    });

    const [movies, tv] = await Promise.all([
        getRecentWatchedMoviesWithEmbeddings.all(sql, {
            userId: ctx.userId,
            limit: count,
            access: boundary,
        }),
        getRecentWatchedTvWithEmbeddings.all(sql, {
            userId: ctx.userId,
            limit: count,
            access: boundary,
        }),
    ]);

    return [...movies, ...tv]
        .sort((a, b) => new Date(b.watched_at).getTime() - new Date(a.watched_at).getTime())
        .slice(0, count)
        .map((r) => ({
            id: r.media_id,
            title: r.title,
            // constrained: this maps over [...movies, ...tv], two pools selected
            // by media type, so no episode/season row can appear here.
            // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
            mediaType: r.media_type as 'movie' | 'tv',
        }));
}

export async function buildBywSections(
    ctx: AccessContext,
    seedCount: number,
    perRail: number,
    apiBase: string,
    surface: ApiSurface,
    excludeSeriesIds: Set<string>,
    locale: Locale,
): Promise<MediaCarouselSection[]> {
    // Age-restricted profiles never get AI similar rails (policy parity with
    // the strategy and /for-you/similar).
    if (ctx.isAgeRestricted) return [];

    const seeds = (await selectRecentVideoSeeds(ctx, seedCount)).filter(
        (s) => !excludeSeriesIds.has(s.id),
    );
    if (seeds.length === 0) return [];

    const { getDb } = await import('$lib/server/database/connection.js');
    const sql = getDb();
    await overlaySeedTitles(sql, seeds, ctx.langs);

    const { getRailItems } = await import('./recommender.js');

    const built = await Promise.all(
        seeds.map(async (seed): Promise<MediaCarouselSection | null> => {
            try {
                const result = await getRailItems('because-you-watched', ctx, {
                    surface,
                    limit: perRail,
                    seed: seed.id,
                    extra: { domain: 'video' },
                });
                if (result.items.length === 0) return null;
                return {
                    type: 'carousel',
                    id: `byw:${seed.id}`,
                    title: m.foryou_because_you_watched({ title: seed.title }, { locale }),
                    items: await recommendationPreviews(getDb()!, surface, result.items),
                    source: {
                        href: `${apiBase}/recommendations?type=because-you-watched&domain=video&seed=${seed.id}`,
                    },
                };
            } catch (err) {
                logger.warn(`Feed: dropping BYW section for seed ${seed.id}`, err as Error);
                return null;
            }
        }),
    );

    return built.filter((s): s is MediaCarouselSection => s !== null);
}
