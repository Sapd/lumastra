// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding-Only Generator
 *
 * Phase 2 of the new architecture: Embedding Generation
 *
 * This module reads metadata from the database and generates embeddings.
 * It does NOT fetch external data - that's handled by the metadata sync modules.
 *
 * The separation allows:
 * 1. Metadata to be collected from all sources first (Jellyfin, TMDB, MDBList)
 * 2. Embeddings to be generated once with complete data
 * 3. No circular dependencies or multiple passes needed
 *
 * Key principle: Always use composite key (tmdb_id, media_type) since TMDB IDs are NOT unique across media types.
 */

import type postgres from 'postgres';
import { Database } from '../database/connection';
import { generateTextEmbedding, EMBEDDING_DIMENSION } from './openai';
import { Logger } from '../utils/logger';
import { isCliEntry } from '../utils/cli-entry.js';
import {
    buildEmbeddingTextFields,
    buildMetadataLateralJoin,
} from '../database/queries/media-queries.js';
import {
    upsertMediaEmbedding,
    upsertExclusiveRecommendationEmbedding,
} from '../database/queries/ai-sync.queries.js';
import { markSkippedPermanentBatch } from '../database/queries/stage-state.queries.js';
import type { GenerationProgress } from './embedding-utils';
import dotenv from 'dotenv';
import { isMovie } from '../utils/media-types';
import { filterKeywords } from './embedding-text-formatter';
import { getPrimaryExternalIdProvider } from '../utils/provider-config.js';
import { EMBEDDING_SOURCE, type EmbeddingSource } from '../utils/embedding-source';
import {
    AVAILABILITY_EXISTS,
    CAN_REQUEST_EXISTS,
} from '$lib/server/database/queries/availability.queries.js';
import {
    createMusicEmbeddingText,
    type MusicTrackMetadata,
} from './music-embedding-text-formatter.js';

dotenv.config({ quiet: true });

const logger = Logger.for('EmbeddingOnlyGenerator');

// Genre ID to name mapping
const GENRE_MAP: Record<number, string> = {
    // Movies
    28: 'Action',
    12: 'Adventure',
    16: 'Animation',
    35: 'Comedy',
    80: 'Crime',
    99: 'Documentary',
    18: 'Drama',
    10751: 'Family',
    14: 'Fantasy',
    36: 'History',
    27: 'Horror',
    10402: 'Music',
    9648: 'Mystery',
    10749: 'Romance',
    878: 'Science Fiction',
    10770: 'TV Movie',
    53: 'Thriller',
    10752: 'War',
    37: 'Western',
    // TV
    10759: 'Action & Adventure',
    10762: 'Kids',
    10763: 'News',
    10764: 'Reality',
    10765: 'Sci-Fi & Fantasy',
    10766: 'Soap',
    10767: 'Talk',
    10768: 'War & Politics',
};

export interface EmbeddingGeneratorOptions {
    /** Target embedding type: LIBRARY for available content, DISCOVERY for requestable content */
    target: EmbeddingSource;
    /** Only process entries without embeddings */
    missingOnly?: boolean;
    /** Force regenerate all embeddings */
    force?: boolean;
    /** Only process entries that have MDBList keywords */
    requireMdblistTags?: boolean;
    /** Batch size for processing */
    batchSize?: number;
    /** Progress callback */
    onProgress?: (progress: GenerationProgress) => void;
    /** Abort callback */
    shouldAbort?: () => boolean;
    /**
     * Optional callback invoked after each item's embedding is successfully
     * stored. Used by the task wrapper to write a coverage-table completion
     * row without coupling the generator to stage-state semantics.
     */
    onSuccess?: (mediaItemId: string) => Promise<void>;
    /**
     * Optional override for the candidate query. When provided, the generator
     * scopes its backlog to only the items returned by this callback instead of
     * using the legacy embedding-presence predicate. Used by task wrappers to
     * drive the generator from `media_item_stage_state` when the coverage-table
     * flag is on.
     */
    candidateSource?: (sql: postgres.Sql, limit: number) => Promise<Array<{ id: string }>>;
    /**
     * Stage ID associated with `candidateSource`. When set, items that the
     * `candidateSource` returns but the downstream legacy SQL predicate filters
     * out (e.g. discovery target vs library availability mismatch) are marked
     * `skipped_transient` with a retry delay so they don't keep coming back on
     * every drain tick. Without this reconciliation step those rows stay
     * `pending` forever — a permanent drift class.
     */
    stageId?: string;
    /** Optional task-pool SQL handle. When provided, queries run on the task pool instead of the web pool. */
    sql?: postgres.Sql | null;
}

