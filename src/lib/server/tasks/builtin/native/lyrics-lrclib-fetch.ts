// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lyrics LRCLIB Bulk Fetch Task
 *
 * Sweeps music tracks whose `custom_metadata->'lyrics'` key is NULL
 * (no definitive lookup result) and calls the existing `resolveLyrics()` service
 * for each one — which in turn calls LRCLIB, stores the result (or the
 * not-found marker), and optionally writes the .lrc sidecar to disk.
 *
 * DO NOT import getLyrics or writeLyricsSidecar directly. All LRCLIB
 * interaction, retry-avoidance, and sidecar writing is handled inside
 * resolveLyrics() which this task calls exclusively.
 *
 * Eligibility predicate (SQL):
 *   media_type = 'track' AND has_files = true
 *   AND custom_metadata->'lyrics' IS NULL   -- no definitive result yet
 *   AND lyricsRetry.nextRetryAt is absent or due
 *
 * Retry-avoidance:
 *   On a LRCLIB miss, resolveLyrics() writes the not-found marker
 *   { plain: null, synced: null, fetchedAt: ... } into custom_metadata.lyrics,
 *   so the key is no longer NULL and those tracks are excluded on the next run.
 *   Provider faults persist lyricsRetry with an exponential deadline (1h–24h,
 *   or longer Retry-After). Selection and resolution both respect that deadline.
 *   No additional state table or migration is needed.
 *
 * Gate dependency chain:
 *   features.musicLyricsFetch (FEATURE_MUSIC_LYRICS_FETCH, default off)
 *     → this task runs.
 *   features.autoLyrics (FEATURE_AUTO_LYRICS, default true)
 *     → resolveLyrics() actually fetches. Without autoLyrics, resolveLyrics()
 *       returns null for every track and LRCLIB is never called, making the
 *       bulk task a no-op even when musicLyricsFetch is true.
 *   features.saveLyricsToDisk (FEATURE_SAVE_LYRICS_TO_DISK)
 *     → resolveLyrics() writes the .lrc sidecar alongside the audio file.
 *
 * Rate-limit:
 *   Tracks are processed sequentially with a polite 300ms delay between calls
 *   (~3 req/s max). LRCLIB is a free community service; parallel hammering
 *   would be antisocial.
 *
 * Resource class: 'bulk' — IO-bound HTTP, may take hours on large libraries.
 * Schedule: every 6h. manualOnly is NOT set so the schedule fires automatically.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { registry } from '../../registry.js';
import { resolveLyrics } from '../../../services/music/lyrics.service.js';
import { getTrackDetail } from '../../../database/queries/music.queries.js';
import type { TrackDetailRow } from '../../../database/queries/music.queries.js';
import type postgres from 'postgres';

const logger = Logger.for('LyricsLrcLibFetch');

// ============================================================================
// Constants
// ============================================================================

/** Tracks fetched per eligibility query slice. */
const SLICE_SIZE = 50;

/**
 * Polite inter-request delay in milliseconds.
 * LRCLIB has no published rate limit; 300 ms ≈ 3 req/s is courteous.
 */
const RATE_LIMIT_MS = 300;

// Stop a sweep during a widespread provider outage. resolveLyrics persists
// per-track retry deadlines, so these failures leave the current candidate set.
// Still stop after a few mostly-failing slices instead of trying the entire
// library against an unavailable provider. This also bounds loops when a DB
// failure prevents persistence of either a result or a retry deadline.
const NO_PROGRESS_BACKOFF_MS = 5_000;
const MAX_NO_PROGRESS_ROUNDS = 4;

// A round only counts as "real progress" when it marks MORE than this fraction of
// the tracks it attempted ineligible (i.e. the error rate stayed below ~90%). The
// old signal reset the no-progress counter on even ONE non-error outcome per
// slice, so a provider that was ~98% failing (a couple of lucky hits amid 48
// errors every 50-track round) never tripped the circuit and ground for the full
// 6h cap. A genuinely-working provider writes a marker for ~every non-error track,
// so it clears this floor comfortably even when it is slow.
const MIN_PROGRESS_FRACTION = 0.1;

/**
 * Decide whether a single drain round made real forward progress.
 *
 * `attempted` counts every track processed in a slice. `progressed` counts
 * non-error outcomes (fetched + notFound + skipped). Deferred provider errors
 * do not count as useful progress: a mostly-failing provider should stop the
 * sweep even though its per-track retry deadlines remove those candidates.
 */
export function roundMadeProgress(attempted: number, progressed: number): boolean {
    return attempted > 0 && progressed > attempted * MIN_PROGRESS_FRACTION;
}

