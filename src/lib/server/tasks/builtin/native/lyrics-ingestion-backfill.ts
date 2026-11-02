// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lyrics Ingestion Backfill Task
 *
 * Embeds track lyrics into `media_lyrics_embeddings` for full-text lyrics search.
 * Lyrics are sourced from two places, in priority order:
 *
 *   1. .lrc sidecar file on disk (next to the audio file): highest fidelity,
 *      includes timestamps. Timestamps are stripped before embedding.
 *   2. DB-fetched LRCLIB lyrics in `custom_metadata.lyrics` (written by the
 *      lyrics-lrclib-fetch task): used as a fallback when no .lrc sidecar exists.
 *      This closes the pipeline gap where LRCLIB-fetched lyrics were stored but
 *      never indexed for search.
 *
 * The column dimension in media_lyrics_embeddings was stamped at migration
 * time using resolveEffectiveEmbedding(). The ingestion service resolves the
 * SAME function at runtime so the dimension always matches — preventing the
 * "expected N dimensions, not M" pgvector error.
 *
 * Gating:
 *   - No-ops immediately when features.lyricsSearch is false.
 *   - Scheduled every 6h, the same cadence as lyrics-lrclib-fetch, which
 *     supplies most of its input. It used to be manual-start only — and as the
 *     sole writer of media_lyrics_embeddings that left lyrics search empty on
 *     any install where nobody ran it by hand. Once drained, a run is one
 *     empty candidate page.
 *
 * Resource class:
 *   'embedding' — same as other text-embedding tasks (library-embeddings,
 *   music-embedding-generation). maxConcurrent=1 so only one lyrics backfill
 *   runs at a time without starving other embedders.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { registry } from '../../registry.js';
import { EMBEDDINGS_DEP } from './embedding-dep.js';
import { runWithEmbeddingFetch } from '../../../ai/embedding-fetch-context.js';
import {
    fetchPendingLyricsTracks,
    upsertLyricsEmbedding,
    upsertLyricsEmbeddingState,
    LYRICS_SOURCE_LRC_SIDECAR,
    LYRICS_SOURCE_DB_FETCH,
} from '../../../database/queries/lyrics-search.queries.js';
import * as path from 'node:path';
import type postgres from 'postgres';
import { readContainedFile } from '$lib/server/utils/contained-fs.js';

const logger = Logger.for('LyricsIngestionBackfill');

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_BATCH_SIZE = 20;

// No-progress circuit — mirrors lyrics-lrclib-fetch.ts. `fetchPendingLyricsTracks`
// selects any row whose embedding_state is NOT 'done'/'no_lyrics' — that INCLUDES
// 'failed' rows, and the query has no offset/exclude parameter, so a down
// embedding provider would otherwise re-select and re-attempt the exact same
// batch forever (an 8h hot loop against the hard timeout). We track track IDs
// that failed WITHIN this run in-memory and filter them out of each subsequent
// fetch; when an entire freshly-fetched batch turns out to be already-failed
// this run, further fetches would return the identical batch (no offset to
// advance), so we stop immediately rather than spin. A round that embeds or
// permanently disqualifies (no_lyrics) at least one track counts as progress;
// after MAX_NO_PROGRESS_ROUNDS non-progressing rounds we give up and throw a
// transient TaskError so the provider outage is surfaced to the breaker/admin
// instead of silently returning success:true having done nothing useful.
const MAX_NO_PROGRESS_ROUNDS = 4;
const INTER_ROUND_DELAY_MS = 300;

/** Abort-aware sleep used to back off between drain rounds. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

// ============================================================================
// LRC stripping
// ============================================================================

/**
 * Strip LRC timestamp tags from lyrics text, returning plain text lines.
 *
 * LRC format: `[mm:ss.xx]Line text`
 * Enhanced LRC: `[mm:ss.xx]<mm:ss.xx>Word text`
 *
 * Both timestamps and empty lines are removed. The result is the raw lyric
 * text suitable for embedding.
 */
export function stripLrcTimestamps(lrcContent: string): string {
    return lrcContent
        .split('\n')
        .map((line) =>
            // Remove LRC bracket tags: [mm:ss.xx], [xx:xx.xx], [ar:...], etc.
            line
                .replace(/\[[\d:.a-zA-Z ]+\]/g, '')
                .replace(/<[\d:.]+>/g, '')
                .trim(),
        )
        .filter((line) => line.length > 0)
        .join('\n');
}

/**
 * Attempt to read the .lrc sidecar file for a given media file path.
 *
 * The sidecar is found by replacing the audio file extension with `.lrc`.
 * Returns null when the file does not exist or cannot be read.
 */
async function readLrcSidecar(filePath: string): Promise<string | null> {
    const ext = path.extname(filePath);
    if (!ext) return null;
    const lrcPath = filePath.slice(0, -ext.length) + '.lrc';
    try {
        const content = await readContainedFile(lrcPath, { maxBytes: 2 * 1024 * 1024 });
        return content.toString('utf-8');
    } catch {
        return null;
    }
}

