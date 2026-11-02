// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * item-mapper.ts — shared helpers to map legacy for-you service items to the
 * canonical `RecommendationItem` contract shape.
 *
 * Each service function returns its own item interface (TrendingItem,
 * BingeSeriesItem, etc.) built around the old SDUI PageSection contract.
 * This module converts those shapes to the new Tier-2 contract:
 *   { media: RecommendedMediaRef, score?, reason? }
 *
 * Rules:
 * - `type` is the canonical PUBLIC discriminator ({@link PublicMediaType}) —
 *   never 'tv', never 'show', and never a raw internal `media_type`. Rows whose
 *   stored type has no public representation are DROPPED, not relabelled (see
 *   `mapToRecommendationItem`).
 * - `images{}` hrefs are derived from the internal UUID via the catalog image path.
 *   Provider names (radarr, tmdb) never appear in public image paths.
 * - `ids{}` carries all provider IDs as string values.
 * - `score` normalises the raw rating to [0, 1].
 */

import type postgres from 'postgres';
import type { RecommendationItem } from '../recommendations/recommender.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { type PublicMediaType } from '$lib/server/utils/media-types.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { type ApiSurface, entityImageUrl } from '$lib/shared/api-urls.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('ItemMapper');

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

// NOTE: the former `canonicalType(raw): string` helper lived here. It was
// `toPublicMediaType(raw) ?? (raw ? raw.toLowerCase() : 'movie')` — a raw
// passthrough with a lying default. Its `string` return type is what let an
// internal-only `media_type` ('tvchannel', 'home_video', 'music', …) reach the
// public `media.type` discriminator verbatim, and let a row with no type at all
// be published as a movie. With the passthrough and the default both removed
// the helper reduced to an exact alias of the shared `toPublicMediaType()`
// (which already lowercases, already folds 'tv'/'show' → 'series', and already
// returns null for values that have no public representation), so it is gone
// rather than re-wrapped: `toPublicMediaType` is documented as "the single
// canonical replacement for the ~9 ad-hoc per-route copies". Call sites now use
// it directly AND MUST DROP the item on null — see `mapToRecommendationItem`.

/**
 * Normalise a raw ExternalIds map to a flat `Record<string, string>` suitable
 * for the `ids{}` field. Skips null/undefined values.
 */
export function toIdsRecord(extIds: ExternalIds | null | undefined): Record<string, string> {
    if (!extIds) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(extIds)) {
        if (v != null) out[k] = String(v);
    }
    return out;
}

/**
 * Resolve the canonical `media.id` for a recommendation item.
 *
 * Priority:
 *   1. the internal catalogue UUID — always preferred, always dereferenceable;
 *   2. a VALID 3-part composite key `provider:id:mediaType`, for discovery-only
 *      items that genuinely aren't in the catalogue yet (a request-only TMDB
 *      title has no UUID to give, but the client can still dereference it);
 *   3. `null` — the item is undereferenceable and the caller MUST drop it.
 *
 * The 3-part form is mandatory. `parseMediaId` (media-key-parser.ts:200-208)
 * explicitly REJECTS 2-part TMDB keys because TMDB ids collide across media
 * types, so a `tmdb:603` fallback is not a degraded id — it is an unusable one.
 * Several rails previously emitted exactly that, or worse (`ext:603`, a bare
 * Jellyfin GUID, or `''`), which is why this is centralised here.
 *
 * `mediaType` is the canonical public discriminator ('movie' | 'series'), so
 * the key stays self-consistent with the sibling `media.type`; parseMediaId
 * normalises the 'series' alias to 'tv' before resolution.
 */
export function resolveMediaRefId(
    extIds: ExternalIds | null | undefined,
    mediaType: PublicMediaType,
): string | null {
    const internal = getExternalIdFor(extIds, 'internal');
    if (internal) return internal;

    const provider = getPrimaryExternalIdProvider();
    const providerId = extIds ? getExternalIdFor(extIds, provider) : undefined;
    if (providerId) return `${provider}:${providerId}:${mediaType}`;

    return null;
}

/**
 * Build the canonical `images{}` hrefs from an internal UUID.
 * Only emitted when an internal UUID is present (self-describing hrefs).
 */
export function buildImagesFromUuid(
    internalId: string | null | undefined,
    surface: ApiSurface,
    roles: readonly ('poster' | 'backdrop' | 'thumb')[] = ['poster', 'backdrop', 'thumb'],
): Record<string, { href: string }> | undefined {
    if (!internalId) return undefined;
    return Object.fromEntries(
        roles.map((role) => [role, { href: entityImageUrl(internalId, role, surface) }]),
    );
}

// ---------------------------------------------------------------------------
// Generic item mapper
// ---------------------------------------------------------------------------

