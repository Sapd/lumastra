// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB Metadata Sync
 *
 * Phase 1 of the new architecture: Data Collection
 *
 * This module ONLY fetches metadata from TMDB API and stores it in the database.
 * It does NOT generate embeddings - that's handled separately by the embedding generators.
 *
 * Key principle: Always use composite key (tmdb_id, media_type) since TMDB IDs are NOT unique across media types.
 */

import type postgres from 'postgres';
import { Database } from '../database/connection';
import {
    invokeProviderPopular,
    invokeProviderTopRated,
    invokeProviderTrending,
    invokeProviderDetail,
} from '../tasks/plugin-context.js';
import { Logger } from '../utils/logger';
import { isCliEntry } from '../utils/cli-entry.js';
import { isProviderAuthError } from '../providers/provider-auth-state.js';
import { BaseProgressGenerator, type GenerationProgress } from './embedding-utils';
import { upsertMediaMetadata } from '../database/queries/media-upsert';
import {
    upsertMediaTitles,
    type MediaTitleInput,
} from '../database/queries/media-titles.queries.js';
import { upsertMediaTranslations } from '../database/queries/media-translations.queries.js';
import { upsertCompletedRow } from '../database/queries/stage-state.queries.js';
import { collectTmdbTranslations } from '../services/tmdb-translations-collect.js';
import { config } from '../config.js';
import { effectiveAgeRatingCountry } from '../utils/age-rating-country.js';
import {
    CERTIFICATION_CHECKED_COUNTRY_KEY,
    pickTmdbCertification,
} from '../utils/tmdb-certification.js';
import {
    updateOriginalTitleByTmdbId,
    listOriginalTitleBackfillCandidates,
    listFreshDiscoveryDetailKeys,
    DISCOVERY_DETAIL_SYNCED_AT_KEY,
} from '../database/queries/ai-sync.queries.js';
import dotenv from 'dotenv';
import { isMovie, isSeries } from '../../utils/media-types.js';
import { getPrimaryExternalIdProvider } from '../utils/provider-config';
import {
    tmdbGenreIdsToSlugs,
    keywordNamesToSlugs,
    batchAggregateMetadata,
} from '../database/queries/metadata-aggregation.queries.js';
import { encodeDetailId } from '../providers/encode-id.js';
import type { ProviderCastMember, ProviderDetailResult } from '@sapd/lumastra-plugin-sdk';

dotenv.config({ quiet: true });

const logger = Logger.for('TMDBMetadataSync');

/** Compact structured cast member stored in `provider_metadata.cast`. */
export interface StructuredCastMember {
    name: string;
    character?: string;
    /** Provider person id (TMDB) → proxied headshot via /api/image/person/{id}. */
    person_id?: string;
    /**
     * Whether the provider has a headshot for this person; absent when the
     * provider did not say. Lets `/j` advertise a person image tag only when
     * there is an image to serve.
     */
    has_profile?: boolean;
}

/**
 * Reduce a provider-neutral cast list to the compact structured shape persisted
 * under `provider_metadata.cast` — top-billed first, capped, names required.
 * This shape powers the detail API's `actors[].character` and proxied
 * `actors[].profileUrl`. The one-off backfill that once shared this helper was
 * deleted on 2026-09-12 (fresh installs never need it); the sync ingest path is the
 * only caller now.
 */
export function buildStructuredCast(
    cast: readonly ProviderCastMember[] | undefined,
    limit = 20,
): StructuredCastMember[] {
    return (
        (cast ?? [])
            .filter(
                (c): c is ProviderCastMember & { name: string } =>
                    typeof c.name === 'string' && c.name !== '',
            )
            // Filter BEFORE the cap so nameless entries can't consume a slot and
            // silently undercount the list (a valid member ranked 21+ still lands).
            .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
            .slice(0, limit)
            .map((c) => ({
                name: c.name,
                character: c.character ?? undefined,
                person_id: c.personId ?? undefined,
                has_profile: c.profileUrl === undefined ? undefined : Boolean(c.profileUrl),
            }))
    );
}

/** Canonical `provider_metadata` fields that a raw TMDB detail does NOT expose
 *  under the keys the aggregator + detail read expect. Key names are the STORED
 *  (snake_case) canonical keys — matching what the discovery path's
 *  `upsertMediaMetadata` writes and what `aggregateFieldsWithPriority` reads. */
export interface CanonicalDetailFields {
    runtime_minutes?: number;
    cast?: StructuredCastMember[];
    actors?: string[];
    directors?: string[];
    producers?: string[];
    writers?: string[];
    trailer_url?: string;
    genre_slugs?: string[];
    /** Keyword NAMES. The raw TMDB detail carries `keywords` as an envelope
     *  object (`{keywords:[…]}` movie, `{results:[…]}` tv); the stored key must
     *  be a flat array or every `jsonb_array_length(metadata->'keywords')`
     *  predicate throws. */
    keywords?: string[];
    keyword_slugs?: string[];
    tmdb_keyword_ids?: number[];
}

/**
 * Reduce a provider-neutral `ProviderDetailResult` to the canonical
 * `provider_metadata` fields the aggregator + detail read consume — bridging
 * the raw-provider shape (`runtime`, `credits.cast`, `videos`, …) to the stored
 * keys (`runtime_minutes`, `cast` with `person_id`, `trailer_url`, `genre_slugs`,
 * …). Provider-agnostic: any provider's `detail()` result feeds this identically,
 * so the per-item refresh path and the discovery path produce the SAME stored
 * shape (the exact set the aggregator sources from the tmdb row —
 * `metadata-aggregation.queries.ts` FIELD_PRIORITY_DEFAULT). Only sets a key when
 * the source has data, so it can be spread as an OVERLAY over an existing
 * metadata blob without clobbering unrelated fields with `undefined`.
 */
