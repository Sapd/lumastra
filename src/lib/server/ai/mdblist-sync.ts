// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// MDBList Ratings Sync Service
// Enriches UUID-based metadata with aggregated ratings from MDBList using
// the SDK batchLookup helper (which fronts the `/tmdb/{type}` batch endpoint
// on the mdblist provider). The legacy `mdblistApi.getBatchByTmdbIds` HTTP
// call was retired in favour of the unified provider invocation path so
// rate limiting, secrets, and abort signals all flow through one channel.

import type postgres from 'postgres';
import { Database } from '../database/connection';
import { mdblistApi, type MDBListMediaItem } from '../services/mdblist-api';
import { invokeProviderBatchLookup } from '../tasks/plugin-context.js';
import { Logger } from '../utils/logger';
import { isCliEntry } from '../utils/cli-entry.js';
import { buildMetadataLateralJoinFragment } from '../database/queries/builders/provider-metadata.builder.js';
import { upsertMdblistMetadata } from '../database/queries/ai-sync.queries.js';
import { markSkippedTransientBatch } from '../database/queries/stage-state.queries.js';
import { aggregateMetadataForMedia } from '../database/queries/metadata-aggregation.queries.js';
import { isMovie, isSeries } from '../utils/media-types';
import { getPrimaryExternalIdProvider } from '../utils/provider-config.js';
import { updateMediaAgeRating } from '../database/queries/media-upsert.js';

// Retry delay for items that pass through `candidateSource` but the
// movies/TV fetch query drops (e.g. no primary `external_ids` row, stale
// freshness threshold). 6 hours mirrors the embedding generators.
const LEGACY_FILTER_SKIP_RETRY_MS = 6 * 60 * 60 * 1000;

const logger = Logger.for('MDBListSync');
type SqlTag = ReturnType<Database['getSql']>;

interface MediaCatalogLiteRow {
    primary_ext_id: string;
    title: string;
    media_id?: string;
}

interface MDBListStatsRow {
    total_items: number;
    with_mdblist: number;
    without_mdblist: number;
    stale_data: number;
    movies_without: number;
    tv_without: number;
}

interface MDBListSampleRow {
    tmdb_id: number;
    title: string;
    media_type: string;
    year: number | null;
    mdblist_score: number | null;
    imdb_rating: string | number | null;
    letterboxd_rating: string | number | null;
    letterboxd_votes: number | null;
    metacritic_score: number | null;
    rt_rating: number | null;
    rt_audience_score: number | null;
    trakt_score: number | null;
    mal_score: string | number | null;
    mal_votes: number | null;
    streaming_services: string[] | null;
    anime_genres: string[] | null;
    mdblist_keywords: string[] | null;
    mdblist_last_updated: Date | null;
}

interface MDBListRawSampleRow {
    tmdb_id: number;
    title: string;
    media_type: string;
    release_date: string | null;
    genres: string[] | null;
    imdb_id: string | null;
    imdb_rating: string | number | null;
    rt_rating: number | null;
    certification: string | null;
    runtime_minutes: number | null;
    actors: string[] | null;
    directors: string[] | null;
    mdblist_score: number | null;
    letterboxd_rating: string | number | null;
    letterboxd_votes: number | null;
    metacritic_score: number | null;
    rt_audience_score: number | null;
    trakt_score: number | null;
    mal_score: string | number | null;
    mal_votes: number | null;
    streaming_services: string[] | null;
    anime_genres: string[] | null;
    mdblist_keywords: string[] | null;
    mdblist_last_updated: Date | null;
}