// ============================================================================
// Schema / types
// ============================================================================

const inputSchema = z.object({}).passthrough();

type BackfillInput = z.infer<typeof inputSchema>;

interface BackfillResult {
    embedded: number;
    noLyrics: number;
    failed: number;
}

// ============================================================================
// Task definition
// ============================================================================

export const lyricsIngestionBackfillTask = defineTask<BackfillInput, BackfillResult>({
    id: 'lyrics-ingestion-backfill',
    purpose: 'music-ai',
    name: 'Lyrics Ingestion Backfill',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },

    // Drains the backlog automatically; execute() no-ops while the feature is
    // off. See "Gating" in the module docblock.
    schedule: {
        every: '6h',
        runOnStartup: false,
    },

    // Text-embedding class with a per-task quota of 1 so only one lyrics
    // backfill runs at a time without starving other embedders.
    resourceClass: 'embedding',
    quotas: { maxConcurrent: 1 },

    scope: 'global',
    identityFor: () => 'global',

    inputSchema,

    // Route embedding HTTP through the shared `embeddings` dep so Voyage/OpenAI
    // calls honour a cross-replica rate limit, circuit breaker, and SSRF guard.
    externalDeps: [EMBEDDINGS_DEP],

    timeout: { hard: '8h', soft: '7h' },

    async execute(ctx) {
        const { sql: rawSql, signal, reportProgress, logger: ctxLogger } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        // Feature gate — no-op when lyricsSearch is off.
        if (!features.lyricsSearch) {
            ctxLogger.info('lyricsSearch feature is disabled — backfill is a no-op');
            return {
                success: true,
                itemsProcessed: 0,
                result: { embedded: 0, noLyrics: 0, failed: 0 },
            };
        }

        // Lazy import — keep embedding generators out of the orchestrator boot path.
        const { generateVoyageEmbedding, isVoyageAvailable } =
            await import('../../../ai/voyage.js');

        if (!isVoyageAvailable()) {
            ctxLogger.warn('No text-embedding provider configured — lyrics backfill skipped');
            return {
                success: false,
                itemsProcessed: 0,
                result: { embedded: 0, noLyrics: 0, failed: 0 },
                message: 'No embedding provider configured',
            };
        }

        let embedded = 0;
        let noLyrics = 0;
        let failed = 0;
        let totalProcessed = 0;

        // Track IDs that failed WITHIN this run — fetchPendingLyricsTracks has no
        // offset/exclude parameter and re-selects 'failed' rows, so without this
        // in-memory exclusion a stuck batch would be re-fetched and re-attempted
        // every round.
        const failedThisRun = new Set<string>();
        let consecutiveNoProgress = 0;
        let noProgressTripped = false;

        ctxLogger.info('Starting lyrics ingestion backfill', {
            batchSize: DEFAULT_BATCH_SIZE,
        });

        // Drain loop: fetch pending tracks → read .lrc → embed → write state → repeat.
        while (!signal.aborted) {
            const rawTracks = await fetchPendingLyricsTracks(sql, DEFAULT_BATCH_SIZE);

            if (rawTracks.length === 0) {
                ctxLogger.info('No more tracks to process — drain complete');
                break;
            }

            const tracks = rawTracks.filter((track) => !failedThisRun.has(track.media_item_id));

            if (tracks.length === 0) {
                // Every row in this batch already failed earlier in this run. The
                // query has no offset/exclude support, so fetching again would
                // return the identical batch — stop instead of hot-looping DB
                // round-trips against a provider that isn't going to recover
                // within this run.
                ctxLogger.warn(
                    'lyrics-ingestion-backfill: remaining eligible tracks all failed earlier this run — stopping drain',
                    { failedThisRun: failedThisRun.size },
                );
                noProgressTripped = true;
                break;
            }

            const progressBefore = embedded + noLyrics;

            for (const track of tracks) {
                if (signal.aborted) break;

                const mediaId = track.media_item_id;

                // 1. Mark as processing (best-effort).
                try {
                    await upsertLyricsEmbeddingState(sql, mediaId, 'processing');
                } catch {
                    // Non-fatal: state tracking failure must not abort embedding.
                }

                // 2. Resolve lyrics text — sidecar (.lrc file) takes priority;
                //    fall back to DB-fetched lyrics from custom_metadata.lyrics
                //    (written by the lyrics-lrclib-fetch task via LRCLIB).
                const lrcContent = await readLrcSidecar(track.file_path);

                let plainText: string;
                let lyricsSource: string;

                if (lrcContent) {
                    // Prefer the on-disk sidecar (highest fidelity: synced LRC).
                    const stripped = stripLrcTimestamps(lrcContent);
                    if (!stripped.trim()) {
                        // LRC file was empty after stripping — fall through to DB.
                        const dbLyrics = track.db_synced_lyrics ?? track.db_plain_lyrics;
                        if (!dbLyrics?.trim()) {
                            // No usable lyrics from either source.
                            try {
                                await upsertLyricsEmbeddingState(sql, mediaId, 'no_lyrics');
                            } catch {
                                // Best-effort.
                            }
                            noLyrics++;
                            totalProcessed++;
                            continue;
                        }
                        // DB lyrics available — strip LRC timestamps (synced may have them).
                        plainText = stripLrcTimestamps(dbLyrics);
                        lyricsSource = LYRICS_SOURCE_DB_FETCH;
                    } else {
                        plainText = stripped;
                        lyricsSource = LYRICS_SOURCE_LRC_SIDECAR;
                    }
                } else {
                    // No sidecar — try the LRCLIB-fetched DB lyrics.
                    // Prefer synced lyrics (strip timestamps); fall back to plain.
                    const rawDbLyrics = track.db_synced_lyrics ?? track.db_plain_lyrics;
                    if (!rawDbLyrics?.trim()) {
                        // No lyrics from any source.
                        try {
                            await upsertLyricsEmbeddingState(sql, mediaId, 'no_lyrics');
                        } catch (err) {
                            logger.warn('Failed to write no_lyrics state', {
                                mediaId,
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                        noLyrics++;
                        totalProcessed++;
                        continue;
                    }
                    plainText = stripLrcTimestamps(rawDbLyrics);
                    lyricsSource = LYRICS_SOURCE_DB_FETCH;
                }

                if (!plainText.trim()) {
                    // Stripped result was empty — treat as no_lyrics.
                    try {
                        await upsertLyricsEmbeddingState(sql, mediaId, 'no_lyrics');
                    } catch {
                        // Best-effort.
                    }
                    noLyrics++;
                    totalProcessed++;
                    continue;
                }

                // 3. Embed the plain text through the rate-limited fetch scope.
                let embeddingVector: number[] | null = null;
                try {
                    embeddingVector = await runWithEmbeddingFetch(ctx.dep('embeddings').fetch, () =>
                        generateVoyageEmbedding(plainText),
                    );
                } catch (err) {
                    logger.warn('Embedding call threw unexpectedly', {
                        mediaId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }

                if (!embeddingVector) {
                    try {
                        await upsertLyricsEmbeddingState(sql, mediaId, 'failed');
                    } catch {
                        // Best-effort.
                    }
                    failed++;
                    failedThisRun.add(mediaId);
                    totalProcessed++;
                    continue;
                }

                // 4. Write embedding + done state.
                try {
                    await upsertLyricsEmbedding(sql, mediaId, embeddingVector, lyricsSource);
                    await upsertLyricsEmbeddingState(sql, mediaId, 'done');
                    embedded++;
                } catch (dbErr) {
                    logger.warn('Failed to write lyrics embedding to DB', {
                        mediaId,
                        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
                    });
                    // Leave status as 'processing' so next run retries. Don't
                    // write 'failed' — the DB error may be transient. Still
                    // exclude from THIS run's re-fetches to avoid spinning on
                    // the same row while the DB issue persists.
                    failed++;
                    failedThisRun.add(mediaId);
                }

                totalProcessed++;
                reportProgress(totalProcessed, totalProcessed + tracks.length, track.file_path);
            }

            ctxLogger.info('Batch complete', { embedded, noLyrics, failed });

            // No-progress circuit: a round counts as forward progress only when
            // it permanently disqualified (embedded → 'done', or → 'no_lyrics')
            // at least one track. 'failed' rows don't count — they'd otherwise
            // be re-selected forever by a provider that never recovers within
            // this run.
            const progressedThisRound = embedded + noLyrics - progressBefore;
            if (progressedThisRound > 0) {
                consecutiveNoProgress = 0;
            } else {
                consecutiveNoProgress++;
                if (consecutiveNoProgress >= MAX_NO_PROGRESS_ROUNDS) {
                    noProgressTripped = true;
                    break;
                }
            }

            if (!signal.aborted) {
                await sleep(INTER_ROUND_DELAY_MS, signal);
            }
        }

        const message = `Lyrics backfill: ${embedded} embedded, ${noLyrics} no_lyrics, ${failed} failed`;
        ctxLogger.info(message);

        // Real failure: the drain made no forward progress and stopped only
        // because everything remaining was failing (e.g. a down embedding
        // provider) — throw so the circuit breaker/admin see this run as
        // failed instead of a silent success:true that did nothing useful.
        // A run that made SOME progress (embedded/no_lyrics > 0) before
        // eventually stalling still returns normally with the failures
        // recorded — partial progress is not a total failure.
        if (noProgressTripped && embedded === 0 && noLyrics === 0 && failed > 0) {
            throw new TaskError({
                message: `lyrics-ingestion-backfill: made no forward progress — ${failed} track(s) failed, 0 embedded, 0 no_lyrics (embedding provider likely unavailable)`,
                kind: 'transient',
            });
        }

        return {
            success: true,
            itemsProcessed: embedded,
            result: { embedded, noLyrics, failed },
            message,
        };
    },
});

// Self-register into the singleton registry (mirrors sonic-embedding-backfill.ts pattern).
registry.registerTask(lyricsIngestionBackfillTask);