export interface EmbeddingGeneratorResult {
    success: boolean;
    totalEntries: number;
    processed: number;
    generated: number;
    skipped: number;
    errors: number;
    message: string;
    tokensUsed: number;
}

export interface MediaEntry {
    primary_ext_id: string;
    media_type: 'movie' | 'tv' | 'artist' | 'album' | 'track';
    title: string;
    overview?: string;
    release_date?: Date;
    runtime_minutes?: number;
    genres?: number[];
    keywords?: string[];
    mdblist_keywords?: string[];
    networks?: string[];
    production_companies?: string[];
    actors?: string[];
    directors?: string[];
    producers?: string[];
    writers?: string[];
    imdb_rating?: number;
    tmdb_rating?: number;
    mdblist_score?: number;
    letterboxd_rating?: number;
    rt_rating?: number;
    anime_genres?: string[];
    streaming_services?: string[];
    is_available?: boolean;
    can_request?: boolean;
    library_embedding?: number[] | string;
    discovery_embedding?: number[] | string;
    // Music-specific fields extracted from custom_metadata JSONB
    custom_metadata?: Record<string, unknown> | null;
}

/**
 * Extract music track metadata from a MediaEntry's custom_metadata JSONB field.
 * Used when media_type is 'music' or 'audio'.
 */
function extractMusicMetadata(entry: MediaEntry): MusicTrackMetadata {
    const cm = entry.custom_metadata;
    const ess: Record<string, unknown> | undefined =
        cm && typeof cm.essentia === 'object' && cm.essentia !== null
            ? (cm.essentia as Record<string, unknown>)
            : undefined;
    const toStringVal = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const toNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
    const toStringArray = (v: unknown): string[] | undefined => {
        if (!Array.isArray(v)) return undefined;
        const result = v.filter((s): s is string => typeof s === 'string');
        return result.length > 0 ? result : undefined;
    };

    return {
        title: entry.title,
        artist: toStringVal(cm?.['artist']) ?? 'Unknown Artist',
        albumArtist: toStringVal(cm?.['album_artist']),
        album: toStringVal(cm?.['album']),
        genre: toStringArray(cm?.['genres']),
        year: entry.release_date
            ? new Date(entry.release_date).getFullYear()
            : toNumber(cm?.['year']),
        bpm: toNumber(ess?.['bpm']),
        key: toStringVal(ess?.['key']),
        energy: toNumber(ess?.['energy']),
        danceability: toNumber(ess?.['danceability']),
        moodTags: toStringArray(ess?.['mood_tags']),
        relatedArtists: toStringArray(cm?.['related_artists']),
    };
}

/**
 * Create embedding text from a media entry with all available metadata
 */
