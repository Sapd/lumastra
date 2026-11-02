// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS I-Frame Handler
 *
 * Handles I-frame playlist and segment requests for HLS streams.
 * Supports two modes:
 * 1. Native I-frames: Byte ranges into video segments
 * 2. Synthetic I-frames: Trickplay thumbnails converted to video segments
 *
 * Routes: iframe.m3u8, iframe_XXXXX.ts
 */

import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import {
    getFFmpegTranscodeService,
    type TranscodeJob,
} from '$lib/server/services/ffmpeg-transcode.service.js';
import { jellyfinMediaService } from '$lib/server/jellyfin.js';
import {
    createIFramePlaylistHeader,
    HlsPlaylistBuilder,
    HLS_CONTENT_TYPE,
    IFRAME_HLS_VERSION,
} from '$lib/server/utils/hls-definitions.js';
import {
    generateSyntheticIFramePlaylist,
    generateSyntheticIFrame,
    calculateSpritePosition,
    type TrickplayMetadata,
} from '$lib/server/utils/synthetic-iframe.js';
import {
    buildIFrameCacheKey,
    getCachedIFrame,
    cacheIFrame,
} from '$lib/server/caches/synthetic-iframe.js';
import { getCachedTile, cacheTile, buildTileCacheKey } from '$lib/server/caches/trickplay-tile.js';
import {
    parseTrickplayParams,
    buildTrickplayMetadata,
    addTrickplayParamsToSearch,
    extractAuthParams,
    addAuthToSearchParams,
} from '$lib/server/utils/hls-request-utils.js';
import { resolveFileScopedToItem, type ResolvedScopedFile } from './file-scope.js';
import { getSpriteSheet } from '$lib/server/services/trickplay-storage.service.js';
import { getJellyfinDiskSpriteSheet } from '$lib/server/tasks/builtin/native/trickplay-providers/jellyfin-disk.js';
import { getMediaItemRuntime } from '$lib/server/database/queries/media-lookup.queries.js';
import { getDb } from '$lib/server/database/connection.js';
import { canCallJellyfin } from '$lib/server/jellyfin/runtime-gate.js';
import { uniformSegmentCount } from '$lib/server/utils/hls-segment-grid.js';

const logger = Logger.for('HLSIFrameHandler');

/** CORS headers */
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
} as const;

/** The outcome of `resolveTrickplayFile`: either the resolved file (`file` is
 *  `null` when no `fileId` was supplied at all) or an HTTP `response` the
 *  caller should return immediately. */
type TrickplayFileResolution =
    { ok: true; file: ResolvedScopedFile | null } | { ok: false; response: Response };

/**
 * Trickplay-flavoured wrapper around `resolveFileScopedToItem`
 * (`file-scope.js`): turns its bare status code into the plain-text Response
 * the trickplay/I-frame handlers have always returned. See
 * `resolveFileScopedToItem`'s doc comment for the underlying scoping logic
 * and its rationale — it also backs the HLS subtitle segment handler
 * (`subtitle-handler.ts`, 2026-09-24 fix plan 6 C1-sibling); don't fork a
 * third copy.
 */
async function resolveTrickplayFile(
    rawFileId: string | null,
    internalId: string | undefined,
): Promise<TrickplayFileResolution> {
    const decision = await resolveFileScopedToItem(rawFileId, internalId);
    if (decision.ok) return decision;

    const body = decision.status === 400 ? 'Invalid fileId' : 'Trickplay tile not available';
    return {
        ok: false,
        response: new Response(body, { status: decision.status, headers: CORS_HEADERS }),
    };
}

// ============================================================================
// TYPES
// ============================================================================

interface VodManifestInfo {
    totalDurationSeconds: number;
    segmentDurationSeconds: number;
    totalSegments: number;
    isComplete: boolean;
}

// ============================================================================
// I-FRAME PLAYLIST GENERATORS
// ============================================================================

/**
 * Generate pre-calculated I-frame playlist for Jellyfin transcoded streams.
 * Keyframes are at segment boundaries due to -force_key_frames.
 */