const toNumberOrNull = (value: string | number | null): number | null => {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

export interface MDBListSyncOptions {
    /**
     * Optional pool handle. Task callers pass `ctx.sql` (task pool) so the bulk
     * 12h enrichment sweep doesn't draw from the web pool; omit for web callers
     * (defaults to getDb()). Pass a POOL handle only — never a transaction.
     */
    sql?: postgres.Sql | null;
    /** Maximum number of items to sync (default: all missing) */
    limit?: number;
    /** Only sync items missing MDBList data */
    onlyMissing?: boolean;
    /** Minimum age of MDBList data before re-syncing (hours) */
    refreshAfterHours?: number;
    /** Media type filter */
    mediaType?: 'movie' | 'tv' | 'all';
    /** Delay between batch API calls (ms) */
    delayMs?: number;
    /** Cancellation signal forwarded to `invokeProviderBatchLookup`. */
    signal?: AbortSignal;
    /**
     * Optional callback invoked after each item's MDBList data is successfully
     * stored. Used by the task wrapper to write a coverage-table completion
     * row without coupling the generator to stage-state semantics.
     */
    onSuccess?: (mediaId: string) => Promise<void>;
    /**
     * Optional callback invoked when MDBList returns no data for an item
     * in a batch. The task wrapper tombstones the coverage row so the
     * same null-result item doesn't cycle through every slice forever.
     */
    onSkip?: (mediaId: string) => Promise<void>;
    /**
     * Optional override for the candidate query. When provided, the sync
     * function resolves the backlog from this callback (coverage-table-driven
     * mode) and scopes its movie/TV queries to only those item UUIDs instead
     * of the legacy `provider_metadata` presence predicate.
     */
    candidateSource?: (sql: postgres.Sql, limit: number) => Promise<Array<{ id: string }>>;
    /**
     * Stage ID associated with `candidateSource`. When set, candidates that
     * the movie/TV fetch query drops (e.g. no primary external_ids row, not
     * stale per refresh threshold) are marked `skipped_transient` with a
     * retry delay — otherwise they keep coming back on every sweep tick.
     */
    stageId?: string;
}

export interface MDBListSyncProgress {
    phase: 'querying' | 'fetching' | 'updating' | 'completed' | 'error';
    total: number;
    processed: number;
    updated: number;
    skipped: number;
    errors: number;
    currentBatch?: number;
    totalBatches?: number;
    eta?: string;
}

export interface MDBListSyncResult {
    processed: number;
    updated: number;
    skipped: number;
    errors: string[];
    duration_ms: number;
    /** Number of external MDBList batch-lookup HTTP requests made. */
    requestCount: number;
    /**
     * Items counted toward `processed` ONLY because their entire batch threw in
     * `invokeProviderBatchLookup` (the "MDBList down" fallback), as opposed to
     * items that reached upstream and got a real (or null) answer. When
     * `processedViaFallback === processed` AND `updated === 0`, every attempted
     * batch failed and nothing was stored → a genuine total outage. This makes
     * the outage guard reachable: the batch-catch inflates `processed`/`skipped`,
     * so `processed === 0` can never signal an outage.
     */
    processedViaFallback: number;
}

// Progress callback for real-time updates
type ProgressCallback = (progress: MDBListSyncProgress) => void;

/**
 * Sync MDBList ratings data for media items in the database using batch API
 */
export async function syncMDBListRatings(
    options: MDBListSyncOptions = {},
    onProgress?: ProgressCallback,
): Promise<MDBListSyncResult> {
    const {
        limit,
        onlyMissing = true,
        refreshAfterHours = 168, // 1 week default
        mediaType = 'all',
        delayMs = 500, // 500ms delay between batches
        signal,
        onSuccess,
        onSkip,
        candidateSource,
        stageId,
    } = options;

    const startTime = Date.now();
    const result: MDBListSyncResult = {
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: [],
        duration_ms: 0,
        requestCount: 0,
        processedViaFallback: 0,
    };

    const progress: MDBListSyncProgress = {
        phase: 'querying',
        total: 0,
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
    };

    const updateProgress = () => {
        if (onProgress) {
            onProgress({ ...progress });
        }
    };

    if (!mdblistApi.isAvailable()) {
        logger.warn('MDBList API key not configured, skipping sync');
        result.errors.push('MDBList API key not configured');
        progress.phase = 'error';
        updateProgress();
        return result;
    }

    const db = new Database(options.sql);
    const sql = db.getSql();

    try {
        logger.info('Starting MDBList batch ratings sync', {
            limit,
            onlyMissing,
            mediaType,
        });
        updateProgress();

        // When candidateSource is provided (coverage-table-driven mode), resolve
        // the candidate UUIDs upfront and scope all item queries to only those
        // items. The existing legacy predicate (mdblist_score presence / refresh
        // threshold) is still applied inside the scoped query so staleness is
        // still respected even in coverage-driven mode.
        let candidateIds: string[] | null = null;
        if (candidateSource) {
            const rows = await candidateSource(sql, limit ?? 10000);
            if (rows.length === 0) {
                progress.phase = 'completed';
                result.duration_ms = Date.now() - startTime;
                updateProgress();
                return result;
            }
            candidateIds = rows.map((r) => r.id);
        }

        // Build query to find items needing sync
        const refreshThreshold = new Date(Date.now() - refreshAfterHours * 60 * 60 * 1000);

        // Query movies
        let movieItems: MediaCatalogLiteRow[] = [];
        let tvItems: MediaCatalogLiteRow[] = [];

        if (isMovie(mediaType) || mediaType === 'all') {
            if (onlyMissing) {
                // Query UUID-based tables: items without mdblist provider_metadata or with stale data
                movieItems = await sql<MediaCatalogLiteRow[]>`
                    SELECT ei.external_id AS primary_ext_id, mi.title, mi.id::text AS media_id
                    FROM media_items mi
                    JOIN external_ids ei ON mi.id = ei.media_id
                        AND ei.provider = ${getPrimaryExternalIdProvider()}
                        AND ei.is_primary = TRUE
                    LEFT JOIN provider_metadata pm_mdb ON mi.id = pm_mdb.media_id
                        AND pm_mdb.provider = 'mdblist'
                    WHERE mi.media_type = 'movie'
                      AND mi.status = 'active'
                      -- Must mirror upsertMdblistMetadata's own lock guard.
                      -- Without this, a locked item missing mdblist data is
                      -- re-selected — and re-fetched from the provider — every
                      -- 12h for a write that can never land (C3 fix-round-2,
                      -- 2026-09-25 security review).
                      AND mi.metadata_locked = false
                      AND (pm_mdb.id IS NULL
                           OR pm_mdb.metadata->>'mdblist_score' IS NULL
                           OR pm_mdb.updated_at < ${refreshThreshold})
                      ${candidateIds ? sql`AND mi.id = ANY(${candidateIds}::uuid[])` : sql``}
                    ORDER BY
                        CASE WHEN pm_mdb.id IS NULL OR pm_mdb.metadata->>'mdblist_score' IS NULL THEN 0 ELSE 1 END,
                        mi.updated_at DESC
                    ${limit ? sql`LIMIT ${limit}` : sql``}
                `;
            } else {
                movieItems = await sql<MediaCatalogLiteRow[]>`
                    SELECT ei.external_id AS primary_ext_id, mi.title, mi.id::text AS media_id
                    FROM media_items mi
                    JOIN external_ids ei ON mi.id = ei.media_id
                        AND ei.provider = ${getPrimaryExternalIdProvider()}
                        AND ei.is_primary = TRUE
                    WHERE mi.media_type = 'movie'
                      AND mi.status = 'active'
                      AND mi.metadata_locked = false
                      ${candidateIds ? sql`AND mi.id = ANY(${candidateIds}::uuid[])` : sql``}
                    ORDER BY mi.updated_at DESC
                    ${limit ? sql`LIMIT ${limit}` : sql``}
                `;
            }
        }

        if (isSeries(mediaType) || mediaType === 'all') {
            const tvLimit = limit && mediaType === 'all' ? Math.ceil(limit / 2) : limit;
            if (onlyMissing) {
                // Query UUID-based tables: items without mdblist provider_metadata or with stale data
                tvItems = await sql<MediaCatalogLiteRow[]>`
                    SELECT ei.external_id AS primary_ext_id, mi.title, mi.id::text AS media_id
                    FROM media_items mi
                    JOIN external_ids ei ON mi.id = ei.media_id
                        AND ei.provider = ${getPrimaryExternalIdProvider()}
                        AND ei.is_primary = TRUE
                    LEFT JOIN provider_metadata pm_mdb ON mi.id = pm_mdb.media_id
                        AND pm_mdb.provider = 'mdblist'
                    WHERE mi.media_type = 'tv'
                      AND mi.status = 'active'
                      -- Must mirror upsertMdblistMetadata's own lock guard —
                      -- see the movie query above.
                      AND mi.metadata_locked = false
                      AND (pm_mdb.id IS NULL
                           OR pm_mdb.metadata->>'mdblist_score' IS NULL
                           OR pm_mdb.updated_at < ${refreshThreshold})
                      ${candidateIds ? sql`AND mi.id = ANY(${candidateIds}::uuid[])` : sql``}
                    ORDER BY
                        CASE WHEN pm_mdb.id IS NULL OR pm_mdb.metadata->>'mdblist_score' IS NULL THEN 0 ELSE 1 END,
                        mi.updated_at DESC
                    ${tvLimit ? sql`LIMIT ${tvLimit}` : sql``}
                `;
            } else {
                tvItems = await sql<MediaCatalogLiteRow[]>`
                    SELECT ei.external_id AS primary_ext_id, mi.title, mi.id::text AS media_id
                    FROM media_items mi
                    JOIN external_ids ei ON mi.id = ei.media_id
                        AND ei.provider = ${getPrimaryExternalIdProvider()}
                        AND ei.is_primary = TRUE
                    WHERE mi.media_type = 'tv'
                      AND mi.status = 'active'
                      AND mi.metadata_locked = false
                      ${candidateIds ? sql`AND mi.id = ANY(${candidateIds}::uuid[])` : sql``}
                    ORDER BY mi.updated_at DESC
                    ${tvLimit ? sql`LIMIT ${tvLimit}` : sql``}
                `;
            }
        }

        progress.total = movieItems.length + tvItems.length;
        progress.phase = 'fetching';
        updateProgress();

        logger.info(`Found ${movieItems.length} movies and ${tvItems.length} TV shows to sync`);

        // Process movies in batches
        if (movieItems.length > 0) {
            const moviePrimaryIds = movieItems.map((m) => m.primary_ext_id);
            const movieIdMap = new Map<string, string>();
            for (const row of movieItems) {
                if (row.media_id) movieIdMap.set(row.primary_ext_id, row.media_id);
            }
            await processBatch(
                sql,
                moviePrimaryIds,
                'movie',
                result,
                progress,
                updateProgress,
                delayMs,
                signal,
                onSuccess,
                onSkip,
                movieIdMap,
            );
        }

        // Process TV shows in batches
        if (tvItems.length > 0) {
            const tvPrimaryIds = tvItems.map((t) => t.primary_ext_id);
            const tvIdMap = new Map<string, string>();
            for (const row of tvItems) {
                if (row.media_id) tvIdMap.set(row.primary_ext_id, row.media_id);
            }
            await processBatch(
                sql,
                tvPrimaryIds,
                'tv',
                result,
                progress,
                updateProgress,
                delayMs,
                signal,
                onSuccess,
                onSkip,
                tvIdMap,
            );
        }

        // Reconcile drift: candidates that the legacy movie/TV fetch queries
        // dropped (no primary external_ids row, missingCondition deemed them
        // up-to-date) need a `skipped_transient` row with a retry window —
        // otherwise they'll come back on every sweep tick. Invalidation
        // events flip them back to `pending` immediately.
        if (candidateIds && stageId) {
            const processedIds = new Set<string>();
            for (const row of movieItems) {
                if (row.media_id) processedIds.add(row.media_id);
            }
            for (const row of tvItems) {
                if (row.media_id) processedIds.add(row.media_id);
            }
            const unprocessed = candidateIds.filter((id) => !processedIds.has(id));
            if (unprocessed.length > 0) {
                try {
                    const updated = await markSkippedTransientBatch(sql, {
                        stageId,
                        mediaItemIds: unprocessed,
                        skippedReason: 'ineligible-by-legacy-filter',
                        retryAfterMs: LEGACY_FILTER_SKIP_RETRY_MS,
                    });
                    logger.info('Reconciled mdblist-sync coverage drift via skipped_transient', {
                        stageId,
                        candidates: candidateIds.length,
                        processed: processedIds.size,
                        unprocessed: unprocessed.length,
                        rowsUpdated: updated,
                    });
                } catch (err) {
                    // Non-fatal — reconciliation failure must not abort the run.
                    logger.warn('Failed to mark mdblist drift items as skipped_transient', {
                        stageId,
                        unprocessedCount: unprocessed.length,
                        error: (err as Error).message,
                    });
                }
            }
        }

        progress.phase = 'completed';
        result.duration_ms = Date.now() - startTime;
        updateProgress();

        logger.info('MDBList batch sync completed', {
            processed: result.processed,
            updated: result.updated,
            skipped: result.skipped,
            errors: result.errors.length,
            duration: `${(result.duration_ms / 1000).toFixed(1)}s`,
        });

        return result;
    } catch (error) {
        logger.error('MDBList batch sync failed', error as Error);
        result.errors.push((error as Error).message);
        result.duration_ms = Date.now() - startTime;
        progress.phase = 'error';
        updateProgress();
        return result;
    }
}

/**
 * Process a batch of items via `invokeProviderBatchLookup`.
 *
 * The provider is responsible for the underlying HTTP call shape; this
 * function feeds it composite ids (`tmdb:{id}:{movie|show}`) and correlates
 * the index-aligned response back to the input primary IDs.
 */
async function processBatch(
    sql: SqlTag,
    primaryIds: string[],
    // DB vocabulary ('movie' | 'tv'), NOT MDBList's ('movie' | 'show').
    // MDBList's `show` spelling is translated at the HTTP boundary only
    // (providers/mdblist.ts), so no internal code can mistake it for a DB
    // media_type. Passing 'show' here used to make `isSeries('show')` false
    // (the guard accepts only 'SERIES'/'TV'), silently typing every series as
    // a movie and writing its ratings to whatever movie shared its TMDB id.
    mediaType: 'movie' | 'tv',
    result: MDBListSyncResult,
    progress: MDBListSyncProgress,
    updateProgress: () => void,
    delayMs: number,
    signal?: AbortSignal,
    onSuccess?: (mediaId: string) => Promise<void>,
    onSkip?: (mediaId: string) => Promise<void>,
    mediaIdByPrimaryId?: Map<string, string>,
): Promise<void> {
    const batchSize = 200;
    const totalBatches = Math.ceil(primaryIds.length / batchSize);
    const dbMediaType = mediaType;

    logger.info(`Processing ${primaryIds.length} ${mediaType}s in ${totalBatches} batches`);

    let progressStartTime = Date.now();
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const batchStart = batchIndex * batchSize;
        const batchEnd = Math.min(batchStart + batchSize, primaryIds.length);
        const batchIds = primaryIds.slice(batchStart, batchEnd);

        progress.currentBatch = batchIndex + 1;
        progress.totalBatches = totalBatches;
        progress.phase = 'fetching';

        // Calculate ETA
        if (batchIndex > 0 && progress.processed > 0) {
            const elapsed = Date.now() - progressStartTime;
            if (elapsed > 0) {
                const rate = progress.processed / elapsed;
                const remaining = progress.total - progress.processed;
                const etaMs = remaining / rate;
                progress.eta = formatDuration(etaMs);
            }
        } else {
            progressStartTime = Date.now();
        }

        updateProgress();

        try {
            // Encode primary (TMDB) ids as the composite form the provider's
            // batchLookup expects: `tmdb:{id}:{movie|show}`. Strict-digit
            // filter — parseInt('123abc') silently returns 123, which would
            // coerce a malformed id like '123-tt' into TMDB ID 123 and pass
            // it upstream. Use a regex to reject anything that isn't pure
            // digits.
            const numericBatchIds = batchIds
                .filter((id) => /^\d+$/.test(id))
                .map((id) => ({ raw: id, n: Number.parseInt(id, 10) }));

            const compositeIds = numericBatchIds.map((e) => `tmdb:${e.n}:${mediaType}`);

            // Count the external MDBList batch-lookup request. Each
            // invokeProviderBatchLookup call is one HTTP request to the
            // provider regardless of how many composite ids it carries.
            if (compositeIds.length > 0) {
                result.requestCount++;
            }

            const batchResults = await invokeProviderBatchLookup<MDBListMediaItem>(
                'mdblist-metadata-provider',
                compositeIds,
                signal ? { signal } : undefined,
            );

            // Build a Map keyed by composite ID for safe O(1) lookup.
            // Index-aligned access would silently misalign if the provider
            // ever returns fewer entries than requested; the Map makes the
            // correlation explicit and robust against that edge case.
            const idMap = new Map<string, MDBListMediaItem | null>(
                compositeIds.map((id, i) => [id, batchResults[i] ?? null]),
            );

            // Update database
            progress.phase = 'updating';
            updateProgress();

            for (const { raw: primaryId, n: numericId } of numericBatchIds) {
                const compositeId = `tmdb:${numericId}:${mediaType}`;
                result.processed++;
                progress.processed++;

                const mdbData = idMap.get(compositeId) ?? null;
                if (!mdbData) {
                    result.skipped++;
                    progress.skipped++;
                    // Tombstone the stage-state row so this null-result
                    // item doesn't cycle through the candidate query
                    // every slice forever. Identity-change invalidation
                    // reseeds on re-id, so the item can re-enter if its
                    // upstream identity changes.
                    if (onSkip) {
                        const mediaId = mediaIdByPrimaryId?.get(primaryId);
                        if (mediaId) {
                            try {
                                await onSkip(mediaId);
                            } catch {
                                // Non-fatal — next sweep tick retries
                            }
                        }
                    }
                    continue;
                }

                try {
                    const { mediaId: storedMediaId, wrote } = await storeMDBListData(
                        sql,
                        numericId,
                        dbMediaType,
                        mdbData,
                    );
                    if (!storedMediaId) {
                        // The upsert matched no row — MDBList returned data but no
                        // media item carries this (tmdb id, media_type) pair. Counting
                        // that as `updated` reported success while persisting nothing,
                        // AND left the coverage row pending, so stage-sweep re-enqueued
                        // the task every 60s indefinitely. Tombstone instead so the
                        // backlog can drain; identity-change invalidation reseeds it.
                        result.skipped++;
                        progress.skipped++;
                        logger.warn('MDBList data discarded — no media item for id', {
                            primaryId,
                            mediaType: dbMediaType,
                        });
                        if (onSkip) {
                            const skipMediaId = mediaIdByPrimaryId?.get(primaryId);
                            if (skipMediaId) {
                                try {
                                    await onSkip(skipMediaId);
                                } catch {
                                    // Non-fatal — next sweep tick retries
                                }
                            }
                        }
                        continue;
                    }
                    if (!wrote) {
                        // The item resolved but is metadata_locked — the upsert
                        // above (and its re-aggregation) silently no-opped. This
                        // is NOT an update (C3 fix-round-2, 2026-09-25 security
                        // review) — counting it as one used to mark the coverage
                        // row `completed` for a write that never landed. Leave
                        // the coverage row untouched: the `metadata-locked`
                        // stage-disposition rule on the `mdblist-sync` stage
                        // (mdblist-sync.ts, the task file) disposes it to
                        // `skipped_transient` on the next sweep tick, which
                        // self-heals once the item is unlocked — calling `onSkip`
                        // here would instead stamp `skipped_permanent`, which
                        // does not.
                        result.skipped++;
                        progress.skipped++;
                        logger.info('MDBList write skipped — item is metadata_locked', {
                            primaryId,
                            mediaType: dbMediaType,
                        });
                        continue;
                    }
                    result.updated++;
                    progress.updated++;
                    if (onSuccess) {
                        try {
                            await onSuccess(storedMediaId);
                        } catch (err) {
                            // Non-fatal for the sync, but a PERSISTENT failure here
                            // leaves the coverage row pending forever and the sweep
                            // re-enqueues every 60s — so log it, never swallow silently.
                            logger.warn('MDBList coverage write failed', {
                                primaryId,
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                    }
                } catch (error) {
                    const errorMsg = `Failed to store ${primaryId}: ${(error as Error).message}`;
                    result.errors.push(errorMsg);
                    progress.errors++;
                    logger.error('Failed to store MDBList data', error as Error, {
                        primaryId,
                        mediaType,
                    });
                }
            }

            // Account for ids that we couldn't even encode (non-numeric) — the
            // legacy code path silently lost them; keep parity by counting
            // them toward processed/skipped so the totals stay consistent.
            const droppedCount = batchIds.length - numericBatchIds.length;
            for (let i = 0; i < droppedCount; i++) {
                result.processed++;
                result.skipped++;
                progress.processed++;
                progress.skipped++;
            }

            logger.info(`Batch ${batchIndex + 1}/${totalBatches} completed`, {
                requested: batchIds.length,
                // batchResults is index-aligned with `null` placeholders for
                // ids the provider didn't resolve — count only non-null hits.
                found: batchResults.filter((r) => r !== null).length,
                updated: result.updated,
            });

            updateProgress();

            // Delay between batches to respect rate limits
            if (batchIndex < totalBatches - 1 && delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        } catch (error) {
            const errorMsg = `Batch ${batchIndex + 1} failed: ${(error as Error).message}`;
            logger.error(errorMsg, error as Error);
            result.errors.push(errorMsg);
            progress.errors++;

            // Mark all items in failed batch as processed but skipped. Track them
            // separately in `processedViaFallback` so the task wrapper can tell a
            // total outage (every attempted batch threw → processed all came from
            // here, nothing updated) apart from a benign run where items reached
            // upstream and simply had no MDBList data.
            for (let i = 0; i < batchIds.length; i++) {
                result.processed++;
                result.skipped++;
                result.processedViaFallback++;
                progress.processed++;
                progress.skipped++;
            }

            updateProgress();
        }
    }
}

/**
 * Store MDBList data in the database using UUID-based provider_metadata table.
 *
 * IMPORTANT: mediaType is REQUIRED because TMDB IDs are NOT unique across types!
 * Example: TMDB ID 1429 = "25th Hour" (movie) AND "Attack on Titan" (tv)
 *
 * @returns `mediaId`: the internal UUID for the stored item, or null when the
 * TMDB ID could not be resolved to a media_items row. `wrote`: false when
 * the item resolved but `upsertMdblistMetadata` skipped the write because it
 * is `metadata_locked` (C3 fix-round-2, 2026-09-25 security review) — the
 * caller must not count this as an update.
 */
async function storeMDBListData(
    sql: SqlTag,
    tmdbId: number,
    mediaType: 'movie' | 'tv',
    data: MDBListMediaItem,
): Promise<{ mediaId: string | null; wrote: boolean }> {
    const ratings = mdblistApi.getNormalizedRatings(data);
    const isAnime = mdblistApi.isAnime(data);
    const animeGenres = isAnime ? mdblistApi.getAnimeGenres(data) : [];
    const streamingServices = mdblistApi.getStreamingServices(data);

    // Get raw Letterboxd and MAL data for vote counts
    const letterboxdRating = mdblistApi.extractRating(data, 'letterboxd');
    const malRating = mdblistApi.extractRating(data, 'myanimelist');

    // Extract keyword names from MDBList keywords array
    const keywords = data.keywords?.map((k) => k.name) || [];

    // Build MDBList metadata object for provider_metadata table
    const mdblistMetadata = {
        mdblist_score: data.score ?? null,
        letterboxd_rating: letterboxdRating?.value ?? null,
        letterboxd_votes: letterboxdRating?.votes ?? null,
        metacritic_score: ratings.metacritic,
        rt_rating: ratings.rt_critic,
        rt_audience_score: ratings.rt_audience,
        trakt_score: ratings.trakt,
        mal_score: malRating?.value ?? null,
        mal_votes: malRating?.votes ?? null,
        age_rating_numeric: data.age_rating ?? null,
        streaming_services: streamingServices.length > 0 ? streamingServices : null,
        anime_genres: animeGenres.length > 0 ? animeGenres : null,
        mdblist_keywords: keywords.length > 0 ? keywords : null,
    };

    // Upsert to provider_metadata via external_ids lookup
    const { mediaId, wrote } = await upsertMdblistMetadata(sql, tmdbId, mediaType, mdblistMetadata);

    // Write numeric age rating directly to media_items for efficient filtering.
    // Runs even when the item is metadata_locked (`wrote` false) on purpose —
    // see updateMediaAgeRating.
    if (mediaId && data.age_rating != null) {
        await updateMediaAgeRating(sql, mediaId, data.age_rating);
    }

    // Trigger metadata aggregation to merge mdblist data with other providers.
    // LOAD-BEARING for embedding freshness: rewriting the `aggregated`
    // provider_metadata row is what fires the `metadata.changed` DB trigger
    // (gated on mdblist_keywords/genres/… IS DISTINCT), which invalidates the
    // library/discovery embedding stages so a late MDBList backfill re-embeds
    // the item. mdblist-sync has NO `feedsInto` edge to embeddings — this
    // aggregation call is the entire mechanism.
    //
    // No `force` — this is a background/scheduled sync with no admin-force
    // override (C3, 2026-09-24 security review). `aggregateMetadataForMedia`
    // silently skips a `metadata_locked` item, which is INTENDED here: the
    // `mdblist` provider row upsert above already skipped it for the same
    // reason, so there is nothing new to fold into 'aggregated', and the
    // embedding re-trigger correctly does not fire for a frozen item either.
    if (mediaId) {
        await aggregateMetadataForMedia(sql, mediaId);
    }

    return { mediaId: mediaId ?? null, wrote };
}

export interface MDBListSampleItem {
    tmdb_id: number;
    title: string;
    media_type: string;
    year: number | null;
    mdblist_score: number | null;
    imdb_rating: number | null;
    letterboxd_rating: number | null;
    letterboxd_votes: number | null;
    metacritic_score: number | null;
    rt_rating: number | null;
    rt_audience_score: number | null;
    trakt_score: number | null;
    mal_score: number | null;
    mal_votes: number | null;
    streaming_services: string[] | null;
    anime_genres: string[] | null;
    mdblist_keywords: string[] | null;
    mdblist_last_updated: string | null;
}

/**
 * Get MDBList sync status with sample items (UUID-based tables)
 */
export async function getMDBListSyncStatus(includeSamples = true): Promise<{
    total_items: number;
    with_mdblist: number;
    without_mdblist: number;
    stale_data: number;
    coverage_percent: number;
    movies_without: number;
    tv_without: number;
    samples?: MDBListSampleItem[];
}> {
    const db = new Database();
    const sql = db.getSql();

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Query UUID-based tables for sync status
    const stats = await sql<MDBListStatsRow[]>`
        SELECT
            COUNT(*) as total_items,
            COUNT(pm_mdb.id) as with_mdblist,
            COUNT(*) - COUNT(pm_mdb.id) as without_mdblist,
            COUNT(CASE WHEN pm_mdb.updated_at < ${weekAgo} THEN 1 END) as stale_data,
            COUNT(CASE WHEN mi.media_type = 'movie' AND pm_mdb.id IS NULL THEN 1 END) as movies_without,
            COUNT(CASE WHEN mi.media_type = 'tv' AND pm_mdb.id IS NULL THEN 1 END) as tv_without
        FROM media_items mi
        JOIN external_ids ei ON mi.id = ei.media_id
            AND ei.provider = ${getPrimaryExternalIdProvider()}
            AND ei.is_primary = TRUE
        LEFT JOIN provider_metadata pm_mdb ON mi.id = pm_mdb.media_id
            AND pm_mdb.provider = 'mdblist'
        WHERE mi.status = 'active'
    `;

    const row = stats[0];
    const result: {
        total_items: number;
        with_mdblist: number;
        without_mdblist: number;
        stale_data: number;
        coverage_percent: number;
        movies_without: number;
        tv_without: number;
        samples?: MDBListSampleItem[];
    } = {
        total_items: Number(row.total_items),
        with_mdblist: Number(row.with_mdblist),
        without_mdblist: Number(row.without_mdblist),
        stale_data: Number(row.stale_data),
        coverage_percent:
            row.total_items > 0 ? Math.round((row.with_mdblist / row.total_items) * 100) : 0,
        movies_without: Number(row.movies_without),
        tv_without: Number(row.tv_without),
    };

    // Fetch sample items with MDBList data from UUID-based tables
    if (includeSamples) {
        const samples = await sql<MDBListSampleRow[]>`
            SELECT
                CAST(ei.external_id AS INTEGER) AS tmdb_id,
                mi.title,
                mi.media_type,
                mi.year,
                CAST(pm_mdb.metadata->>'mdblist_score' AS SMALLINT) AS mdblist_score,
                CAST(pm.metadata->>'imdb_rating' AS NUMERIC) AS imdb_rating,
                CAST(pm_mdb.metadata->>'letterboxd_rating' AS NUMERIC) AS letterboxd_rating,
                CAST(pm_mdb.metadata->>'letterboxd_votes' AS INTEGER) AS letterboxd_votes,
                CAST(pm_mdb.metadata->>'metacritic_score' AS SMALLINT) AS metacritic_score,
                CAST(pm_mdb.metadata->>'rt_rating' AS INTEGER) AS rt_rating,
                CAST(pm_mdb.metadata->>'rt_audience_score' AS SMALLINT) AS rt_audience_score,
                CAST(pm_mdb.metadata->>'trakt_score' AS SMALLINT) AS trakt_score,
                CAST(pm_mdb.metadata->>'mal_score' AS NUMERIC) AS mal_score,
                CAST(pm_mdb.metadata->>'mal_votes' AS INTEGER) AS mal_votes,
                pm_mdb.metadata->'streaming_services' AS streaming_services,
                pm_mdb.metadata->'anime_genres' AS anime_genres,
                pm_mdb.metadata->'mdblist_keywords' AS mdblist_keywords,
                pm_mdb.updated_at AS mdblist_last_updated
            FROM media_items mi
            JOIN external_ids ei ON mi.id = ei.media_id
                AND ei.provider = ${getPrimaryExternalIdProvider()}
                AND ei.is_primary = TRUE
            ${buildMetadataLateralJoinFragment(sql)}
            JOIN provider_metadata pm_mdb ON mi.id = pm_mdb.media_id
                AND pm_mdb.provider = 'mdblist'
            WHERE mi.status = 'active'
              AND pm_mdb.metadata->>'mdblist_score' IS NOT NULL
            ORDER BY
                CASE WHEN pm_mdb.metadata->>'mal_score' IS NOT NULL THEN 0 ELSE 1 END,
                CAST(pm_mdb.metadata->>'letterboxd_votes' AS INTEGER) DESC NULLS LAST,
                pm_mdb.updated_at DESC NULLS LAST
            LIMIT 5
        `;

        result.samples = samples.map((s) => ({
            tmdb_id: s.tmdb_id,
            title: s.title,
            media_type: s.media_type,
            year: s.year,
            mdblist_score: s.mdblist_score,
            imdb_rating: toNumberOrNull(s.imdb_rating),
            letterboxd_rating: toNumberOrNull(s.letterboxd_rating),
            letterboxd_votes: s.letterboxd_votes,
            metacritic_score: s.metacritic_score,
            rt_rating: s.rt_rating,
            rt_audience_score: s.rt_audience_score,
            trakt_score: s.trakt_score,
            mal_score: toNumberOrNull(s.mal_score),
            mal_votes: s.mal_votes,
            streaming_services: s.streaming_services,
            anime_genres: s.anime_genres,
            mdblist_keywords: s.mdblist_keywords,
            mdblist_last_updated: s.mdblist_last_updated
                ? s.mdblist_last_updated.toISOString()
                : null,
        }));
    }

    return result;
}

/**
 * Get raw sample data for debugging (5 random movies with all data) - UUID-based tables
 */
export async function getMDBListRawSamples(): Promise<MDBListRawSampleRow[]> {
    const db = new Database();
    const sql = db.getSql();

    const samples = await sql<MDBListRawSampleRow[]>`
        SELECT
            CAST(ei.external_id AS INTEGER) AS tmdb_id,
            mi.title,
            mi.media_type,
            pm.metadata->>'release_date' AS release_date,
            pm.metadata->'genres' AS genres,
            imdb_ext.external_id AS imdb_id,
            CAST(pm.metadata->>'imdb_rating' AS NUMERIC) AS imdb_rating,
            CAST(pm_mdb.metadata->>'rt_rating' AS INTEGER) AS rt_rating,
            pm.metadata->>'certification' AS certification,
            CAST(pm.metadata->>'runtime_minutes' AS INTEGER) AS runtime_minutes,
            pm.metadata->'actors' AS actors,
            pm.metadata->'directors' AS directors,
            CAST(pm_mdb.metadata->>'mdblist_score' AS SMALLINT) AS mdblist_score,
            CAST(pm_mdb.metadata->>'letterboxd_rating' AS NUMERIC) AS letterboxd_rating,
            CAST(pm_mdb.metadata->>'letterboxd_votes' AS INTEGER) AS letterboxd_votes,
            CAST(pm_mdb.metadata->>'metacritic_score' AS SMALLINT) AS metacritic_score,
            CAST(pm_mdb.metadata->>'rt_audience_score' AS SMALLINT) AS rt_audience_score,
            CAST(pm_mdb.metadata->>'trakt_score' AS SMALLINT) AS trakt_score,
            CAST(pm_mdb.metadata->>'mal_score' AS NUMERIC) AS mal_score,
            CAST(pm_mdb.metadata->>'mal_votes' AS INTEGER) AS mal_votes,
            pm_mdb.metadata->'streaming_services' AS streaming_services,
            pm_mdb.metadata->'anime_genres' AS anime_genres,
            pm_mdb.metadata->'mdblist_keywords' AS mdblist_keywords,
            pm_mdb.updated_at AS mdblist_last_updated
        FROM media_items mi
        JOIN external_ids ei ON mi.id = ei.media_id
            AND ei.provider = ${getPrimaryExternalIdProvider()}
            AND ei.is_primary = TRUE
        LEFT JOIN external_ids imdb_ext ON mi.id = imdb_ext.media_id
            AND imdb_ext.provider = 'imdb'
        ${buildMetadataLateralJoinFragment(sql)}
        JOIN provider_metadata pm_mdb ON mi.id = pm_mdb.media_id
            AND pm_mdb.provider = 'mdblist'
        WHERE mi.status = 'active'
          AND pm_mdb.metadata->>'mdblist_score' IS NOT NULL
        ORDER BY RANDOM()
        LIMIT 5
    `;

    return samples;
}

/**
 * Format duration in human readable format
 */
function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
}

/**
 * Enhanced embedding text that includes MDBList ratings
 * Use this when generating new embeddings for richer semantic content
 */
export function createMDBListEnhancedRatingsText(data: {
    imdb_rating?: number | null;
    rt_rating?: number | null; // RT critic score
    rt_audience_score?: number | null;
    letterboxd_rating?: number | null;
    letterboxd_votes?: number | null;
    metacritic_score?: number | null;
    trakt_score?: number | null;
    mal_score?: number | null;
    mal_votes?: number | null;
    mdblist_score?: number | null;
}): string {
    const parts: string[] = [];

    // Determine if this is anime (MAL score present with significant votes)
    const isAnime = data.mal_score && data.mal_votes && data.mal_votes > 1000;

    if (isAnime) {
        // Anime-optimized ratings order: MAL first (authority), then Letterboxd, IMDB
        if (data.mal_score && data.mal_votes) {
            parts.push(
                `MAL: ${data.mal_score.toFixed(1)}/10 (${formatVotes(data.mal_votes)} votes)`,
            );
        }
        if (data.letterboxd_rating && data.letterboxd_votes) {
            parts.push(
                `Letterboxd: ${data.letterboxd_rating.toFixed(1)}/5 (${formatVotes(data.letterboxd_votes)} votes)`,
            );
        }
        if (data.imdb_rating) {
            parts.push(`IMDB: ${data.imdb_rating.toFixed(1)}/10`);
        }
    } else {
        // Standard movies/TV: Letterboxd (cinephile), IMDB, RT, Metacritic
        if (data.letterboxd_rating && data.letterboxd_votes) {
            parts.push(
                `Letterboxd: ${data.letterboxd_rating.toFixed(1)}/5 (${formatVotes(data.letterboxd_votes)} votes)`,
            );
        }
        if (data.imdb_rating) {
            parts.push(`IMDB: ${data.imdb_rating.toFixed(1)}/10`);
        }
        if (data.rt_rating) {
            parts.push(`RT Critics: ${data.rt_rating}%`);
        }
        if (data.rt_audience_score) {
            parts.push(`RT Audience: ${data.rt_audience_score}%`);
        }
        if (data.metacritic_score) {
            parts.push(`Metacritic: ${data.metacritic_score}/100`);
        }
        if (data.trakt_score) {
            parts.push(`Trakt: ${data.trakt_score}%`);
        }
    }

    // Always include aggregate score if available
    if (data.mdblist_score) {
        parts.push(`Aggregate Score: ${data.mdblist_score}/100`);
    }

    return parts.length > 0 ? `Ratings: ${parts.join(', ')}` : '';
}

/**
 * Format vote counts with K/M suffixes
 */
function formatVotes(votes: number): string {
    if (votes >= 1000000) {
        return `${(votes / 1000000).toFixed(1)}M`;
    }
    if (votes >= 1000) {
        return `${(votes / 1000).toFixed(0)}K`;
    }
    return votes.toString();
}

// CLI support
// Gated on LUMASTRA_CLI (set by the npm script), never on
// `import.meta.url === file://${argv[1]}` — see utils/cli-entry.ts.
if (isCliEntry('sync-mdblist')) {
    const args = process.argv.slice(2);
    const limit = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
    const fullRefresh = args.includes('--full');
    const moviesOnly = args.includes('--movies');
    const tvOnly = args.includes('--tv');

    logger.info('Starting MDBList batch sync', {
        limit: limit || 'all',
        fullRefresh,
        moviesOnly,
        tvOnly,
    });

    const mediaType = moviesOnly ? 'movie' : tvOnly ? 'tv' : 'all';

    syncMDBListRatings(
        {
            limit: limit ? parseInt(limit) : undefined,
            onlyMissing: !fullRefresh,
            mediaType,
            delayMs: 500,
        },
        (progress) => {
            if (progress.phase === 'fetching' || progress.phase === 'updating') {
                const pct =
                    progress.total > 0
                        ? Math.round((progress.processed / progress.total) * 100)
                        : 0;
                process.stdout.write(
                    `\r[${progress.phase}] ${progress.processed}/${progress.total} (${pct}%) - Updated: ${progress.updated}, Skipped: ${progress.skipped}${progress.eta ? ` - ETA: ${progress.eta}` : ''}    `,
                );
            }
        },
    )
        .then((result) => {
            logger.info('MDBList batch sync completed', {
                processed: result.processed,
                updated: result.updated,
                skipped: result.skipped,
                errors: result.errors.length,
                duration: `${(result.duration_ms / 1000).toFixed(1)}s`,
                sampleErrors: result.errors.slice(0, 10),
            });
            process.exit(result.errors.length > 10 ? 1 : 0);
        })
        .catch((error) => {
            logger.error('Sync failed', error instanceof Error ? error : undefined);
            process.exit(1);
        });
}
