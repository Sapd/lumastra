// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS Subtitle Handler
 *
 * Handles subtitle playlist and segment requests for HLS streams.
 * Routes: subs_X/index.m3u8, subs_X/seg_XXXXX.vtt
 */

import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/index.js';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service.js';
import { subtitleCacheService } from '$lib/server/services/subtitle-cache.service.js';
import { SubtitleFileCacheService } from '$lib/server/services/cache/subtitle-file-cache.service.js';
import { resolveSubtitle } from '$lib/server/services/subtitle-resolver.service.js';
import { resolveFileScopedToItem, type FileScopeDecision } from './file-scope.js';
import {
    generateSegment,
    generateDebugSegment,
    parseWebVTT,
    type ParsedCue,
} from '$lib/server/utils/webvtt-parser.js';
import { sanitizeWebVTT } from '$lib/server/utils/subtitle-sanitizer.js';
import {
    createEmptyPlaylist,
    createVodPlaylistHeader,
    HLS_CONTENT_TYPE,
} from '$lib/server/utils/hls-definitions.js';

const logger = Logger.for('HLSSubtitleHandler');
import { UUID_RE } from '$lib/server/utils/id-patterns.js';
import { uniformSegmentCount, uniformSegmentDuration } from '$lib/server/utils/hls-segment-grid.js';

/** Default duration fallback when job info is unavailable (2 hours in seconds) */
const DEFAULT_DURATION_SECONDS = 7200;

/**
 * Subtitle segment duration — intentionally longer than audio/video segments.
 * Subtitles are text-based and don't need keyframe alignment. Using 60s instead
 * of the default 6s reduces a 3-hour movie from ~1952 to ~195 segments, cutting
 * AVPlayer's initial subtitle download burst by ~90%.
 */
const SUBTITLE_SEGMENT_DURATION = 60;

// ============================================================================
// PARSED CUE CACHE
// ============================================================================

/**
 * In-memory LRU cache for parsed subtitle cues.
 * Without this, every subtitle segment request re-resolves, re-sanitizes,
 * and re-parses the full subtitle file — O(n * fileSize) for n segments.
 * A 3-hour movie with 6s segments would parse the file ~1952 times.
 */
const parsedCueCache = new Map<string, { cues: ParsedCue[]; accessedAt: number }>();
const PARSED_CUE_CACHE_MAX = 32;
const PARSED_CUE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getParsedCueCacheKey(
    itemId: string,
    subtitleIndex: number,
    fileId: string,
    probedAt: Date | null,
): string {
    return `v2:${itemId}:${subtitleIndex}:${fileId}:${probedAt?.getTime() ?? 0}`;
}

function getCachedCues(key: string): ParsedCue[] | undefined {
    const entry = parsedCueCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.accessedAt > PARSED_CUE_CACHE_TTL_MS) {
        parsedCueCache.delete(key);
        return undefined;
    }
    entry.accessedAt = Date.now();
    return entry.cues;
}

function setCachedCues(key: string, cues: ParsedCue[]): void {
    // Evict oldest entry if at capacity
    if (parsedCueCache.size >= PARSED_CUE_CACHE_MAX) {
        let oldestKey: string | undefined;
        let oldestTime = Infinity;
        for (const [k, v] of parsedCueCache) {
            if (v.accessedAt < oldestTime) {
                oldestTime = v.accessedAt;
                oldestKey = k;
            }
        }
        if (oldestKey) parsedCueCache.delete(oldestKey);
    }
    parsedCueCache.set(key, { cues, accessedAt: Date.now() });
}

// ============================================================================
// BACKGROUND EXTRACTION (non-blocking)
// ============================================================================

/**
 * In-flight subtitle extractions keyed by `fileId:subtitleIndex`.
 *
 * Extracting an embedded subtitle (e.g. SRT→WebVTT) from a large remuxed file
 * requires ffmpeg to read the whole interleaved container, which can take
 * 100s+. Awaiting that inside the segment response FREEZES native-HLS players
 * (Safari/AVPlayer) — they won't start video until the selected subtitle
 * track's first segment loads. So a cache-miss kicks off ONE deduped background
 * extraction (this map) and the handler returns an empty segment immediately;
 * the cache fills when extraction completes and subtitles appear on the next
 * request / reload.
 */
const inflightExtractions = new Map<string, Promise<void>>();

/**
 * How long a segment request waits for an extraction that is already running
 * before it falls back to an empty segment. Short extractions (a few seconds)
 * then serve real cues on the first request; long ones still don't freeze the
 * player for more than this. AVPlayer does not re-request a VOD subtitle
 * segment it already has, so an empty first answer means no subtitles for
 * that stretch until the player is reopened.
 */
