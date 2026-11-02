// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holiday Plugin Service
 *
 * Main orchestrator for the holiday recommendation system.
 * Handles:
 * - Holiday detection based on current date
 * - Content discovery from multiple sources
 * - Content validation and scoring
 * - Jellyfin availability enrichment
 * - AI personalization (optional)
 * - Caching
 */

import type {
    HolidayConfig,
    HolidayRecommendation,
    HolidayApiResponse,
    DiscoveredItem,
    HolidayPluginSettings,
} from './types';
import {
    getHolidayConfig,
    getHolidays,
    getHolidayById,
    getHolidaySettings,
    initHolidayConfig,
    reloadConfig,
} from './config-loader';
import { getSourceAdapter } from './sources';
import {
    ExternalIdMap,
    ExternalIdSet,
    type ExternalIdMediaType,
} from '$lib/server/utils/tmdb-composite-key';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { Logger } from '$lib/server/utils/logger';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { getExternalIdFor } from '$lib/utils/external-ids';
import { isMovie, isSeries } from '$lib/server/utils/media-types';
import { calculateCosineSimilarity } from '$lib/server/utils/suggestion-utils.js';
import { getDb } from '$lib/server/database/connection.js';
import { features } from '$lib/server/config.js';
import {
    getAccessibleMediaByTmdbIds,
    getMediaByTmdbKeyword,
} from '$lib/server/database/queries/browse.queries.js';
import {
    scopedCacheKey,
    searchAccessBoundary,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context.js';
import { createHash } from 'node:crypto';

const logger = Logger.for('HolidayPlugin');

// ============================================================================
// Initialize Plugin
// ============================================================================

let initialized = false;

/**
 * Initialize the holiday plugin. Idempotent; config loading is synchronous,
 * so a failure is logged and retried on the next call instead of surfacing
 * as an unhandled rejection.
 */
export function initHolidayPlugin(): void {
    if (initialized) return;
    try {
        initHolidayConfig();
        initialized = true;
        logger.info('Holiday plugin initialized');
    } catch (error) {
        logger.error('Failed to initialize holiday plugin', error as Error);
    }
}

// ============================================================================
// Localization Helpers
// ============================================================================

/**
 * Get the localized name for a holiday or pre-holiday config.
 * Falls back through: localizedNames[locale] -> name (primary)
 * @param config - Holiday or pre-holiday configuration
 * @param locale - Optional locale code (e.g., 'de', 'fr')
 * @returns The resolved name string
 */
function getLocalizedName(
    config: { name: string; localizedNames?: Record<string, string> },
    locale?: string,
): string {
    // Try localizedNames first
    if (locale && config.localizedNames?.[locale]) {
        return config.localizedNames[locale];
    }

    // Default to primary name
    return config.name;
}

// ============================================================================
// Holiday Detection
// ============================================================================

/**
 * Check if a date falls within a holiday range
 * Handles year-wrapping holidays (e.g., New Year's)
 */
function isDateInRange(
    date: Date,
    startMonth: number,
    startDay: number,
    endMonth: number,
    endDay: number,
): boolean {
    const month = date.getMonth() + 1;
    const day = date.getDate();

    // Handle year-wrapping holidays (e.g., New Year's Dec 28 - Jan 7)
    if (startMonth > endMonth) {
        const inStartRange = month > startMonth || (month === startMonth && day >= startDay);
        const inEndRange = month < endMonth || (month === endMonth && day <= endDay);
        return inStartRange || inEndRange;
    }

    // Normal case: within same year
    const afterStart = month > startMonth || (month === startMonth && day >= startDay);
    const beforeEnd = month < endMonth || (month === endMonth && day <= endDay);
    return afterStart && beforeEnd;
}

/**
 * Get the current active holiday (if any)
 */
export function getCurrentHoliday(date: Date = new Date()): HolidayConfig | null {
    const holidays = getHolidays();

    // Find all active holidays and sort by priority
    const activeHolidays = holidays
        .filter((h) => h.enabled !== false)
        .filter((h) => isDateInRange(date, h.startMonth, h.startDay, h.endMonth, h.endDay))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    if (activeHolidays.length === 0) {
        return null;
    }

    const holiday = activeHolidays[0];

    // Check for pre-holiday variant
    if (holiday.preHoliday) {
        const inPreHoliday = isDateInRange(
            date,
            holiday.preHoliday.startMonth,
            holiday.preHoliday.startDay,
            holiday.preHoliday.endMonth,
            holiday.preHoliday.endDay,
        );

        if (inPreHoliday) {
            return {
                ...holiday,
                name: holiday.preHoliday.name,
                localizedNames: holiday.preHoliday.localizedNames,
                emoji: holiday.preHoliday.emoji,
            };
        }
    }

    return holiday;
}

/**
 * Get all defined holidays
 */
export function getAllHolidays(): HolidayConfig[] {
    return getHolidays();
}

// ============================================================================
// Content Validation
// ============================================================================

/**
 * Validate content against holiday validation rules
 */
function validateContent(item: DiscoveredItem, holiday: HolidayConfig): boolean {
    const validation = holiday.validation;
    if (!validation) {
        return true; // No validation rules
    }

    // Skip validation for featured content if configured
    if (validation.skipForFeatured && item.isFeatured) {
        return true;
    }

    const title = (item.title || '').toLowerCase();
    const overview = (item.overview || '').toLowerCase();
    const combined = `${title} ${overview}`;

    // Check required terms
    if (validation.requiredTerms?.length) {
        const hasRequiredTerm = validation.requiredTerms.some((term) =>
            combined.includes(term.toLowerCase()),
        );
        if (!hasRequiredTerm) {
            return false;
        }
    }

    // Check excluded terms
    if (validation.excludeTerms?.length) {
        const hasExcludedTerm = validation.excludeTerms.some((term) =>
            combined.includes(term.toLowerCase()),
        );
        if (hasExcludedTerm) {
            return false;
        }
    }

    return true;
}

// ============================================================================
// Content Scoring
// ============================================================================

/**
 * Calculate a score for content item for ranking
 * Returns a bounded, valid number (never NaN or Infinity)
 */
function calculateScore(item: DiscoveredItem): number {
    // Clamp values to sensible ranges to avoid NaN/Infinity
    const popularity = Math.max(0.1, Math.min(item.popularity ?? 1, 10000));
    const rating = Math.max(0, Math.min(item.voteAverage ?? 5, 10));
    const voteCount = Math.max(0, Math.min(item.voteCount ?? 1, 1000000));
    const boostFactor = Math.max(0.1, Math.min(item.boostFactor ?? 1, 100));

    // Vote confidence: higher vote counts are more trustworthy
    const voteConfidence = Math.log10(Math.max(voteCount, 1) + 1) / 3;

    // Recency boost
    let recencyBoost = 1;
    if (item.isNewRelease) {
        recencyBoost = 2.5;
    } else if (item.isFromCollection) {
        recencyBoost = 1.5;
    }

    const score = boostFactor * popularity * rating * recencyBoost * (0.5 + voteConfidence);

    // Final safety check
    return Number.isFinite(score) ? score : 0;
}

// ============================================================================
// Content Discovery
// ============================================================================

interface DbDiscoveryContext {
    sql: NonNullable<ReturnType<typeof getDb>>;
    accessCtx: SearchAccessContext;
}

/**
 * Query the local library for items matching any of the given TMDB keyword IDs.
 * Deduplicates by TMDB ID across keyword results.
 */
async function discoverByKeywordsFromDb(
    dbCtx: DbDiscoveryContext,
    keywordIds: number[],
    holiday: HolidayConfig,
    limit: number,
): Promise<DiscoveredItem[]> {
    const { sql, accessCtx } = dbCtx;
    const seen = new ExternalIdSet();
    const results: DiscoveredItem[] = [];

    const rows = (
        await Promise.all(
            keywordIds.map((keywordId) =>
                getMediaByTmdbKeyword(sql, keywordId, {
                    mediaType: 'all',
                    limit,
                    access: searchAccessBoundary(accessCtx),
                }).catch((err) => {
                    logger.warn(
                        'DB keyword query failed',
                        { keywordId, holidayId: holiday.id },
                        err as Error,
                    );
                    return [] as Awaited<ReturnType<typeof getMediaByTmdbKeyword>>;
                }),
            ),
        )
    ).flat();

    for (const row of rows) {
        if (row.tmdb_id === null) continue;
        const mediaType = isMovie(row.media_type) ? 'movie' : 'tv';
        if (seen.has(row.tmdb_id, mediaType)) continue;
        seen.add(row.tmdb_id, mediaType);
        results.push({
            id: row.tmdb_id,
            internalId: row.internal_id,
            mediaType,
            title: row.title,
            overview: row.overview ?? undefined,
            posterPath: row.poster_path ?? undefined,
            backdropPath: row.backdrop_path ?? undefined,
            releaseDate: row.year != null ? String(row.year) : undefined,
            // Unknown signals stay undefined so calculateScore applies its
            // neutral defaults — 0 here zeroed the score and sank every owned
            // title below the TMDB candidates.
            popularity: row.popularity ?? undefined,
            voteAverage: row.rating ?? undefined,
            genreIds: [],
            source: 'library',
        });
    }

    logger.debug('DB keyword discovery complete', {
        holidayId: holiday.id,
        keywords: keywordIds.length,
        found: results.length,
    });

    return results;
}

const inFlightDiscoveries = new Map<string, Promise<DiscoveredItem[]>>();

/** TTL for results built while a source or the library lookup was failing. */
const DEGRADED_TTL_MS = 60 * 1000;

/**
 * Fixed size of the shared (user-independent) candidate pool. Every request
 * limit slices from the same pool, so varying `?limit=` can't multiply the
 * TMDB fan-out or the cache entries.
 */
const SHARED_DISCOVERY_LIMIT = 200;

/**
 * Run a source adapter's discovery through a global (user-independent) cache
 * with in-process single-flight: the TMDB/MDBList candidate set is identical
 * for every user, so N users on a cold cache must not mean N full fan-outs.
 *
 * Adapters swallow their own errors and return `[]`, so an empty result is
 * cached only briefly (DEGRADED_TTL_MS) — one TMDB blip must not blank the
 * shelf for every user for the whole TTL, nor be retried on every request.
 * `bypassCache` (an allowed refresh) skips the read only.
 */
function discoverShared(
    sourceConfig: HolidayConfig['sources'][number],
    holiday: HolidayConfig,
    bypassCache: boolean,
): Promise<DiscoveredItem[]> {
    const adapter = getSourceAdapter(sourceConfig.type);
    if (!adapter) return Promise.resolve([]);

    const configHash = createHash('sha1').update(JSON.stringify(sourceConfig)).digest('hex');
    const key = `v1:${holiday.id}:${sourceConfig.type}:${configHash.slice(0, 16)}`;
    const existing = inFlightDiscoveries.get(key);
    if (existing) return existing;

    const run = (async () => {
        const discoveryCache = cacheManager.for(CACHE_NAMESPACES.holidayDiscovery);
        if (!bypassCache) {
            const cached = await discoveryCache.get<{ items: DiscoveredItem[] }>(key);
            if (cached) return cached.items;
        }
        const items = await adapter.discover(sourceConfig, holiday, SHARED_DISCOVERY_LIMIT);
        const ttlMs =
            items.length > 0 ? getHolidaySettings().cacheTtlMinutes * 60 * 1000 : DEGRADED_TTL_MS;
        await discoveryCache.set(key, { items }, ttlMs);
        return items;
    })().finally(() => inFlightDiscoveries.delete(key));

    inFlightDiscoveries.set(key, run);
    return run;
}

/**
 * Discover content from all configured sources for a holiday
 * Sources are fetched in parallel for better performance
 */
async function discoverContent(
    holiday: HolidayConfig,
    limit: number,
    dbCtx: DbDiscoveryContext | undefined,
    bypassCache: boolean,
): Promise<{ items: DiscoveredItem[]; complete: boolean }> {
    // Prepare discovery tasks for available sources
    const discoveryTasks: Array<{
        sourceConfig: (typeof holiday.sources)[0];
        promise: Promise<DiscoveredItem[]>;
    }> = [];

    for (const sourceConfig of holiday.sources) {
        if (sourceConfig.type === 'tmdb' && dbCtx && sourceConfig.keywordIds?.length) {
            // Keyword discovery: query the local library instead of TMDB so
            // results are restricted to content the user already owns.
            discoveryTasks.push({
                sourceConfig,
                promise: discoverByKeywordsFromDb(
                    dbCtx,
                    sourceConfig.keywordIds,
                    holiday,
                    limit * 2,
                ),
            });

            // Continue running the TMDB adapter for the remaining strategies
            // (featured IDs, new-release discovery, collections, text-search
            // fallback) — those surfaces are intentionally discovery-oriented
            // and may return content the user does not yet own.
            const tmdbAdapter = getSourceAdapter('tmdb');
            if (tmdbAdapter?.isAvailable()) {
                const nonKeywordConfig = {
                    ...sourceConfig,
                    keywordIds: undefined,
                    includeNewReleases: false,
                };
                discoveryTasks.push({
                    sourceConfig: nonKeywordConfig,
                    promise: discoverShared(nonKeywordConfig, holiday, bypassCache),
                });
            }
            continue;
        }

        const adapter = getSourceAdapter(sourceConfig.type);
        if (!adapter) {
            logger.warn('Unknown source type', {
                type: sourceConfig.type,
                holidayId: holiday.id,
            });
            continue;
        }

        if (!adapter.isAvailable()) {
            logger.debug('Source not available', { type: sourceConfig.type });
            continue;
        }

        // Queue discovery task
        discoveryTasks.push({
            sourceConfig,
            promise: discoverShared(sourceConfig, holiday, bypassCache),
        });
    }

    // Run all discoveries in parallel
    const results = await Promise.allSettled(discoveryTasks.map((t) => t.promise));
    // A source that threw or came back empty (adapters swallow their errors)
    // makes the result incomplete; the caller caches it only briefly.
    const complete = results.every((r) => r.status === 'fulfilled' && r.value.length > 0);

    // Process results and deduplicate
    const allResults: DiscoveredItem[] = [];
    const seenIds = new ExternalIdSet();

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const sourceConfig = discoveryTasks[i].sourceConfig;

        if (result.status === 'rejected') {
            logger.error('Source discovery failed', result.reason as Error, {
                type: sourceConfig.type,
                holidayId: holiday.id,
            });
            continue;
        }

        // Deduplicate and validate
        for (const item of result.value) {
            if (seenIds.has(item.id, item.mediaType)) {
                continue;
            }

            if (!validateContent(item, holiday)) {
                continue;
            }

            seenIds.add(item.id, item.mediaType);
            allResults.push(item);
        }
    }

    // Sort by score
    allResults.sort((a, b) => calculateScore(b) - calculateScore(a));

    logger.debug('Content discovery complete', {
        holidayId: holiday.id,
        totalItems: allResults.length,
        sourcesQueried: discoveryTasks.length,
    });

    return { items: allResults, complete };
}