export function createEmbeddingText(entry: MediaEntry): string {
    // Music tracks use a dedicated formatter optimized for audio similarity
    if (
        entry.media_type === 'artist' ||
        entry.media_type === 'album' ||
        entry.media_type === 'track'
    ) {
        const musicMeta = extractMusicMetadata(entry);
        return createMusicEmbeddingText(musicMeta);
    }

    const parts: string[] = [];

    // Title
    parts.push(`Title: ${entry.title}`);

    // Media type
    parts.push(`Type: ${isMovie(entry.media_type) ? 'Movie' : 'TV Series'}`);

    // Overview/description
    if (entry.overview) {
        parts.push(`Description: ${entry.overview}`);
    }

    // Year
    if (entry.release_date) {
        const year = new Date(entry.release_date).getFullYear();
        if (!Number.isNaN(year)) {
            parts.push(`Year: ${year}`);
        }
    }

    // Genres (from TMDB genre IDs)
    if (entry.genres?.length) {
        const genreNames = entry.genres.map((id) => GENRE_MAP[id]).filter(Boolean);
        if (genreNames.length) {
            parts.push(`Genres: ${genreNames.join(', ')}`);
        }
    }

    // MDBList keywords (high value for recommendations). filterKeywords drops the
    // ~900 noise tags (blu-ray, award-winner, body parts, etc.) + dedups stems so
    // they don't pollute the embedding's semantic space.
    const mdblistKeywords = filterKeywords(entry.mdblist_keywords ?? []);
    if (mdblistKeywords.length) {
        parts.push(`Keywords: ${mdblistKeywords.join(', ')}`);
    }

    // Regular keywords (filtered + de-duplicated against the mdblist set)
    if (entry.keywords?.length) {
        const mdbSet = new Set(mdblistKeywords);
        const uniqueKeywords = filterKeywords(entry.keywords).filter((k) => !mdbSet.has(k));
        if (uniqueKeywords.length) {
            parts.push(`Themes: ${uniqueKeywords.join(', ')}`);
        }
    }

    // Anime genres (from MDBList)
    if (entry.anime_genres?.length) {
        const animeTags = filterKeywords(entry.anime_genres);
        if (animeTags.length) {
            parts.push(`Anime Tags: ${animeTags.join(', ')}`);
        }
    }

    // Multi-source ratings — a strong taste signal (e.g. high Letterboxd + low
    // TMDB ⇒ arthouse). Only IMDB/TMDB were captured before; include the others
    // when present.
    const ratingBits: string[] = [];
    if (entry.imdb_rating) ratingBits.push(`IMDB ${entry.imdb_rating.toFixed(1)}`);
    if (entry.tmdb_rating) ratingBits.push(`TMDB ${entry.tmdb_rating.toFixed(1)}`);
    if (entry.rt_rating) ratingBits.push(`RT ${Math.round(entry.rt_rating)}%`);
    if (entry.letterboxd_rating)
        ratingBits.push(`Letterboxd ${entry.letterboxd_rating.toFixed(1)}`);
    if (ratingBits.length) {
        parts.push(`Ratings: ${ratingBits.join(', ')}`);
    }

    // Cast and crew
    if (entry.directors?.length) {
        parts.push(`Directors: ${entry.directors.join(', ')}`);
    }
    if (entry.actors?.length) {
        parts.push(`Cast: ${entry.actors.slice(0, 8).join(', ')}`);
    }
    if (entry.writers?.length) {
        parts.push(`Writers: ${entry.writers.join(', ')}`);
    }

    // Networks (for TV)
    if (entry.networks?.length) {
        parts.push(`Networks: ${entry.networks.join(', ')}`);
    }

    // Production companies
    if (entry.production_companies?.length) {
        parts.push(`Studios: ${entry.production_companies.slice(0, 3).join(', ')}`);
    }

    // Runtime (useful for mood matching)
    if (entry.runtime_minutes) {
        if (entry.runtime_minutes < 90) {
            parts.push('Length: Short');
        } else if (entry.runtime_minutes < 150) {
            parts.push('Length: Standard');
        } else {
            parts.push('Length: Long');
        }
    }

    // Streaming availability (useful context)
    if (entry.streaming_services?.length) {
        parts.push(`Available on: ${entry.streaming_services.slice(0, 3).join(', ')}`);
    }

    return parts.join('. ');
}

/**
 * Generate embeddings for entries in the database
 */
