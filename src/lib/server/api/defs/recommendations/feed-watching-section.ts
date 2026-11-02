// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildMediaPreview } from '$lib/server/services/media-preview.service.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/resolver.js';
import { getDb } from '$lib/server/database/connection.js';

/**
 * feed-watching-section.ts — builds the merged Continue-Watching + Next-Up
 * "watching" feed section from the shared effectiveWatchingFor primitive, so
 * the native Home gets the SAME recency-interleaved, live-overlaid, access-
 * vetted list web renders — as one server-composed section.
 */

import type { AccessContext } from './recommender.js';
import type { WatchingFeedItem, WatchingSection } from '$lib/schemas/api-feed-responses.js';
import type { ContinueWatchingItem, WatchingAnchor } from '$lib/server/utils/section-builder.js';
import { toIdsRecord } from '../for-you/item-mapper.js';
import { presentContinueWatchingItem } from './continue-watching-presentation.js';
import type { Locale } from '$lib/paraglide/runtime.js';
import { type ApiSurface } from '$lib/shared/api-urls.js';
import { filterByPublicMediaType, type MediaTypeAllowList } from './continue-watching.js';

type WatchingBuckets = {
    continueWatching: ContinueWatchingItem[];
    nextUp: ContinueWatchingItem[];
    sourceExhausted: boolean;
};

/** Expand stable CW/NU prefixes until the filtered/arbitrated page is exact. */
export async function fetchExactWatchingCandidates(
    fetch: (limit: number) => Promise<WatchingBuckets>,
    targetSize: number,
    select: (buckets: WatchingBuckets) => WatchingAnchor[],
): Promise<WatchingAnchor[]> {
    let fetchLimit = Math.max(1, targetSize);
    for (;;) {
        const buckets = await fetch(fetchLimit);
        const selected = select(buckets);
        if (selected.length >= targetSize || buckets.sourceExhausted) return selected;

        const nextLimit = fetchLimit * 2;
        if (!Number.isSafeInteger(nextLimit) || nextLimit <= fetchLimit) return selected;
        fetchLimit = nextLimit;
    }
}

/**
 * Map one arbitrated watching item into the feed envelope + origin marker.
 *
 * Returns `null` when the row's internal `media_type` has no public
 * representation ('tvchannel', 'home_video', … → `toPublicMediaType` returns
 * null) — the caller MUST drop it. Continue-Watching / Next-Up rows are
 * movie/tv/episode/audiobook in practice, so this drops nothing today; the point
 * is that the compiler now guarantees `media.type` is a real public value
 * instead of whatever string the DB happened to hold.
 */
export function watchingItemToFeedItem(
    item: ContinueWatchingItem,
    origin: 'cw' | 'nextup',
    _surface: ApiSurface,
): WatchingFeedItem | null {
    const presentation = presentContinueWatchingItem(item);
    if (!presentation) return null;
    const preview = buildMediaPreview({
        id: presentation.internalId,
        type: presentation.publicType,
        title: item.title,
        ids: toIdsRecord(item.externalIds),
        overview: presentation.overview,
        progress: presentation.progress,
        ...(presentation.seriesId && {
            context: {
                series: {
                    id: presentation.seriesId,
                    catalogId: presentation.seriesId,
                    title: presentation.seriesName ?? '',
                },
                seasonNumber: presentation.seasonNumber,
                episodeNumber: presentation.episodeNumber,
            },
        }),
        reason: { kind: origin === 'nextup' ? 'next-up' : 'continue-watching' },
    });
    if (!preview) return null;
    const feedItem: WatchingFeedItem = {
        ...preview,
        progress: presentation.progress,
        ...(presentation.lastPlayedAt ? { lastPlayedAt: presentation.lastPlayedAt } : {}),
        origin,
        ...(item.livePlaybackState ? { livePlaybackState: item.livePlaybackState } : {}),
        ...(item.isSuspicious ? { isSuspicious: true } : {}),
    };

    return feedItem;
}

/**
 * Build the merged watching section. Delegates recency-interleave + one-card-
 * per-series arbitration to the SHARED `arbitrateWatching` helper (same logic
 * web renders — no drift). Returns null when nothing's in progress / DB is
 * down, so the feed handler drops the section.
 */
