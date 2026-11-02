// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Thumbnail Generation (scheduled maintenance).
 *
 * Makes a thumbnail for episodes that have NONE — the population no amount of
 * re-scanning can fix, because there is no image on disk to map. On the
 * reference library that was ~1,900 episodes: the retired `episode-thumbnail-repair` task had
 * been re-enqueueing them twice an hour for 1,370 runs, reporting success, and
 * changing nothing, because its premise ("re-walk the folder and re-match") is
 * only true when a file exists.
 *
 * Frame selection deliberately does NOT use the shipped flat 10%-of-runtime
 * seek. Sampling six real TNG S3 episodes at that offset on production produced
 * two near-black starfields and one title card out of six. Instead:
 *   - `frame-window.ts` excludes the intro/credits period and the tail, so the
 *     act-one credit window is structurally unreachable;
 *   - candidates are spread deterministically per episode UUID;
 *   - `frame-metrics.ts` rejects the black/blank frames and ranks the rest.
 *
 * PACING: the media library is an NFS mount that also serves live playback, and
 * each episode costs one ffmpeg spawn. `analysis` class at maxConcurrent 1 with
 * a small per-cycle batch keeps this a trickle. Measured cost on prod: ~1.6s
 * per episode for a four-seek spawn.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { dirname, join } from 'path';
import { registry } from '../../registry.js';
import {
    findEpisodeThumbnailWork,
    loadEpisodeThumbnailExclusions,
    isArtworkSuppressed,
    hasArtworkSuppressionForType,
    type EpisodeThumbnailWorkRow,
} from '$lib/server/database/queries/media-artwork.queries.js';
import { classifyEpisodeThumbnail } from '$lib/server/services/episode-thumbnail-state.js';
import {
    captureEpisodeThumbnailInput,
    publishEpisodeThumbnail,
} from '$lib/server/services/episode-thumbnail-publication.service.js';
import { generateEpisodeThumbnail } from '$lib/server/services/frame-candidate.service.js';
import { safeReaddir } from '$lib/server/utils/safe-fs.js';
import {
    metadataCentralBaseDir,
    resolveWritePath,
} from '$lib/server/services/metadata-storage.service.js';

/** Episodes generated per cycle when the caller doesn't override `limit`. */
const DEFAULT_BATCH = 20;

/**
 * Candidates inspected per cycle while hunting for `limit` that genuinely need
 * generating. Episodes whose file already exists are skipped cheaply, so
 * without a wider window the id ordering would stall on an already-fine prefix.
 */
const SCAN_WINDOW_MULTIPLIER = 6;

/** Namespaced-cache key holding the episode id the previous cycle stopped after. */
const CURSOR_CACHE_KEY = 'episode-thumbnail-generate-cursor';

/** Safety net: a stale cursor only skips ahead, never loses work, so a long TTL is fine. */
const CURSOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const inputSchema = z
    .object({
        /** Max episodes to generate this cycle. Capped — each costs an ffmpeg spawn. */
        limit: z.number().int().min(1).max(200).optional(),
        /** Restrict to one season; used to pilot the task on a known series first. */
        seasonId: z.string().guid().optional(),
    })
    .passthrough();

interface GenerateResult {
    /** Thumbnails successfully written. */
    generated: number;
    /** Episodes whose artwork file already existed — nothing to do. */
    alreadyPresent: number;
    /** Episodes where every candidate frame was rejected; least-bad was kept. */
    bestEffort: number;
    /** Episodes where extraction produced nothing at all. */
    failed: number;
    /** True when the scan reached the end of the candidate set and will restart from the beginning. */
    wrapped: boolean;
}

/** Effective duration and base offset, honouring combined multi-episode files. */
export function resolveEpisodeSpan(row: EpisodeThumbnailWorkRow): {
    base: number;
    duration: number;
} {
    // bigint columns arrive as strings from postgres.js.
    const start = row.startOffsetMs === null ? null : Number(row.startOffsetMs);
    const end = row.endOffsetMs === null ? null : Number(row.endOffsetMs);

    if (
        start !== null &&
        end !== null &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end > start
    ) {
        return { base: start / 1000, duration: (end - start) / 1000 };
    }
    return { base: 0, duration: Number(row.durationSeconds) };
}

