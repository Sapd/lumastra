// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Embedding Generator
 *
 * Generates embeddings for audio tracks using metadata from custom_metadata JSONB.
 * Uses the music-specific text formatter and stores with source = 'music'.
 */

import type postgres from 'postgres';
import { generateTextEmbedding, EMBEDDING_DIMENSION } from './openai.js';
import { createMusicEmbeddingText } from './music-embedding-text-formatter.js';
import type { MusicTrackMetadata } from './music-embedding-text-formatter.js';
import { upsertMediaEmbedding } from '../database/queries/ai-sync.queries.js';
import { markSkippedTransientBatch } from '../database/queries/stage-state.queries.js';
import { aiDbService } from '../services/database.service.js';
import { Logger } from '../utils/logger.js';
import { config } from '../config.js';

// Retry delay for tracks that pass through `candidateSource` but the fetch
// query drops (e.g. parent-album linkage missing, not a `track` row).
// 6 hours: long enough to avoid sweep-tick hot loops, short enough that
// fixing the underlying drift (file relinked, parent inferred) is picked up
// the same business day. Invalidation events flip the row back to `pending`
// immediately and bypass this window.
const LEGACY_FILTER_SKIP_RETRY_MS = 6 * 60 * 60 * 1000;

const logger = Logger.for('MusicEmbeddingGenerator');

// Whitelist matches PopularitySource in services/popularity/types.ts. Validated
// here to keep the downstream sql.unsafe() call injection-proof even if the
// config schema were bypassed.
const VALID_POPULARITY_SOURCES = new Set<string>(['lastfm']);

interface MusicEmbeddingResult {
    success: boolean;
    total: number;
    generated: number;
    skipped: number;
    errors: number;
    message: string;
    tokensUsed: number;
}

/**
 * Generate embeddings for all audio tracks that don't have one yet.
 *
 * When `itemIds` is supplied, the candidate set is scoped to just those
 * media_item IDs — used by the music-analysis → music-embedding-generation
 * chain so an incremental run only re-embeds the tracks that were actually
 * (re)analyzed, instead of sweeping every stale track in the library.
 */