export function buildCanonicalDetailFields(
    detail: ProviderDetailResult | null | undefined,
): CanonicalDetailFields {
    if (!detail) return {};
    const cast = buildStructuredCast(detail.cast);
    // Flat actor names for embeddings/search — top-billed, mirrors the discovery
    // path (top 10 of the structured list) so the two never drift.
    const actors = cast.slice(0, 10).map((c) => c.name);
    const fields: CanonicalDetailFields = {};
    if (typeof detail.runtime === 'number') fields.runtime_minutes = detail.runtime;
    if (cast.length > 0) fields.cast = cast;
    if (actors.length > 0) fields.actors = actors;
    if (detail.directors && detail.directors.length > 0) fields.directors = detail.directors;
    if (detail.producers && detail.producers.length > 0) fields.producers = detail.producers;
    if (detail.writers && detail.writers.length > 0) fields.writers = detail.writers;
    if (detail.trailerUrl) fields.trailer_url = detail.trailerUrl;
    if (detail.genreSlugs && detail.genreSlugs.length > 0) fields.genre_slugs = detail.genreSlugs;
    if (detail.keywordNames && detail.keywordNames.length > 0)
        fields.keywords = detail.keywordNames;
    if (detail.keywordSlugs && detail.keywordSlugs.length > 0) {
        fields.keyword_slugs = detail.keywordSlugs;
    }
    if (detail.rawKeywordIds && detail.rawKeywordIds.length > 0) {
        fields.tmdb_keyword_ids = detail.rawKeywordIds;
    }
    return fields;
}

// The TMDB-specific provider id used for detail() calls in this module.
// This module is explicitly TMDB-centric for its list-fetching phase; the
// detail enrichment calls go through the SDK so callers can intercept them
// in tests without reaching api.themoviedb.org directly.
const TMDB_PROVIDER_ID = 'tmdb-metadata-provider';

/**
 * Map an ExternalIdProvider key (e.g. 'tmdb') to the registered plugin/provider
 * ID used by invokeProviderDetail (e.g. 'tmdb-metadata-provider').
 * Falls back to the input value so unknown providers are passed through as-is.
 */
const EXTERNAL_ID_TO_PLUGIN_ID: Record<string, string> = {
    tmdb: 'tmdb-metadata-provider',
};

function externalIdToPluginId(externalId: string): string {
    return EXTERNAL_ID_TO_PLUGIN_ID[externalId] ?? externalId;
}

/**
 * Extract localized-title aliases from a TMDB `translations` append-to-response
 * block. `upsertMediaMetadata`'s Step 4 already persists primary/original/English
 * aliases from the same `originalTitle`/`englishTitle` values passed to it — this
 * only adds what that step can't know: the per-language translated titles.
 *
 * `ProviderDetailResult` doesn't declare a `translations` field (it's TMDB-raw,
 * not provider-neutral), but the TMDB provider's `detail()` spreads the raw TMDB
 * response alongside the neutral fields (see `buildProviderDetailResult` in
 * `providers/tmdb.ts`), so it's read here via an untyped cast — same pattern
 * already used elsewhere in this file for `original_title`/`original_name`.
 */
export function collectTmdbTranslationTitles(
    detail: ProviderDetailResult | null,
): MediaTitleInput[] {
    const raw = (detail ?? {}) as Record<string, unknown>;
    const titles: MediaTitleInput[] = [];

    const translationsRaw = raw['translations'];
    const translations =
        translationsRaw &&
        typeof translationsRaw === 'object' &&
        Array.isArray((translationsRaw as { translations?: unknown }).translations)
            ? (
                  translationsRaw as {
                      translations: Array<{
                          iso_639_1?: unknown;
                          data?: { title?: unknown; name?: unknown };
                      }>;
                  }
              ).translations
            : [];

    for (const translation of translations) {
        const localized =
            typeof translation.data?.title === 'string'
                ? translation.data.title
                : typeof translation.data?.name === 'string'
                  ? translation.data.name
                  : null;
        if (!localized) continue;
        titles.push({
            title: localized,
            language: typeof translation.iso_639_1 === 'string' ? translation.iso_639_1 : null,
            kind: 'localized',
        });
    }

    return titles;
}

export interface TMDBMetadataSyncOptions {
    /** Maximum movies to fetch */
    maxMovies?: number;
    /** Maximum TV series to fetch */
    maxSeries?: number;
    /** Minimum TMDB rating */
    minRating?: number;
    /** Minimum vote count */
    minVotes?: number;
    /** Minimum popularity score */
    minPopularity?: number;
    /** Only sync items that don't exist in the database yet */
    missingOnly?: boolean;
    /** Fetch detailed info (credits, keywords) - slower but more complete */
    fetchDetails?: boolean;
    /**
     * How far to page the discovery lists. `'deep'` (default) pages every
     * source to its cap (~740 list requests per sweep); `'shallow'` pages only
     * the fronts of the lists that actually move — see SHALLOW_LIST_PAGES.
     */
    listDepth?: DiscoveryListDepth;
    /** Progress callback */
    onProgress?: (progress: GenerationProgress) => void;
    /** Abort callback */
    shouldAbort?: () => boolean;
    /**
     * Called with the internal media_item UUID after each item is successfully
     * upserted. Used by the task wrapper to write coverage-table rows per item
     * so the sweep path keeps `media_item_stage_state` up-to-date.
     * Non-fatal if it throws — the sweep continues regardless.
     */
    onSuccess?: (mediaItemId: string) => Promise<void>;
    /** Optional task-pool SQL handle. When provided, queries run on the task pool instead of the web pool. */
    sql?: postgres.Sql | null;
}

export interface TMDBMetadataSyncResult {
    success: boolean;
    total_fetched: number;
    total_movies: number;
    total_series: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
    message: string;
    /** Number of external TMDB HTTP requests made during this sync. */
    requestCount: number;
    /**
     * Message from the last per-item failure, if any. Lets callers distinguish
     * a rate-limit (429) or auth (invalid/missing API key) cause from a generic
     * outage in their own outage-detection guard, instead of only having a
     * bare error count.
     */
    lastErrorMessage?: string;
}