/** Abort-aware sleep used to back off between fruitless drain rounds. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        // Capture the abort handler so BOTH resolution paths can detach it. The
        // signal is the long-lived task signal shared across every drain round;
        // without removing the listener on the normal (timeout) path, each
        // oscillating round would leak one 'abort' listener onto it.
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
// Schema / types
// ============================================================================

const inputSchema = z.object({}).passthrough();

type LyricsLrcLibFetchInput = z.infer<typeof inputSchema>;

interface LyricsLrcLibFetchResult {
    fetched: number;
    notFound: number;
    skipped: number;
    errors: number;
}

// ============================================================================
// Eligibility query
// ============================================================================

/**
 * Fetch a slice of track IDs eligible for lyrics fetching.
 *
 * Eligibility: file-backed track with no definitive lyrics result or miss,
 * and no future retry deadline. Provider faults leave the lyrics key absent
 * and defer this track through lyricsRetry instead.
 */
export async function fetchEligibleTrackIds(
    sql: postgres.Sql,
    limit: number,
    offset: number,
): Promise<Array<{ id: string }>> {
    return sql<Array<{ id: string }>>`
        SELECT mi.id
        FROM media_items mi
        WHERE mi.media_type = 'track'
          AND mi.has_files = true
          AND mi.custom_metadata->'lyrics' IS NULL
          AND COALESCE((mi.custom_metadata #>> '{lyricsRetry,nextRetryAt}')::timestamptz, '-infinity'::timestamptz) <= NOW()
        ORDER BY mi.created_at ASC
        LIMIT ${limit} OFFSET ${offset}
    `;
}

/**
 * Count the total number of eligible tracks (for progress reporting).
 */
export async function countEligibleTracks(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<[{ count: number }]>`
        SELECT COUNT(*)::int AS count
        FROM media_items mi
        WHERE mi.media_type = 'track'
          AND mi.has_files = true
          AND mi.custom_metadata->'lyrics' IS NULL
          AND COALESCE((mi.custom_metadata #>> '{lyricsRetry,nextRetryAt}')::timestamptz, '-infinity'::timestamptz) <= NOW()
    `;
    return row?.count ?? 0;
}

// ============================================================================
// Task definition
// ============================================================================