export async function generateMusicEmbeddings(options?: {
    force?: boolean;
    batchSize?: number;
    itemIds?: string[];
    onProgress?: (processed: number, total: number) => void;
    /**
     * Optional abort predicate, polled between batches and between tracks
     * within a batch (before each OpenAI embedding call). When it returns
     * true the function exits cleanly with whatever has been written so far
     * — same `success: errors === 0` shape as natural completion, with the
     * `message` indicating the abort.
     *
     * Wired by the music-embedding-generation task wrapper to ctx.signal so
     * admin Cancel stops the OpenAI token burn instead of letting the
     * full-library sweep continue to the soft-budget timeout.
     */
    shouldAbort?: () => boolean;
    /**
     * Optional callback invoked after each track's embedding is successfully
     * stored. Used by the task wrapper to write a coverage-table completion
     * row without coupling the generator to stage-state semantics.
     */
    onSuccess?: (trackId: string) => Promise<void>;
    /**
     * Optional override for the candidate query. When provided, the generator
     * resolves its backlog from this callback (coverage-table-driven mode) and
     * uses the returned IDs as an `itemIds` scope instead of the legacy
     * embedding-presence predicate. The `limit` passed is `batchSize * 10`.
     */
    candidateSource?: (sql: postgres.Sql, limit: number) => Promise<Array<{ id: string }>>;
    /**
     * Stage ID associated with `candidateSource`. When set, candidate items
     * that the fetch query then drops (e.g. parent-album linkage missing) are
     * marked `skipped_transient` with a retry delay — otherwise they keep
     * coming back on every drain tick.
     */
    stageId?: string;
}): Promise<MusicEmbeddingResult> {
    const {
        force = false,
        batchSize = 20,
        itemIds,
        onProgress,
        shouldAbort,
        onSuccess,
        candidateSource,
        stageId,
    } = options ?? {};
    const sql = await aiDbService.getSql();

    const popularitySource = VALID_POPULARITY_SOURCES.has(config.MUSIC_POPULARITY_PRIMARY_SOURCE)
        ? config.MUSIC_POPULARITY_PRIMARY_SOURCE
        : 'lastfm';

    if (!sql) {
        return {
            success: false,
            total: 0,
            generated: 0,
            skipped: 0,
            errors: 0,
            message: 'Database unavailable',
            tokensUsed: 0,
        };
    }

    // When candidateSource is provided (coverage-table-driven mode), resolve
    // the backlog IDs upfront and treat them as an itemIds scope. This keeps
    // all downstream query logic (cursor pagination, metadata joins, etc.)
    // unchanged — only the candidate set changes.
    //
    // `candidateIds` is preserved separately so the post-loop reconciliation
    // step can mark items as `skipped_transient` when they passed through
    // `candidateSource` but the fetch query dropped them (e.g. media_type
    // isn't 'track', missingCondition excluded them as up-to-date).
    let effectiveItemIds = itemIds;
    let candidateIds: string[] | null = null;
    if (candidateSource) {
        const rows = await candidateSource(sql, batchSize * 10);
        if (rows.length === 0) {
            return {
                success: true,
                total: 0,
                generated: 0,
                skipped: 0,
                errors: 0,
                message: 'No tracks found in coverage table backlog',
                tokensUsed: 0,
            };
        }
        candidateIds = rows.map((r) => r.id);
        effectiveItemIds = candidateIds;
    }

    // Count tracks to process:
    // - Tracks with no music embedding at all
    // - Tracks whose metadata was updated after the embedding was generated
    //   (e.g. Essentia analysis added BPM/key/energy after initial embedding)
    const missingCondition = force
        ? ''
        : `AND (
            NOT EXISTS (
                SELECT 1 FROM media_embeddings me
                WHERE me.media_id = mi.id AND me.source = 'music'
            )
            OR EXISTS (
                SELECT 1 FROM media_embeddings me
                WHERE me.media_id = mi.id AND me.source = 'music'
                AND mi.updated_at > me.updated_at
            )
        )`;

    // Scope filter for incremental chain runs and coverage-table-driven mode.
    // Count and fetch queries use different param positions (COUNT has no other
    // params; FETCH already uses $1 for popularitySource) so the placeholder
    // number differs.
    const hasItemIds = !!effectiveItemIds && effectiveItemIds.length > 0;
    const countScopeCondition = hasItemIds ? 'AND mi.id = ANY($1::uuid[])' : '';
    const fetchScopeCondition = hasItemIds ? 'AND mi.id = ANY($2::uuid[])' : '';

    const [{ count }] = await sql.unsafe<[{ count: number }]>(
        `
        SELECT COUNT(*)::int as count
        FROM media_items mi
        WHERE mi.media_type = 'track'
        ${missingCondition}
        ${countScopeCondition}
    `,
        hasItemIds && effectiveItemIds ? [effectiveItemIds] : [],
    );

    logger.info('Music tracks to embed', { count, force });

    if (count === 0) {
        // Reconcile drift: if `candidateSource` returned items but the legacy
        // fetch predicate dropped them all (e.g. up-to-date per
        // missingCondition, wrong media_type), mark every candidate as
        // `skipped_transient` so they don't keep coming back.
        if (candidateIds && stageId && candidateIds.length > 0) {
            try {
                const updated = await markSkippedTransientBatch(sql, {
                    stageId,
                    mediaItemIds: candidateIds,
                    skippedReason: 'ineligible-by-legacy-filter',
                    retryAfterMs: LEGACY_FILTER_SKIP_RETRY_MS,
                });
                logger.info(
                    'Reconciled empty-fetch music-embedding coverage drift via skipped_transient',
                    {
                        stageId,
                        candidates: candidateIds.length,
                        rowsUpdated: updated,
                    },
                );
            } catch (err) {
                logger.warn(
                    'Failed to mark music drift items as skipped_transient (empty-fetch path)',
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
            total: 0,
            generated: 0,
            skipped: 0,
            errors: 0,
            message: 'All tracks already have up-to-date embeddings',
            tokensUsed: 0,
        };
    }

    let generated = 0;
    let skipped = 0;
    let errors = 0;
    let tokensUsed = 0;
    let lastId: string | null = null;
    let aborted = false;
    // Tracks the candidate IDs the fetch query actually returned, so the
    // post-loop reconciliation step can flip the rest to `skipped_transient`.
    const processedIds = new Set<string>();

    while (true) {
        // Check between batches so admin Cancel stops the OpenAI token burn
        // before another batch of tracks is fetched + embedded. The current
        // partial result is preserved.
        if (shouldAbort?.()) {
            aborted = true;
            break;
        }
        // Cursor is passed positionally so the query stays parameterized —
        // the slot number shifts depending on whether itemIds is scoped in.
        const cursorPlaceholder = hasItemIds ? '$3' : '$2';
        const cursorCondition: string = lastId ? `AND mi.id > ${cursorPlaceholder}::uuid` : '';

        const baseParams: Array<string | string[]> = hasItemIds
            ? [popularitySource, effectiveItemIds as string[]]
            : [popularitySource];
        const queryParams: Array<string | string[]> = lastId ? [...baseParams, lastId] : baseParams;

        // Fetch batch of tracks with their metadata. Popularity JOIN is
        // optional — NULL when the provider hasn't fetched this artist yet
        // (cold start), in which case we omit related_artists/tags from the
        // embedding text without penalty.
        const tracks = await sql.unsafe<
            Array<{
                id: string;
                title: string;
                custom_metadata: Record<string, unknown>;
                artist_title: string | null;
                album_title: string | null;
                album_artist_title: string | null;
                year: number | null;
                popularity_metadata: Record<string, unknown> | null;
            }>
        >(
            `
            SELECT
                mi.id,
                mi.title,
                COALESCE(mi.custom_metadata, '{}'::jsonb) as custom_metadata,
                COALESCE(
                    NULLIF(mi.custom_metadata->>'artist', ''),
                    NULLIF(artist.title, 'Unknown Artist'),
                    artist.title
                ) as artist_title,
                album.title as album_title,
                artist.title as album_artist_title,
                EXTRACT(YEAR FROM mi.premiere_date)::int as year,
                apop.raw_metadata as popularity_metadata
            FROM media_items mi
            LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
            LEFT JOIN media_popularity apop
                ON apop.media_id = artist.id
                AND apop.source = $1
                AND apop.score_context = 'artist_global'
            WHERE mi.media_type = 'track'
            ${missingCondition}
            ${fetchScopeCondition}
            ${cursorCondition}
            ORDER BY mi.id
            LIMIT ${batchSize}
        `,
            queryParams,
        );

        if (tracks.length === 0) break;

        // Track which candidate IDs the fetch query returned (vs dropped by
        // media_type / missingCondition filters), for post-loop reconciliation.
        for (const t of tracks) {
            processedIds.add(t.id);
        }

        for (const track of tracks) {
            // Check per-track so admin Cancel doesn't continue burning tokens
            // through the rest of a 20-track batch after the abort fires. The
            // outer while-loop guard catches abort between batches; this
            // guard catches abort mid-batch.
            if (shouldAbort?.()) {
                aborted = true;
                break;
            }
            try {
                const cm = track.custom_metadata;
                const ess: Record<string, unknown> =
                    cm.essentia && typeof cm.essentia === 'object'
                        ? (cm.essentia as Record<string, unknown>)
                        : {};
                const pm = track.popularity_metadata ?? {};
                const meta: MusicTrackMetadata = {
                    title: track.title,
                    artist: track.artist_title ?? 'Unknown Artist',
                    albumArtist: track.album_artist_title ?? undefined,
                    album: track.album_title ?? undefined,
                    genre: toStringArray(cm.genre) ?? toStringArray(cm.genres),
                    year: track.year ?? toNumber(cm.year),
                    bpm: toNumber(ess.bpm),
                    key: toStringVal(ess.key),
                    energy: toNumber(ess.energy),
                    danceability: toNumber(ess.danceability),
                    moodTags: toStringArray(ess.mood_tags) ?? toStringArray(cm.moods),
                    relatedArtists: toStringArray(pm.similar_artists),
                    artistTags: toStringArray(pm.tags),
                };

                const text = createMusicEmbeddingText(meta);

                if (text.length < 20) {
                    skipped++;
                    continue;
                }

                const embedding = await generateTextEmbedding(text, (t) => {
                    // Guard a malformed provider usage value — a single NaN would
                    // poison tokensUsed for the whole run.
                    if (Number.isFinite(t)) tokensUsed += t;
                });

                if (!embedding || embedding.length !== EMBEDDING_DIMENSION) {
                    logger.warn('Invalid embedding for track', {
                        id: track.id,
                        title: track.title,
                    });
                    errors++;
                    continue;
                }

                await upsertMediaEmbedding(sql, track.id, 'music', embedding);

                if (onSuccess) {
                    try {
                        await onSuccess(track.id);
                    } catch {
                        // Non-fatal — coverage write failure must not abort embedding generation
                    }
                }

                generated++;

                // Rate limit: ~10 requests/sec
                await new Promise((r) => setTimeout(r, 100));
            } catch (err) {
                errors++;
                logger.error('Failed to embed track', err as Error, {
                    id: track.id,
                    title: track.title,
                });
            }
        }

        // Inner loop set `aborted` and broke; propagate to the outer loop
        // before advancing the cursor / reporting progress.
        if (aborted) break;
        lastId = tracks[tracks.length - 1].id;
        onProgress?.(generated + skipped + errors, count);
    }

    // Reconcile drift: items that `candidateSource` returned but the fetch
    // query filtered out (media_type mismatch, missingCondition deemed them
    // up-to-date) need a `skipped_transient` row with a retry window so they
    // don't keep coming back on every sweep tick. Invalidation events
    // (file content changed, metadata updated) re-flip the row to `pending`
    // and bypass the window.
    if (candidateIds && stageId && !aborted) {
        const unprocessed = candidateIds.filter((id) => !processedIds.has(id));
        if (unprocessed.length > 0) {
            try {
                const updated = await markSkippedTransientBatch(sql, {
                    stageId,
                    mediaItemIds: unprocessed,
                    skippedReason: 'ineligible-by-legacy-filter',
                    retryAfterMs: LEGACY_FILTER_SKIP_RETRY_MS,
                });
                logger.info('Reconciled music-embedding coverage drift via skipped_transient', {
                    stageId,
                    candidates: candidateIds.length,
                    processed: processedIds.size,
                    unprocessed: unprocessed.length,
                    rowsUpdated: updated,
                });
            } catch (err) {
                // Non-fatal — reconciliation failure must not abort the run.
                logger.warn('Failed to mark music drift items as skipped_transient', {
                    stageId,
                    unprocessedCount: unprocessed.length,
                    error: (err as Error).message,
                });
            }
        }
    }

    const message = aborted
        ? `Aborted after generating ${generated} music embeddings (${skipped} skipped, ${errors} errors)`
        : `Generated ${generated} music embeddings (${skipped} skipped, ${errors} errors)`;
    logger.info(message, { generated, skipped, errors });

    return {
        success: errors === 0,
        total: count,
        generated,
        skipped,
        errors,
        message,
        tokensUsed,
    };
}

// Helpers
function toStringVal(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}

function toNumber(v: unknown): number | undefined {
    return typeof v === 'number' ? v : undefined;
}

function toStringArray(v: unknown): string[] | undefined {
    if (typeof v === 'string') return [v];
    if (!Array.isArray(v)) return undefined;
    const result = v.filter((s): s is string => typeof s === 'string');
    return result.length > 0 ? result : undefined;
}