/**
 * Classify a `TMDBMetadataSyncResult.lastErrorMessage` for an outage-detection
 * guard, so callers can tell a self-healing rate limit or a bad/missing API
 * key apart from a generic outage. Both TMDB task wrappers (metadata-sync.ts,
 * tmdb-metadata-sync-task.ts) hit this same failure shape via TmdbApiError's
 * message text (client.ts): "TMDB API request failed: 429 ..." for rate
 * limits, "TMDB API key not configured" / "TMDB API key is invalid" for auth.
 */
export function classifyTmdbFailure(
    lastErrorMessage: string | undefined,
): 'rate-limit' | 'auth' | 'unknown' {
    if (!lastErrorMessage) return 'unknown';
    if (/\b429\b/.test(lastErrorMessage)) return 'rate-limit';
    if (/api key/i.test(lastErrorMessage)) return 'auth';
    return 'unknown';
}

/**
 * True for list-fetch errors that will repeat on every page: the TMDB provider
 * is not registered in this process, or its key is missing/rejected.
 * Exported for unit tests.
 */
export function isFatalTmdbFetchError(error: unknown): boolean {
    if (isProviderAuthError(error)) return true;
    const message = error instanceof Error ? error.message : String(error);
    if (/Provider not found in registry/i.test(message)) return true;
    return classifyTmdbFailure(message) === 'auth' || /\b401\b/.test(message);
}

/** Result of a TMDB list-fetch phase: the items plus the HTTP request count. */
interface TMDBFetchResult {
    items: TMDBItem[];
    requestCount: number;
}

interface TMDBItem {
    id: number;
    title?: string;
    name?: string;
    overview?: string;
    release_date?: string;
    first_air_date?: string;
    vote_average?: number;
    vote_count?: number;
    popularity?: number;
    genre_ids?: number[];
    original_language?: string;
    original_title?: string;
    original_name?: string;
    adult?: boolean;
    runtime?: number;
}

interface ExistingEntry {
    tmdb_id: string;
    media_type: 'movie' | 'tv';
}

export type DiscoveryListDepth = 'deep' | 'shallow';

/**
 * Pages per source on a shallow sweep. New and rising titles surface at the
 * front of popular and trending; the tail of popular and all of top-rated
 * barely move day to day, so those are only paged by the weekly deep sweep.
 * ~35 list requests per media type instead of ~370.
 */
export const SHALLOW_LIST_PAGES: Readonly<Record<'popular' | 'top-rated' | 'trending', number>> = {
    popular: 25,
    'top-rated': 0,
    trending: 10,
};

function pagesFor(
    source: keyof typeof SHALLOW_LIST_PAGES,
    deepPages: number,
    options: TMDBMetadataSyncOptions,
): number {
    return options.listDepth === 'shallow' ? SHALLOW_LIST_PAGES[source] : deepPages;
}

/**
 * Fetch movies from TMDB API
 */
async function fetchMoviesFromTMDB(
    options: TMDBMetadataSyncOptions,
    onProgress?: (status: string, fetchedCount?: number) => void,
    shouldAbort?: () => boolean,
): Promise<TMDBFetchResult> {
    const movies: TMDBItem[] = [];
    const maxMovies = options.maxMovies || 5000;
    const seenIds = new Set<number>();
    let requestCount = 0;

    // Fetch from multiple sources for diversity
    const sources = [
        {
            name: 'popular',
            fetcher: (page: number) =>
                invokeProviderPopular(TMDB_PROVIDER_ID, { mediaType: 'movie', page }).then(
                    (results) => ({ results }),
                ),
            maxPages: pagesFor('popular', 200, options),
        },
        {
            name: 'top-rated',
            fetcher: (page: number) =>
                invokeProviderTopRated(TMDB_PROVIDER_ID, { mediaType: 'movie', page }).then(
                    (results) => ({ results }),
                ),
            maxPages: pagesFor('top-rated', 150, options),
        },
        {
            name: 'trending',
            fetcher: (page: number) =>
                invokeProviderTrending(TMDB_PROVIDER_ID, {
                    mediaType: 'movie',
                    window: 'week',
                    page,
                }).then((results) => ({ results })),
            maxPages: pagesFor('trending', 100, options),
        },
    ];

    for (const source of sources) {
        if (movies.length >= maxMovies || shouldAbort?.()) break;

        logger.info(`Fetching ${source.name} movies`);

        for (let page = 1; page <= source.maxPages && movies.length < maxMovies; page++) {
            if (shouldAbort?.()) break;

            onProgress?.(
                `Fetching ${source.name} movies page ${page}/${source.maxPages} (${movies.length} found)`,
                movies.length,
            );

            try {
                requestCount++;
                const data = await source.fetcher(page);
                if (!data.results?.length) break;

                for (const movie of data.results) {
                    if (movies.length >= maxMovies) break;
                    const tmdbItem = movie as unknown as TMDBItem;
                    if (!tmdbItem.id || seenIds.has(tmdbItem.id)) continue;
                    if (!passesFilters(tmdbItem, options)) continue;

                    seenIds.add(tmdbItem.id);
                    movies.push(tmdbItem);
                }

                await new Promise((resolve) => setTimeout(resolve, 50)); // Rate limiting
            } catch (error) {
                // A missing provider or a rejected key fails EVERY page the
                // same way — say so once and stop, instead of one warning per
                // page (56x on a fresh install with a placeholder key).
                if (isFatalTmdbFetchError(error)) {
                    logger.warn(`TMDB unavailable — skipping the movies list fetch`, {
                        source: source.name,
                        error: (error as Error).message,
                    });
                    return { items: movies, requestCount };
                }
                logger.warn(`Failed to fetch ${source.name} movies page ${page}`, {
                    error: (error as Error).message,
                });
            }
        }
    }

    return { items: movies, requestCount };
}

/**
 * Fetch TV series from TMDB API
 */
