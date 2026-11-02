// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video Frame Extractor Service
 *
 * Extracts thumbnail images from video files using ffprobe and ffmpeg.
 * Supports configurable timestamp, quality, and resolution settings.
 * Also supports batch extraction for series/season scopes.
 */

import type postgres from 'postgres';
import { classifyMediaInfraError } from '$lib/server/tasks/infra-retry.js';
import { spawnFFmpegSafely } from '$lib/server/utils/ffmpeg-spawn.js';
import { ffprobeLibraryInputArgs } from '$lib/server/utils/library-input-guard.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { withArtworkChoice } from './artwork-choice.service.js';
import { upsertLocalArtwork } from '$lib/server/database/queries/media-artwork.queries.js';
import {
    findVideoFile,
    findEpisodesForSeries,
    findEpisodesForSeason,
    hasLocalArtwork,
    getMediaItemForImageSync,
} from '$lib/server/database/queries/image-sync.queries.js';
import { resolveWritePath } from './metadata-storage.service.js';
import { safeMkdir, safeRename, safeRm, safeUnlink } from '$lib/server/utils/safe-fs.js';
import { assertTranscodeInputIsMedia } from './transcoding/input-guard.js';
import { dirname, join } from 'path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
    captureExplicitEpisodeThumbnailInput,
    isExplicitEpisodeThumbnailInputCurrent,
    publishExplicitEpisodeThumbnail,
    type ExplicitEpisodeThumbnailInput,
} from './explicit-episode-thumbnail.service.js';

const execFileAsync = promisify(execFile);
const logger = Logger.for('VideoFrameExtractor');

/**
 * Resolve the output path for an extracted frame using the unified
 * METADATA_STORAGE_LOCATION strategy.
 *
 * Each extraction gets a distinct file so retained or locked candidates keep their bytes.
 * Alongside: saves next to the video file.
 * Central: saves under the fallback directory.
 */
async function resolveOutputPath(
    videoPath: string,
    fallbackDir: string,
    artworkType: string,
    mediaItemId?: string,
): Promise<string> {
    // Candidate files are immutable. A concurrent extraction must never overwrite
    // an existing (possibly locked) frame. UUID names stay below filesystem limits.
    const fileName = `${mediaItemId ?? randomUUID()}-${randomUUID()}-${artworkType}.jpg`;
    const result = await resolveWritePath({
        mediaFilePath: videoPath,
        centralDir: fallbackDir,
        fileName,
    });
    return result.filePath;
}

export interface ExtractionOptions {
    videoPath: string;
    outputPath: string;
    timestampPercent?: number;
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    /**
     * The file's duration in seconds, when the caller already has it (the
     * media_files row). Used instead of an ffprobe; a missing or unusable value
     * (not finite, not positive) probes the file as before.
     */
    durationSeconds?: number;
    baseOffsetSeconds?: number;
    signal?: AbortSignal;
}

export interface ExtractionResult {
    success: boolean;
    outputPath?: string;
    error?: string;
    /** Classified from the original error, never from the rendered stderr/path. */
    transientError?: string;
}

interface FFprobeFormat {
    duration?: string;
}

interface FFprobeOutput {
    format?: FFprobeFormat;
}

function candidateTimestamps(primary: number): number[] {
    const safePrimary = Math.min(90, Math.max(1, primary));
    return [...new Set([safePrimary, 25, 40, 55, 70])];
}

async function isUsableStillFrame(filePath: string): Promise<boolean> {
    try {
        const stats = await sharp(filePath).resize(64, 64, { fit: 'inside' }).greyscale().stats();
        const channel = stats.channels[0];
        if (!channel) return true;

        const contrast = channel.max - channel.min;
        return channel.mean >= 12 && channel.mean <= 245 && contrast >= 10;
    } catch (err) {
        logger.debug('Could not inspect extracted frame; accepting candidate', {
            filePath,
            error: err instanceof Error ? err.message : String(err),
        });
        return true;
    }
}

