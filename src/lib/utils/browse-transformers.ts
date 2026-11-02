// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browse Page Data Transformers
 * Transform API data into UniversalMediaItem format
 */

import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import type { UniversalMediaType } from '$lib/schemas/api-responses';
import type { MediaPreview } from '$lib/schemas/api-media-preview';
import { mediaPreviewToUniversal } from './media-preview';
import type { ExternalIds } from '$lib/types/api-common';
import type { ImageSet } from '$lib/schemas/api-image-descriptor';
import * as m from '$lib/paraglide/messages';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import { imageFromIds, getCatalogPosterUrl, getCatalogBackdropUrl } from './image-utils';
import { mediaCompositeKey, hasValidExternalId } from './media-id-helpers';
import { toTmdbMediaType as toTmdbType, toUniversalMediaType } from '$lib/shared/media-type-domain';
import { FALLBACK_IMAGE } from '$lib/constants/images';
import { getExternalIdFor } from './external-ids';
import { asInternalUuid } from './id-patterns';

export type BrowseItem = {
    id: string;
    seasonCount?: number;
    episodeCount?: number;
    availableEpisodeCount?: number;
    watchedEpisodeCount?: number;
    unwatchedEpisodeCount?: number;

    externalIds?: ExternalIds;
    type?: string;
    mediaType?: string;
    isEpisode?: boolean;
    seriesId?: string;
    seriesExternalIds?: ExternalIds;
    name?: string;
    seriesName?: string;
    year?: number;
    imageId?: string;
    backdropImageId?: string;
    _imageUrl?: string;
    overview?: string;
    communityRating?: number;
    genres?: string[];
    userData?: { playedPercentage?: number };
    seasonNumber?: number;
    episodeNumber?: number;
    trailerUrl?: string;
};

export type KeywordBrowseItem = {
    seasonCount?: number;
    episodeCount?: number;
    availableEpisodeCount?: number;
    watchedEpisodeCount?: number;
    unwatchedEpisodeCount?: number;

    externalIds?: ExternalIds;
    type?: string;
    name?: string;
    year?: number;
    overview?: string;
    rating?: number;
    isAvailable?: boolean;
    trailerUrl?: string;
};

export type ChannelProgram = {
    name?: string;
    startTime?: string;
    endTime?: string;
    progressPercent?: number;
};

export type ChannelBrowseItem = {
    id: string;
    name: string;
    number?: string | number;
    imageId?: string;
    images: ImageSet;
    currentProgram?: ChannelProgram;
    nextProgram?: ChannelProgram;
};

/**
 * Transform a Jellyfin browse item to UniversalMediaItem.
 *
 * Returns `null` when the item carries no media type the client has a card for
 * — **call sites must filter the nulls out** (see the `.flatMap`/`filter` guards
 * in `browse/+page.svelte` and `RecentlyAddedSection.svelte`). This mirrors
 * `MediaTransformerService.transformToUniversalMedia`, which already returns
 * null on an unmappable type: a card the client cannot open is worse than no
 * card.
 *
 * ⚠️ This used to end in `: 'movie'` — the fourth shipped instance of that bug
 * class. An audiobook is neither an episode nor a series, so it became a movie,
 * `UniversalMediaCard`'s `isAudiobook(item.mediaType)` guard stayed false, and
 * the card emitted `getCatalogBackdropSrcSet(uuid)` — a role AudiobookShelf
 * books do not have, so `size=hd` 302'd to the popcorn placeholder. Measured on
 * production 2026-07-30 for three audiobooks on the /browse Continue-Watching
 * rail. Do not reintroduce a fallback here; widen `TO_UNIVERSAL` in
 * `$lib/shared/media-type-domain` if a type needs a card.
 *
 * Defensive against a falsy/malformed `item` (e.g. a null entry in an API
 * array) — call sites are expected to filter these out before mapping, but
 * this guards against throwing (and taking out the whole section) if one
 * slips through. A malformed item has no `type`, so it now drops out as `null`
 * instead of rendering a movie card with an empty id.
 */