function generatePreCalculatedIFramePlaylist(
    vodInfo: VodManifestInfo,
    videoStreamIndex: number,
    segmentBase: string,
    queryParams?: string,
    segmentOffset: number = 0,
): string {
    const { totalDurationSeconds, segmentDurationSeconds, totalSegments } = vodInfo;
    const querySuffix = queryParams ? `?${queryParams}` : '';

    const availableSegments = totalSegments - segmentOffset;
    const startTimeSeconds = segmentOffset * segmentDurationSeconds;

    const builder = createIFramePlaylistHeader({
        targetDuration: segmentDurationSeconds,
        playlistType: 'VOD',
    }).mapUri(
        `${segmentBase}/stream_${videoStreamIndex}/init_${videoStreamIndex}.mp4${querySuffix}`,
    );

    if (segmentOffset > 0) {
        builder.startOffset(startTimeSeconds, true);
    }

    // 200KB byte range for keyframe extraction
    const byteRangeSize = 200000;

    for (let i = 0; i < availableSegments; i++) {
        const logicalSegment = segmentOffset + i;
        const isLast = logicalSegment === totalSegments - 1;
        const duration = isLast
            ? totalDurationSeconds - logicalSegment * segmentDurationSeconds
            : segmentDurationSeconds;

        const segmentUri = `${segmentBase}/stream_${videoStreamIndex}/segment_${String(i).padStart(5, '0')}.m4s${querySuffix}`;
        builder.segmentWithByteRange(duration, segmentUri, byteRangeSize, 0);
    }

    return builder.endlist().build();
}

/**
 * Generate analyzed I-frame playlist using ffprobe-derived keyframe positions.
 * Exported for tests.
 */