export async function generateEmbeddingsFromDB(
    options: EmbeddingGeneratorOptions,
): Promise<EmbeddingGeneratorResult> {
    const {
        target,
        missingOnly = true,
        force = false,
        requireMdblistTags = false,
        batchSize = 10,
        onProgress,
        shouldAbort,
        onSuccess,
        candidateSource,
        stageId,
    } = options;

    logger.info('Starting embedding generation from database', {
        target,
        missingOnly,
        force,
        requireMdblistTags,
    });

    const db = new Database(options.sql);
    const sql = db.getSql();

    const progress: GenerationProgress = {
        phase: 'fetching',
        totalItems: 0,
        processedItems: 0,
        currentSubStatus: 'Querying entries to process...',
        errors: [],
        recentLogs: [`Starting ${target} embedding generation`],
        startTime: new Date(),
        created: 0,
        updated: 0,
        skipped: 0,
        errorCount: 0,
        progressPercentage: 0,
    };

    onProgress?.(progress);

    try {
        // When a candidateSource is provided (coverage-table-driven mode), fetch
        // the candidate IDs upfront and scope every subsequent query to just
        // those items. The limit passed is `batchSize * 10` so a single call
        // pre-fills a reasonable work queue; the cursor-based loop below then
        // pages through them in the usual way.
        let candidateIds: string[] | null = null;
        if (candidateSource) {
            const rows = await candidateSource(sql, batchSize * 10);
            if (rows.length === 0) {
                return {
                    success: true,
                    totalEntries: 0,
                    processed: 0,
                    generated: 0,
                    skipped: 0,
                    errors: 0,
                    message: 'No entries found in coverage table backlog',
                    tokensUsed: 0,
                };
            }
            candidateIds = rows.map((r) => r.id);
        }

        // Build query conditions for UUID-based tables
        // availabilityFilter maps to: LIBRARY = has media_file_items, DISCOVERY = no media_file_items
        const availabilityJoin =
            target === EMBEDDING_SOURCE.LIBRARY
                ? '' // Filtered via WHERE EXISTS below
                : '';

        const availabilityCondition =
            target === EMBEDDING_SOURCE.LIBRARY
                ? `AND ${AVAILABILITY_EXISTS}`
                : `AND ${CAN_REQUEST_EXISTS}`;

        const embeddingJoin =
            target === EMBEDDING_SOURCE.LIBRARY
                ? `LEFT JOIN media_embeddings emb ON emb.media_id = mi.id AND emb.source = '${EMBEDDING_SOURCE.LIBRARY}'`
                : `LEFT JOIN media_embeddings emb ON emb.media_id = mi.id AND emb.source = '${EMBEDDING_SOURCE.DISCOVERY}'`;

        // Re-embed when: no embedding exists, OR provider_metadata was updated
        // after the embedding (metadata-sync filled in actors/keywords), OR
        // media_items itself was updated after the embedding. The latter
        // covers two cases the pm-only check missed:
        //   1. Music items, which have no provider_metadata row — their
        //      embedding text comes from media_items.custom_metadata
        //      (artist/album/year/essentia tags), so admin edits via
        //      /api/admin/media/[id]/metadata bump mi.updated_at and need
        //      to trigger re-embedding.
        //   2. Direct media_items writes (title/overview/year) on paths
        //      that don't touch provider_metadata at all.
        // False positives (re-embedding when a non-embedding field changes)
        // are rare in practice and cost one extra OpenAI call each.
        const embeddingCondition =
            missingOnly && !force
                ? 'AND (emb.id IS NULL OR pm.updated_at > emb.updated_at OR mi.updated_at > emb.updated_at)'
                : '';

        const mdblistCondition = requireMdblistTags
            ? "AND pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_array_length(pm.metadata->'mdblist_keywords') > 0"
            : '';

        // When candidateIds are set, scope to only those items so the coverage-table
        // read path drives the backlog instead of the legacy embedding-presence predicate.
        // Parameterized form mirrors the canonical pattern used by mdblist-sync — the
        // array is bound as `$1::uuid[]` so postgres handles UUID validation.
        const candidateCountCondition = candidateIds ? `AND mi.id = ANY($1::uuid[])` : '';
        const countParams: string[][] = candidateIds ? [candidateIds] : [];

        // Count total entries to process using UUID-based tables
        // ESLint exception: sql.unsafe() required for dynamic JOIN fragments (availabilityJoin,
        // embeddingJoin, mdblistCondition). All fragments are server-side config strings — no
        // user input. Documented in docs/dev/eslint-exceptions.md.
        const countResult = await sql.unsafe(
            `
            SELECT COUNT(DISTINCT mi.id) as count
            FROM media_items mi
            ${availabilityJoin}
            ${embeddingJoin}
            ${buildMetadataLateralJoin()}
            WHERE mi.status = 'active'
            ${availabilityCondition}
            ${embeddingCondition}
            ${mdblistCondition}
            ${candidateCountCondition}
        `,
            countParams,
        );
        const totalCount = parseInt(countResult[0].count, 10);

        logger.info('Entries to process', { count: totalCount, target });

        if (totalCount === 0) {
            // Reconcile drift: if `candidateSource` returned items but the
            // legacy fetch predicate dropped them all, mark every candidate
            // as `skipped_transient` so they don't keep coming back on every
            // sweep tick.
            if (candidateIds && stageId && candidateIds.length > 0) {
                try {
                    const updated = await markSkippedPermanentBatch(sql, {
                        stageId,
                        mediaItemIds: candidateIds,
                        skippedReason: 'ineligible-by-legacy-filter',
                    });
                    logger.info('Reconciled empty-fetch coverage drift via skipped_transient', {
                        stageId,
                        candidates: candidateIds.length,
                        rowsUpdated: updated,
                    });
                } catch (err) {
                    logger.warn(
                        'Failed to mark drift items as skipped_transient (empty-fetch path)',
                        {
                            stageId,
                            unprocessedCount: candidateIds.length,
                            error: (err as Error).message,
                        },
                    );
                }
            }
            return {
                success: true,
                totalEntries: 0,
                processed: 0,
                generated: 0,
                skipped: 0,
                errors: 0,
                message: 'No entries found matching criteria',
                tokensUsed: 0,
            };
        }

        progress.totalItems = totalCount;
        progress.phase = 'generating';
        progress.currentSubStatus = 'Generating embeddings...';
        onProgress?.(progress);

        let generated = 0;
        let skipped = 0;
        let errors = 0;
        let tokensUsed = 0;
        let lastProcessedId: string | null = null;
        const provider = getPrimaryExternalIdProvider();
        // Tracks IDs the fetch query actually returned, so we can reconcile
        // (mark `skipped_transient`) the items that `candidateSource` returned
        // but the downstream SQL predicate dropped.
        const processedIds = new Set<string>();

        // Process in batches using cursor-based pagination
        // (OFFSET-based pagination doesn't work when the query modifies its own results)
        while (true) {
            if (shouldAbort?.()) {
                logger.info('Generation aborted by user');
                progress.phase = 'error';
                progress.currentSubStatus = 'Aborted by user';
                onProgress?.(progress);
                break;
            }

            // Cursor pagination is parameterized via $N to match the
            // candidate-ids array binding. When candidateIds is set, slot $1
            // is bound to the array and the cursor uses $2; otherwise the
            // cursor uses $1.
            const cursorPlaceholder = candidateIds ? '$2' : '$1';
            const cursorCondition: string = lastProcessedId
                ? `AND mi.id > ${cursorPlaceholder}::uuid`
                : '';
            const fetchParams: Array<string | string[]> = candidateIds
                ? lastProcessedId
                    ? [candidateIds, lastProcessedId]
                    : [candidateIds]
                : lastProcessedId
                  ? [lastProcessedId]
                  : [];
            const candidateFetchCondition = candidateIds ? `AND mi.id = ANY($1::uuid[])` : '';

            // Fetch batch of entries using UUID-based tables
            // Uses scalar subquery for TMDB ID to avoid duplicate rows from external_ids
            // ESLint exception: sql.unsafe() required for dynamic JOIN fragments and cursor
            // condition. Provider value (`${provider}`) is server config, not user input.
            // Documented in docs/dev/eslint-exceptions.md.
            const entries = await sql.unsafe<(MediaEntry & { media_id: string })[]>(
                `
                SELECT
                    mi.id as media_id,
                    (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = '${provider}' LIMIT 1) as primary_ext_id,
                    mi.media_type,
                    mi.title,
                    pm.metadata->>'overview' as overview,
                    CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999 THEN make_date(mi.year, 1, 1) ELSE NULL END as release_date,
                    (pm.metadata->>'runtime_minutes')::integer as runtime_minutes,
                    CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                        THEN ARRAY(SELECT (elem->>'id')::integer FROM jsonb_array_elements(pm.metadata->'genres') AS elem)
                        ELSE NULL
                    END as genres,
                    CASE WHEN pm.metadata->'keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'keywords') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'keywords') AS elem)
                        ELSE NULL
                    END as keywords,
                    CASE WHEN pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'mdblist_keywords') AS elem)
                        ELSE NULL
                    END as mdblist_keywords,
                    CASE WHEN pm.metadata->'networks' IS NOT NULL AND jsonb_typeof(pm.metadata->'networks') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'networks') AS elem)
                        ELSE NULL
                    END as networks,
                    CASE WHEN pm.metadata->'production_companies' IS NOT NULL AND jsonb_typeof(pm.metadata->'production_companies') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'production_companies') AS elem)
                        ELSE NULL
                    END as production_companies,
                    CASE WHEN pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'actors') AS elem)
                        ELSE NULL
                    END as actors,
                    CASE WHEN pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'directors') AS elem)
                        ELSE NULL
                    END as directors,
                    CASE WHEN pm.metadata->'producers' IS NOT NULL AND jsonb_typeof(pm.metadata->'producers') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'producers') AS elem)
                        ELSE NULL
                    END as producers,
                    CASE WHEN pm.metadata->'writers' IS NOT NULL AND jsonb_typeof(pm.metadata->'writers') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'writers') AS elem)
                        ELSE NULL
                    END as writers,
                    (pm.metadata->>'imdb_rating')::float as imdb_rating,
                    (pm.metadata->>'tmdb_rating')::float as tmdb_rating,
                    (pm.metadata->>'mdblist_score')::float as mdblist_score,
                    (pm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
                    (pm.metadata->>'rt_rating')::integer as rt_rating,
                    CASE WHEN pm.metadata->'anime_genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'anime_genres') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'anime_genres') AS elem)
                        ELSE NULL
                    END as anime_genres,
                    CASE WHEN pm.metadata->'streaming_services' IS NOT NULL AND jsonb_typeof(pm.metadata->'streaming_services') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'streaming_services') AS elem)
                        ELSE NULL
                    END as streaming_services,
                    ${AVAILABILITY_EXISTS} AS is_available,
                    ${CAN_REQUEST_EXISTS} AS can_request,
                    mi.custom_metadata,
                    ${buildEmbeddingTextFields()}
                FROM media_items mi
                ${availabilityJoin}
                ${embeddingJoin}
                ${buildMetadataLateralJoin()}
                LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id AND lib_emb.source = '${EMBEDDING_SOURCE.LIBRARY}'
                LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id AND disc_emb.source = '${EMBEDDING_SOURCE.DISCOVERY}'
                WHERE mi.status = 'active'
                ${availabilityCondition}
                ${embeddingCondition}
                ${mdblistCondition}
                ${candidateFetchCondition}
                ${cursorCondition}
                ORDER BY mi.id
                LIMIT ${batchSize}
            `,
                fetchParams,
            );

            if (entries.length === 0) break;

            // Track which candidate IDs were actually returned by this batch,
            // for the post-loop reconciliation step.
            for (const entry of entries) {
                processedIds.add(entry.media_id);
            }

            // Process each entry
            for (const entry of entries) {
                if (shouldAbort?.()) break;

                try {
                    // Skip if already has embedding (unless force).
                    //
                    // Drift class: the media_embeddings row exists but the
                    // coverage row is still `pending` — most likely the
                    // generator wrote the embedding in a previous run but
                    // onSuccess (upsertCompletedRow) failed silently.
                    // Catch-up by calling onSuccess here so the row goes
                    // to `completed` instead of cycling pending forever.
                    const hasEmbedding =
                        target === EMBEDDING_SOURCE.LIBRARY
                            ? entry.library_embedding !== null
                            : entry.discovery_embedding !== null;

                    if (hasEmbedding && !force) {
                        skipped++;
                        progress.skipped = skipped;
                        progress.processedItems++;
                        if (onSuccess) {
                            try {
                                await onSuccess(entry.media_id);
                            } catch {
                                // Best-effort — already-skipped items aren't critical
                            }
                        }
                        continue;
                    }

                    // Create embedding text
                    const embeddingText = createEmbeddingText(entry);

                    // Permanent-skip when the embedding text is too short to
                    // produce a meaningful vector. Most common cause: an
                    // item that has a row in `media_items` but no
                    // `provider_metadata` yet — title alone is all we have,
                    // and OpenAI embeddings on a single short German release
                    // group string ("Pokemon.S09E40.German.1080p…") would
                    // cluster everything by codec/release-group rather than
                    // by content.
                    //
                    // Mark skipped_permanent here so the row stops cycling
                    // through this loop on every sweep tick. The stage's
                    // `invalidatedBy` includes `metadata.changed` —
                    // when provider_metadata eventually arrives via
                    // tmdb-metadata-sync / metadata-update, the DB trigger
                    // fires the event, the dispatcher flips the row back to
                    // pending, and the embedding finally runs with real text.
                    if (!embeddingText || embeddingText.length < 20) {
                        logger.warn('Insufficient text for embedding', {
                            tmdbId: entry.primary_ext_id,
                            mediaType: entry.media_type,
                            textLength: embeddingText?.length,
                        });
                        skipped++;
                        progress.skipped = skipped;
                        progress.processedItems++;
                        if (stageId) {
                            try {
                                await markSkippedPermanentBatch(sql, {
                                    stageId,
                                    mediaItemIds: [entry.media_id],
                                    skippedReason: 'insufficient-text-for-embedding',
                                });
                            } catch (markErr) {
                                logger.warn(
                                    'Failed to mark insufficient-text-for-embedding skipped',
                                    {
                                        stageId,
                                        mediaId: entry.media_id,
                                        error: (markErr as Error).message,
                                    },
                                );
                            }
                        }
                        continue;
                    }

                    // Generate embedding using the pre-built embedding text
                    const embedding = await generateTextEmbedding(embeddingText, (t) => {
                        // Guard a malformed provider usage value: a single NaN
                        // would poison tokensUsed for the whole run, so the
                        // end-of-run ctx.spend('openai_tokens') would be dropped.
                        if (Number.isFinite(t)) tokensUsed += t;
                    });

                    if (!embedding || embedding.length !== EMBEDDING_DIMENSION) {
                        throw new Error(`Invalid embedding dimension: ${embedding?.length}`);
                    }

                    // Store embedding in UUID-based media_embeddings table
                    const mediaId = (entry as MediaEntry & { media_id: string }).media_id;

                    // Upsert embedding into media_embeddings table.
                    //
                    // library- and discovery-embeddings are mutually exclusive
                    // by has_files (an item is eligible for exactly one source).
                    // When has_files flips, the item migrates between sources;
                    // writing the new source AND deleting the stale opposite one
                    // atomically prevents an item from transiently holding both
                    // (one fresh, one stale) — which would let weighted-fusion
                    // similarity blend a stale vector into the score (F74 drift).
                    // MUSIC embeddings are not part of this pair, so they take
                    // the plain upsert.
                    if (
                        target === EMBEDDING_SOURCE.LIBRARY ||
                        target === EMBEDDING_SOURCE.DISCOVERY
                    ) {
                        await upsertExclusiveRecommendationEmbedding(
                            sql,
                            mediaId,
                            target,
                            embedding,
                        );
                    } else {
                        await upsertMediaEmbedding(sql, mediaId, target, embedding);
                    }

                    if (onSuccess) {
                        try {
                            await onSuccess(mediaId);
                        } catch {
                            // Non-fatal — coverage write failure must not abort embedding generation
                        }
                    }

                    generated++;
                    progress.created = generated;
                    progress.currentItem = entry.title;
                    progress.processedItems++;
                    progress.progressPercentage = Math.round(
                        (progress.processedItems / progress.totalItems) * 100,
                    );

                    // Rate limit
                    await new Promise((resolve) => setTimeout(resolve, 100));
                } catch (error) {
                    errors++;
                    progress.errorCount = errors;
                    progress.errors.push(`${entry.title}: ${(error as Error).message}`);
                    logger.error('Failed to generate embedding', error as Error, {
                        tmdbId: entry.primary_ext_id,
                        mediaType: entry.media_type,
                        title: entry.title,
                    });
                    progress.processedItems++;
                }
            }

            // Update cursor to last processed item's ID
            if (entries.length > 0) {
                lastProcessedId = entries[entries.length - 1].media_id;
            }
            onProgress?.(progress);
        }

        // Reconcile drift: items that `candidateSource` returned but the
        // downstream fetch query filtered out (e.g. discovery target vs
        // library availability mismatch, MDBList-only filter mismatch) get a
        // `skipped_permanent` row keyed on the same reason — invalidation
        // events (`file.attached` / `file.contentChanged` / `metadata.changed`
        // / `identity.*`) re-flip the row to `pending` automatically. The
        // earlier `skipped_transient + 6h retry` shape cycled forever for
        // items whose legacy-filter outcome never changes on its own: at
        // each retry the candidate source picked them up, the filter
        // rejected them, the row got marked transient with a new retry,
        // and the dashboard "pending" counter never drained. Permanent +
        // event-driven recovery is the durable shape.
        if (candidateIds && stageId && !shouldAbort?.()) {
            const unprocessed = candidateIds.filter((id) => !processedIds.has(id));
            if (unprocessed.length > 0) {
                try {
                    const updated = await markSkippedPermanentBatch(sql, {
                        stageId,
                        mediaItemIds: unprocessed,
                        skippedReason: 'ineligible-by-legacy-filter',
                    });
                    logger.info('Reconciled coverage drift via skipped_permanent', {
                        stageId,
                        candidates: candidateIds.length,
                        processed: processedIds.size,
                        unprocessed: unprocessed.length,
                        rowsUpdated: updated,
                    });
                } catch (err) {
                    // Non-fatal — reconciliation failure must not abort the run.
                    logger.warn('Failed to mark drift items as skipped_transient', {
                        stageId,
                        unprocessedCount: unprocessed.length,
                        error: (err as Error).message,
                    });
                }
            }
        }

        // Final result
        progress.phase = 'completed';
        progress.currentSubStatus = `Completed: ${generated} generated, ${skipped} skipped, ${errors} errors`;
        onProgress?.(progress);

        const result: EmbeddingGeneratorResult = {
            success: true,
            totalEntries: totalCount,
            processed: progress.processedItems,
            generated,
            skipped,
            errors,
            message: `Successfully generated ${generated} ${target} embeddings`,
            tokensUsed,
        };

        logger.info('Embedding generation completed', result);
        return result;
    } catch (error) {
        logger.error('Fatal error in embedding generation', error as Error);
        progress.phase = 'error';
        progress.errors.push((error as Error).message);
        onProgress?.(progress);

        throw error;
    }
}