async function fetchSeriesFromTMDB(
    options: TMDBMetadataSyncOptions,
    onProgress?: (status: string, fetchedCount?: number) => void,
    shouldAbort?: () => boolean,
): Promise<TMDBFetchResult> {
    const series: TMDBItem[] = [];
    const maxSeries = options.maxSeries || 5000;
    const seenIds = new Set<number>();
    let requestCount = 0;

    // Fetch from multiple sources
    const sources = [
        {
            name: 'popular',
            fetcher: (page: number) =>
                invokeProviderPopular(TMDB_PROVIDER_ID, { mediaType: 'tv', page }).then(
                    (results) => ({ results }),
                ),
            maxPages: pagesFor('popular', 200, options),
        },
        {
            name: 'top-rated',
            fetcher: (page: number) =>
                invokeProviderTopRated(TMDB_PROVIDER_ID, { mediaType: 'tv', page }).then(
                    (results) => ({ results }),
                ),
            maxPages: pagesFor('top-rated', 150, options),
        },
        {
            name: 'trending',
            fetcher: (page: number) =>
                invokeProviderTrending(TMDB_PROVIDER_ID, {
                    mediaType: 'tv',
                    window: 'week',
                    page,
                }).then((results) => ({ results })),
            maxPages: pagesFor('trending', 100, options),
        },
    ];

    for (const source of sources) {
        if (series.length >= maxSeries || shouldAbort?.()) break;

        logger.info(`Fetching ${source.name} TV series`);

        for (let page = 1; page <= source.maxPages && series.length < maxSeries; page++) {
            if (shouldAbort?.()) break;

            onProgress?.(
                `Fetching ${source.name} TV series page ${page}/${source.maxPages} (${series.length} found)`,
                series.length,
            );

            try {
                requestCount++;
                const data = await source.fetcher(page);
                if (!data.results?.length) break;

                for (const show of data.results) {
                    if (series.length >= maxSeries) break;
                    const tmdbItem = show as unknown as TMDBItem;
                    if (!tmdbItem.id || seenIds.has(tmdbItem.id)) continue;
                    if (!passesFilters(tmdbItem, options)) continue;

                    seenIds.add(tmdbItem.id);
                    series.push(tmdbItem);
                }

                await new Promise((resolve) => setTimeout(resolve, 50));
            } catch (error) {
                // A missing provider or a rejected key fails EVERY page the
                // same way — say so once and stop, instead of one warning per
                // page (56x on a fresh install with a placeholder key).
                if (isFatalTmdbFetchError(error)) {
                    logger.warn(`TMDB unavailable — skipping the TV series list fetch`, {
                        source: source.name,
                        error: (error as Error).message,
                    });
                    return { items: series, requestCount };
                }
                logger.warn(`Failed to fetch ${source.name} TV series page ${page}`, {
                    error: (error as Error).message,
                });
            }
        }
    }

    return { items: series, requestCount };
}

/**
 * Check if item passes quality filters
 */
function passesFilters(item: TMDBItem, options: TMDBMetadataSyncOptions): boolean {
    const minRating = options.minRating ?? 4.0;
    const minVotes = options.minVotes ?? 20;
    const minPopularity = options.minPopularity ?? 1;

    if ((item.vote_average ?? 0) < minRating) return false;
    if ((item.vote_count ?? 0) < minVotes) return false;
    if ((item.popularity ?? 0) < minPopularity) return false;

    return true;
}

/**
 * How long a discovery item's fetched details count as fresh. The sweep runs
 * daily, so a 14-day window re-fetches ~1/14 of the listed catalog per run.
 */
export const DISCOVERY_DETAIL_REFRESH_DAYS = 14;

/**
 * Sync TMDB metadata to database (no embedding generation)
 */