export interface GenericForYouItem {
    seasonCount?: number;
    episodeCount?: number;
    availableEpisodeCount?: number;
    watchedEpisodeCount?: number;
    unwatchedEpisodeCount?: number;

    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    rating?: number | null;
    year?: number | null;
    /**
     * Availability, propagated to the RecommendationItem top-level
     * `isAvailable`/`canRequest` fields. MUST be supplied by any rail whose
     * items can be discovery-only (not in the library) — otherwise the field is
     * omitted and the client defaults to "available", rendering a request-only
     * title as watchable (a `/watch/<uuid>` 404). Library-only rails may leave
     * these undefined: their items are available by construction.
     */
    isAvailable?: boolean | null;
    canRequest?: boolean | null;
}

/**
 * Map any generic for-you service item to a `RecommendationItem`.
 *
 * Returns `null` when the item cannot be published: either its `media_type` has
 * no public representation, or no dereferenceable `media.id` can be built. The
 * caller MUST drop it (see `mapBatch`).
 *
 * @param item       - the service-layer item
 * @param reasonKind - the reason `kind` string for this strategy
 * @param score      - optional pre-computed score in [0, 1] (derived from rating when omitted)
 */
export function mapToRecommendationItem(
    item: GenericForYouItem,
    reasonKind: string,
    surface: ApiSurface,
    score?: number,
): RecommendationItem | null {
    const internalId = getExternalIdFor(item.externalIds, 'internal');
    const ids = toIdsRecord(item.externalIds);
    const images = buildImagesFromUuid(internalId, surface);

    // Items whose internal `media_type` has NO public representation
    // ('tvchannel', 'home_video', 'music', … → null) are DROPPED, and so is an
    // item with no type at all. Same reasoning as the undereferenceable-id drop
    // below: a card the client cannot open is worse than no card. Relabelling
    // them (the old `?? raw.toLowerCase()` passthrough, or the old `?? 'movie'`
    // default) is strictly worse than dropping — the client routes on
    // `media.type`, so a mislabelled tvchannel is sent down the movie playback
    // path and fails there instead of never being offered.
    const canonical = toPublicMediaType(item.mediaType);
    if (!canonical) return null;

    // Undereferenceable items are DROPPED rather than shipped with a synthetic
    // id. The previous `ext:${Object.values(ids)[0]}` fallback was both
    // unparseable and non-deterministic (it took whichever key happened to come
    // first). A card the client cannot open is worse than no card.
    const mediaId = resolveMediaRefId(item.externalIds, canonical);
    if (!mediaId) return null;

    // Derive normalised score from raw rating when not provided explicitly
    const derivedScore = score ?? (item.rating != null ? Math.min(item.rating / 10, 1) : undefined);

    const result: RecommendationItem = {
        media: {
            id: mediaId,
            type: canonical,
            title: item.title,
            seasonCount: item.seasonCount,
            episodeCount: item.episodeCount,
            availableEpisodeCount: item.availableEpisodeCount,
            watchedEpisodeCount: item.watchedEpisodeCount,
            unwatchedEpisodeCount: item.unwatchedEpisodeCount,

            ...(item.year != null ? { year: item.year } : {}),
            ids,
            ...(images ? { images } : {}),
        },
        ...(derivedScore !== undefined ? { score: derivedScore } : {}),
        ...(item.isAvailable != null ? { isAvailable: item.isAvailable } : {}),
        ...(item.canRequest != null ? { canRequest: item.canRequest } : {}),
        reason: { kind: reasonKind },
    };

    return result;
}

/**
 * Batch-map a service item array and apply limit + hasMore detection.
 * Callers should fetch `limit + 1` items and pass the full result here.
 */
/**
 * A row from the pure-library onboarding queries (getRecentlyAddedItems /
 * getRandomPickItems): the internal UUID as `id` + a lowercase `media_type`, and
 * crucially NO `externalIds`.
 */
export interface LibraryRow {
    id: string;
    media_type: string;
    title: string;
    year?: number | null;
}

/**
 * Reshape pure-library rows into the {@link GenericForYouItem} contract the
 * mappers expect. REQUIRED before mapBatch: mapToRecommendationItem reads
 * `externalIds.internal` to build the `/api/image/catalog/{uuid}` hrefs and the
 * media id. Casting the raw `{ id, media_type }` rows straight to the item shape
 * (an `as` cast — no runtime effect) left `externalIds` undefined, so every card
 * fell back to the popcorn placeholder AND collapsed to a single `ext:unknown`
 * media id (duplicate keys → only one card rendered).
 */
export function libraryRowsToItems(rows: LibraryRow[]): GenericForYouItem[] {
    return rows.map((r) => ({
        externalIds: { internal: r.id } as ExternalIds,
        mediaType: r.media_type,
        title: r.title,
        year: r.year ?? null,
    }));
}