/**
 * Class-based generator for progress tracking
 */
export class EmbeddingOnlyGenerator {
    private currentProgress: GenerationProgress | null = null;
    private aborted = false;
    private isRunning = false;

    async generate(options: EmbeddingGeneratorOptions): Promise<EmbeddingGeneratorResult> {
        if (this.aborted) {
            throw new Error('Generator has been aborted');
        }

        if (this.isRunning) {
            throw new Error('Generation is already running');
        }

        this.isRunning = true;
        this.aborted = false;
        this.currentProgress = {
            phase: 'fetching',
            totalItems: 0,
            processedItems: 0,
            currentSubStatus: 'Initializing...',
            errors: [],
            recentLogs: [`Starting ${options.target} embedding generation`],
            startTime: new Date(),
            created: 0,
            updated: 0,
            skipped: 0,
            errorCount: 0,
            progressPercentage: 0,
        };

        try {
            const result = await generateEmbeddingsFromDB({
                ...options,
                shouldAbort: () => this.aborted,
                onProgress: (progress) => {
                    this.currentProgress = { ...progress };
                    options.onProgress?.(progress);
                },
                onSuccess: options.onSuccess,
            });

            this.isRunning = false;
            return result;
        } catch (error) {
            this.isRunning = false;
            if (this.currentProgress) {
                this.currentProgress.phase = 'error';
                this.currentProgress.errors.push((error as Error).message);
            }
            throw error;
        }
    }