export async function syncTMDBMetadata(
    options: TMDBMetadataSyncOptions = {},
): Promise<TMDBMetadataSyncResult> {
    const {
        missingOnly = false,
        fetchDetails = true,
        onProgress,
        shouldAbort,
        onSuccess,
    } = options;

    logger.info('Starting TMDB metadata sync', {
        mode: missingOnly ? 'missing-only' : 'full',
        fetchDetails,
        listDepth: options.listDepth ?? 'deep',
        maxMovies: options.maxMovies,
        maxSeries: options.maxSeries,
    });

    const db = new Database(options.sql);
    const sql = db.getSql();

    const progress: GenerationProgress = {
        phase: 'fetching',
        totalItems: 0,
        processedItems: 0,
        currentSubStatus: 'Fetching content from TMDB...',
        errors: [],
        recentLogs: ['Starting TMDB metadata sync'],
        startTime: new Date(),
        created: 0,
        updated: 0,
        skipped: 0,
        errorCount: 0,
        progressPercentage: 0,
    };

    onProgress?.(progress);

    // Track fetched counts for progress display during fetch phase
    let moviesFetched = 0;
    let seriesFetched = 0;
    // Count every external TMDB HTTP request (list pages + per-item details).
    let requestCount = 0;

    try {
        // Phase 1: Fetch content from TMDB
        const moviesResult = await fetchMoviesFromTMDB(
            options,
            (status, fetchedCount) => {
                moviesFetched = fetchedCount || 0;
                progress.currentSubStatus = status;
                // Show fetched count as processedItems during fetch phase
                progress.processedItems = moviesFetched;
                progress.totalItems = options.maxMovies || 5000; // Show target as estimate
                onProgress?.(progress);
            },
            shouldAbort,
        );
        const movies = moviesResult.items;
        requestCount += moviesResult.requestCount;

        const seriesResult = await fetchSeriesFromTMDB(
            options,
            (status, fetchedCount) => {
                seriesFetched = fetchedCount || 0;
                progress.currentSubStatus = status;
                // Show total fetched (movies + series) during fetch phase
                progress.processedItems = moviesFetched + seriesFetched;
                progress.totalItems = (options.maxMovies || 5000) + (options.maxSeries || 5000);
                onProgress?.(progress);
            },
            shouldAbort,
        );
        const series = seriesResult.items;
        requestCount += seriesResult.requestCount;

        logger.info('Fetched content from TMDB', {
            movies: movies.length,
            series: series.length,
        });

        // Combine and prepare for sync
        const allItems: Array<TMDBItem & { mediaType: 'movie' | 'tv' }> = [
            ...movies.map((m) => ({ ...m, mediaType: 'movie' as const })),
            ...series.map((s) => ({ ...s, mediaType: 'tv' as const })),
        ];

        // Phase 2: Check existing entries if missingOnly
        let itemsToSync = allItems;
        if (missingOnly) {
            progress.phase = 'filtering';
            progress.currentSubStatus = 'Checking existing entries...';
            onProgress?.(progress);

            const keysToCheck = allItems.map((item) => ({
                tmdb_id: item.id,
                media_type: item.mediaType,
            }));

            // Query existing entries using composite key from UUID-based tables
            const existingEntries = await sql<ExistingEntry[]>`
        SELECT
            primary_ext.external_id AS tmdb_id,
            mi.media_type
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
        WHERE mi.status = 'active'
            AND (primary_ext.external_id, mi.media_type) IN (
                SELECT * FROM unnest(
                    ${keysToCheck.map((k) => String(k.tmdb_id))}::text[],
                    ${keysToCheck.map((k) => k.media_type)}::text[]
                )
            )
      `;

            const existingSet = new Set(existingEntries.map((e) => `${e.tmdb_id}:${e.media_type}`));

            itemsToSync = allItems.filter(
                (item) => !existingSet.has(`${item.id}:${item.mediaType}`),
            );

            logger.info('Items needing sync', {
                total: allItems.length,
                existing: existingSet.size,
                toSync: itemsToSync.length,
            });
        }

        // Phase 2b: skip items whose details this sweep fetched recently. The
        // discovery lists barely move between runs, so re-fetching every
        // item's details each sweep cost ~9k TMDB requests per run (twice a
        // day, back then) to rewrite unchanged rows. Items refresh on a rolling
        // DISCOVERY_DETAIL_REFRESH_DAYS cadence instead; new items and ones
        // never stamped still sync immediately.
        if (fetchDetails && itemsToSync.length > 0) {
            const freshSince = new Date(Date.now() - DISCOVERY_DETAIL_REFRESH_DAYS * 86_400_000);
            const fresh = await listFreshDiscoveryDetailKeys(
                sql,
                itemsToSync.map((item) => ({ tmdbId: String(item.id), mediaType: item.mediaType })),
                freshSince,
            );
            if (fresh.size > 0) {
                itemsToSync = itemsToSync.filter(
                    (item) => !fresh.has(`${item.id}:${item.mediaType}`),
                );
                logger.info('Skipping recently refreshed discovery items', {
                    fresh: fresh.size,
                    toSync: itemsToSync.length,
                });
            }
        }

        // Phase 3: Sync metadata
        progress.phase = 'generating';
        progress.processedItems = 0; // Reset for sync phase
        progress.totalItems = itemsToSync.length;
        progress.currentSubStatus = 'Syncing metadata to database...';
        onProgress?.(progress);

        let created = 0;
        let updated = 0;
        let skipped = 0;
        let errors = 0;
        let lastErrorMessage: string | undefined;
        const syncedMediaIds: string[] = [];
        // Admin's configured extra languages — same value for the whole run,
        // computed once rather than re-read per item.
        const extraLanguages = config.METADATA_ADDITIONAL_LANGUAGES;

        for (let i = 0; i < itemsToSync.length; i++) {
            if (shouldAbort?.()) {
                logger.info('Sync aborted by user');
                progress.phase = 'aborted';
                progress.currentSubStatus = 'Sync aborted by user';
                progress.errors.push('Sync aborted by user');
                onProgress?.(progress);
                break;
            }

            const item = itemsToSync[i];
            const title = item.title || item.name || 'Unknown';

            try {
                // Optionally fetch detailed info via the provider SDK abstraction.
                // Using invokeProviderDetail('tmdb-metadata-provider', ...) instead
                // of tmdbApi.getMovieDetails/getTVShowDetails directly so callers
                // can intercept in tests and the rate-limiter is respected.
                let detail: ProviderDetailResult | null = null;
                if (fetchDetails) {
                    try {
                        requestCount++;
                        const encodedId = encodeDetailId(
                            TMDB_PROVIDER_ID,
                            item.mediaType,
                            String(item.id),
                        );
                        detail = await invokeProviderDetail<ProviderDetailResult>(
                            TMDB_PROVIDER_ID,
                            encodedId,
                        );
                        await new Promise((resolve) => setTimeout(resolve, 50)); // Rate limit
                    } catch (detailError) {
                        logger.warn('Failed to fetch details', {
                            id: item.id,
                            error: (detailError as Error).message,
                        });
                    }
                }

                // Check abort after potentially slow API calls
                if (shouldAbort?.()) {
                    logger.info('Sync aborted by user during provider fetch');
                    progress.phase = 'aborted';
                    progress.currentSubStatus = 'Sync aborted by user';
                    progress.errors.push('Sync aborted by user');
                    onProgress?.(progress);
                    break;
                }

                // Structured cast (name + character + person id) drives the detail
                // API's actors[].character and actors[].profileUrl (proxied headshot),
                // stored under provider_metadata.cast.
                const castStructured = buildStructuredCast(detail?.cast);
                // Flat `actors` names are kept for embeddings/search (derived from the
                // same top-billed structured list so the two stay consistent).
                const actors = castStructured.slice(0, 10).map((c) => c.name);
                const directors = detail?.directors ?? [];
                const producers = detail?.producers ?? [];
                const writers = detail?.writers ?? [];

                // Parse release date from neutral shape
                const releaseDate =
                    detail?.releaseDate ?? item.release_date ?? item.first_air_date ?? null;

                // Genre names from neutral shape; fall back to raw genre_ids for
                // the tmdbGenreIdsToSlugs canonical mapping path.
                const genreIds = item.genre_ids ?? [];
                const genreNames = detail?.genreNames ?? [];
                // Prefer provider-supplied slugs; fall back to the TMDB numeric-id
                // canonical map when genre_ids are available.
                const genreSlugs =
                    detail?.genreSlugs ??
                    (genreIds.length > 0
                        ? tmdbGenreIdsToSlugs(genreIds)
                        : keywordNamesToSlugs(genreNames));

                // Keywords from the neutral shape — names, slugs, and TMDB-numeric IDs.
                const keywordNames = detail?.keywordNames ?? [];
                const keywordSlugs = detail?.keywordSlugs ?? keywordNamesToSlugs(keywordNames);
                // rawKeywordIds is TMDB-specific; absent for non-TMDB providers.
                const keywordIds = detail?.rawKeywordIds ?? [];

                // TV networks from neutral shape
                const networks = detail?.networks ?? [];

                // Production meta from neutral shape
                const productionCompanies = detail?.productionCompanies ?? [];
                const spokenLanguages = detail?.spokenLanguages ?? [];
                const productionCountries = detail?.productionCountries ?? [];

                // Original + English titles from neutral shape; fall back to raw fields
                const originalTitle =
                    detail?.originalTitle ?? item.original_title ?? item.original_name ?? null;
                const originalLanguage = item.original_language ?? null;
                const englishTitle = detail?.englishTitle ?? null;

                // Trailer URL from neutral shape
                const trailerUrl = detail?.trailerUrl;

                // Runtime from neutral shape; fall back to raw field
                const runtime = detail?.runtime ?? item.runtime ?? null;

                // Vote average from neutral shape; fall back to raw field
                const voteAverage = detail?.voteAverage ?? item.vote_average ?? null;

                // Check abort before expensive database operation
                if (shouldAbort?.()) {
                    logger.info('Sync aborted by user before database write');
                    progress.phase = 'aborted';
                    progress.currentSubStatus = 'Sync aborted by user';
                    progress.errors.push('Sync aborted by user');
                    onProgress?.(progress);
                    break;
                }

                // National certification (FSK, MPAA, ...) from the release_dates /
                // content_ratings blocks of the detail response. upsertMediaMetadata
                // derives age_rating from it; it wins over MDBList.
                const ageRatingCountry = effectiveAgeRatingCountry();
                const nationalCertification = detail
                    ? pickTmdbCertification(
                          detail,
                          isMovie(item.mediaType) ? 'movie' : 'tv',
                          ageRatingCountry,
                      )
                    : null;

                // Upsert using UUID-based tables
                const result = await upsertMediaMetadata(sql, {
                    primaryExternalId: String(item.id),
                    mediaType: item.mediaType,
                    title,
                    originalTitle,
                    originalLanguage,
                    englishTitle,
                    overview: detail?.overview ?? item.overview ?? null,
                    releaseDate,
                    runtimeMinutes: runtime,
                    externalRating: voteAverage,
                    genres: genreIds.length > 0 ? genreIds : null,
                    keywords: keywordNames.length > 0 ? keywordNames : null,
                    actors: actors.length > 0 ? actors : null,
                    directors: directors.length > 0 ? directors : null,
                    producers: producers.length > 0 ? producers : null,
                    writers: writers.length > 0 ? writers : null,
                    canRequest: true,
                    certification: nationalCertification?.certification ?? null,
                    // Additional metadata stored in provider_metadata
                    providerMetadata: {
                        networks: networks.length > 0 ? networks : undefined,
                        production_companies:
                            productionCompanies.length > 0 ? productionCompanies : undefined,
                        spoken_languages: spokenLanguages.length > 0 ? spokenLanguages : undefined,
                        production_countries:
                            productionCountries.length > 0 ? productionCountries : undefined,
                        popularity: detail?.popularity ?? item.popularity ?? undefined,
                        vote_count: detail?.voteCount ?? item.vote_count ?? undefined,
                        trailer_url: trailerUrl,
                        adult: item.adult ?? undefined,
                        certification_country: nationalCertification?.country,
                        [CERTIFICATION_CHECKED_COUNTRY_KEY]: detail ? ageRatingCountry : undefined,
                        // TMDB-specific numeric keyword IDs (backward-compat GIN path).
                        // Only present when the provider returns rawKeywordIds.
                        tmdb_keyword_ids: keywordIds.length > 0 ? keywordIds : undefined,
                        // Provider-neutral slugs for browse queries
                        genre_slugs: genreSlugs.length > 0 ? genreSlugs : undefined,
                        keyword_slugs: keywordSlugs.length > 0 ? keywordSlugs : undefined,
                        // Structured cast for the detail API (character + headshot).
                        cast: castStructured.length > 0 ? castStructured : undefined,
                        // Freshness stamp read by listFreshDiscoveryDetailKeys — only
                        // when details were actually fetched, so a list-only write
                        // (detail fetch failed) is retried on the next sweep.
                        [DISCOVERY_DETAIL_SYNCED_AT_KEY]: detail
                            ? new Date().toISOString()
                            : undefined,
                    },
                });

                if (result.inserted) {
                    created++;
                } else {
                    updated++;
                }

                if (detail) {
                    await upsertMediaTitles(
                        sql,
                        result.mediaId,
                        collectTmdbTranslationTitles(detail),
                        'tmdb',
                    );
                    if (extraLanguages.length > 0) {
                        await upsertMediaTranslations(
                            sql,
                            result.mediaId,
                            collectTmdbTranslations(detail, extraLanguages),
                        );
                        // Stage bookkeeping (movies only): mark the
                        // translations stage completed so the per-item
                        // metadata-translations-sync task skips this item on
                        // its next sweep instead of re-fetching TMDB detail
                        // for translations this bulk sync just wrote. Mirrors
                        // metadata-sync-single.service.ts's guarded block.
                        // Series stay pending — episode-level fetches are
                        // still needed. Non-fatal: a failure here must not
                        // fail the bulk sync, worst case is one wasted TMDB
                        // call the next time the seed task re-checks this
                        // item.
                        if (isMovie(item.mediaType)) {
                            try {
                                await upsertCompletedRow(sql, {
                                    mediaItemId: result.mediaId,
                                    stageId: 'metadata-translations-sync',
                                    processingVersion: 1,
                                });
                            } catch (err) {
                                logger.warn(
                                    'Failed to mark metadata-translations-sync stage completed',
                                    { mediaItemId: result.mediaId, tmdbId: item.id },
                                    err as Error,
                                );
                            }
                        }
                    }
                }

                syncedMediaIds.push(result.mediaId);

                if (onSuccess) {
                    await onSuccess(result.mediaId).catch(() => {
                        // Non-fatal — coverage write failure must not abort sweep
                    });
                }

                progress.processedItems++;
                progress.created = created;
                progress.updated = updated;
                progress.currentItem = title;
                progress.progressPercentage = Math.round(
                    (progress.processedItems / progress.totalItems) * 100,
                );

                // Log every 100 items
                if (progress.processedItems % 100 === 0) {
                    onProgress?.(progress);
                }
            } catch (error) {
                errors++;
                progress.errorCount = errors;
                lastErrorMessage = `Failed to sync ${title}: ${(error as Error).message}`;
                progress.errors.push(lastErrorMessage);
                logger.error('Failed to sync item', error as Error, {
                    title,
                    tmdbId: item.id,
                });
            }
        }

        // Re-aggregate provider rows into the merged `aggregated` row for every
        // item written this run. batchAggregateMetadata already processes in
        // internal batches of 100 so this is safe to call over large sets.
        // Non-fatal: aggregation failure must not fail the sync.
        if (syncedMediaIds.length > 0) {
            try {
                const aggStats = await batchAggregateMetadata(sql, syncedMediaIds);
                logger.info('Post-sync aggregation complete', {
                    aggregated: aggStats.updated,
                    skipped: aggStats.skipped,
                    errors: aggStats.errors,
                });
            } catch (aggError) {
                logger.warn(
                    'Post-sync aggregation failed — provider rows written, aggregated row may be stale',
                    {
                        error: (aggError as Error).message,
                        count: syncedMediaIds.length,
                    },
                );
            }
        }

        // Calculate skipped count and update progress
        skipped = allItems.length - created - updated - errors;

        // Final result
        progress.phase = 'completed';
        progress.skipped = skipped;
        progress.currentSubStatus = `Completed: ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors`;
        onProgress?.(progress);

        const result: TMDBMetadataSyncResult = {
            success: true,
            total_fetched: allItems.length,
            total_movies: movies.length,
            total_series: series.length,
            created,
            updated,
            skipped,
            errors,
            message: `Successfully synced TMDB metadata: ${created} created, ${updated} updated, ${skipped} skipped`,
            requestCount,
            lastErrorMessage,
        };

        logger.info('TMDB metadata sync completed', result);
        return result;
    } catch (error) {
        logger.error('Fatal error in TMDB metadata sync', error as Error);
        progress.phase = 'error';
        progress.errors.push((error as Error).message);
        onProgress?.(progress);

        throw error;
    }
}