async function getVideoDuration(videoPath: string): Promise<number> {
    const ffprobePath = config.FFPROBE_PATH;
    const { stdout } = await execFileAsync(
        ffprobePath,
        [
            '-v',
            'quiet',
            '-print_format',
            'json',
            '-show_format',
            ...(await ffprobeLibraryInputArgs()),
            videoPath,
        ],
        { timeout: 30000, killSignal: 'SIGKILL' },
    );

    try {
        const data = JSON.parse(stdout) as FFprobeOutput;
        const duration = data.format?.duration;
        if (!duration) return 0;
        return parseFloat(duration);
    } catch {
        logger.warn('Failed to parse ffprobe output', { videoPath, stdout });
        return 0;
    }
}

export async function extractFrame(options: ExtractionOptions): Promise<ExtractionResult> {
    const {
        videoPath,
        outputPath,
        timestampPercent = config.IMAGE_SYNC_VIDEO_TIMESTAMP,
        quality = config.IMAGE_SYNC_VIDEO_QUALITY,
        maxWidth = config.IMAGE_SYNC_VIDEO_MAX_WIDTH,
        maxHeight = config.IMAGE_SYNC_VIDEO_MAX_HEIGHT,
        durationSeconds,
        baseOffsetSeconds = 0,
    } = options;

    let workDir: string | undefined;
    try {
        // Refused before ffprobe and ffmpeg alike: a library file whose content
        // became a playlist/manifest body after the last scan would have both
        // follow its references into other libraries.
        await assertTranscodeInputIsMedia({ localFilePath: videoPath });
        // A duration the caller already holds (the scanner's probe, the stored
        // media_files row) saves a second ffprobe of the same file.
        const duration =
            durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > 0
                ? durationSeconds
                : await getVideoDuration(videoPath);
        if (duration <= 0) {
            return {
                success: false,
                error: 'Could not determine video duration',
            };
        }

        await safeMkdir(dirname(outputPath), { recursive: true });

        // Private work dir with an unguessable name: ffmpeg `-y` follows a symlink
        // planted at a predictable output name. Non-recursive mkdir fails on an
        // existing name, so a planted entry cannot be reused. Always removed below.
        workDir = join(dirname(outputPath), `.frame-${randomUUID().slice(0, 8)}`);
        await safeMkdir(workDir, { mode: 0o700 });

        let firstSuccessfulPath: string | null = null;
        let lastError: string | null = null;
        let rejectedLowInfoFrames = 0;
        const timestamps = candidateTimestamps(timestampPercent);

        for (let i = 0; i < timestamps.length; i++) {
            const candidatePercent = timestamps[i];
            if (options.signal?.aborted) return { success: false, error: 'Extraction cancelled' };
            const seekTime = baseOffsetSeconds + (candidatePercent / 100) * duration;
            const seekTimeStr = seekTime.toFixed(2);
            const candidatePath = join(workDir, `candidate-${i}.jpg`);

            const args = [
                '-ss',
                seekTimeStr,
                '-i',
                videoPath,
                '-vframes',
                '1',
                '-q:v',
                String(Math.round((100 - quality) / 3.33)),
                '-vf',
                `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease`,
                // One literal file: without it image2 expands `%d` in the path,
                // and the path embeds the library file's name.
                '-update',
                '1',
                '-y',
                candidatePath,
            ];

            // Again before each candidate: every one is a fresh ffmpeg that
            // re-opens the path, up to five of them with a 60 s ceiling each.
            await assertTranscodeInputIsMedia({ localFilePath: videoPath });
            const result = await spawnFFmpegSafely({
                args,
                libraryInput: videoPath,
                timeout: 60000,
                abortSignal: options.signal,
                context: {
                    videoPath,
                    outputPath: candidatePath,
                    seekTime: seekTimeStr,
                },
            });

            if (result.exitCode !== 0) {
                lastError = `FFmpeg exited with code ${result.exitCode}`;
                if (classifyMediaInfraError(result)) {
                    return {
                        success: false,
                        error: `${lastError}: ${result.stderr.slice(-500)}`,
                        transientError: `${lastError}: ${result.stderr.slice(-500)}`,
                    };
                }
                logger.warn('FFmpeg extraction candidate failed', {
                    videoPath,
                    outputPath: candidatePath,
                    exitCode: result.exitCode,
                    stderr: result.stderr.slice(-500),
                });
                continue;
            }

            firstSuccessfulPath ??= candidatePath;

            if (await isUsableStillFrame(candidatePath)) {
                await safeRename(candidatePath, outputPath);
                if (firstSuccessfulPath && firstSuccessfulPath !== candidatePath) {
                    await safeUnlink(firstSuccessfulPath).catch(() => {});
                }
                logger.info('Frame extracted', {
                    videoPath,
                    outputPath,
                    timestampPercent: candidatePercent,
                });
                return { success: true, outputPath };
            }

            logger.debug('Skipping low-information extracted frame candidate', {
                videoPath,
                outputPath: candidatePath,
                timestampPercent: candidatePercent,
            });
            rejectedLowInfoFrames++;
            if (firstSuccessfulPath !== candidatePath) {
                await safeUnlink(candidatePath).catch(() => {});
            }
        }

        if (!firstSuccessfulPath) {
            return {
                success: false,
                error: lastError ?? 'No frame could be extracted',
            };
        }

        // All quality checks rejected every candidate (e.g. flat-colour cartoon
        // backgrounds score below the contrast threshold at 64×64).  The frame is
        // still a real video frame — use it rather than leaving the episode without
        // any thumbnail at all.
        logger.info('Using first extractable frame as low-contrast fallback', {
            videoPath,
            outputPath,
            rejectedCount: rejectedLowInfoFrames,
        });
        await safeRename(firstSuccessfulPath, outputPath);
        return { success: true, outputPath };
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn('Frame extraction failed', { videoPath, error: errorMsg });
        return {
            success: false,
            error: errorMsg,
            ...(classifyMediaInfraError(err) ? { transientError: errorMsg } : {}),
        };
    } finally {
        if (workDir) await safeRm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

export type ArtworkExtractionType = 'backdrop' | 'poster' | 'thumb';

/**
 * Timestamp (percentage into the file) for segment `index` of `count` segments
 * packed into one physical file. Lands each segment in the middle of its share:
 * two episodes → 25% / 75%; three → 16.7% / 50% / 83.3%; one → 50% (centre).
 *
 * This is the single source of truth for the multi-episode frame distribution
 * used by both the batch extractor and the per-item resolver below — keep it in
 * sync with the inline copy in the file-scanner video-processor.
 */
export function proportionalEpisodeTimestamp(index: number, count: number): number {
    return ((2 * index + 1) / (2 * count)) * 100;
}

/**
 * For a set of episode IDs, compute a per-episode timestamp percentage so that
 * episodes sharing the same physical file each get a distinct frame.
 * Episodes in a single-episode file use the config default (returned as undefined
 * so callers fall back to config).
 *
 * Resolves the FULL set of episodes on each referenced file — not just the ones
 * passed in — so an episode-scope call (one combined-file segment in scope)
 * still distributes correctly against its off-scope sibling instead of treating
 * the file as single-episode and falling back to the config default. The map
 * may therefore contain entries for off-scope siblings; callers only read the
 * ids they extract, so the extra entries are harmless.
 */
export async function buildEpisodeTimestampMap(
    sql: postgres.Sql,
    episodeIds: string[],
): Promise<Map<string, number>> {
    if (episodeIds.length === 0) return new Map();

    const rows = await sql<
        {
            media_item_id: string;
            file_id: string;
            episode_number: number | null;
        }[]
    >`
        SELECT mfi.media_item_id, mfi.file_id, mi.episode_number
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mfi.is_default = true
          AND mfi.file_id IN (
              SELECT file_id FROM media_file_items
              WHERE media_item_id = ANY(${sql.array(episodeIds)}::uuid[])
                AND is_default = true
          )
    `;

    // Group by file
    const byFile = new Map<string, { id: string; episodeNumber: number }[]>();
    for (const row of rows) {
        const group = byFile.get(row.file_id) ?? [];
        group.push({
            id: row.media_item_id,
            episodeNumber: row.episode_number ?? 0,
        });
        byFile.set(row.file_id, group);
    }

    const timestamps = new Map<string, number>();
    for (const group of byFile.values()) {
        const N = group.length;
        if (N <= 1) continue; // single-episode file — caller uses config default
        group.sort((a, b) => a.episodeNumber - b.episodeNumber);
        for (let i = 0; i < N; i++) {
            timestamps.set(group[i].id, proportionalEpisodeTimestamp(i, N));
        }
    }
    return timestamps;
}

/**
 * For a SINGLE episode, resolve the per-segment timestamp it should be extracted
 * at when its physical file holds more than one episode (a "combined file").
 * Returns the proportional timestamp (e.g. 75% for the second of two segments)
 * or `undefined` when the file holds only this episode (or the episode has no
 * default file link) so the caller falls back to the config default.
 *
 * This is the per-item counterpart to `buildEpisodeTimestampMap`. It exists so
 * that single-item extraction paths (episode-thumbnail repair, the admin
 * extract endpoint) produce segment-correct frames instead of grabbing the
 * global config-default timestamp — which for a two-segment file lands inside
 * the FIRST segment and gives the second episode the wrong show.
 */
export async function resolveMultiEpisodeTimestamp(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<number | undefined> {
    const rows = await sql<{ media_item_id: string; episode_number: number | null }[]>`
        SELECT mfi.media_item_id, mi.episode_number
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mfi.is_default = true
          AND mfi.file_id = (
              SELECT file_id FROM media_file_items
              WHERE media_item_id = ${mediaItemId} AND is_default = true
              LIMIT 1
          )
        ORDER BY mi.episode_number ASC NULLS LAST, mfi.media_item_id ASC
    `;

    if (rows.length <= 1) return undefined; // single-episode file or no link

    const index = rows.findIndex((r) => r.media_item_id === mediaItemId);
    if (index < 0) return undefined;

    return proportionalEpisodeTimestamp(index, rows.length);
}

/** Restrict every quality retry to this episode's segment of the selected file. */
export async function resolveExtractionSpan(
    sql: postgres.Sql,
    mediaItemId: string,
    videoPath: string,
    duration?: number,
): Promise<{ base: number; duration: number } | undefined> {
    const rows = await sql<{ start_ms: string | null; end_ms: string | null; id: string }[]>`
        SELECT mfi.start_offset_ms::text AS start_ms, mfi.end_offset_ms::text AS end_ms, mfi.media_item_id AS id
        FROM media_file_items mfi JOIN media_files mf ON mf.id=mfi.file_id
        JOIN media_items mi ON mi.id=mfi.media_item_id AND mi.media_type='episode'
        WHERE mf.file_path=${videoPath} AND mfi.is_default
        ORDER BY mi.episode_number ASC NULLS LAST, mi.id`;
    const index = rows.findIndex((r) => r.id === mediaItemId);
    if (index < 0) return undefined;
    const row = rows[index];
    if (row.start_ms !== null && row.end_ms !== null) {
        const base = Number(row.start_ms) / 1000;
        const end = Number(row.end_ms) / 1000;
        if (Number.isFinite(base) && Number.isFinite(end) && base >= 0 && end > base)
            return { base, duration: end - base };
    }
    if (rows.length > 1) {
        if (!duration || !Number.isFinite(duration) || duration <= 0) {
            await assertTranscodeInputIsMedia({ localFilePath: videoPath });
            duration = await getVideoDuration(videoPath);
        }
        if (duration > 0)
            return { base: (index * duration) / rows.length, duration: duration / rows.length };
    }
    return undefined;
}

export interface BatchExtractionOptions {
    mediaItemId: string;
    scope: 'series' | 'season' | 'episode';
    mode: 'execute' | 'plan';
    /** Type of artwork to extract (default: 'backdrop') */
    artworkType?: ArtworkExtractionType;
    /** Force extraction even if artwork already exists */
    force?: boolean;
    onProgress?: (processed: number, total: number) => void;
    selectAsAdmin?: boolean;
    signal?: AbortSignal;
    /** Captured when a reviewed episode action was queued; old clients capture at task start. */
    reviewedInput?: ExplicitEpisodeThumbnailInput;
}

export interface BatchExtractionResult {
    /** First infrastructure error, retained for the task retry boundary. */
    transientError?: string;
    processed: number;
    extracted: number;
    skipped: number;
    errors: number;
    /** Number of items that would be extracted in plan mode */
    planned: number;
}

export async function extractFramesBatch(
    sql: postgres.Sql,
    options: BatchExtractionOptions,
): Promise<BatchExtractionResult> {
    const {
        mediaItemId,
        scope,
        mode,
        artworkType = 'backdrop',
        force = false,
        onProgress,
    } = options;

    const result: BatchExtractionResult = {
        processed: 0,
        extracted: 0,
        skipped: 0,
        errors: 0,
        planned: 0,
    };

    let targetIds: string[];

    if (scope === 'series') {
        const episodes = await findEpisodesForSeries(sql, mediaItemId);
        targetIds = episodes.map((e) => e.id);
    } else if (scope === 'season') {
        const episodes = await findEpisodesForSeason(sql, mediaItemId);
        targetIds = episodes.map((e) => e.id);
    } else {
        targetIds = [mediaItemId];
    }

    logger.info('Batch extraction started', {
        scope,
        mode,
        targetCount: targetIds.length,
        mediaItemId,
    });

    // Pre-compute proportional timestamps for multi-episode files so each
    // episode in the same file gets a distinct frame.
    const episodeTimestamps = await buildEpisodeTimestampMap(sql, targetIds);

    const baseDir = config.BASE_PATH || '/tmp';
    const outputDir = join(baseDir, 'image-sync', 'batch', mediaItemId);

    for (const targetId of targetIds) {
        if (options.signal?.aborted) break;
        try {
            if (!force) {
                const alreadyHas = await hasLocalArtwork(sql, targetId, artworkType);

                if (alreadyHas) {
                    result.skipped++;
                    result.processed++;
                    onProgress?.(result.processed, targetIds.length);
                    continue;
                }
            }

            const explicitInput =
                artworkType === 'thumb' && options.selectAsAdmin
                    ? await captureExplicitEpisodeThumbnailInput(sql, targetId, options.signal)
                    : null;
            if (
                artworkType === 'thumb' &&
                options.selectAsAdmin &&
                (!explicitInput ||
                    (options.reviewedInput &&
                        (options.reviewedInput.episodeId !== targetId ||
                            !(await isExplicitEpisodeThumbnailInputCurrent(
                                sql,
                                options.reviewedInput,
                                options.signal,
                            )))))
            ) {
                result.skipped++;
                result.processed++;
                onProgress?.(result.processed, targetIds.length);
                continue;
            }
            const videoFile = explicitInput
                ? {
                      filePath: explicitInput.videoPath,
                      durationSeconds: explicitInput.durationSeconds,
                  }
                : await findVideoFile(sql, targetId);

            if (!videoFile) {
                result.skipped++;
                result.processed++;
                onProgress?.(result.processed, targetIds.length);
                continue;
            }
            const videoPath = videoFile.filePath;
            if (mode === 'plan') {
                result.planned++;
                result.processed++;
                onProgress?.(result.processed, targetIds.length);
                continue;
            }

            const fallbackDir = join(outputDir, targetId);
            const outputPath = await resolveOutputPath(
                videoPath,
                fallbackDir,
                artworkType,
                targetId,
            );

            const span =
                explicitInput?.span ??
                (await resolveExtractionSpan(
                    sql,
                    targetId,
                    videoPath,
                    videoFile.durationSeconds ?? undefined,
                ));
            const timestampPercent = span
                ? config.IMAGE_SYNC_VIDEO_TIMESTAMP
                : (episodeTimestamps.get(targetId) ?? config.IMAGE_SYNC_VIDEO_TIMESTAMP);

            const extractionResult = await extractFrame({
                videoPath,
                outputPath,
                timestampPercent,
                signal: options.signal,
                ...(span ? { baseOffsetSeconds: span.base, durationSeconds: span.duration } : {}),
                quality: config.IMAGE_SYNC_VIDEO_QUALITY,
                maxWidth: config.IMAGE_SYNC_VIDEO_MAX_WIDTH,
                maxHeight: config.IMAGE_SYNC_VIDEO_MAX_HEIGHT,
                ...(!span &&
                    videoFile.durationSeconds !== null && {
                        durationSeconds: videoFile.durationSeconds,
                    }),
            });

            if (extractionResult.success && extractionResult.outputPath) {
                const wrote = explicitInput
                    ? await publishExplicitEpisodeThumbnail(
                          sql,
                          explicitInput,
                          extractionResult.outputPath,
                          options.signal,
                      )
                    : await upsertLocalArtwork(sql, {
                          mediaItemId: targetId,
                          artworkType,
                          filePath: extractionResult.outputPath,
                          sourceTag: 'generated:ffmpeg',
                          ...(options.selectAsAdmin ? { chosenBy: 'admin' as const } : {}),
                          provider: 'frame-extract',
                      });
                if (wrote) {
                    if (options.selectAsAdmin) {
                        const { getImageProxyService } = await import('./image-proxy/index.js');
                        getImageProxyService(sql).invalidateCatalogImage(targetId);
                    }
                    result.extracted++;
                } else {
                    // A false publication result guarantees that no row selected this
                    // invocation's unique output. Keep retained candidate paths intact.
                    if (explicitInput)
                        await safeUnlink(extractionResult.outputPath).catch(() => {});
                    result.skipped++;
                }
            } else {
                result.errors++;
                if (extractionResult.transientError)
                    result.transientError ??= extractionResult.transientError;
                logger.warn('Failed to extract frame', {
                    targetId,
                    error: extractionResult.error,
                });
            }
        } catch (err) {
            result.errors++;
            if (classifyMediaInfraError(err))
                result.transientError ??= err instanceof Error ? err.message : String(err);
            logger.warn('Batch extraction error', {
                targetId,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        result.processed++;
        onProgress?.(result.processed, targetIds.length);
    }

    logger.info('Batch extraction complete', result);
    return result;
}

export interface SingleExtractionOptions {
    mediaItemId: string;
    artworkType: ArtworkExtractionType;
    /** Force extraction even if artwork already exists */
    force?: boolean;
    /** Optional: provide video file path directly to skip DB lookup (useful for items with no linked file, e.g. series) */
    videoFilePath?: string;
    /** Percentage into the video to extract the frame (0–100). Overrides IMAGE_SYNC_VIDEO_TIMESTAMP. */
    timestampPercent?: number;
    /**
     * Duration in seconds of the video file. With `videoFilePath` it is the
     * caller's own figure; otherwise the stored duration of the linked file is
     * used when this is not given.
     */
    durationSeconds?: number;
    selectAsAdmin?: boolean;
}

export interface SingleExtractionResult {
    extracted: boolean;
    filePath?: string;
    reason?: 'already_exists' | 'no_video_file' | 'extraction_failed' | 'stale_input';
}

/**
 * Extract a single frame from a media item's video file.
 * Checks for existing artwork unless force=true.
 */
export async function extractPosterForItem(
    sql: postgres.Sql,
    options: SingleExtractionOptions,
): Promise<SingleExtractionResult> {
    const {
        mediaItemId,
        artworkType,
        force = false,
        videoFilePath,
        timestampPercent,
        durationSeconds,
    } = options;

    // Check if artwork already exists
    if (!force) {
        const exists = await hasLocalArtwork(sql, mediaItemId, artworkType);
        if (exists) {
            return { extracted: false, reason: 'already_exists' };
        }
    }

    const itemType =
        artworkType === 'thumb' && options.selectAsAdmin
            ? (await getMediaItemForImageSync(sql, mediaItemId))?.media_type
            : undefined;
    const isExplicitEpisode = itemType === 'episode';
    const explicitInput = isExplicitEpisode
        ? await captureExplicitEpisodeThumbnailInput(sql, mediaItemId)
        : null;
    if (isExplicitEpisode && !explicitInput) return { extracted: false, reason: 'stale_input' };
    // A caller-supplied path for an episode must still match its selected
    // association. Otherwise the source cannot be fenced at publication.
    if (explicitInput && videoFilePath && videoFilePath !== explicitInput.videoPath)
        return { extracted: false, reason: 'stale_input' };

    // Find video file — use provided path or look up from DB. The stored
    // duration of the looked-up file comes with it, so the frame extraction does
    // not need its own ffprobe. A caller-supplied path keeps the caller's duration.
    let videoPath: string;
    let knownDuration: number | undefined;
    if (explicitInput) {
        videoPath = explicitInput.videoPath;
        knownDuration = explicitInput.durationSeconds;
    } else if (videoFilePath) {
        videoPath = videoFilePath;
        knownDuration = durationSeconds;
    } else {
        const videoFile = await findVideoFile(sql, mediaItemId);
        if (!videoFile) {
            return { extracted: false, reason: 'no_video_file' };
        }
        videoPath = videoFile.filePath;
        knownDuration = durationSeconds ?? videoFile.durationSeconds ?? undefined;
    }

    // When the caller didn't pin a timestamp, detect whether this episode shares
    // its physical file with siblings (a combined file) and pick the segment's
    // own slice of the timeline. Without this, a combined-file second episode
    // would extract at the global config default — inside the FIRST segment —
    // and show the wrong show.
    const resolvedTimestamp =
        timestampPercent ??
        (await resolveMultiEpisodeTimestamp(sql, mediaItemId)) ??
        config.IMAGE_SYNC_VIDEO_TIMESTAMP;

    const span =
        explicitInput?.span ??
        (videoFilePath
            ? undefined
            : await resolveExtractionSpan(sql, mediaItemId, videoPath, knownDuration));

    // Extract frame
    const baseDir = config.BASE_PATH || '/tmp';
    const fallbackDir = join(baseDir, 'image-sync', 'single', mediaItemId);
    const outputPath = await resolveOutputPath(videoPath, fallbackDir, artworkType, mediaItemId);

    const result = await extractFrame({
        videoPath,
        outputPath,
        timestampPercent: span
            ? (timestampPercent ?? config.IMAGE_SYNC_VIDEO_TIMESTAMP)
            : resolvedTimestamp,
        ...(span ? { baseOffsetSeconds: span.base, durationSeconds: span.duration } : {}),
        quality: config.IMAGE_SYNC_VIDEO_QUALITY,
        maxWidth: config.IMAGE_SYNC_VIDEO_MAX_WIDTH,
        maxHeight: config.IMAGE_SYNC_VIDEO_MAX_HEIGHT,
        ...(!span && knownDuration !== undefined ? { durationSeconds: knownDuration } : {}),
    });

    if (!result.success || !result.outputPath) {
        return { extracted: false, reason: 'extraction_failed' };
    }

    // Store in database
    const wrote = explicitInput
        ? await publishExplicitEpisodeThumbnail(sql, explicitInput, result.outputPath)
        : options.selectAsAdmin
          ? (
                await withArtworkChoice(sql, mediaItemId, 'admin', (tx) =>
                    upsertLocalArtwork(tx, {
                        mediaItemId,
                        artworkType,
                        filePath: result.outputPath!,
                        sourceTag: 'generated:ffmpeg',
                        chosenBy: 'admin',
                        provider: 'frame-extract',
                    }),
                )
            ).value
          : await upsertLocalArtwork(sql, {
                mediaItemId,
                artworkType,
                filePath: result.outputPath,
                sourceTag: 'generated:ffmpeg',
                ...(options.selectAsAdmin ? { chosenBy: 'admin' as const } : {}),
                provider: 'frame-extract',
            });

    if (!wrote) {
        // Only a definite stale result permits deleting this newly named frame.
        // An exception may have followed a commit, so it must leave bytes alone.
        if (explicitInput) await safeUnlink(result.outputPath).catch(() => {});
        return { extracted: false, reason: explicitInput ? 'stale_input' : 'extraction_failed' };
    }
    if (options.selectAsAdmin) {
        const { getImageProxyService } = await import('./image-proxy/index.js');
        getImageProxyService(sql).invalidateCatalogImage(mediaItemId);
    }

    logger.info('Single frame extracted', { mediaItemId, artworkType });
    return { extracted: true, filePath: result.outputPath };
}
