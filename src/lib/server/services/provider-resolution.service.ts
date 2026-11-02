// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider Resolution Service
 *
 * Resolves external IDs from various providers (IMDB, TVDB, etc.) to a target
 * provider's ID space.  The public-facing {@link ProviderResolutionService.resolveToTmdb}
 * method preserves its original signature and return shape; internally it delegates to
 * the provider-neutral {@link ProviderResolutionService.resolve} core.
 *
 * Supported lookups (tmdb target):
 * - TMDB → TMDB (passthrough)
 * - IMDB → TMDB (via TMDB /find endpoint, movies + TV)
 * - TVDB → TMDB (via TMDB /find endpoint, TV ONLY)
 *
 * NOT supported:
 * - TVDB → TMDB for movies (TMDB doesn't index movies by TVDB)
 * - MAL → TMDB (no direct mapping available)
 * - Trakt → TMDB (would need separate Trakt API)
 */

import type { ExternalIds } from '$lib/types/api-common';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { Logger } from '../utils/logger.js';
import { isMovie, isSeries } from '../../utils/media-types.js';
import { tmdbApi } from '../providers/implementations/tmdb/index.js';

const logger = Logger.for('ProviderResolution');

// =============================================================================
// Legacy types (kept verbatim — callers depend on these shapes)
// =============================================================================

export type ResolutionReason =
    | 'unsupported_provider'
    | 'not_found'
    | 'api_error'
    | 'api_unavailable'
    | 'no_valid_ids'
    | 'media_type_mismatch';

export interface ResolutionSuccess {
    success: true;
    tmdbId: number;
    /** Provider that was used for resolution */
    resolvedFrom: 'tmdb' | 'imdb' | 'tvdb';
}

export interface ResolutionFailure {
    success: false;
    error: string;
    reason: ResolutionReason;
}

export type ResolutionResult = ResolutionSuccess | ResolutionFailure;

// =============================================================================
// Provider-neutral types
// =============================================================================

/**
 * Describes the ID space a caller wants as the output of resolution.
 * Currently only `"tmdb"` is wired; new entries can be added to the
 * strategy registry without touching callers.
 */
export interface ResolutionTarget {
    idSpace: 'tmdb' | (string & Record<never, never>);
}

/**
 * Successful resolution — provider-neutral.
 * `numericId` is populated when the target provider uses integer IDs (e.g. TMDB).
 */
export interface ResolvedTarget {
    success: true;
    provider: string;
    id: string;
    numericId?: number;
    resolvedFrom: string;
}

export interface NeutralResolutionFailure {
    success: false;
    error: string;
    reason: ResolutionReason;
}

export type NeutralResolution = ResolvedTarget | NeutralResolutionFailure;

// =============================================================================
// Strategy registry
// =============================================================================

/**
 * A resolution strategy knows how to map arbitrary external IDs into a single
 * target ID space.  Register new strategies via {@link registerResolutionStrategy}.
 */
export interface ResolutionStrategy {
    readonly idSpace: string;
    resolve(externalIds: ExternalIds, mediaType: 'movie' | 'tv'): Promise<NeutralResolution>;
}

/**
 * Module-level registry keyed by {@link ResolutionStrategy.idSpace}.
 * Populated below with the built-in TMDB strategy.
 */
const strategyRegistry = new Map<string, ResolutionStrategy>();

/**
 * Register (or replace) a resolution strategy.
 * Call this before the first {@link ProviderResolutionService.resolve} invocation
 * for the target id-space.
 */
export function registerResolutionStrategy(strategy: ResolutionStrategy): void {
    strategyRegistry.set(strategy.idSpace, strategy);
}

// =============================================================================
// Built-in TMDB strategy  (verbatim body from the original resolveToTmdb)
// =============================================================================

const tmdbResolutionStrategy: ResolutionStrategy = {
    idSpace: 'tmdb',

    async resolve(externalIds: ExternalIds, mediaType: 'movie' | 'tv'): Promise<NeutralResolution> {
        // Check if TMDB API is available before attempting resolution
        if (!tmdbApi.isAvailable()) {
            return {
                success: false,
                error: 'TMDB API is not configured or unavailable',
                reason: 'api_unavailable',
            };
        }

        // 1. TMDB passthrough (most common case)
        // Jellyseerr requires TMDB ID - use explicit provider access
        const tmdbIdStr = getExternalIdFor(externalIds, 'tmdb');
        if (tmdbIdStr) {
            const tmdbId = parseInt(tmdbIdStr, 10);
            if (!isNaN(tmdbId) && tmdbId > 0) {
                return {
                    success: true,
                    provider: 'tmdb',
                    id: tmdbIdStr,
                    numericId: tmdbId,
                    resolvedFrom: 'tmdb',
                };
            }
        }

        // 2. IMDB → TMDB resolution
        const imdbId = getExternalIdFor(externalIds, 'imdb');
        if (imdbId) {
            // Validate IMDB ID format (tt followed by digits)
            if (!/^tt\d+$/.test(imdbId)) {
                logger.warn('Invalid IMDB ID format', { imdbId });
            } else {
                try {
                    const tmdbId = await tmdbApi.resolveImdbToTmdb(imdbId, mediaType);
                    if (tmdbId) {
                        logger.debug('Resolved IMDB to TMDB', {
                            imdbId,
                            tmdbId,
                            mediaType,
                        });
                        return {
                            success: true,
                            provider: 'tmdb',
                            id: String(tmdbId),
                            numericId: tmdbId,
                            resolvedFrom: 'imdb',
                        };
                    }
                    logger.debug('IMDB ID not found in TMDB', {
                        imdbId,
                        mediaType,
                    });
                } catch (error) {
                    logger.error('IMDB resolution failed', error as Error, {
                        imdbId,
                    });
                    return {
                        success: false,
                        error: `Failed to resolve IMDB ID: ${(error as Error).message}`,
                        reason: 'api_error',
                    };
                }
            }
        }

        // 3. TVDB → TMDB resolution (TV only)
        const tvdbId = getExternalIdFor(externalIds, 'tvdb');
        if (tvdbId) {
            // TMDB only indexes TV shows by TVDB, not movies
            if (isMovie(mediaType)) {
                logger.debug('TVDB not supported for movies', { tvdbId });
                // Don't return error here - try other providers or fail at end
            } else {
                try {
                    const resolvedTmdbId = await tmdbApi.resolveTvdbToTmdb(tvdbId);
                    if (resolvedTmdbId) {
                        logger.debug('Resolved TVDB to TMDB', {
                            tvdbId,
                            tmdbId: resolvedTmdbId,
                        });
                        return {
                            success: true,
                            provider: 'tmdb',
                            id: String(resolvedTmdbId),
                            numericId: resolvedTmdbId,
                            resolvedFrom: 'tvdb',
                        };
                    }
                    logger.debug('TVDB ID not found in TMDB', { tvdbId });
                } catch (error) {
                    logger.error('TVDB resolution failed', error as Error, {
                        tvdbId,
                    });
                    return {
                        success: false,
                        error: `Failed to resolve TVDB ID: ${(error as Error).message}`,
                        reason: 'api_error',
                    };
                }
            }
        }

        // 4. Unsupported providers (MAL, Trakt)
        const malId = getExternalIdFor(externalIds, 'mal');
        const traktId = getExternalIdFor(externalIds, 'trakt');
        const hasOnlyUnsupportedIds = malId || traktId;

        if (hasOnlyUnsupportedIds) {
            const providers = [];
            if (malId) providers.push('MAL');
            if (traktId) providers.push('Trakt');

            return {
                success: false,
                error: `Cannot resolve ${providers.join(', ')} IDs to TMDB`,
                reason: 'unsupported_provider',
            };
        }

        // 5. No valid IDs found
        return {
            success: false,
            error: 'No resolvable external IDs found',
            reason: 'not_found',
        };
    },
};

registerResolutionStrategy(tmdbResolutionStrategy);

// =============================================================================
// Service
// =============================================================================

export class ProviderResolutionService {
    /**
     * Provider-neutral resolution core.
     *
     * Dispatches to the strategy registered for `target.idSpace`.  Returns a
     * {@link NeutralResolution} so callers that need a target other than TMDB
     * can wire a new strategy without modifying this service.
     *
     * @param externalIds - External IDs object from media item
     * @param mediaType   - Expected media type (movie or tv)
     * @param target      - Desired output ID space
     */
    async resolve(
        externalIds: ExternalIds | undefined,
        mediaType: 'movie' | 'tv',
        target: ResolutionTarget,
    ): Promise<NeutralResolution> {
        if (!externalIds) {
            return {
                success: false,
                error: 'No external IDs provided',
                reason: 'no_valid_ids',
            };
        }

        const strategy = strategyRegistry.get(target.idSpace);
        if (!strategy) {
            return {
                success: false,
                error: `No resolution strategy registered for id-space "${target.idSpace}"`,
                reason: 'unsupported_provider',
            };
        }

        return strategy.resolve(externalIds, mediaType);
    }

    /**
     * Resolve any external ID to TMDB ID.
     * REQUIRED for all Jellyseerr requests.
     *
     * Resolution priority:
     * 1. TMDB (passthrough)
     * 2. IMDB (via TMDB /find endpoint)
     * 3. TVDB (via TMDB /find endpoint, TV only)
     *
     * @param externalIds - External IDs object from media item
     * @param mediaType - Expected media type (movie or tv)
     * @returns Resolution result with TMDB ID or error
     */
    async resolveToTmdb(
        externalIds: ExternalIds | undefined,
        mediaType: 'movie' | 'tv',
    ): Promise<ResolutionResult> {
        const neutral = await this.resolve(externalIds, mediaType, { idSpace: 'tmdb' });

        if (!neutral.success) {
            return neutral;
        }

        // Map neutral result back to the legacy ResolutionSuccess shape.
        // numericId is always present for the tmdb strategy.
        return {
            success: true,
            tmdbId: neutral.numericId as number,
            resolvedFrom: neutral.resolvedFrom as ResolutionSuccess['resolvedFrom'],
        };
    }

    /**
     * Check if externalIds can potentially be resolved to TMDB
     * This is a quick check without making API calls.
     *
     * @param externalIds - External IDs object
     * @param mediaType - Expected media type
     * @returns True if resolution might succeed
     */
    canResolve(externalIds: ExternalIds | undefined, mediaType: 'movie' | 'tv'): boolean {
        if (!externalIds) return false;

        // TMDB always works
        if (getExternalIdFor(externalIds, 'tmdb')) return true;

        // IMDB works for both movies and TV
        if (getExternalIdFor(externalIds, 'imdb')) return true;

        // TVDB only works for TV
        if (getExternalIdFor(externalIds, 'tvdb') && isSeries(mediaType)) return true;

        return false;
    }

    /**
     * Get TMDB ID from externalIds without API calls.
     * Only returns if TMDB ID is directly available.
     *
     * @param externalIds - External IDs object
     * @returns TMDB ID or undefined
     */
    getTmdbIdDirect(externalIds: ExternalIds | undefined): number | undefined {
        // Jellyseerr requires TMDB ID - use explicit provider access
        const tmdbIdStr = getExternalIdFor(externalIds, 'tmdb');
        if (!tmdbIdStr) return undefined;
        const tmdbId = parseInt(tmdbIdStr, 10);
        return isNaN(tmdbId) ? undefined : tmdbId;
    }
}

// Export singleton instance
export const providerResolutionService = new ProviderResolutionService();
