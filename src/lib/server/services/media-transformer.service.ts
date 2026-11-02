// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Transformation Service
 *
 * Consolidates 190+ scattered transformation patterns into unified service.
 * Handles composite key validation, external ID extraction, and image URL generation.
 *
 * Benefits:
 * - Eliminates 18 duplicate transformer functions from section-builder.ts
 * - Enforces provider-agnostic composite key usage
 * - Centralized validation prevents TMDB ID collisions
 * - Consistent image URL generation across all endpoints
 *
 * Usage:
 * ```typescript
 * const transformer = new MediaTransformerService();
 * const items = transformer.transformBatch(rows, {
 *     prefix: 'cw',
 *     includeProgress: true
 * });
 * ```
 */

import type { UniversalMediaItem, Badge } from '$lib/types/server-driven-ui';
import type { ExternalIds } from '$lib/types/api-common';
import {
    getCatalogPosterUrl,
    getCatalogBackdropUrl,
    getCatalogThumbUrl,
} from '$lib/utils/image-utils.js';
import { getExternalIdFor } from '$lib/utils/external-ids';
import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
import { isMovie, isSeries, isEpisode, isAudiobook } from '$lib/server/utils/media-types.js';
import { toUniversalMediaType } from '$lib/shared/media-type-domain';
import { GenreService } from '$lib/server/services/genre.service.js';
import { FALLBACK_IMAGE } from '$lib/constants/images';
import {
    resolveMediaAvailability,
    resolveMediaRequestability,
} from '$lib/shared/media-availability.js';

/**
 * Base row structure from database queries
 * Most queries will return a superset of these fields
 */
export interface QueryRowLike {
    // Core identity
    id?: string | null;
    title?: string | null;
    media_type?: string | null;
    mediaType?: string | null;

    // External IDs (can come from joined tables)
    tmdb?: string | number | null;
    imdb?: string | null;
    tvdb?: string | number | null;
    trakt?: string | number | null;
    mal?: string | number | null;
    internal?: string | null;

    // or as separate object
    externalIds?: ExternalIds;

    // Episode-specific
    series_name?: string;
    seriesName?: string;
    season_number?: number;
    seasonNumber?: number;
    episode_number?: number;
    episodeNumber?: number;
    /** Internal series UUID (for episode rows) */
    series_id?: string;
    seriesId?: string;

    // Display
    image_url?: string;
    imageUrl?: string;
    poster_path?: string;
    posterPath?: string;
    backdrop_path?: string;
    backdropPath?: string;
    overview?: string;

    // Progress and status
    watch_progress?: number;
    watchProgress?: number;
    duration?: number;
    runtime_minutes?: number;
    runtimeMinutes?: number;
    is_available?: boolean;
    isAvailable?: boolean;
    hasFile?: boolean;
    has_files?: boolean;
    hasFiles?: boolean;
    can_request?: boolean;
    canRequest?: boolean;
    isCompleted?: boolean;
    is_watched?: boolean;
    isWatched?: boolean;

    // Ratings and metadata
    rank?: number;
    rating?: number;
    imdb_rating?: number;
    imdbRating?: number;
    rt_critic?: number | null;
    rtCritic?: number | null;
    rt_audience?: number | null;
    rtAudience?: number | null;
    letterboxd_rating?: number;
    letterboxdRating?: number;
    letterboxd_votes?: number;
    letterboxdVotes?: number;
    mal_score?: number;
    malScore?: number;
    mdblist_score?: number;
    mdblistScore?: number;
    metacritic_score?: number;
    metacriticScore?: number;
    trakt_score?: number;
    traktScore?: number;
    year?: number | string | null;
    release_date?: string | Date | null;
    releaseDate?: string | Date | null;

    // AI/recommendation specific
    similarity?: number;
    similarity_score?: number;
    similarityScore?: number;
    ai_similarity?: number;
    aiSimilarity?: number;
    reason?: string;

    // Trailers
    trailer_url?: string;
    trailerUrl?: string;

    // Series specific
    season_count?: number;
    seasonCount?: number;

    // Media ID (for AI suggestions)
    media_id?: string;
    mediaId?: string;

    // Genre IDs (integer arrays from provider_metadata JSONB)
    genres?: number[] | null;
    genre_ids?: number[] | null;

    // Custom metadata for non-entertainment types
    custom_metadata?: Record<string, unknown> | null;
    customMetadata?: Record<string, unknown> | null;

    // BlurHash placeholders
    poster_blurhash?: string | null;
    posterBlurHash?: string | null;
    backdrop_blurhash?: string | null;
    backdropBlurHash?: string | null;
}