export const lyricsLrcLibFetchTask = defineTask<LyricsLrcLibFetchInput, LyricsLrcLibFetchResult>({
    id: 'lyrics-lrclib-fetch',
    purpose: 'music-ai',
    name: 'Lyrics LRCLIB Bulk Fetch',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    // IO-bound HTTP. May run for hours on large libraries.
    resourceClass: 'bulk',

    // Serialize: only one bulk fetch at a time so we don't double-hammer LRCLIB.
    quotas: { maxConcurrent: 1 },

    // Fire every 6 hours automatically (like music-analysis).
    schedule: {
        every: '6h',
        runOnStartup: false,
    },

    scope: 'global',
    identityFor: () => 'global',

    // quotas.maxConcurrent only counts CURRENTLY-active runs — it does not
    // protect the scheduler's narrow double-fire window (a run that
    // COMPLETES before the ~30s bucket-claim TTL, combined with a failed
    // scheduler_state advance), because by the time the retry fires the first
    // run is no longer "active". exclusiveWith's SETNX key persists past
    // completion (floored to the hard timeout), closing that gap for the
    // "don't double-hammer LRCLIB" invariant the maxConcurrent comment above
    // already states as the goal. identityFor is the constant 'global'. ttl
    // exceeds the 6h hard timeout with margin. Must be a single-unit duration
    // string (SDK's exclusiveWith.ttl validator rejects compound forms like
    // '6h20m', unlike timeout.hard/soft).
    exclusiveWith: { scope: 'global', ttl: '7h' },

    inputSchema,

    timeout: { hard: '6h', soft: '5h' },

    async execute(ctx): Promise<{
        success: boolean;
        itemsProcessed: number;
        result: LyricsLrcLibFetchResult;
        message?: string;
    }> {
        const { sql: rawSql, signal, reportProgress } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        // Feature gate — no-op when musicLyricsFetch is off.
        if (!features.musicLyricsFetch) {
            ctx.logger.info(
                'musicLyricsFetch feature is disabled (FEATURE_MUSIC_LYRICS_FETCH) — task is a no-op',
            );
            return {
                success: true,
                itemsProcessed: 0,
                result: { fetched: 0, notFound: 0, skipped: 0, errors: 0 },
            };
        }

        // No-op when autoLyrics is off: resolveLyrics() returns null WITHOUT
        // writing a not-found marker, so every track would stay eligible and
        // re-queue forever (infinite drain). Don't iterate at all in that case.
        if (!features.autoLyrics) {
            ctx.logger.info(
                'FEATURE_AUTO_LYRICS is off — bulk lyrics fetch is a no-op (enable it for the task to do useful work)',
            );
            return {
                success: true,
                itemsProcessed: 0,
                result: { fetched: 0, notFound: 0, skipped: 0, errors: 0 },
            };
        }

        let fetched = 0;
        let notFound = 0;
        let skipped = 0;
        let errors = 0;
        let totalProcessed = 0;

        // Snapshot eligible count once for progress reporting.
        let totalEligible = 0;
        try {
            totalEligible = await countEligibleTracks(sql);
        } catch (err) {
            logger.warn('Failed to count eligible tracks — progress bar will be approximate', {
                error: err instanceof Error ? err.message : String(err),
            });
        }

        logger.info('Starting lyrics LRCLIB bulk fetch', {
            totalEligible,
            autoLyrics: features.autoLyrics,
            saveLyricsToDisk: features.saveLyricsToDisk,
        });

        // Drain: always fetch from offset 0. After resolveLyrics() processes a
        // track it writes either lyrics or the not-found marker into
        // custom_metadata.lyrics, making the row ineligible on the next slice
        // query. So the offset stays 0 — each slice fetches the next batch of
        // still-unprocessed tracks.
        let consecutiveNoProgress = 0;
        while (!signal.aborted) {
            const idRows = await fetchEligibleTrackIds(sql, SLICE_SIZE, 0);

            if (idRows.length === 0) {
                logger.info('No more eligible tracks — drain complete');
                break;
            }

            // Count useful completions separately from deferred errors so a
            // widespread outage still trips the sweep-level circuit.
            const progressBefore = fetched + notFound + skipped;
            const processedBefore = totalProcessed;

            // Process tracks sequentially with a polite inter-request delay.
            for (const { id } of idRows) {
                if (signal.aborted) break;

                let track: TrackDetailRow | null;
                try {
                    track = await getTrackDetail(sql, id);
                } catch (err) {
                    logger.warn('Failed to fetch track detail — skipping', {
                        id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    errors++;
                    totalProcessed++;
                    reportProgress(totalProcessed, totalEligible);
                    continue;
                }

                if (!track) {
                    // Track disappeared between the eligibility query and here.
                    skipped++;
                    totalProcessed++;
                    reportProgress(totalProcessed, totalEligible);
                    continue;
                }

                // No-artist tracks are NOT special-cased here: resolveLyrics()
                // now writes a not-found marker when artist/title is missing, so
                // they get marked (not re-queued) like any other miss.

                try {
                    const result = await resolveLyrics(sql, track);
                    if (result && (result.plain || result.synced)) {
                        fetched++;
                        logger.debug('Lyrics fetched for track', {
                            id: track.id,
                            title: track.title,
                            hasSynced: !!result.synced,
                        });
                    } else {
                        notFound++;
                        logger.debug('No lyrics found for track', {
                            id: track.id,
                            title: track.title,
                        });
                    }
                } catch (err) {
                    logger.warn('Lyrics fetch failed for track', {
                        id: track.id,
                        title: track.title,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    errors++;
                }

                totalProcessed++;
                reportProgress(
                    totalProcessed,
                    Math.max(totalEligible, totalProcessed),
                    track.title,
                );

                // Polite rate-limit — LRCLIB is a free community service.
                if (!signal.aborted) {
                    await new Promise<void>((r) => setTimeout(r, RATE_LIMIT_MS));
                }
            }

            // A few mostly-failing slices stop this pass. Persisted retry
            // deadlines protect those tracks across subsequent passes too.
            const attemptedThisRound = totalProcessed - processedBefore;
            const progressThisRound = fetched + notFound + skipped - progressBefore;
            const madeProgress = roundMadeProgress(attemptedThisRound, progressThisRound);
            if (madeProgress) {
                consecutiveNoProgress = 0;
            } else {
                consecutiveNoProgress++;
                if (consecutiveNoProgress >= MAX_NO_PROGRESS_ROUNDS) {
                    logger.warn(
                        'Lyrics fetch made no progress for several rounds — LRCLIB likely unavailable; stopping (will retry on next scheduled/manual run)',
                        { rounds: consecutiveNoProgress },
                    );
                    break;
                }
                await sleep(NO_PROGRESS_BACKOFF_MS, signal);
            }
        }

        const message =
            `Lyrics LRCLIB fetch: ${fetched.toString()} fetched, ` +
            `${notFound.toString()} not found, ` +
            `${skipped.toString()} skipped, ` +
            `${errors.toString()} errors`;

        logger.info(message);

        return {
            success: true,
            itemsProcessed: fetched,
            result: { fetched, notFound, skipped, errors },
            message,
        };
    },
});

// Self-register into the singleton registry.
registry.registerTask(lyricsLrcLibFetchTask);