export const episodeThumbnailGenerateTask = defineTask<z.infer<typeof inputSchema>, GenerateResult>(
    {
        id: 'episode-thumbnail-generate',
        purpose: 'repair',
        name: 'Episode Thumbnail Generation',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '0.0.0',
        capabilities: { database: true, cache: true },

        schedule: { every: '1h', runOnStartup: false },

        identityFor: (input) => input.seasonId ?? 'global',
        scope: 'global',
        // Long-running ffmpeg work belongs on `analysis`, never alongside the
        // fast-cycle classes: a per-episode spawn next to seconds-long jobs causes
        // exactly the head-of-line blocking that starved intro-analyzer for 30h.
        resourceClass: 'analysis',
        quotas: { maxConcurrent: 1 },
        inputSchema,
        timeout: { hard: '30m', soft: '28m' },

        async execute(ctx) {
            const limit = ctx.input.limit ?? DEFAULT_BATCH;
            const windowLimit = limit * SCAN_WINDOW_MULTIPLIER;

            const result: GenerateResult = {
                generated: 0,
                alreadyPresent: 0,
                bestEffort: 0,
                failed: 0,
                wrapped: false,
            };

            // A FAILED listing must not be cached as "directory is empty". A transient
            // NFS error would otherwise make every episode in the season look like it
            // has no artwork on disk, and this cycle would regenerate over files that
            // are already there. `null` means "unknown — skip, retry next cycle".
            const dirCache = new Map<string, Set<string> | null>();
            const listDir = async (dir: string): Promise<Set<string> | null> => {
                if (dirCache.has(dir)) return dirCache.get(dir) ?? null;
                let names: Set<string> | null;
                try {
                    names = new Set((await safeReaddir(dir)).map((e) => e.name));
                } catch {
                    names = null;
                }
                dirCache.set(dir, names);
                return names;
            };

            // The scan cursor persists across runs: restarting from the first id every
            // run pinned the window on an all-non-actionable prefix while later episodes
            // were never inspected. A run that hits the end of the candidate set stops
            // (no same-run wrap) and clears the cursor, so the next run starts over.
            // A seasonId pilot run neither reads nor writes the global cursor.
            const persistCursor = !ctx.input.seasonId;
            let cursor: string | null = persistCursor
                ? ((await ctx.cache?.get<string>(CURSOR_CACHE_KEY)) ?? null)
                : null;
            let lastProcessedId: string | null = cursor;
            let reachedEnd = false;
            let inspected = 0;

            // Computed once per run, not once per page: the whole-catalog
            // shared-path aggregate is stable for the duration of this loop
            // (prod slow-query log, 2026-09-26 — see
            // `loadEpisodeThumbnailExclusions`'s doc comment for the measured
            // per-page cost this removes).
            const exclusions = await loadEpisodeThumbnailExclusions(ctx.sql);

            while (result.generated + result.failed < limit && inspected < windowLimit) {
                if (ctx.signal.aborted) break;

                const page: EpisodeThumbnailWorkRow[] = await findEpisodeThumbnailWork(
                    ctx.sql,
                    cursor,
                    Math.min(limit, windowLimit - inspected),
                    exclusions,
                );
                const requested = Math.min(limit, windowLimit - inspected);
                if (page.length < requested) reachedEnd = true;
                if (page.length === 0) break;

                inspected += page.length;
                cursor = page[page.length - 1].episodeId;

                for (const row of page) {
                    if (ctx.signal.aborted) break;
                    if (result.generated + result.failed >= limit) break;
                    lastProcessedId = row.episodeId;
                    if (ctx.input.seasonId && row.seasonId !== ctx.input.seasonId) continue;

                    const dir = dirname(row.videoPath);
                    const names = await listDir(dir);
                    if (!names) continue; // listing failed — retry next cycle

                    // Shared classifier: this task owns exactly one state.
                    // 'unmapped' is a database fix that the retired episode-thumbnail-repair task
                    // performs for free — decoding a frame there would discard a
                    // perfectly good image and spend an ffmpeg spawn doing it.
                    const cls = classifyEpisodeThumbnail(row, names);
                    if (cls.state !== 'missing') {
                        result.alreadyPresent++;
                        continue;
                    }

                    const input = await captureEpisodeThumbnailInput(ctx.sql, row, ctx.signal);
                    if (!input) continue;

                    // Follow the unified metadata-storage strategy: next to the video
                    // when that folder is writable, otherwise the app's central
                    // .metadata store. A fixed "next to the video" failed every episode
                    // with EROFS on a read-only library mount, every cycle.
                    let outputPath: string;
                    try {
                        outputPath = (
                            await resolveWritePath({
                                mediaFilePath: row.videoPath,
                                centralDir: join(
                                    metadataCentralBaseDir(),
                                    '.metadata',
                                    row.episodeId,
                                ),
                                fileName: `${row.episodeId}-${randomUUID()}-thumb.jpg`,
                            })
                        ).filePath;
                    } catch (err) {
                        result.failed++;
                        ctx.logger.warn('thumbnail output location unavailable', {
                            episodeId: row.episodeId,
                            error: err instanceof Error ? err.message : String(err),
                        });
                        continue;
                    }
                    // Check the tombstone BEFORE spending an ffmpeg spawn.
                    // upsertLocalArtwork would refuse the row anyway, but the
                    // decoded file would already be on disk — and a later cycle
                    // would classify it 'unmapped' and remap onto it, quietly
                    // resurrecting artwork the operator removed.
                    if (
                        (await hasArtworkSuppressionForType(ctx.sql, row.episodeId, 'thumb')) ||
                        (await isArtworkSuppressed(ctx.sql, row.episodeId, 'thumb', outputPath))
                    ) {
                        result.alreadyPresent++;
                        continue;
                    }

                    const { base, duration } = input.extractionSpan;

                    const gen = await generateEpisodeThumbnail({
                        episodeId: row.episodeId,
                        videoPath: row.videoPath,
                        outputPath,
                        durationSeconds: duration,
                        baseOffsetSeconds: base,
                        signal: ctx.signal,
                    });

                    if (!gen.success) {
                        result.failed++;
                        ctx.logger.warn('thumbnail generation failed', {
                            episodeId: row.episodeId,
                            error: gen.error,
                        });
                        continue;
                    }

                    const wrote = await publishEpisodeThumbnail(
                        ctx.sql,
                        row,
                        input,
                        outputPath,
                        ctx.signal,
                    );
                    if (!wrote) {
                        ctx.logger.debug('thumbnail publication declined; leaving file in place', {
                            episodeId: row.episodeId,
                        });
                        continue;
                    }

                    result.generated++;
                    if (gen.bestEffort) result.bestEffort++;

                    // Yield between episodes: each one is an ffmpeg spawn plus NFS
                    // reads, and this shares a worker with other tasks.
                    await new Promise((r) => setImmediate(r));
                }
                if (reachedEnd) break;
            }

            if (persistCursor) {
                if (reachedEnd && !ctx.signal.aborted) {
                    result.wrapped = true;
                    await ctx.cache?.del(CURSOR_CACHE_KEY);
                } else if (lastProcessedId !== null) {
                    await ctx.cache?.set(CURSOR_CACHE_KEY, lastProcessedId, CURSOR_TTL_MS);
                }
            }

            ctx.logger.info('episode-thumbnail-generate cycle complete', { ...result, inspected });

            return {
                success: true,
                itemsProcessed: result.generated,
                result,
            };
        },
    },
);

registry.registerTask(episodeThumbnailGenerateTask);