/**
 * Context for transformation - determines which fields to include
 */
export interface TransformContext {
    /** Prefix for composite key generation (e.g., 'cw', 'tr', 'sim') */
    prefix: string;
    /** Include watch progress (for continue watching) */
    includeProgress?: boolean;
    /** Include AI reason field (for AI suggestions) */
    includeReason?: boolean;
    /** Override media type from row */
    mediaType?: string;
    /** Mark as new/unwatched (for next-up sections) */
    markAsNew?: boolean;
    /** Add custom badges */
    badges?: Badge[];
}

/**
 * Media Transformation Service
 *
 * Singleton service for transforming database query results into UniversalMediaItem format.
 */
export class MediaTransformerService {
    /**
     * Transform a single database row to UniversalMediaItem, or `null` when the
     * row's media type has no `UniversalMediaType` representation.
     *
     * `null` covers `season` (the union has no member), the four
     * non-entertainment library types, `radio`, `extra`, `book`/`manga`/`comic`/
     * `podcast` and the storage-only bookkeeping rows. Those used to come back as
     * `mediaType: 'movie'`, i.e. a card the client renders as a movie and opens
     * as a movie.
     *
     * Callers DROP on null. A card the client cannot open correctly is worse than
     * no card — the same rule the recommendation feeds already apply when
     * `toPublicMediaType()` returns null.
     *
     * @param row Database query result row
     * @param context Transformation context
     * @returns Transformed UniversalMediaItem, or null if unrepresentable
     */
    transformToUniversalMedia(
        row: QueryRowLike,
        context: TransformContext,
    ): UniversalMediaItem | null {
        // Extract external IDs from the row
        const externalIds = this.extractExternalIds(row);

        // Determine media type. The `'movie'` here is a LAST-RESORT for a row
        // that carries no type column at all (some legacy query shapes) — it is
        // not a classification of a known-but-unmapped type, which is what the
        // deleted normalizeMediaType() used it for.
        const mediaType = context.mediaType || row.media_type || row.mediaType || 'movie';
        const universalType = toUniversalMediaType(mediaType);
        if (universalType === null) return null;

        // Generate unique composite key (prevents TMDB ID collisions)
        const uniqueId = mediaCompositeKey(externalIds, mediaType, context.prefix);

        // Determine if this is an episode
        const isEpisodeItem = isEpisode(mediaType);

        // Build base item
        const item: UniversalMediaItem = {
            id: uniqueId,
            externalIds,
            mediaType: universalType,
            title: this.getTitle(row, isEpisodeItem),
            subtitle: this.getSubtitle(row, isEpisodeItem),
            image: this.getImageUrl(externalIds, row, mediaType),
            overview: row.overview,
            isAvailable: resolveMediaAvailability(row),
            canRequest: resolveMediaRequestability(row),
        };

        // Backdrop is OMITTED, not emptied, when the type has no backdrop art.
        // An audiobook (AudiobookShelf book) has exactly one cover image and
        // resolves ONLY under the 'poster' role — every other role short-circuits
        // to null in ImageProxyService.getImageByCatalogId() and the
        // /api/media/{id}/images/{role} route turns that null into a 302 to the
        // popcorn placeholder. A truthy-but-doomed URL is worse than an absent
        // field: consumers that prefer `backdrop` over `image` (the
        // backdrop-variant card the CW rail uses) then swap a real cover for the
        // placeholder, while an absent field lets every consumer fall back to the
        // poster on its own.
        const backdrop = this.getBackdropUrl(externalIds, row, mediaType);
        if (backdrop) {
            item.backdrop = backdrop;
        }

        // Preserve the canonical file signal separately for downstream cards.
        // Missing evidence remains unavailable in the shared reader above.
        const hasFilesValue = row.hasFile ?? row.hasFiles ?? row.has_files;
        if (typeof hasFilesValue === 'boolean') {
            item.hasFiles = hasFilesValue;
        }

        // Add progress if requested
        if (context.includeProgress && row.watch_progress !== undefined) {
            item.progress = row.watchProgress ?? row.watch_progress;
        } else if (context.includeProgress && row.watchProgress !== undefined) {
            item.progress = row.watchProgress;
        }

        // Add runtime
        if (row.duration) {
            item.durationMs = Math.round(row.duration * 1000);
        } else if (row.runtime_minutes || row.runtimeMinutes) {
            item.durationMs = Math.round((row.runtimeMinutes ?? row.runtime_minutes ?? 0) * 60_000);
        }

        // Add episode-specific fields
        if (isEpisodeItem) {
            item.seasonNumber = row.seasonNumber ?? row.season_number;
            item.episodeNumber = row.episodeNumber ?? row.episode_number;
            item.seriesName = row.seriesName ?? row.series_name;
            // Internal series UUID — required by client-side actions
            // that target the series (e.g. CW dismissal). Both casings
            // are accepted because row shapes vary across callers.
            const seriesIdValue = row.seriesId ?? row.series_id;
            if (typeof seriesIdValue === 'string' && seriesIdValue.length > 0) {
                item.seriesId = seriesIdValue;
            }
        }

        // Add rank (for trending, top lists)
        if (row.rank !== undefined) {
            item.rank = row.rank;
        }

        // Add ratings
        this.addRatings(item, row);

        // Add year
        if (row.year !== undefined && row.year !== null) {
            item.year = row.year;
        }

        // Add genres (convert integer IDs to human-readable names)
        const rawGenres = row.genres ?? row.genre_ids;
        if (Array.isArray(rawGenres) && rawGenres.length > 0) {
            const validIds = (rawGenres as unknown[]).filter(
                (g): g is number => typeof g === 'number',
            );
            if (validIds.length > 0) {
                const mt = isMovie(mediaType) ? 'movie' : isSeries(mediaType) ? 'tv' : undefined;
                item.genres = GenreService.convertGenreIds(validIds, mt).map((g) => g.name);
            }
        }

        // Add trailer URL
        if (row.trailer_url || row.trailerUrl) {
            item.trailerUrl = row.trailerUrl ?? row.trailer_url;
        }

        // Add similarity score (for similar items, AI suggestions)
        if (row.similarity !== undefined) {
            item.similarityScore = row.similarity / 100; // Convert percentage to 0-1
        } else if (row.similarity_score !== undefined) {
            item.similarityScore = row.similarityScore ?? row.similarity_score;
        } else if (row.ai_similarity !== undefined) {
            item.similarityScore = row.aiSimilarity ?? row.ai_similarity;
        }

        // Add AI reason if requested
        if (context.includeReason && row.reason) {
            item.reason = row.reason;
        }

        // Add watched status
        if (row.is_watched !== undefined || row.isWatched !== undefined) {
            item.isPlayed = row.isWatched ?? row.is_watched;
        }

        // Mark as new if requested
        if (context.markAsNew) {
            item.isNew = true;
            item.progress = undefined; // Clear progress for next-up items
        }

        // Add custom badges
        if (context.badges && context.badges.length > 0) {
            item.badges = context.badges;
        }

        // Add release date
        if (row.release_date || row.releaseDate) {
            const releaseDate = row.releaseDate ?? row.release_date;
            if (releaseDate instanceof Date) {
                item.releaseDate = releaseDate.toISOString().split('T')[0];
            } else if (releaseDate) {
                item.releaseDate = releaseDate;
            }
        }

        // Add season count (for series)
        if (row.season_count || row.seasonCount) {
            item.seasonCount = row.seasonCount ?? row.season_count;
        }

        // Add custom metadata (for non-entertainment types)
        const customMeta = row.customMetadata ?? row.custom_metadata;
        if (customMeta && Object.keys(customMeta).length > 0) {
            item.customMetadata = customMeta;
        }

        // Add BlurHash placeholders
        const posterHash = row.posterBlurHash ?? row.poster_blurhash;
        if (posterHash) {
            item.posterBlurHash = posterHash;
        }
        const backdropHash = row.backdropBlurHash ?? row.backdrop_blurhash;
        if (backdropHash) {
            item.backdropBlurHash = backdropHash;
        }

        return item;
    }