/**
 * Class-based generator for progress tracking (extends shared BaseProgressGenerator)
 */
export class TMDBMetadataSyncGenerator extends BaseProgressGenerator {
    async sync(options: TMDBMetadataSyncOptions = {}): Promise<TMDBMetadataSyncResult> {
        if (this.aborted) {
            throw new Error('Sync has been aborted');
        }

        if (this.isCurrentlyRunning()) {
            throw new Error('Sync is already running');
        }

        this.setRunning(true);
        this.initProgress('Starting TMDB metadata sync');

        try {
            const result = await syncTMDBMetadata({
                ...options,
                shouldAbort: () => this.aborted,
                onProgress: (progress) => {
                    this.currentProgress = { ...progress };
                    options.onProgress?.(progress);
                },
                onSuccess: options.onSuccess,
            });

            this.setRunning(false);
            return result;
        } catch (error) {
            this.setRunning(false);
            this.handleSyncError(error as Error);
            throw error;
        }
    }

    isSyncing(): boolean {
        return this.isCurrentlyRunning();
    }
}

/**
 * Update existing items in the database with missing metadata from the primary provider.
 * Fetches original_title and other metadata for items that already exist.
 */
export async function updateExistingMetadata(
    options: {
        onProgress?: (progress: GenerationProgress) => void;
        shouldAbort?: () => boolean;
        batchSize?: number;
        sql?: postgres.Sql | null;
    } = {},
): Promise<TMDBMetadataSyncResult> {
    const { onProgress, shouldAbort } = options;

    logger.info('Starting metadata update for existing items');

    const db = new Database(options.sql);
    const sql = db.getSql();

    const progress: GenerationProgress = {
        phase: 'fetching',
        totalItems: 0,
        processedItems: 0,
        currentSubStatus: 'Finding items with missing metadata...',
        errors: [],
        recentLogs: ['Starting metadata update'],
        startTime: new Date(),
        created: 0,
        updated: 0,
        skipped: 0,
        errorCount: 0,
        progressPercentage: 0,
    };

    onProgress?.(progress);

    try {
        const itemsNeedingUpdate = await listOriginalTitleBackfillCandidates(sql);

        logger.info('Found items needing metadata update', {
            count: itemsNeedingUpdate.length,
        });

        if (itemsNeedingUpdate.length === 0) {
            progress.phase = 'completed';
            progress.currentSubStatus = 'All items already have original_title';
            onProgress?.(progress);

            return {
                success: true,
                total_fetched: 0,
                total_movies: 0,
                total_series: 0,
                created: 0,
                updated: 0,
                skipped: 0,
                errors: 0,
                message: 'No items need updating',
                requestCount: 0,
            };
        }

        progress.phase = 'generating';
        progress.processedItems = 0; // Reset for update phase
        progress.totalItems = itemsNeedingUpdate.length;
        progress.currentSubStatus = 'Fetching metadata from provider...';
        onProgress?.(progress);

        let updated = 0;
        let errors = 0;
        let skipped = 0;
        let lastErrorMessage: string | undefined;
        // Count every external provider detail request made during this update pass.
        let requestCount = 0;

        // Process items one at a time
        for (let i = 0; i < itemsNeedingUpdate.length; i++) {
            if (shouldAbort?.()) {
                logger.info('Update aborted by user');
                progress.phase = 'aborted';
                progress.currentSubStatus = 'Update aborted by user';
                progress.errors.push('Update aborted by user');
                onProgress?.(progress);
                break;
            }

            const item = itemsNeedingUpdate[i];

            try {
                // Fetch from the primary provider via the SDK abstraction.
                // For TMDB items this resolves to detailMovie/detailTv via
                // tmdb-metadata-provider; for a non-TMDB primary provider it
                // calls that provider's detail() implementation.
                const primaryProvider = getPrimaryExternalIdProvider();
                const pluginId = externalIdToPluginId(primaryProvider);
                const encodedId = encodeDetailId(pluginId, item.media_type, item.external_id);
                requestCount++;
                const detail = await invokeProviderDetail<ProviderDetailResult>(
                    pluginId,
                    encodedId,
                );

                if (!detail) {
                    skipped++;
                    progress.processedItems++;
                    progress.skipped = skipped;
                    progress.currentItem = item.title ?? 'Unknown';
                    progress.progressPercentage = Math.round(
                        (progress.processedItems / progress.totalItems) * 100,
                    );
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    if (progress.processedItems % 10 === 0) {
                        onProgress?.(progress);
                    }
                    continue;
                }

                // originalTitle from neutral shape; fall back to provider-specific fields
                // that may still be present on the raw spread (for TMDB's TmdbDetailResult).
                const originalTitle =
                    detail.originalTitle ??
                    ((detail as Record<string, unknown>)['original_title'] as string | undefined) ??
                    ((detail as Record<string, unknown>)['original_name'] as string | undefined) ??
                    null;

                // englishTitle from neutral shape; fall back to translation extraction
                // that may still be present on the raw spread for TMDB.
                const engTitle = detail.englishTitle ?? null;

                if (originalTitle || engTitle) {
                    // Update media_items via join with external_ids. A 0-row result
                    // is legitimate (item is metadata_locked, or no row carries this
                    // composite key) and does NOT throw — so count the rows actually
                    // written. Counting unconditionally reported these as `updated`
                    // on every run forever, since the candidate query re-selects them.
                    const rowsWritten = await updateOriginalTitleByTmdbId(
                        sql,
                        String(item.external_id),
                        item.media_type,
                        originalTitle ?? '',
                        engTitle,
                    );
                    if (rowsWritten > 0) {
                        updated++;
                    } else {
                        skipped++;
                    }
                } else {
                    skipped++;
                }

                progress.processedItems++;
                progress.updated = updated;
                progress.skipped = skipped;
                progress.currentItem = item.title ?? 'Unknown';
                progress.progressPercentage = Math.round(
                    (progress.processedItems / progress.totalItems) * 100,
                );

                // Rate limit: 50ms between requests
                await new Promise((resolve) => setTimeout(resolve, 50));

                // Update progress every 10 items
                if (progress.processedItems % 10 === 0) {
                    onProgress?.(progress);
                }
            } catch (error) {
                errors++;
                progress.errorCount = errors;
                lastErrorMessage = (error as Error).message;
                logger.warn('Failed to update item', {
                    externalId: item.external_id,
                    error: lastErrorMessage,
                });
            }
        }

        progress.phase = 'completed';
        progress.currentSubStatus = `Completed: ${updated} updated, ${skipped} skipped, ${errors} errors`;
        onProgress?.(progress);

        const result: TMDBMetadataSyncResult = {
            success: true,
            total_fetched: itemsNeedingUpdate.length,
            total_movies: itemsNeedingUpdate.filter((i) => isMovie(i.media_type)).length,
            total_series: itemsNeedingUpdate.filter((i) => isSeries(i.media_type)).length,
            created: 0,
            updated,
            skipped,
            errors,
            message: `Updated ${updated} items with original_title`,
            requestCount,
            lastErrorMessage,
        };

        logger.info('Metadata update completed', result);
        return result;
    } catch (error) {
        logger.error('Fatal error in metadata update', error as Error);
        progress.phase = 'error';
        progress.errors.push((error as Error).message);
        onProgress?.(progress);
        throw error;
    }
}