export function mapBatch<T extends GenericForYouItem>(
    rawItems: T[],
    limit: number,
    reasonKind: string,
    surface: ApiSurface,
    scoreFn?: (item: T) => number | undefined,
): { items: RecommendationItem[]; hasMore: boolean } {
    const hasMore = rawItems.length > limit;
    const page = rawItems.slice(0, limit);
    // Undereferenceable items — and items whose internal media_type has no
    // public representation — are dropped by mapToRecommendationItem (null), so
    // a page may come back shorter than `limit`. That is deliberate: `hasMore`
    // still reflects the raw fetch, so the caller pages forward correctly rather
    // than stalling on a page that shrank.
    const items = page
        .map((item) =>
            mapToRecommendationItem(item, reasonKind, surface, scoreFn ? scoreFn(item) : undefined),
        )
        .filter((item): item is RecommendationItem => item !== null);
    return { items, hasMore };
}

// ---------------------------------------------------------------------------
// Rail display metadata hydration
// ---------------------------------------------------------------------------

/**
 * Hydrate `media.overview`/`rating`/`criticRating`/`runtimeMinutes`/`genres`/
 * `certification`/quality-tier fields onto an already-mapped page of
 * `RecommendationItem`s, via ONE batched `getMediaRailMetadataBatch` round
 * trip keyed on the internal UUID.
 *
 * `mapToRecommendationItem`/`mapBatch` only ever set id/type/title/year/ids/
 * images — none of this rail metadata — so every caller that skipped this
 * step (every for-you rail except the `ai` strategy and the watchlist
 * endpoint, until this helper was centralised here) shipped items with no
 * synopsis, no rating badge, no runtime and no genre tags in
 * MediaHoverCard's popup, which gates each of those on the corresponding
 * `currentItem.*` field. Call this right after `mapBatch` in every rail that
 * wants its hover popup to show more than a bare title.
 *
 * Items whose `media.id` is a composite `provider:id:type` key (discovery-only,
 * no catalogue row yet) are skipped — there is no `media_items` row to join.
 * Missing/unresolvable ids are simply left as mapBatch produced them.
 *
 * Best-effort: every call site sits inside a strategy `try/catch` whose catch
 * discards already-fetched, already-mapped items on ANY throw (returning
 * `{ items: [], hasMore: false }`), which drops the whole rail from /feed. A
 * transient DB hiccup or one dirty `provider_metadata` value tripping the
 * regex guards in `getMediaRailMetadataBatch` must not blank titles/posters
 * that were already successfully resolved — same reasoning as the try/catch
 * `ai.strategy.ts` wraps its own `getMediaRailMetadataBatch` call in. Failures
 * are swallowed here, once, so none of the ~13 call sites have to repeat it.
 */
export async function hydrateRailMetadata(
    sql: postgres.Sql,
    items: RecommendationItem[],
): Promise<void> {
    const uuidIds = items
        .map((it) => it.media.id)
        .filter((id): id is string => !!id && !id.includes(':'));
    if (uuidIds.length === 0) return;

    try {
        const [{ getMediaRailMetadataBatch }, { pickDisplayRating }] = await Promise.all([
            import('$lib/server/database/queries/media-rail-metadata.queries.js'),
            import('$lib/server/utils/rating-utils.js'),
        ]);
        const metaMap = await getMediaRailMetadataBatch(sql, uuidIds);

        for (const it of items) {
            const meta = metaMap.get(it.media.id);
            if (!meta) continue;
            if (meta.overview) it.media.overview = meta.overview;
            const displayRating = pickDisplayRating({
                imdbRating: meta.imdbRating,
                tmdbRating: meta.tmdbRating,
                voteCount: meta.voteCount,
            });
            if (displayRating != null) it.media.rating = displayRating;
            if (meta.rtRating != null) it.media.criticRating = meta.rtRating;
            if (meta.runtimeMinutes != null)
                it.media.durationMs = Math.round(meta.runtimeMinutes * 60_000);
            if (meta.genres && meta.genres.length > 0) it.media.genres = meta.genres;
            if (meta.certification) it.media.certification = meta.certification;
            if (meta.resolutionTier) it.media.resolutionTier = meta.resolutionTier;
            if (meta.hdrTier) it.media.hdrTier = meta.hdrTier;
            if (meta.hasAtmos) it.media.hasAtmos = true;
            if (meta.hasCc) it.media.hasCc = true;
            if (meta.hasSdh) it.media.hasSdh = true;
            if (meta.hasAd) it.media.hasAd = true;
        }
    } catch (err) {
        logger.warn('Failed to hydrate rail metadata; serving items without it', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Public rail serialization. Internal strategy rows never become a wire contract. */
export {
    buildMediaPreview,
    buildMediaPreviews,
    recommendationPreviews,
} from '$lib/server/services/media-preview.service.js';