    /**
     * Transform multiple rows in batch, DROPPING rows whose media type has no
     * `UniversalMediaType` representation.
     *
     * The count of the returned array can therefore be smaller than `rows.length`.
     * That is the intended behaviour: the alternative is what this used to do —
     * emit a `mediaType: 'movie'` card for a season, home video or storage-only
     * row, which the client renders as a movie and opens as a movie.
     */
    transformBatch(rows: QueryRowLike[], context: TransformContext): UniversalMediaItem[] {
        return rows
            .map((row) => this.transformToUniversalMedia(row, context))
            .filter((item): item is UniversalMediaItem => item !== null);
    }

    /**
     * Extract external IDs from a database row
     * Handles both snake_case (database) and camelCase (API) naming
     *
     * @param row Database query result row
     * @returns ExternalIds object
     */
    private extractExternalIds(row: QueryRowLike): ExternalIds {
        // If row already has externalIds, use it
        if (row.externalIds) {
            return row.externalIds;
        }

        const ids: ExternalIds = {};

        // Extract individual fields (normalize to strings, filter out nulls)
        if (row.tmdb !== undefined && row.tmdb !== null) ids.tmdb = String(row.tmdb);
        if (row.imdb !== undefined && row.imdb !== null) ids.imdb = row.imdb;
        if (row.tvdb !== undefined && row.tvdb !== null) ids.tvdb = String(row.tvdb);
        if (row.trakt !== undefined && row.trakt !== null) ids.trakt = String(row.trakt);
        if (row.mal !== undefined && row.mal !== null) ids.mal = String(row.mal);
        if (row.internal !== undefined && row.internal !== null) ids.internal = row.internal;

        return ids;
    }