export function transformJellyfinItem(
    item: BrowseItem | MediaPreview | null | undefined,
): UniversalMediaItem | null {
    if (item && 'catalogId' in item && 'images' in item) return mediaPreviewToUniversal(item);
    const safeItem: BrowseItem = item ?? { id: '' };
    // `isEpisode` is an INDEPENDENT wire flag, not a restatement of `type`:
    // watching-payload items set it alongside a `type` that may name the parent
    // series, and cached SSR seeds produced before this fix still do. It wins.
    // Everything else goes through the domain module's exhaustive table, so a
    // new media type is a compile error there rather than a silent 'movie' here.
    const mediaType: UniversalMediaType | null =
        safeItem.isEpisode === true ? 'episode' : toUniversalMediaType(safeItem.type);
    if (mediaType === null) return null;
    const isEpisode = mediaType === 'episode';

    // Build externalIds: the item id is the internal UUID (browse/watching
    // payloads are UUID-first); a provided `internal` wins.
    const externalIds: ExternalIds = {
        ...(safeItem.externalIds || {}),
        internal: getExternalIdFor(safeItem.externalIds, 'internal') ?? asInternalUuid(safeItem.id),
    };

    // Use pre-computed image URL if available (from watching API), otherwise build from imageId
    // Use catalog URL (provider-agnostic) which checks local artwork → providers → placeholder
    const imageUrl = safeItem._imageUrl
        ? safeItem._imageUrl
        : safeItem.imageId
          ? getCatalogPosterUrl(safeItem.imageId, { size: 'thumb' })
          : FALLBACK_IMAGE;

    return {
        id: safeItem.id,
        externalIds,
        mediaType,
        title: safeItem.name || m.browse_unknown_title(),
        seasonCount: safeItem.seasonCount,
        episodeCount: safeItem.episodeCount,
        availableEpisodeCount: safeItem.availableEpisodeCount,
        watchedEpisodeCount: safeItem.watchedEpisodeCount,
        unwatchedEpisodeCount: safeItem.unwatchedEpisodeCount,

        subtitle:
            isEpisode && safeItem.seriesName && safeItem.seriesName !== safeItem.name
                ? safeItem.seriesName
                : undefined,
        image: imageUrl,
        backdrop: safeItem.backdropImageId
            ? getCatalogBackdropUrl(safeItem.backdropImageId, { size: 'thumb' })
            : undefined,
        overview: safeItem.overview,
        rating: safeItem.communityRating,
        year: safeItem.year,
        isAvailable: true,
        canRequest: false,
        progress: safeItem.userData?.playedPercentage,
        seasonNumber: safeItem.seasonNumber,
        episodeNumber: safeItem.episodeNumber,
        seriesName: safeItem.seriesName,
        trailerUrl: safeItem.trailerUrl,
        clickData: safeItem,
    };
}

/**
 * Map an array of browse items to cards, dropping the ones the client has no
 * card for (and the falsy/id-less entries the call sites used to filter by hand).
 *
 * Every `.map(transformJellyfinItem)` call site wants exactly this; having one
 * helper means a future widening of the drop rule cannot be applied to three
 * rails and missed on the fourth.
 */
export function transformJellyfinItems(
    items: readonly (BrowseItem | null | undefined)[],
): UniversalMediaItem[] {
    const out: UniversalMediaItem[] = [];
    for (const item of items) {
        if (!item?.id) continue;
        const card = transformJellyfinItem(item);
        if (card !== null) out.push(card);
    }
    return out;
}

/**
 * Transform a TMDB/keyword item to UniversalMediaItem
 *
 * Defensive against a falsy/malformed `item` (e.g. a null entry in an API
 * array) — call sites are expected to filter these out before mapping, but
 * this guards against throwing (and taking out the whole section) if one
 * slips through.
 */
export function transformKeywordItem(
    item: KeywordBrowseItem | null | undefined,
): UniversalMediaItem {
    const safeItem: KeywordBrowseItem = item ?? {};
    // Both discriminators are derived INDEPENDENTLY from the same raw
    // `safeItem.type`. The previous version computed `mediaType` from the
    // already-narrowed `tmdbType`, which meant the second narrowing could only
    // ever see 'movie' or 'tv' and silently agreed with whatever the first one
    // had guessed.
    //
    // The `?? 'movie'` on both is safe HERE specifically, and unlike
    // transformJellyfinItem above this claim is schema-enforced rather than
    // asserted. The wire contract for these items is
    // `KeywordBrowseItemSchema` (src/lib/schemas/api-browse-responses.ts:158):
    //
    //     type: z.enum(['movie', 'series']).describe('Media type'),
    //
    // — required, exactly two members. The client validates the whole payload
    // against `BrowseKeywordsResponseSchema` before it reaches here
    // (`$lib/api/browse.ts:48`, `apiGet('/api/browse/keywords', …)`), so an
    // 'audiobook'/'track'/'tvchannel' value cannot arrive: it would fail
    // response validation, not fall through to the substitute. The only way to
    // reach `?? 'movie'` is the `item ?? {}` malformed-item path above, whose
    // card is a titled placeholder either way.
    //
    // If that enum is ever widened, this pair of `?? 'movie'` becomes the same
    // bug transformJellyfinItem just had — widen the narrowing, not the fallback.
    // tmdbType is 'movie' | 'tv' — used for TMDB image URLs and composite key construction.
    // eslint-disable-next-line callback-safety/no-inline-media-type-default -- the validated keyword schema is movie/series-only.
    const tmdbType = toTmdbType(safeItem.type) ?? 'movie';
    // Canonical public discriminator: 'series' replaces legacy 'tv'.
    // eslint-disable-next-line callback-safety/no-inline-media-type-default -- the validated keyword schema is movie/series-only.
    const mediaType: 'movie' | 'series' = toMovieOrSeries(safeItem.type) ?? 'movie';

    // Build externalIds from provided externalIds
    const externalIds: ExternalIds = {
        ...(safeItem.externalIds || {}),
    };

    // Build unique ID from externalIds using composite key (uses tmdbType for TMDB key format)
    const compositeKey = mediaCompositeKey(externalIds, tmdbType, safeItem.name);

    return {
        id: compositeKey || `browse-${safeItem.name}-${mediaType}`,
        externalIds,
        mediaType,
        title: safeItem.name || m.browse_unknown_title(),
        seasonCount: safeItem.seasonCount,
        episodeCount: safeItem.episodeCount,
        availableEpisodeCount: safeItem.availableEpisodeCount,
        watchedEpisodeCount: safeItem.watchedEpisodeCount,
        unwatchedEpisodeCount: safeItem.unwatchedEpisodeCount,

        subtitle: safeItem.year?.toString(),
        // Use 'thumb' size for browse grids to reduce bandwidth (~40KB vs 100KB+)
        image: hasValidExternalId(externalIds)
            ? (imageFromIds(externalIds, 'poster', tmdbType, {
                  size: 'thumb',
              }) ?? FALLBACK_IMAGE)
            : FALLBACK_IMAGE,
        overview: safeItem.overview,
        rating: safeItem.rating,
        year: safeItem.year,
        isAvailable: safeItem.isAvailable || false,
        // isAvailable is derived from media_items.has_files, so a discovery
        // TMDB/keyword item with no local file is non-playable. Carry it as
        // hasFiles so the play gate hides Play on these cards.
        hasFiles: safeItem.isAvailable || false,
        canRequest: !safeItem.isAvailable,
        trailerUrl: safeItem.trailerUrl,
        clickData: safeItem,
    };
}