// ============================================================================
// TMDB Image Enrichment
// ============================================================================

/**
 * Enrich discovered items with TMDB poster/backdrop images
 * This is needed for items from sources that don't provide images (e.g., MDBList)
 */
async function enrichFromTmdbDetails(items: DiscoveredItem[]): Promise<DiscoveredItem[]> {
    if (!tmdbApi.isAvailable()) {
        logger.debug('TMDB API not available for image enrichment');
        return items;
    }

    // Only the overview survives to the client (posters are served by the
    // image proxy from the ids), so only items without one are worth a call.
    const itemsNeedingEnrichment = items.filter((item) => !item.overview);

    if (itemsNeedingEnrichment.length === 0) {
        return items;
    }

    // Limit enrichment to avoid overwhelming the TMDB API
    const MAX_ENRICHMENT_ITEMS = 30;
    const BATCH_SIZE = 10;
    const toEnrich = itemsNeedingEnrichment.slice(0, MAX_ENRICHMENT_ITEMS);

    logger.debug('Enriching items with TMDB images', {
        needed: itemsNeedingEnrichment.length,
        enriching: toEnrich.length,
    });

    // Process in batches to avoid overwhelming the API
    const allEnrichments: Array<{
        id: number;
        mediaType: 'movie' | 'tv';
        posterPath?: string;
        backdropPath?: string;
        overview?: string;
    } | null> = [];

    for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
        const batch = toEnrich.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
            batch.map(async (item) => {
                try {
                    if (isMovie(item.mediaType)) {
                        const details = await tmdbApi.getMovieDetails(item.id);
                        if (details) {
                            return {
                                id: item.id,
                                mediaType: item.mediaType,
                                posterPath: details.poster_path,
                                backdropPath: details.backdrop_path,
                                overview: details.overview,
                            };
                        }
                    } else if (isSeries(item.mediaType)) {
                        const details = await tmdbApi.getTVShowDetails(item.id);
                        if (details) {
                            return {
                                id: item.id,
                                mediaType: item.mediaType,
                                posterPath: details.poster_path,
                                backdropPath: details.backdrop_path,
                                overview: details.overview,
                            };
                        }
                    }
                } catch {
                    logger.debug('Failed to enrich item', {
                        id: item.id,
                        mediaType: item.mediaType,
                    });
                }
                return null;
            }),
        );
        allEnrichments.push(...batchResults);
    }

    const enrichments = allEnrichments;

    // Build a lookup map for enrichments
    const enrichmentMap = new ExternalIdMap<{
        posterPath?: string;
        backdropPath?: string;
        overview?: string;
    }>();

    let successCount = 0;
    for (const enrichment of enrichments) {
        if (enrichment) {
            successCount++;
            enrichmentMap.set(enrichment.id, enrichment.mediaType, {
                posterPath: enrichment.posterPath,
                backdropPath: enrichment.backdropPath,
                overview: enrichment.overview,
            });
        }
    }

    // Log warning if significant portion failed
    const failedCount = toEnrich.length - successCount;
    if (failedCount > 0) {
        const failureRate = failedCount / toEnrich.length;
        if (failureRate > 0.5) {
            logger.warn('High TMDB enrichment failure rate', {
                failed: failedCount,
                total: toEnrich.length,
                rate: `${Math.round(failureRate * 100)}%`,
            });
        } else {
            logger.debug('Some TMDB enrichments failed', {
                failed: failedCount,
                total: toEnrich.length,
            });
        }
    }

    // Apply enrichments to items
    return items.map((item) => {
        const enrichment = enrichmentMap.get(item.id, item.mediaType);
        if (enrichment) {
            return {
                ...item,
                posterPath: item.posterPath || enrichment.posterPath,
                backdropPath: item.backdropPath || enrichment.backdropPath,
                overview: item.overview || enrichment.overview,
            };
        }
        return item;
    });
}