    /**
     * Get the backdrop URL for a row, or `undefined` when the media type has no
     * backdrop art at all.
     *
     * Kept separate from {@link getImageUrl} precisely because "no backdrop"
     * must be expressible. `getImageUrl` always returns a string (it falls back
     * to FALLBACK_IMAGE), which is right for the poster slot — a card must show
     * something — but wrong for the backdrop slot, where the consumer's own
     * poster fallback is the better answer.
     */
    private getBackdropUrl(
        externalIds: ExternalIds,
        row: QueryRowLike,
        mediaType: string,
    ): string | undefined {
        // Audiobooks resolve only the 'poster' role — see the call site.
        if (isAudiobook(mediaType)) return undefined;

        const internalId = getExternalIdFor(externalIds, 'internal');
        // Episodes: 'thumb' is the episode's own art (see getImageUrl).
        if (isEpisode(mediaType) && internalId) {
            return getCatalogThumbUrl(internalId, { size: 'thumb' });
        }
        if (internalId) {
            return getCatalogBackdropUrl(internalId, { size: 'thumb' });
        }
        // No UUID → no catalog URL to build. Deliberately NOT FALLBACK_IMAGE:
        // the placeholder in a backdrop slot is exactly the bug this avoids.
        return undefined;
    }

    /**
     * Get the poster (primary card image) URL from row data and external IDs.
     * Always returns a string — a card must show something, so the last resort
     * is FALLBACK_IMAGE. The backdrop slot has the opposite contract; see
     * {@link getBackdropUrl}.
     *
     * @param externalIds External provider IDs
     * @param row Database query result row
     * @param mediaType Media type for provider lookups
     * @returns Image URL or fallback
     */
    private getImageUrl(externalIds: ExternalIds, row: QueryRowLike, mediaType: string): string {
        const internalId = getExternalIdFor(externalIds, 'internal');

        // Episodes have neither a poster nor a backdrop of their own — TMDB only
        // ever gives an episode a `still_path`, which the catalog endpoint only
        // resolves under type 'thumb'. Requesting 'poster'/'backdrop' on an
        // episode id skips the episode entirely and inherits season/series art
        // (or 404s to the popcorn placeholder if that's empty too). 'thumb' is
        // wired for episodes end-to-end: it prefers a locally ffmpeg-extracted
        // frame, then the episode's own still_path, then a live TMDB lookup —
        // so route BOTH poster and backdrop slots through it for episodes.
        if (isEpisode(mediaType) && internalId) {
            return getCatalogThumbUrl(internalId, { size: 'thumb' });
        }

        // Check row for a direct image URL first (non-episode rows only — see
        // above). For an audiobook this is the ABS cover href the CW query
        // already resolved.
        if (row.image_url || row.imageUrl) {
            return row.imageUrl ?? row.image_url ?? FALLBACK_IMAGE;
        }

        // Use catalog endpoint via internal UUID
        if (internalId) {
            return getCatalogPosterUrl(internalId, { size: 'thumb' });
        }

        return FALLBACK_IMAGE;
    }

    /**
     * Get title for the item
     * For episodes, returns the series name
     *
     * @param row Database query result row
     * @param isEpisode Whether this is an episode
     * @returns Title string
     */
    private getTitle(row: QueryRowLike, isEpisode: boolean): string {
        if (isEpisode) {
            return row.seriesName || row.series_name || row.title || 'Unknown Series';
        }
        return row.title || 'Unknown';
    }