/**
 * Class-based generator for updating existing metadata (extends shared BaseProgressGenerator)
 */
export class MetadataUpdateGenerator extends BaseProgressGenerator {
    async update(
        options: { batchSize?: number; sql?: postgres.Sql | null } = {},
    ): Promise<TMDBMetadataSyncResult> {
        if (this.aborted) {
            throw new Error('Update has been aborted');
        }

        if (this.isCurrentlyRunning()) {
            throw new Error('Update is already running');
        }

        this.setRunning(true);
        this.initProgress('Starting metadata update');

        try {
            const result = await updateExistingMetadata({
                ...options,
                shouldAbort: () => this.aborted,
                onProgress: (progress) => {
                    this.currentProgress = { ...progress };
                },
            });

            this.setRunning(false);
            return result;
        } catch (error) {
            this.setRunning(false);
            this.handleSyncError(error as Error);
            throw error;
        }
    }

    isUpdating(): boolean {
        return this.isCurrentlyRunning();
    }
}

// CLI support
// Gated on LUMASTRA_CLI (set by the npm script), never on
// `import.meta.url === file://${argv[1]}` — see utils/cli-entry.ts.
if (isCliEntry('sync-tmdb-metadata')) {
    const missingOnly = process.argv.includes('--missing-only');
    const fetchDetails = process.argv.includes('--fetch-details');

    syncTMDBMetadata({
        maxMovies: 1000,
        maxSeries: 1000,
        missingOnly,
        fetchDetails,
        onProgress: (progress) => {
            logger.info('Progress', {
                phase: progress.phase,
                processedItems: progress.processedItems,
                totalItems: progress.totalItems,
                currentItem: progress.currentItem || progress.currentSubStatus,
            });
        },
    })
        .then((result) => {
            logger.info('Result', result);
            process.exit(0);
        })
        .catch((error) => {
            logger.error('Failed', error instanceof Error ? error : undefined);
            process.exit(1);
        });
}
