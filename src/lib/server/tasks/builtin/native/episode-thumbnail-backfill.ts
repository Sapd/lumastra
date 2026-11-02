// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Thumbnail Backfill (scheduled maintenance).
 *
 * Populates the LOCAL episode-thumbnail artwork (`media_artwork` rows,
 * artwork_type='thumb') that nothing else fills in automatically:
 *
 *   - The per-item `image-sync` eager path only runs `scanImages`, which
 *     matches pre-existing image FILES on disk (Sonarr `S##E##-thumb.jpg`).
 *     It never runs ffmpeg, and it only passes `{ mediaItemId }` — the
 *     `extractVideo` flag that gates frame extraction is set exclusively by
 *     the admin "regenerate thumbnails" routes.
 *   - The old automatic post-scan materialization that ran ffmpeg extraction
 *     right after a scan went dead in the task-system rewrite (the file
 *     scanner's `maybeEnqueuePostScan` hook became a no-op).
 *
 * So an episode with neither an on-disk thumb file nor a TMDB `still_path`
 * showed the popcorn placeholder forever — even though its video file exists
 * and a frame could be extracted trivially. This task closes that gap.
 *
 * It reuses `materializeMissingEpisodeThumbnails` in the provider-artwork
 * materialization service, which walks a config-ordered priority
 * (`IMAGE_SYNC_EPISODE_THUMB_PRIORITY`, default `['video','provider']`):
 * extract a real frame from the file first, else download the provider still
 * and MATERIALIZE it locally. Materializing the provider still (rather than
 * leaning on the request-time live-TMDB fallback) means episode thumbnails
 * keep working offline, survive a lost TMDB key, and don't pay a live TMDB
 * round-trip on every cold image request.
 *
 * PACING MATTERS: the media library is typically an NFS mount, and both the
 * ffmpeg frame extraction and the file walk hit it — while it also serves
 * live playback. So this runs at `maxConcurrent: 1` on the `analysis` class
 * and processes only a small `limit` of episodes per cycle: a slow trickle
 * that converges over time without contending with streaming. Candidates are
 * ordered newest-first (`created_at DESC`), so freshly-scanned episodes get
 * their thumbnail before the long-tail backlog. Fixed episodes stop matching
 * the "missing local thumb" predicate, so the task winds down to no-ops.
 *
 * SCOPE — deliberately narrow (audited 2026-09-27). Its only candidates are episodes with NO local thumb row at all
 * (`findEpisodeThumbnailCandidates`). It does not consult the shared classifier
 * (`episode-thumbnail-state.ts`) and must not grow its own notion of a "broken"
 * thumbnail: a row that exists but points at the wrong file is
 * the retired episode-thumbnail-repair task's (`unmapped`), and an episode with no file on disk
 * is episode-thumbnail-generate's (`missing`). What this task alone adds is
 * the provider half — materialising the TMDB still locally when no frame can be
 * decoded. Near-zero candidates per run is its expected steady state (one
 * indexed anti-join, ~100 ms on the reference library), not a stall.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import {
    findEpisodeThumbnailCandidates,
    materializeMissingEpisodeThumbnails,
} from '$lib/server/services/provider-artwork-materialization.service.js';

/** Episodes processed per cycle when the caller doesn't override `limit`. */
const DEFAULT_BATCH = 20;

const inputSchema = z
    .object({
        /**
         * Max episodes to backfill this cycle. Kept small so the NFS-bound
         * ffmpeg extraction trickles rather than floods (the mount also serves
         * live playback). Capped at 200 — a higher manual override would
         * re-create the saturation the pacing exists to prevent.
         */
        limit: z.number().int().min(1).max(200).optional(),
    })
    .passthrough();

interface BackfillResult {
    /** Episodes with no local thumb that were considered this cycle. */
    candidates: number;
    /** Local thumbs written from a provider still (TMDB `still_path`). */
    storedProvider: number;
    /** Local thumbs written from an ffmpeg-extracted video frame. */
    extracted: number;
    /** Candidates that produced neither (no video file + no provider still). */
    skipped: number;
    /** Candidates whose provider fetch or extraction errored. */
    errors: number;
    /**
     * True when the batch filled `limit` — a cheap proxy for "more remain",
     * so /admin surfaces (and operators) can see the backfill converging
     * cycle over cycle without an expensive full residual COUNT.
     */
    batchFull: boolean;
}

export const episodeThumbnailBackfillTask = defineTask<z.infer<typeof inputSchema>, BackfillResult>(
    {
        id: 'episode-thumbnail-backfill',
        purpose: 'library',
        name: 'Episode Thumbnail Backfill',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '0.0.0',
        capabilities: { database: true, ffmpeg: true, http: true },

        // Hourly trickle to bound ffmpeg work per episode. A fresh scan kicks
        // an immediate run via file-scanner's post-scan hook, so this schedule is
        // the steady-state catch-up, not the only trigger.
        schedule: { every: '1h', runOnStartup: false },

        identityFor: () => 'global',
        scope: 'global',
        // ffmpeg-bound and long-tolerant → analysis class. maxConcurrent:1 keeps a
        // fast-completing run + a scheduler double-fire from ever running two
        // backfill sweeps at once (they'd extract the same episodes).
        resourceClass: 'analysis',
        quotas: { maxConcurrent: 1 },
        // Singleton guard against the scheduler's narrow double-fire window; ttl
        // exceeds the hard timeout with margin.
        exclusiveWith: { scope: 'global', ttl: '35m' },
        inputSchema,
        timeout: { hard: '30m', soft: '28m' },

        async execute(ctx) {
            if (ctx.signal.aborted) {
                return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
            }

            const limit = ctx.input.limit ?? DEFAULT_BATCH;

            const candidates = await findEpisodeThumbnailCandidates(ctx.sql, { limit });
            if (candidates.length === 0) {
                ctx.logger.debug('episode-thumbnail-backfill: no episodes missing a local thumb');
                return {
                    success: true,
                    itemsProcessed: 0,
                    result: {
                        candidates: 0,
                        storedProvider: 0,
                        extracted: 0,
                        skipped: 0,
                        errors: 0,
                        batchFull: false,
                    },
                };
            }

            // Pass the already-fetched candidates through so the materializer
            // doesn't re-run the (indexed but non-trivial) candidate query.
            const materialized = await materializeMissingEpisodeThumbnails(
                ctx.sql,
                {
                    limit,
                    onProgress: (processed, total) => ctx.reportProgress(processed, total),
                },
                { candidates },
            );

            const result: BackfillResult = {
                candidates: materialized.candidates,
                storedProvider: materialized.storedProvider,
                extracted: materialized.extracted,
                skipped: materialized.skipped,
                errors: materialized.errors,
                batchFull: candidates.length >= limit,
            };

            ctx.logger.info('episode-thumbnail-backfill cycle complete', result);

            // A cycle where EVERY candidate errored (e.g. NFS mount gone, ffmpeg
            // missing) is a real failure — throw so the run is marked failed and
            // the circuit breaker can quarantine a persistently broken backfill,
            // rather than logging success while making zero progress.
            if (materialized.errors > 0 && materialized.errors === materialized.candidates) {
                throw new TaskError({
                    message: `episode-thumbnail-backfill: all ${materialized.candidates} candidates errored`,
                    kind: 'transient',
                });
            }

            return {
                success: true,
                itemsProcessed: result.storedProvider + result.extracted,
                result,
            };
        },
    },
);

registry.registerTask(episodeThumbnailBackfillTask);