    /**
     * Get subtitle for the item
     * For episodes, returns "S1:E4 - Episode Title"
     *
     * @param row Database query result row
     * @param isEpisode Whether this is an episode
     * @returns Subtitle string or undefined
     */
    private getSubtitle(row: QueryRowLike, isEpisode: boolean): string | undefined {
        let subtitle: string | undefined;

        if (isEpisode) {
            const season = row.seasonNumber ?? row.season_number;
            const episode = row.episodeNumber ?? row.episode_number;
            const title = row.title;

            if (season !== undefined && episode !== undefined && title) {
                subtitle = `S${season}:E${episode} - ${title}`;
            } else if (season !== undefined && episode !== undefined) {
                subtitle = `S${season}:E${episode}`;
            }
        }

        // For short movies, show runtime
        if (subtitle === undefined && (row.runtime_minutes || row.runtimeMinutes)) {
            const runtime = row.runtimeMinutes ?? row.runtime_minutes;
            if (runtime && runtime < 90) {
                // Only show for movies under 90 minutes
                subtitle = `${runtime} Min.`;
            }
        }

        // Never surface a subtitle that duplicates the title (e.g. an episode
        // whose row lacks season/episode numbers so it falls through to the
        // series name for both title and subtitle).
        if (subtitle !== undefined && subtitle === this.getTitle(row, isEpisode)) {
            return undefined;
        }

        return subtitle;
    }

    /**
     * Add rating fields to the item
     *
     * @param item UniversalMediaItem to add ratings to
     * @param row Database query result row
     */
    private addRatings(item: UniversalMediaItem, row: QueryRowLike): void {
        // Primary rating (IMDB/TMDB)
        if (row.rating !== undefined) {
            item.rating = row.rating;
        } else if (row.imdb_rating !== undefined || row.imdbRating !== undefined) {
            item.rating = row.imdbRating ?? row.imdb_rating;
        }

        // Critic rating (Rotten Tomatoes)
        if (row.rt_critic !== undefined || row.rtCritic !== undefined) {
            const critic = row.rtCritic ?? row.rt_critic;
            item.criticRating = critic ?? undefined;
        }

        // Audience rating (Rotten Tomatoes)
        if (row.rt_audience !== undefined || row.rtAudience !== undefined) {
            const audience = row.rtAudience ?? row.rt_audience;
            item.audienceRating = audience ?? undefined;
        }

        // Letterboxd rating
        if (row.letterboxd_rating !== undefined || row.letterboxdRating !== undefined) {
            item.letterboxdRating = row.letterboxdRating ?? row.letterboxd_rating;
        }

        // Letterboxd votes
        if (row.letterboxd_votes !== undefined || row.letterboxdVotes !== undefined) {
            item.letterboxdVotes = row.letterboxdVotes ?? row.letterboxd_votes;
        }

        // MyAnimeList score
        if (row.mal_score !== undefined || row.malScore !== undefined) {
            const malScore = row.malScore ?? row.mal_score;
            item.malScore = malScore ?? undefined;
        }

        // MDBList score
        if (row.mdblist_score !== undefined || row.mdblistScore !== undefined) {
            const mdblistScore = row.mdblistScore ?? row.mdblist_score;
            item.mdblistScore = mdblistScore ?? undefined;
        }

        // Metacritic score
        if (row.metacritic_score !== undefined || row.metacriticScore !== undefined) {
            item.metacriticScore = row.metacriticScore ?? row.metacritic_score;
        }

        // Trakt score
        if (row.trakt_score !== undefined || row.traktScore !== undefined) {
            item.traktScore = row.traktScore ?? row.trakt_score;
        }
    }

    /**
     * `normalizeMediaType()` was REMOVED from this class.
     *
     * It was an INDEPENDENT COPY of a function of the same name in
     * `utils/api-transforms.ts` — which is precisely why fixing that one did not
     * fix this one, and why `audiobook` had to be added twice. Both are now
     * `toUniversalMediaType()` / `toInternalMediaType()` in
     * `$lib/shared/media-type-domain`, which is the only implementation left.
     *
     * The old body was `isEpisode → 'episode'; isSeries → 'tv'; isAudiobook →
     * 'audiobook'; return 'movie'`. That trailing `'movie'` still swallowed
     * `season`, `track`, `album`, `artist`, `home_video`, `training`,
     * `educational`, `personal` and every storage-only type. The visible casualty
     * was audiobooks in the home Continue-Watching rail: `mediaType: 'movie'`
     * made `UniversalMediaCard` request backdrop art an audiobook does not have
     * (→ 302 → popcorn placeholder), gave the modal URL a `slug=movie-…`, and
     * made `ModalMovie` render "Watch Movie" with no author/narrator/chapter
     * block — all three gates read `isAudiobook()` on THIS field.
     *
     * `toUniversalMediaType()` returns `null` for the types `UniversalMediaType`
     * cannot represent, and {@link transformToUniversalMedia} now returns `null`
     * in turn rather than minting a card the client would open as a movie.
     */
}

/**
 * Get or create the singleton MediaTransformerService instance
 */
let instance: MediaTransformerService | null = null;

export function getMediaTransformerService(): MediaTransformerService {
    if (!instance) {
        instance = new MediaTransformerService();
    }
    return instance;
}