    getProgress(): GenerationProgress {
        if (!this.currentProgress) {
            return {
                phase: 'initializing',
                totalItems: 0,
                processedItems: 0,
                currentSubStatus: 'Initializing...',
                errors: [],
                recentLogs: [],
                startTime: new Date(),
                created: 0,
                updated: 0,
                skipped: 0,
                errorCount: 0,
                progressPercentage: 0,
            };
        }
        return this.currentProgress;
    }

    async abort(): Promise<void> {
        this.aborted = true;
        if (this.currentProgress) {
            this.currentProgress.phase = 'aborted';
            this.currentProgress.errors.push('Generation aborted by user');
        }
    }

    isAborted(): boolean {
        return this.aborted;
    }

    isGenerating(): boolean {
        return this.isRunning;
    }
}

// Convenience functions
export async function generateLibraryEmbeddingsFromDB(
    options: Omit<EmbeddingGeneratorOptions, 'target'> = {},
) {
    return generateEmbeddingsFromDB({
        ...options,
        target: EMBEDDING_SOURCE.LIBRARY,
    });
}

export async function generateDiscoveryEmbeddingsFromDB(
    options: Omit<EmbeddingGeneratorOptions, 'target'> = {},
) {
    return generateEmbeddingsFromDB({
        ...options,
        target: EMBEDDING_SOURCE.DISCOVERY,
    });
}

// CLI support
// Gated on LUMASTRA_CLI (set by the npm script), never on
// `import.meta.url === file://${argv[1]}` — see utils/cli-entry.ts.
if (isCliEntry('embedding-only-generator')) {
    const target = process.argv.includes('--discovery')
        ? EMBEDDING_SOURCE.DISCOVERY
        : EMBEDDING_SOURCE.LIBRARY;
    const force = process.argv.includes('--force');
    const requireMdblist = process.argv.includes('--require-mdblist');

    generateEmbeddingsFromDB({
        target,
        force,
        requireMdblistTags: requireMdblist,
        missingOnly: !force,
        onProgress: (progress) => {
            logger.info('Progress', {
                phase: progress.phase,
                processedItems: progress.processedItems,
                totalItems: progress.totalItems,
                percentage: progress.progressPercentage,
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