// ============================================================================
// Library Availability
// ============================================================================

interface LibraryMatch {
    internal: string;
}

/**
 * Resolve TMDB-discovered candidates to library items THIS caller may play
 * (library groups + age rating + has_files). Matching is by TMDB id only: the
 * old title fallback stripped non-Latin titles to '' and collided remakes,
 * marking unrelated items available. No access context or DB ⇒ nothing is
 * claimed available.
 */
async function resolveLibraryMatches(
    items: DiscoveredItem[],
    access: SearchAccessContext | null,
): Promise<{ matches: ExternalIdMap<LibraryMatch>; degraded: boolean }> {
    const matches = new ExternalIdMap<LibraryMatch>();
    const pairs = items
        .filter((item) => item.source !== 'library')
        .map((item) => ({
            tmdbId: item.id,
            mediaType: (isMovie(item.mediaType) ? 'movie' : 'tv') as ExternalIdMediaType,
        }));
    const sql = getDb();
    if (!access || !sql || pairs.length === 0) return { matches, degraded: false };

    try {
        const rows = await getAccessibleMediaByTmdbIds(sql, pairs, searchAccessBoundary(access));
        for (const row of rows) {
            const tmdbId = Number.parseInt(row.tmdb_id, 10);
            if (Number.isNaN(tmdbId)) continue;
            matches.set(tmdbId, row.media_type, { internal: row.media_id });
        }
    } catch (error) {
        // Owned titles would show as "Request": serve it, but don't cache it.
        logger.warn('Failed to resolve holiday library matches', {}, error as Error);
        return { matches, degraded: true };
    }
    return { matches, degraded: false };
}

