// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Universal Media ID Resolution Types
 *
 * Types for the media ID resolution system that accepts any ID format
 * (internal UUID, composite keys, and the legacy Jellyfin item id an older
 * client may still hold) and resolves it to the internal UUID.
 */

import type { ExternalIds } from '$lib/types/api-common.js';
import type { ParsedMediaTypeToken } from '$lib/server/utils/media-key-parser.js';

/**
 * Source of the ID in the resolution request. `'jellyfin'` means the input was
 * a legacy Jellyfin item id mapped through `external_ids` (a database lookup
 * only; nothing calls a Jellyfin server).
 */
export type IdSource = 'uuid' | 'jellyfin' | 'composite';

/**
 * Result of resolving any media ID format to all available ID types
 */
export interface ResolvedIds {
    /**
     * Internal UUID (from media_items.id). null only for a TMDB composite key
     * that is not in the library yet (routes may fetch it from TMDB).
     */
    internalId: string | null;

    /**
     * All external IDs for this media (flat format: { tmdb: 'id', imdb: 'id' }).
     * undefined when the item is not in the library.
     */
    externalIds?: ExternalIds;

    /**
     * Which format was provided as input
     */
    source: IdSource;

    /**
     * Resolved media type (if known).
     *
     * Deliberately the parser's own token union rather than `'movie' | 'tv'`.
     * A composite key can name an episode or a season, and `resolveComposite`
     * puts that token straight in here — so narrowing to two values was a lie
     * the compiler could not catch, and a consumer writing
     * `mediaType === 'tv' ? seriesPath : moviePath` would silently send
     * episodes down the movie branch.
     *
     * Note it spans BOTH naming conventions (`'tv'` and `'series'`), because
     * the parser's runtime output does. Compare with the helpers in
     * `$lib/server/utils/media-types` (`isSeries`, `isEpisode`, …), which
     * accept either, rather than with a bare `===`.
     */
    mediaType?: ParsedMediaTypeToken;

    /**
     * True if canonical_id was followed (merged media redirect)
     */
    wasCanonicalized?: boolean;

    /**
     * Original input ID (for debugging/telemetry)
     */
    inputId?: string;
}

/**
 * Options for ID resolution
 */
export interface ResolveOptions {
    /**
     * Maximum hops to follow canonical_id chain (default: 5)
     */
    maxCanonicalHops?: number;

    /**
     * Whether to cache negative results (default: true, L1 only)
     */
    cacheNegative?: boolean;
}

/**
 * Resolution statistics for monitoring
 */
export interface ResolutionStats {
    totalResolutions: number;
    cacheHitRateL1: number;
    cacheHitRateL2: number;
    avgResolutionTimeMs: number;
    resolutionsBySource: {
        uuid: number;
        jellyfin: number;
        composite: number;
    };
    errors: {
        invalidFormat: number;
        notFound: number;
        timeout: number;
    };
}