export async function buildWatchingSection(
    ctx: AccessContext,
    limit: number,
    apiBase: string,
    surface: ApiSurface,
    locale: Locale,
    typeFilter: MediaTypeAllowList = null,
): Promise<WatchingSection | null> {
    const { effectiveWatchingFor } =
        await import('$lib/server/services/effective-watching.service.js');
    const { arbitrateWatching } = await import('$lib/server/utils/section-builder.js');
    const { filterStaleWatchingItems } = await import('./continue-watching.js');

    // EXACT web parity: match the knobs web's steady-state Continue-Watching
    // row uses (the client refetch via /api/for-you/watching + SSR home). That
    // means: NOT skipSuspicion (compute the bulk-mark warning), the live overlay
    // ON (no budget cap — this is an API call, not the nav-blocking SSR path),
    // includeNewEpisodes false (the client fetches new-episode alerts
    // separately), and mergeSort false (web default). arbitrateWatching then
    // produces the same one-card-per-series order web renders.
    const fetchBuckets = (fetchLimit: number) =>
        effectiveWatchingFor({
            username: ctx.username,
            userId: ctx.userId,
            limit: fetchLimit,
            mergeSort: false,
            includeNewEpisodes: false,
            access:
                ctx.deniedGroupIds != null || ctx.maxAgeRating != null
                    ? {
                          deniedGroupIds: ctx.deniedGroupIds,
                          ageRating:
                              ctx.maxAgeRating != null
                                  ? {
                                        maxAgeRating: ctx.maxAgeRating,
                                        allowUnrated: ctx.allowUnrated,
                                    }
                                  : null,
                      }
                    : undefined,
            langs: ctx.langs,
        });

    // Same stale/barely-started policy GET /continue-watching applies, via the
    // SHARED predicate — otherwise this feed section keeps nagging about the
    // exact rows that endpoint has already decided to forget (both are fed by
    // `watchManager.getContinueWatching`). Applied to the Continue-Watching
    // bucket BEFORE arbitration on purpose: a stale CW row must not win the
    // one-card-per-series slot and suppress a perfectly good Next-Up card for
    // that series. Next-Up rows are deliberately NOT filtered — their
    // `updatedAt` is the last COMPLETION in the series and their progress is 0,
    // so Rule A would read "0% and untouched for 30 days" and delete the whole
    // point of Next Up.
    const select = ({ continueWatching, nextUp }: WatchingBuckets) => {
        const typeScopedContinueWatching = filterByPublicMediaType(
            continueWatching,
            typeFilter,
            (item) => item.mediaType,
        );
        const typeScopedNextUp = filterByPublicMediaType(
            nextUp,
            typeFilter,
            (item) => item.mediaType,
        );
        const freshContinueWatching = filterStaleWatchingItems(typeScopedContinueWatching);
        return arbitrateWatching({
            continueWatching: freshContinueWatching,
            nextUp: typeScopedNextUp,
        });
    };

    const anchors =
        typeFilter === null
            ? select(await fetchBuckets(limit + 1))
            : await fetchExactWatchingCandidates(fetchBuckets, limit + 1, select);
    if (anchors.length === 0) return null;

    const items = anchors
        .slice(0, limit)
        .map((a) => watchingItemToFeedItem(a.item, a.origin, surface))
        // Rows with no public media type are dropped (see watchingItemToFeedItem).
        .filter((it): it is WatchingFeedItem => it !== null);
    // Never emit an empty section — the feed compositor's contract is that a
    // section with nothing to show is omitted entirely.
    if (items.length === 0) return null;

    const sql = getDb();
    if (!sql) return null;
    const images = await resolveImageSets(
        sql,
        surface,
        items.map((item) => ({ id: item.id, mediaType: item.type })),
    );
    for (const item of items) item.images = images.get(item.id) ?? {};

    // i18n parity: web titles this row via the paraglide message, not a literal.
    const { m } = await import('$lib/paraglide/messages.js');

    return {
        type: 'watching',
        id: 'watching',
        title: m.section_continue_watching({}, { locale }),
        items,
        source: { href: `${apiBase}/continue-watching` },
    };
}