function finiteOr(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Enrich discovered items with per-user library availability
 */
async function enrichWithAvailability(
    items: DiscoveredItem[],
    holiday: HolidayConfig,
    access: SearchAccessContext | null,
): Promise<{ items: HolidayRecommendation[]; degraded: boolean }> {
    const { matches, degraded } = await resolveLibraryMatches(items, access);

    const enriched = items.map((item): HolidayRecommendation => {
        const mediaType: ExternalIdMediaType = isMovie(item.mediaType) ? 'movie' : 'tv';
        // Library-sourced rows were found through the caller's access boundary
        // (has_files enforced by the query), so they are available as-is.
        const match: LibraryMatch | undefined =
            item.source === 'library' && item.internalId
                ? { internal: item.internalId }
                : matches.get(item.id, mediaType);
        const isAvailable = !!match;

        // Keys are only ever set to strings: a present-but-undefined value
        // failed the endpoint's schema and 500'd Home (2026-10-02).
        const externalIds: HolidayRecommendation['externalIds'] = match
            ? {
                  tmdb: String(item.id),
                  internal: match.internal,
              }
            : { tmdb: String(item.id) };

        return {
            externalIds,
            mediaType: item.mediaType,
            title: item.title,
            overview: item.overview || '',
            genres: item.genreIds || [],
            rating: finiteOr(item.voteAverage, 0),
            criticRating: undefined,
            posterPath: item.posterPath,
            backdropPath: item.backdropPath,
            releaseDate: item.releaseDate,
            popularity: finiteOr(item.popularity, 0),
            aiSuggestion: false,
            holidayThemed: true,
            holidayId: holiday.id,
            holidayName: getLocalizedName(holiday),
            isAvailable,
            canRequest: !isAvailable,
            availabilitySource: isAvailable ? 'lumastra' : 'tmdb',
            isNewRelease: item.isNewRelease,
            isFeatured: item.isFeatured,
        };
    });
    return { items: enriched, degraded };
}

// ============================================================================
// AI Enhancement (Optional)
// ============================================================================

/**
 * Enhance recommendations with AI personalization
 */
async function enhanceWithAI(
    items: HolidayRecommendation[],
    username: string,
): Promise<HolidayRecommendation[]> {
    const settings = getHolidaySettings();
    if (!settings.enableAiPersonalization) {
        return items;
    }

    try {
        const { testDbConnection, Database, getDb } = await import('$lib/server/database');
        const { resolveExternalIdToUuid } =
            await import('$lib/server/database/queries/media-lookup.queries.js');
        const { getUserIdByUsername } =
            await import('$lib/server/database/queries/users.queries.js');

        const aiHealthy = await testDbConnection();
        if (!aiHealthy) {
            return items;
        }

        // user_profiles.user_id is the users.id UUID (mig 16.46.0); resolve the
        // login handle. No local user ⇒ skip AI personalization.
        const sql = getDb();
        const userId = sql ? await getUserIdByUsername(sql, username) : null;
        if (!userId) {
            return items;
        }

        const db = new Database();
        const userProfile = await db.getUserProfile(userId);

        if (!userProfile?.catalog_embedding && !userProfile?.request_embedding) {
            return items;
        }

        const scoreItem = async (
            item: HolidayRecommendation,
        ): Promise<HolidayRecommendation & { aiScore: number }> => {
            try {
                const mediaType = isSeries(item.mediaType) ? 'tv' : 'movie';
                const extIdStr = getExternalIdFor(item.externalIds, 'tmdb');
                if (!extIdStr) {
                    return { ...item, aiScore: 0 };
                }

                const sql = getDb();
                if (!sql) {
                    return { ...item, aiScore: 0 };
                }
                const mediaUuid = await resolveExternalIdToUuid(sql, extIdStr, mediaType);
                if (!mediaUuid) {
                    return { ...item, aiScore: 0 };
                }

                const media = await db.getMediaEmbeddingByUuid(mediaUuid);

                if (!media) {
                    return { ...item, aiScore: 0 };
                }

                let similarity = 0;
                if (media.library_embedding && userProfile.catalog_embedding) {
                    similarity = calculateCosineSimilarity(
                        userProfile.catalog_embedding,
                        media.library_embedding,
                    );
                } else if (media.discovery_embedding && userProfile.request_embedding) {
                    similarity = calculateCosineSimilarity(
                        userProfile.request_embedding,
                        media.discovery_embedding,
                    );
                }

                return {
                    ...item,
                    aiScore: similarity,
                    aiSuggestion: similarity > 0.5,
                };
            } catch (e) {
                logger.debug('AI scoring failed for holiday item, using score 0', {
                    title: item.title,
                    error: e,
                });
                return { ...item, aiScore: 0 };
            }
        };

        // Two DB round trips per item: score in bounded batches instead of
        // firing every item at once (limit=100 ⇒ ~400 concurrent queries).
        const AI_BATCH_SIZE = 10;
        const itemsWithScores: Array<HolidayRecommendation & { aiScore: number }> = [];
        for (let i = 0; i < items.length; i += AI_BATCH_SIZE) {
            itemsWithScores.push(
                ...(await Promise.all(items.slice(i, i + AI_BATCH_SIZE).map(scoreItem))),
            );
        }

        // Sort by AI score
        itemsWithScores.sort((a, b) => {
            if (Math.abs((a.aiScore || 0) - (b.aiScore || 0)) > 0.1) {
                return (b.aiScore || 0) - (a.aiScore || 0);
            }
            return (b.popularity || 0) - (a.popularity || 0);
        });

        return itemsWithScores;
    } catch (error) {
        logger.warn('AI enhancement failed', {}, error as Error);
        return items;
    }
}

// ============================================================================
// Main API
// ============================================================================

/** Boundary-less callers (no DB / plugin surface) get their own key space. */
const NO_ACCESS_CTX: SearchAccessContext = {
    username: null,
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: true,
};

/** A refresh younger than this serves the cached result instead of rediscovering. */
const REFRESH_MIN_INTERVAL_MS = 60 * 1000;

/**
 * Get holiday recommendations for a user.
 *
 * `access` is the caller's library/age boundary. It scopes library discovery
 * and availability, so every caller (the endpoint and the editorial rail) must
 * pass the SAME boundary for a user — they share the per-user cache entry.
 * `null` (no DB / no user) yields TMDB-only results with nothing available.
 */
export async function getHolidayRecommendations(
    username: string,
    options: {
        limit?: number;
        refresh?: boolean;
        access: SearchAccessContext | null;
    },
): Promise<HolidayApiResponse> {
    // The admin setting is the one gate (DISABLE_HOLIDAY_RECOMMENDATIONS, off
    // by default). Checked before init so a disabled install never loads the
    // config or touches TMDB, whichever caller asks.
    if (!features.holidays) {
        return {
            active: false,
            holiday: null,
            items: [],
            cached: false,
            message: 'Holiday recommendations are disabled',
        };
    }

    // Ensure plugin is initialized
    if (!initialized) {
        initHolidayPlugin();
    }

    const settings = getHolidaySettings();

    // Check if plugin is enabled
    if (!settings.enabled) {
        return {
            active: false,
            holiday: null,
            items: [],
            cached: false,
            message: 'Holiday recommendations are disabled',
        };
    }

    // Check for active holiday
    const holiday = getCurrentHoliday();
    if (!holiday) {
        return {
            active: false,
            holiday: null,
            items: [],
            cached: false,
            message: 'No active holiday',
        };
    }

    const { access } = options;
    const limit = options.limit || settings.defaultLimit;
    const holidayCache = cacheManager.for(CACHE_NAMESPACES.holidayRecommendations);
    // Per-user entry, further keyed by access boundary + locale (holidayName is
    // localized) so callers with a different or no boundary never share it.
    // `v3`: items now carry `internal` ids and per-user availability; v2
    // entries came from the unscoped global availability map.
    const cacheKey = scopedCacheKey(
        `v3:${access ? 'scoped' : 'none'}:${holiday.id.replace(/[|:]/g, '_')}`,
        access ?? NO_ACCESS_CTX,
        [limit],
    );

    const cached = await holidayCache.get<{
        items: HolidayRecommendation[];
        holiday: HolidayConfig;
    }>(cacheKey, username);
    // `refresh` forces rediscovery, but at most once per interval per user
    // (keyed by user only, so varying `limit` can't dodge it) — it fans out
    // to TMDB and any authenticated user can send it.
    const refreshKey = 'v1:refresh-at';
    const lastRefresh = options.refresh
        ? await holidayCache.get<{ at: number }>(refreshKey, username)
        : null;
    const refreshAllowed =
        options.refresh === true &&
        (!lastRefresh || Date.now() - lastRefresh.at >= REFRESH_MIN_INTERVAL_MS);
    if (cached && !refreshAllowed) {
        return {
            active: true,
            holiday: cached.holiday,
            items: cached.items,
            cached: true,
        };
    }
    if (refreshAllowed) {
        await holidayCache.set(refreshKey, { at: Date.now() }, REFRESH_MIN_INTERVAL_MS, username);
    }

    // Library-backed keyword discovery needs the caller's boundary; without
    // it the TMDB adapter's live keyword discover is used instead.
    const sql = getDb();
    const dbCtx: DbDiscoveryContext | undefined =
        sql && access ? { sql, accessCtx: access } : undefined;

    // Discover content (score-sorted, deduplicated)
    const discovery = await discoverContent(holiday, limit, dbCtx, refreshAllowed);
    const discoveredItems = discovery.items;

    // Availability over the whole pool BEFORE truncating, so the
    // SHOW_UNAVAILABLE_MEDIA filter below can't empty a shelf whose owned
    // titles happened to rank below the cut.
    const availability = await enrichWithAvailability(discoveredItems, holiday, access);
    let recommendations = availability.items;

    // Discovery surfaces honour SHOW_UNAVAILABLE_MEDIA: when off, only items
    // the user can play are shown (same rule as Trending / For You / Search).
    if (access && !access.showUnavailableMedia) {
        recommendations = recommendations.filter((item) => item.isAvailable);
    }
    recommendations = recommendations.slice(0, limit * 2);

    // Apply AI personalization
    recommendations = await enhanceWithAI(recommendations, username);

    // Take final limit, then fill missing overviews (e.g. MDBList rows) for
    // only the items actually returned.
    const finalItems = await fillMissingOverviews(recommendations.slice(0, limit));

    // Configured TTL for a clean result; a degraded one (a source empty or
    // failing, or the library lookup failing) is kept only briefly so it is
    // neither pinned for the whole TTL nor recomputed on every request.
    const cacheTtlMs =
        discovery.complete && !availability.degraded
            ? settings.cacheTtlMinutes * 60 * 1000
            : DEGRADED_TTL_MS;
    await holidayCache.set(cacheKey, { items: finalItems, holiday }, cacheTtlMs, username);

    return {
        active: true,
        holiday,
        items: finalItems,
        cached: false,
    };
}

/**
 * Fill empty overviews from TMDB details for the final items only.
 */
async function fillMissingOverviews(
    items: HolidayRecommendation[],
): Promise<HolidayRecommendation[]> {
    if (!items.some((item) => !item.overview)) return items;
    const asDiscovered: DiscoveredItem[] = items.map((item) => ({
        id: Number(getExternalIdFor(item.externalIds, 'tmdb')),
        mediaType: item.mediaType,
        title: item.title,
        overview: item.overview || undefined,
        source: 'tmdb',
    }));
    const enriched = await enrichFromTmdbDetails(asDiscovered);
    return items.map((item, i) => ({ ...item, overview: enriched[i].overview || item.overview }));
}

// ============================================================================
// Exports
// ============================================================================

export {
    getHolidayConfig,
    getHolidays,
    getHolidayById,
    getHolidaySettings,
    reloadConfig as reloadHolidayConfig,
};

export type { HolidayConfig, HolidayRecommendation, HolidayApiResponse, HolidayPluginSettings };