export const SUBTITLE_EXTRACTION_WAIT_MS = 5000;

async function waitForInflightExtraction(fileId: string, subtitleIndex: number): Promise<void> {
    const task = inflightExtractions.get(`${fileId}:${subtitleIndex}`);
    if (!task) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        task,
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SUBTITLE_EXTRACTION_WAIT_MS);
        }),
    ]);
    clearTimeout(timer);
}

function startBackgroundSubtitleExtraction(
    itemId: string,
    subtitleIndex: number,
    fileId: string,
    cacheKey: string,
): void {
    const key = `${fileId}:${subtitleIndex}`;
    if (inflightExtractions.has(key)) return;
    const sql = getDb();
    if (!sql) return;

    const task = (async (): Promise<void> => {
        try {
            const resolved = await resolveSubtitle(sql, itemId, subtitleIndex, {
                fileId,
                format: 'vtt',
            });
            if (!resolved) return;
            const raw = Buffer.isBuffer(resolved.content)
                ? resolved.content.toString('utf-8')
                : resolved.content;
            await SubtitleFileCacheService.set(fileId, subtitleIndex, raw).catch(() => {});
            const { content: sanitized } = sanitizeWebVTT(raw, {
                enableLogging: false,
            });
            setCachedCues(cacheKey, parseWebVTT(sanitized).cues);
            logger.info('Subtitle extracted and cached (background)', {
                fileId,
                subtitleIndex,
            });
        } catch (err) {
            logger.warn('Background subtitle extraction failed', {
                fileId,
                subtitleIndex,
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            inflightExtractions.delete(key);
        }
    })();
    inflightExtractions.set(key, task);
}

// ============================================================================
// TYPES
// ============================================================================

export interface SubtitleRequest {
    itemId: string;
    playSessionId: string;
    subtitleIndex: number;
    fileId: string;
    /** 'index.m3u8' for playlist, or segment number for individual segments */
    target: 'playlist' | number;
    /** URL for extracting additional params */
    url: URL;
}

export interface SubtitleHandlerResult {
    response: Response;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Calculate the duration of a specific segment.
 * The last segment carries the remainder (see hls-segment-grid.ts).
 */
function calculateSegmentDuration(
    segmentIndex: number,
    totalSegments: number,
    segmentDuration: number,
    totalDuration: number,
): number {
    if (segmentIndex < totalSegments - 1) {
        return segmentDuration;
    }
    // Same grid as the video playlists: the last entry absorbs a sliver.
    return uniformSegmentDuration(segmentIndex, totalDuration, segmentDuration);
}

/**
 * Generate empty WebVTT segment with NO cues (just header).
 * Used when segment is entirely before seek position or beyond media duration.
 * Prevents invalid zero-duration or negative timestamp cues.
 */
function generateEmptySegmentWithNoCues(): string {
    return 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n';
}

/**
 * Parse subtitle request from path.
 * Returns null if path doesn't match subtitle pattern.
 *
 * @param segmentPath - Path like "subs_0/index.m3u8" or "subs_0/seg_00000.vtt"
 * @returns Parsed info or null
 */
export function parseSubtitlePath(segmentPath: string): {
    fileName: string;
    segmentNumber: number | null;
    subtitleTrackIndex: number;
} | null {
    const match = segmentPath.match(/^subs_(\d+)\/(index\.m3u8|seg_(\d{5})\.vtt)$/);
    if (!match) return null;

    return {
        subtitleTrackIndex: parseInt(match[1], 10),
        fileName: match[2],
        segmentNumber: match[3] ? parseInt(match[3], 10) : null,
    };
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Handle subtitle playlist request (index.m3u8).
 *
 * Generates ABSOLUTE TIMELINE VOD playlist covering ENTIRE media duration.
 * Playlist is loaded ONCE by AVPlayer and never reloaded during seeking.
 * Each segment maps to its absolute media time (seg_00150.vtt = 900-906s content)
 * regardless of where FFmpeg currently is or where playback started.
 *
 * This matches how video/audio playlists work in VOD mode:
 * - Show full timeline from 0 to end
 * - AVPlayer can request any segment by absolute position
 * - Segments may return empty content if not available yet
 */
export async function handleSubtitlePlaylist(
    itemId: string,
    playSessionId: string,
    subtitleIndex: number,
    url: URL,
): Promise<Response> {
    const transcodeService = getFFmpegTranscodeService();
    const job = transcodeService.getJob(playSessionId);
    const totalDuration = job?.config?.totalDurationSeconds || DEFAULT_DURATION_SECONDS;

    if (!job) {
        logger.debug('No transcode job found for subtitle request, using default duration', {
            playSessionId,
            itemId,
            subtitleIndex,
            defaultDuration: DEFAULT_DURATION_SECONDS,
        });
    }

    const segmentDuration = SUBTITLE_SEGMENT_DURATION;
    // ALWAYS generate playlist from segment 0 to end (absolute timeline)
    const totalSegments = uniformSegmentCount(totalDuration, segmentDuration);

    // Check for debug subtitle mode
    const debugSubtitles = config.DEBUG_SUBTITLES || url.searchParams.get('debug_subs') === '1';

    // Build params to pass through to segment URLs
    const segParams = new URLSearchParams(url.searchParams);
    const paramString = segParams.toString();

    // Generate VOD playlist using centralized builder
    const builder = createVodPlaylistHeader({
        targetDuration: segmentDuration,
        playlistType: 'VOD',
        mediaSequence: 0, // Always 0 for absolute timeline
    });

    // PROGRAM-DATE-TIME epoch must match the video/audio VOD playlists
    // (see vod-playlist.ts buildVodManifestContent). Without PDT on subtitle
    // segments, Safari/AVPlayer can't correlate subtitle timing with the
    // video/audio timeline in demux mode, causing ~4s subtitle delay.
    const PDT_EPOCH = new Date('2026-01-01T00:00:00.000Z').getTime();
    let cumulativeSeconds = 0;

    // Generate ALL segment entries from 0 to totalSegments
    // seg_00000.vtt = 0-60s, seg_00001.vtt = 60-120s, etc.
    for (let i = 0; i < totalSegments; i++) {
        const duration = calculateSegmentDuration(i, totalSegments, segmentDuration, totalDuration);

        builder.programDateTime(new Date(PDT_EPOCH + cumulativeSeconds * 1000));
        const segmentUri = `seg_${i.toString().padStart(5, '0')}.vtt?${paramString}`;
        builder.segment(duration, segmentUri);
        cumulativeSeconds += duration;
    }

    builder.endlist();

    logger.info('Serving subtitle playlist (absolute timeline VOD)', {
        itemId,
        subtitleIndex,
        totalDuration,
        totalSegments,
        segmentDuration,
        debugMode: debugSubtitles,
    });

    return new Response(builder.build(), {
        status: 200,
        headers: {
            'Content-Type': HLS_CONTENT_TYPE.PLAYLIST,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'max-age=3600',
        },
    });
}

/**
 * Handle individual subtitle segment request (seg_XXXXX.vtt).
 *
 * Segment numbers use ABSOLUTE TIMELINE mapping (SUBTITLE_SEGMENT_DURATION is 60s):
 * - seg_00000.vtt = 0-60s content
 * - seg_00015.vtt = 900-960s content
 * - Independent of current FFmpeg seek position
 *
 * Subtitles are extracted from the ORIGINAL media file (not transcode segments),
 * so they're available at ANY position regardless of FFmpeg transcode progress or seek position.
 *
 * Cue times are ABSOLUTE and are NOT adjusted for the transcode's seek position —
 * the muxer emits absolute PTS under `-copyts`. See the note in the body; getting
 * this wrong put every cue early by the resume offset.
 */
export async function handleSubtitleSegment(
    itemId: string,
    playSessionId: string,
    subtitleIndex: number,
    fileId: string,
    segmentNumber: number,
    url: URL,
    internalId?: string,
): Promise<Response> {
    const transcodeService = getFFmpegTranscodeService();
    const job = transcodeService.getJob(playSessionId);
    const totalDuration = job?.config?.totalDurationSeconds || DEFAULT_DURATION_SECONDS;
    const segmentDuration = SUBTITLE_SEGMENT_DURATION;

    // Fast-path: bitmap subtitles (PGS, VobSub) cannot produce VTT cues.
    // Return empty WebVTT immediately to avoid expensive FFmpeg extraction.
    const subtitleTrack = job?.config?.subtitleTracks?.find((t) => t.index === subtitleIndex);
    if (subtitleTrack && !subtitleTrack.isTextBased) {
        return new Response(generateEmptySegmentWithNoCues(), {
            status: 200,
            headers: {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'max-age=86400',
            },
        });
    }

    // A caller-supplied `fileId` must belong to THIS item before it's ever
    // used to look up the disk-cached subtitle text or drive extraction —
    // otherwise a caller permitted for THIS item could request
    // `...&fileId=<a file that belongs only to a different item>` and be
    // served that other item's cached subtitle (fix plan 6, C1 sibling of
    // 2026-09-13 fix plan Task 12's C27 / research §10.3). The job->item
    // binding check in lumastra-segment-handler.ts runs before this handler
    // is ever reached but does NOT close this: it verifies the
    // PlaySessionId's job/session belongs to the gated item, never this
    // `fileId` query param, and a disk-cache hit needs no job at all. Reuses
    // the same DB scoping check the trickplay/I-frame handlers use — see
    // resolveFileScopedToItem's doc comment (file-scope.ts) — instead of
    // forking a third copy of it.
    //
    // Wrapped in its own try/catch (fail closed): resolveFileScopedToItem can
    // throw on a DB error, and letting that escape this function would 500
    // with a bare error body instead of the valid-empty-WebVTT response every
    // other rejection path here returns — a 500 with no VTT body is exactly
    // the AVPlayer parse-error hazard this module otherwise guards against.
    let scopedFile: FileScopeDecision;
    try {
        scopedFile = await resolveFileScopedToItem(fileId, internalId);
    } catch (error) {
        logger.error('fileId scoping check failed, failing closed', error as Error, {
            itemId,
            subtitleIndex,
            fileId,
        });
        return createSubtitleErrorResponse(segmentNumber, 404);
    }
    if (!scopedFile.ok) {
        return createSubtitleErrorResponse(segmentNumber, scopedFile.status);
    }
    // fileId is REQUIRED by the caller (lumastra-segment-handler.ts 400s
    // before ever reaching this handler without one), so `scopedFile.file` is
    // always non-null here — resolveFileScopedToItem only returns a null
    // `file` when the raw fileId itself was empty.
    fileId = scopedFile.file?.fileId ?? fileId;

    try {
        // Cue times stay ABSOLUTE. Do NOT subtract the transcode's seek position.
        //
        // This used to be `job.config.startTimeSeconds`, justified by a comment
        // claiming `-avoid_negative_ts make_zero` resets the output PTS to 0 after
        // a seek. That justification went stale: `addOutputOptions` only uses
        // `make_zero` when NOT seeking. Once seeking, it emits `-copyts` (plus
        // `-start_at_zero` for copied video), and the muxer then writes the SOURCE
        // timestamps — the whole point being that fMP4 BMDT lines up with the VOD
        // playlist's cumulative segment times, which are themselves absolute.
        //
        // Measured on prod, real media (2160p HEVC MKV, container start_time 0),
        // with the exact flags the args builder produces, seeking to 1800s:
        //
        //   transcode + seek  (-copyts)                  -> first PTS 1800.0
        //   copy + seek       (-copyts -start_at_zero)   -> first PTS 1798.0
        //                                                   (keyframe before seek)
        //   no seek           (-avoid_negative_ts make_zero) -> first PTS 0.0
        //
        // Absolute in every case; `-start_at_zero` shifts by the container's
        // start_time, NOT by the seek. The WebVTT cues extracted for this same file
        // are absolute too (identical with and without `-copyts`). So subtracting
        // the seek made every cue land EARLY by exactly the resume offset —
        // invisible when starting from 0, and proportional to how far in you
        // resumed. `seekToSegment` also rewrites `startTimeSeconds` on each new
        // generation, so mid-playback seeks hit it as well.
        //
        // The subtitle playlist and the video VOD playlist are both built on the
        // absolute timeline and share a PROGRAM-DATE-TIME epoch, so absolute cue
        // times are what agrees with both.
        let seekOffsetSeconds = 0;

        // Diagnostic: allow URL-based subtitle offset adjustment for testing.
        // Usage: &sub_offset=-5 shifts subtitles 5s earlier.
        const subOffsetParam = url.searchParams.get('sub_offset');
        if (subOffsetParam) {
            const adjustment = parseFloat(subOffsetParam);
            if (Number.isFinite(adjustment)) {
                logger.info('Applying subtitle offset adjustment', {
                    original: seekOffsetSeconds,
                    adjustment,
                    adjusted: seekOffsetSeconds + adjustment,
                });
                seekOffsetSeconds += adjustment;
            }
        }

        // Calculate ABSOLUTE time range for this segment
        // Segment numbers map to absolute media time, not relative to seek
        const startSeconds = segmentNumber * segmentDuration;
        // The last listed segment runs to the end: it absorbs a folded tail
        // (see hls-segment-grid.ts), so its cues must too.
        const listedCount = uniformSegmentCount(totalDuration, segmentDuration);
        const isLastListed = segmentNumber === listedCount - 1;
        const endSeconds = isLastListed
            ? totalDuration
            : Math.min(startSeconds + segmentDuration, totalDuration);

        // Validate segment is within media bounds. Past the folded last entry
        // too: its cues already went out with the last listed segment.
        if (startSeconds >= totalDuration || segmentNumber >= listedCount) {
            return new Response(generateEmptySegmentWithNoCues(), {
                status: 200,
                headers: {
                    'Content-Type': 'text/vtt; charset=utf-8',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'max-age=86400',
                },
            });
        }

        // Check for debug subtitle mode
        const debugSubtitles = config.DEBUG_SUBTITLES || url.searchParams.get('debug_subs') === '1';

        let segmentContent: string;
        // True when this segment is being served empty because extraction
        // is still pending — must NOT poison the cue cache with [] (the
        // background extraction will populate it once done), nor be cached
        // by the client.
        let pendingExtraction = false;

        if (debugSubtitles) {
            // DEBUG MODE: Generate per-second timing cues
            segmentContent = generateDebugSegment(
                startSeconds,
                endSeconds,
                segmentNumber,
                seekOffsetSeconds,
            );
        } else {
            // Resolve cues — check cache first, then resolve and parse
            const cacheKey = getParsedCueCacheKey(
                itemId,
                subtitleIndex,
                fileId,
                scopedFile.file?.probedAt ?? null,
            );
            let cues = getCachedCues(cacheKey);

            if (!cues) {
                if (UUID_RE.test(itemId)) {
                    // Check disk cache first (survives restarts)
                    const diskCached = await SubtitleFileCacheService.get(
                        fileId,
                        subtitleIndex,
                        scopedFile.file?.probedAt,
                    );
                    if (diskCached) {
                        const { content: sanitized } = sanitizeWebVTT(diskCached, {
                            enableLogging: false,
                        });
                        cues = parseWebVTT(sanitized).cues;
                    } else {
                        // Not cached yet: extracting embedded subtitles from a
                        // large file can take 100s+ and would FREEZE native-HLS
                        // players that block on the selected subtitle track. So
                        // kick off a deduped background extraction and serve an
                        // empty segment now — subtitles fill in on a later
                        // request once the cache is populated.
                        startBackgroundSubtitleExtraction(itemId, subtitleIndex, fileId, cacheKey);
                        await waitForInflightExtraction(fileId, subtitleIndex);
                        cues = getCachedCues(cacheKey);
                        pendingExtraction = !cues;
                    }
                }

                if (!cues && !UUID_RE.test(itemId)) {
                    cues = await subtitleCacheService.getCues(itemId, subtitleIndex, fileId);
                }

                cues = cues ?? [];
                // Only cache a definitive result. A pending-extraction empty is
                // transient — caching it would hide the real cues once ready.
                if (!pendingExtraction) {
                    setCachedCues(cacheKey, cues);
                }
            }

            // Generate WebVTT segment with seek offset for relative timestamps
            segmentContent = generateSegment(
                cues,
                startSeconds,
                endSeconds,
                segmentNumber,
                segmentDuration,
                debugSubtitles,
                seekOffsetSeconds,
            );
        }

        return new Response(segmentContent, {
            status: 200,
            headers: {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                // An empty answer while extraction is still running is
                // transient: never let a cache keep it (it used to be cached
                // for a day, so reopening the title showed no subtitles either).
                'Cache-Control': pendingExtraction ? 'no-store' : 'max-age=86400',
            },
        });
    } catch (error) {
        logger.error('Error serving subtitle segment', error as Error, {
            itemId,
            subtitleIndex,
            segmentNumber,
        });
        // Return empty segment with no cues to avoid any timestamp issues
        return new Response(generateEmptySegmentWithNoCues(), {
            status: 200,
            headers: {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }
}

/**
 * Create error response appropriate for subtitle requests.
 * Returns valid WebVTT/HLS to prevent AVPlayer parse errors.
 */
export function createSubtitleErrorResponse(
    segmentNumber: number | null,
    status: number,
): Response {
    if (segmentNumber !== null) {
        // Segment request - return valid empty WebVTT with no cues
        // Safer than generateEmptySegmentWebVTT which might have timing issues
        return new Response(generateEmptySegmentWithNoCues(), {
            status,
            headers: {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } else {
        // Playlist request - return valid empty HLS playlist
        return new Response(createEmptyPlaylist(), {
            status,
            headers: {
                'Content-Type': HLS_CONTENT_TYPE.PLAYLIST,
                'Access-Control-Allow-Origin': '*',
            },
        });
    }
}