/**
 * Transform a channel to UniversalMediaItem with live progress calculation
 * Uses programTick to trigger reactive updates
 * Returns { item, needsRefresh } to allow smart refresh detection
 */
export function transformChannelItem(
    channel: ChannelBrowseItem,
    _tick: number,
): { item: UniversalMediaItem; needsRefresh: boolean } {
    const logoUrl = channel.images.primary?.href ?? '';
    const channelId = `channel-${channel.id}`;

    // Calculate live progress and handle program transitions
    const now = Date.now();
    let displayName = channel.number
        ? m.browse_channel_number({ n: String(channel.number) }).trim()
        : m.browse_channel_number({ n: '' }).trim();
    let progress: number | undefined = undefined;
    let needsRefresh = false;

    const currentProg = channel.currentProgram;
    const nextProg = channel.nextProgram;

    if (currentProg?.startTime && currentProg?.endTime) {
        const start = new Date(currentProg.startTime).getTime();
        const end = new Date(currentProg.endTime).getTime();

        if (now < end) {
            // Current program is still playing
            displayName = currentProg.name || displayName;
            progress = Math.min(
                100,
                Math.max(0, Math.round(((now - start) / (end - start)) * 100)),
            );
        } else if (nextProg?.startTime && nextProg?.endTime) {
            // Current program ended - check next program
            const nextStart = new Date(nextProg.startTime).getTime();
            const nextEnd = new Date(nextProg.endTime).getTime();

            if (now >= nextStart && now < nextEnd) {
                // Next program is now playing - this is a program transition!
                displayName = nextProg.name || displayName;
                progress = Math.min(
                    100,
                    Math.max(0, Math.round(((now - nextStart) / (nextEnd - nextStart)) * 100)),
                );
                needsRefresh = true; // We've consumed nextProgram, need fresh data
            } else if (now < nextStart) {
                // In between programs (rare)
                displayName = m
                    .browse_coming_up({
                        program: nextProg.name || m.browse_unknown_title(),
                    })
                    .trim();
                progress = undefined;
            } else {
                // Past both programs - need refresh
                displayName = currentProg.name || displayName;
                progress = 100;
                needsRefresh = true;
            }
        } else {
            // No next program info available
            displayName = currentProg.name || displayName;
            progress = 100;
            needsRefresh = true;
        }
    } else if (currentProg?.name) {
        // Has name but no timing info
        displayName = currentProg.name;
    }

    return {
        item: {
            id: channelId,
            externalIds: asInternalUuid(channel.id) ? { internal: channel.id } : {},
            // Canonical: 'tvchannel' so isTvChannel() guards work correctly.
            mediaType: 'tvchannel',
            title: channel.name || m.browse_unknown_channel(),
            subtitle: displayName,
            image: logoUrl,
            backdrop: logoUrl,
            isAvailable: true,
            canRequest: false,
            progress,
            badges: [{ text: m.browse_live_badge(), color: 'error' }],
            clickData: channel,
        },
        needsRefresh,
    };
}