export function generateAnalyzedIFramePlaylist(
    job: Pick<TranscodeJob, 'iframeData' | 'iframeAnalysisComplete'>,
    videoStreamIndex: number,
    segmentBase: string,
    queryParams?: string,
): string {
    const querySuffix = queryParams ? `?${queryParams}` : '';

    // A reduce, not Math.max(...spread): one entry per keyframe overflows the
    // call stack on a long (or bogus-duration) timeline.
    const maxDuration = job.iframeData.reduce((max, f) => (f.duration > max ? f.duration : max), 6);

    const builder = new HlsPlaylistBuilder()
        .header()
        .version(IFRAME_HLS_VERSION)
        .iFramesOnly()
        .mapUri(
            `${segmentBase}/stream_${videoStreamIndex}/init_${videoStreamIndex}.mp4${querySuffix}`,
        )
        .targetDuration(maxDuration);

    if (job.iframeAnalysisComplete) {
        builder.playlistType('VOD');
    }

    for (const iframe of job.iframeData) {
        builder.segmentWithByteRange(
            iframe.duration,
            `${segmentBase}/${iframe.segmentUri}${querySuffix}`,
            iframe.byteSize,
            iframe.byteOffset,
        );
    }

    if (job.iframeAnalysisComplete) {
        builder.endlist();
    }

    return builder.build();
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Handle synthetic I-frame playlist request.
 */
async function handleSyntheticIFramePlaylist(
    itemId: string,
    playSessionId: string,
    url: URL,
    segmentParams: URLSearchParams,
    internalId?: string,
): Promise<Response> {
    const trickplayParams = parseTrickplayParams(url);

    if (!trickplayParams || !trickplayParams.width || !trickplayParams.count) {
        logger.error('Missing trickplay metadata for synthetic I-frame playlist', undefined, {
            itemId,
            width: trickplayParams?.width,
            count: trickplayParams?.count,
        });
        return new Response('Missing trickplay metadata', {
            status: 400,
            headers: CORS_HEADERS,
        });
    }

    // A fileId must belong to THIS item before it's baked into every
    // segment URL below — otherwise the playlist would hand out a foreign
    // (possibly restricted) item's thumbnail via iframe_XXXXX.ts?fileId=...
    const resolvedFile = await resolveTrickplayFile(trickplayParams.fileId, internalId);
    if (!resolvedFile.ok) return resolvedFile.response;
    trickplayParams.fileId = resolvedFile.file?.fileId ?? null;

    // Get total duration
    let totalDurationSeconds: number | null = null;
    const transcodeService = getFFmpegTranscodeService();
    const job = transcodeService.getJob(playSessionId);

    if (job?.config?.totalDurationSeconds) {
        totalDurationSeconds = job.config.totalDurationSeconds;
    }

    if (!totalDurationSeconds) {
        const db = getDb();
        if (db) {
            totalDurationSeconds = await getMediaItemRuntime(db, itemId);
        }
    }

    if (!totalDurationSeconds) {
        try {
            // Jellyfin is only a last-resort duration source, and only while sync
            // is on and it is reachable — a stopped server must not cost a timeout.
            const itemInfo = canCallJellyfin()
                ? await jellyfinMediaService.getItemInfo(itemId)
                : null;
            if (!itemInfo?.RunTimeTicks) {
                logger.warn('Could not get duration for synthetic I-frame playlist', { itemId });
                return new Response('Duration not available', {
                    status: 503,
                    headers: CORS_HEADERS,
                });
            }
            totalDurationSeconds = itemInfo.RunTimeTicks / 10_000_000;
        } catch (error) {
            logger.error('Failed to fetch item info for synthetic I-frames', error as Error, {
                itemId,
            });
            return new Response('Failed to get item info', {
                status: 503,
                headers: CORS_HEADERS,
            });
        }
    }

    const resolvedDurationSeconds = totalDurationSeconds!;
    const trickplayMetadata = buildTrickplayMetadata(trickplayParams);

    // Add trickplay params to segment URLs
    addTrickplayParamsToSearch(segmentParams, trickplayParams);

    const segmentBase = '.';
    const queryParams = segmentParams.toString();
    const targetIntervalSeconds = config.SYNTHETIC_IFRAME_INTERVAL_SECONDS;

    const playlistContent = generateSyntheticIFramePlaylist(
        trickplayMetadata,
        resolvedDurationSeconds,
        segmentBase,
        queryParams,
        targetIntervalSeconds,
    );

    // Calculate actual I-frame count
    const trickplayIntervalSec = trickplayParams.interval / 1000;
    const skipFactor = Math.max(1, Math.round(targetIntervalSeconds / trickplayIntervalSec));
    const actualIntervalSec = trickplayIntervalSec * skipFactor;
    const iframeCount = Math.min(
        Math.ceil(resolvedDurationSeconds / actualIntervalSec),
        Math.ceil(trickplayParams.count / skipFactor),
    );

    logger.info('Serving synthetic I-frame playlist', {
        itemId,
        playSessionId,
        iframeCount,
        trickplayWidth: trickplayParams.width,
        totalDurationSeconds: resolvedDurationSeconds,
        targetIntervalSeconds,
        skipFactor,
    });

    return new Response(playlistContent, {
        status: 200,
        headers: {
            'Content-Type': HLS_CONTENT_TYPE.PLAYLIST,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'max-age=3600',
        },
    });
}

/**
 * Handle native I-frame playlist request.
 */
async function handleNativeIFramePlaylist(
    itemId: string,
    playSessionId: string,
    queryParams: string,
): Promise<Response> {
    const transcodeService = getFFmpegTranscodeService();
    const job = transcodeService.getJob(playSessionId);

    let playlistContent: string;
    let mode: string;
    let iframeCount: number;
    let cacheControl: string;

    if (job) {
        const vodInfo = transcodeService.getVodManifestInfo(playSessionId);
        if (!vodInfo) {
            logger.warn('VOD info not available for I-frame playlist', {
                playSessionId,
                itemId,
            });
            return new Response('VOD info not available', {
                status: 503,
                headers: CORS_HEADERS,
            });
        }

        const videoStreamIndex = job.config.audioTracks.length;
        const segmentBase = '.';
        const segmentOffset = transcodeService.getSegmentOffset(playSessionId);

        if (job.config.isJellyfinTranscoded) {
            playlistContent = generatePreCalculatedIFramePlaylist(
                vodInfo,
                videoStreamIndex,
                segmentBase,
                queryParams,
                segmentOffset,
            );
            mode = 'pre-calculated';
            iframeCount = vodInfo.totalSegments - segmentOffset;
        } else {
            // Wait for I-frame analysis if needed
            if (job.iframeData.length === 0 && !job.iframeAnalysisComplete) {
                const deadline = Date.now() + 3000;
                while (
                    job.iframeData.length === 0 &&
                    Date.now() < deadline &&
                    !job.iframeAnalysisComplete
                ) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }

            playlistContent = generateAnalyzedIFramePlaylist(
                job,
                videoStreamIndex,
                segmentBase,
                queryParams,
            );
            mode = 'analyzed';
            iframeCount = job.iframeData.length;
        }
        cacheControl = job.iframeAnalysisComplete ? 'max-age=3600' : 'no-cache, max-age=0';
    } else {
        // No job - try DB first, then fall back to Jellyfin
        logger.debug('No transcode job, resolving item duration for I-frame playlist', {
            itemId,
        });

        let totalDurationSeconds: number | null = null;
        const db = getDb();
        if (db) {
            totalDurationSeconds = await getMediaItemRuntime(db, itemId);
        }

        if (totalDurationSeconds) {
            const segmentDurationSeconds = 6;
            const totalSegments = uniformSegmentCount(totalDurationSeconds, segmentDurationSeconds);
            const audioTrackCount = 2;

            const vodInfo: VodManifestInfo = {
                totalDurationSeconds,
                segmentDurationSeconds,
                totalSegments,
                isComplete: true,
            };

            playlistContent = generatePreCalculatedIFramePlaylist(
                vodInfo,
                audioTrackCount,
                '.',
                queryParams,
            );
            mode = 'pre-calculated-from-db';
            iframeCount = totalSegments;
            cacheControl = 'max-age=60';
        } else {
            try {
                const itemInfo = canCallJellyfin()
                    ? await jellyfinMediaService.getItemInfo(itemId)
                    : null;
                if (!itemInfo?.RunTimeTicks) {
                    logger.warn('Could not get item duration for I-frame playlist', { itemId });
                    return new Response('Item info not available', {
                        status: 503,
                        headers: CORS_HEADERS,
                    });
                }

                const jellyfinDurationSeconds = itemInfo.RunTimeTicks / 10_000_000;
                const segmentDurationSeconds = 6;
                const totalSegments = uniformSegmentCount(
                    jellyfinDurationSeconds,
                    segmentDurationSeconds,
                );

                const audioTrackCount =
                    itemInfo.MediaStreams?.filter((s: { Type: string }) => s.Type === 'Audio')
                        .length || 2;

                const vodInfo: VodManifestInfo = {
                    totalDurationSeconds: jellyfinDurationSeconds,
                    segmentDurationSeconds,
                    totalSegments,
                    isComplete: true,
                };

                playlistContent = generatePreCalculatedIFramePlaylist(
                    vodInfo,
                    audioTrackCount,
                    '.',
                    queryParams,
                );
                mode = 'pre-calculated-from-jellyfin';
                iframeCount = totalSegments;
                cacheControl = 'max-age=60';
            } catch (error) {
                logger.error('Failed to fetch item info for I-frame playlist', error as Error, {
                    itemId,
                });
                return new Response('Failed to get item info', {
                    status: 503,
                    headers: CORS_HEADERS,
                });
            }
        }
    }

    logger.info('Serving I-frame playlist', {
        itemId,
        playSessionId,
        mode,
        iframeCount,
    });

    return new Response(playlistContent, {
        status: 200,
        headers: {
            'Content-Type': HLS_CONTENT_TYPE.PLAYLIST,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': cacheControl,
        },
    });
}

/**
 * Handle I-frame playlist request (iframe.m3u8).
 * Dispatches to synthetic or native handler based on query params.
 */
export async function handleIFramePlaylist(
    itemId: string,
    playSessionId: string,
    url: URL,
    internalId?: string,
): Promise<Response> {
    const isSynthetic = url.searchParams.get('synthetic') === 'true';

    // Build query params for segment URLs
    const segmentParams = new URLSearchParams();
    segmentParams.set('PlaySessionId', playSessionId);

    const auth = extractAuthParams(url);
    addAuthToSearchParams(segmentParams, auth);

    if (isSynthetic) {
        return handleSyntheticIFramePlaylist(itemId, playSessionId, url, segmentParams, internalId);
    } else {
        return handleNativeIFramePlaylist(itemId, playSessionId, segmentParams.toString());
    }
}

/**
 * Handle synthetic I-frame segment request (iframe_XXXXX.ts).
 * Extracts thumbnail from trickplay sprite sheet and converts to MPEG-TS.
 */
export async function handleSyntheticIFrameSegment(
    itemId: string,
    iframeIndex: number,
    url: URL,
    internalId?: string,
): Promise<Response> {
    const trickplayParams = parseTrickplayParams(url);

    if (!trickplayParams?.width) {
        logger.error('Missing trickplay metadata for I-frame segment', undefined, {
            itemId,
            iframeIndex,
            width: trickplayParams?.width,
        });
        return new Response('Missing trickplay metadata', {
            status: 400,
            headers: CORS_HEADERS,
        });
    }

    const trickplayMetadata: TrickplayMetadata = {
        ...buildTrickplayMetadata(trickplayParams),
        thumbnailCount: 0, // Not needed for single segment
    };

    // Validate + resolve fileId against THIS item BEFORE it is used for
    // anything — including the cache key below. A raw, unvalidated fileId
    // here would let a caller pull (and cache-poison) another item's
    // thumbnail, or escape the trickplay storage root via a path-traversal
    // payload.
    const resolvedFile = await resolveTrickplayFile(trickplayParams.fileId, internalId);
    if (!resolvedFile.ok) return resolvedFile.response;
    const fileId = resolvedFile.file?.fileId ?? null;
    const mediaFilePath = resolvedFile.file?.mediaFilePath ?? null;

    // Check cache first
    const cacheKey = buildIFrameCacheKey(itemId, iframeIndex, trickplayParams.width, fileId);
    const cachedSegment = getCachedIFrame(cacheKey);
    if (cachedSegment) {
        logger.debug('Serving cached synthetic I-frame', {
            itemId,
            iframeIndex,
            size: cachedSegment.length,
        });
        return new Response(new Uint8Array(cachedSegment), {
            status: 200,
            headers: {
                'Content-Type': 'video/mp2t',
                'Content-Length': cachedSegment.length.toString(),
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'max-age=3600',
            },
        });
    }

    try {
        // Calculate sprite position
        const pos = calculateSpritePosition(iframeIndex, trickplayMetadata);

        // Get trickplay manifest
        // Get sprite sheet
        const tileCacheKey = buildTileCacheKey(
            itemId,
            pos.sheetIndex,
            trickplayParams.width,
            fileId,
        );
        let spriteSheet = getCachedTile(tileCacheKey);

        if (!spriteSheet) {
            if (!fileId) {
                return new Response('fileId required for trickplay', {
                    status: 400,
                    headers: CORS_HEADERS,
                });
            }

            spriteSheet = await getSpriteSheet(
                fileId,
                trickplayParams.width,
                pos.sheetIndex,
                mediaFilePath,
            );

            // Fall back to Jellyfin's on-disk trickplay layout, exactly as the
            // regular tile route does. The two sources store sheets completely
            // differently — ours is `.trickplay/{key}/{width}/{i}.webp`, Jellyfin's
            // is `{basename}.trickplay/{width} - {tw}x{th}/{i}.jpg` — and only the
            // local reader was wired up here. On a library whose trickplay came
            // from Jellyfin that meant a 404 for every thumbnail, so AVPlayer drew
            // the scrubbing frame with nothing in it. (Prod: 46327 jellyfin-disk
            // rows vs 242 local, i.e. this path failed for ~99.5% of titles.)
            if (!spriteSheet) {
                const jellyfinTile = await getJellyfinDiskSpriteSheet(
                    itemId,
                    trickplayParams.width,
                    pos.sheetIndex,
                );
                if (jellyfinTile) {
                    spriteSheet = jellyfinTile.buffer;
                }
            }

            if (!spriteSheet) {
                logger.warn('No trickplay sheet available for synthetic I-frame', {
                    itemId,
                    fileId,
                    sheetIndex: pos.sheetIndex,
                });
                return new Response('Trickplay tile not available', {
                    status: 404,
                    headers: CORS_HEADERS,
                });
            }

            cacheTile(tileCacheKey, spriteSheet);

            logger.debug('Cached sprite sheet for I-frame generation', {
                itemId,
                sheetIndex: pos.sheetIndex,
                size: spriteSheet.length,
            });
        }

        // Generate synthetic I-frame
        const iframeSegment = await generateSyntheticIFrame(
            spriteSheet,
            iframeIndex,
            trickplayMetadata,
        );

        // Cache result
        cacheIFrame(cacheKey, iframeSegment);

        logger.debug('Generated and serving synthetic I-frame', {
            itemId,
            iframeIndex,
            sheetIndex: pos.sheetIndex,
            position: `${pos.col},${pos.row}`,
            size: iframeSegment.length,
        });

        return new Response(new Uint8Array(iframeSegment), {
            status: 200,
            headers: {
                'Content-Type': 'video/mp2t',
                'Content-Length': iframeSegment.length.toString(),
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'max-age=3600',
            },
        });
    } catch (error) {
        logger.error('Error generating synthetic I-frame', error as Error, {
            itemId,
            iframeIndex,
        });
        return new Response('I-frame generation failed', {
            status: 500,
            headers: CORS_HEADERS,
        });
    }
}

/**
 * Parse I-frame segment path.
 * Returns null if path doesn't match I-frame segment pattern.
 *
 * @param segmentPath - Path like "iframe_00123.ts"
 * @returns Iframe index or null
 */
export function parseIFrameSegmentPath(segmentPath: string): number | null {
    const match = segmentPath.match(/^iframe_(\d{5})\.ts$/);
    return match ? parseInt(match[1], 10) : null;
}
