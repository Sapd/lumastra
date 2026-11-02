// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS Request Utilities
 *
 * Helper functions for parsing HLS request parameters, extracting auth tokens,
 * and common async operations used across HLS route handlers.
 */

import type { TrickplayMetadata } from '$lib/server/utils/synthetic-iframe.js';
import * as fs from 'fs/promises';

// ============================================================================
// PLAY SESSION ID
// ============================================================================

/**
 * Character whitelist for a client-supplied `PlaySessionId`.
 *
 * `PlaySessionId` becomes part of the transcode output directory (see
 * `resolveOutputBaseDir` in ffmpeg-transcode.service.ts, which also asserts
 * containment independently as a backstop) and a DB/in-memory lookup key, so
 * this charset is the FIRST of two guards against path traversal — a value
 * like `..` or `../../app` must never reach `path.join`. Deliberately
 * permissive enough to allow preview session IDs like
 * `preview-<uuid>-<timestamp>`, but excludes `/`, `.`, and every other
 * path-meaningful character.
 *
 * This is the single definition of the charset — `startHlsPlayback` validates
 * every caller against it (the one seam all three routes share), and it must
 * not be redefined anywhere else in the tree.
 */
export const SAFE_PLAY_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Parsed trickplay parameters from URL query string
 */
export interface TrickplayParams {
    width: number;
    height: number;
    interval: number;
    count: number;
    tileWidth: number;
    tileHeight: number;
    fileId: string | null;
}

/**
 * Authentication parameters extracted from URL
 */
export interface AuthParams {
    grant: string | null;
    playbackSessionId?: string | null;
    /** Jellyfin compatibility only; never extracted on API routes. */
    apiKey?: string | null;
}

/**
 * Options for waiting for a file to exist
 */
export interface WaitForFileOptions {
    /** Timeout in milliseconds */
    timeout: number;
    /** Polling interval in milliseconds (default: 100) */
    pollInterval?: number;
    /** Optional callback to check if we should stop waiting (e.g., job errored) */
    shouldAbort?: () => boolean;
    /** Optional callback for progress logging */
    onProgress?: (elapsedMs: number) => void;
    /** Interval for progress callbacks in milliseconds (default: 5000) */
    progressInterval?: number;
}

/**
 * Result of waiting for a file
 */
export interface WaitForFileResult {
    exists: boolean;
    waitTimeMs: number;
    aborted: boolean;
}

// ============================================================================
// TRICKPLAY HELPERS
// ============================================================================

/**
 * Parse trickplay parameters from URL query string.
 * Returns null if required parameters are missing.
 *
 * @param url - URL with query parameters
 * @returns Parsed trickplay params or null if invalid
 */
export function parseTrickplayParams(url: URL): TrickplayParams | null {
    const width = url.searchParams.get('trickplay_width');
    const interval = url.searchParams.get('trickplay_interval');
    const count = url.searchParams.get('trickplay_count');

    // Required params
    if (!width || !interval || !count) {
        return null;
    }

    return {
        width: parseInt(width, 10),
        height: parseInt(url.searchParams.get('trickplay_height') || '0', 10),
        interval: parseInt(interval, 10),
        count: parseInt(count, 10),
        tileWidth: parseInt(url.searchParams.get('trickplay_tile_width') || '10', 10),
        tileHeight: parseInt(url.searchParams.get('trickplay_tile_height') || '10', 10),
        fileId: url.searchParams.get('fileId'),
    };
}

/**
 * Build TrickplayMetadata object from parsed params.
 * Calculates height from width if not provided (assumes 16:9 aspect ratio).
 *
 * @param params - Parsed trickplay parameters
 * @returns TrickplayMetadata object
 */
export function buildTrickplayMetadata(params: TrickplayParams): TrickplayMetadata {
    return {
        width: params.width,
        height: params.height || Math.floor((params.width * 9) / 16),
        tileWidth: params.tileWidth,
        tileHeight: params.tileHeight,
        intervalMs: params.interval,
        thumbnailCount: params.count,
    };
}

/**
 * Add trickplay metadata to URLSearchParams for passing to segment requests.
 *
 * @param searchParams - URLSearchParams to modify
 * @param params - Trickplay parameters to add
 */
export function addTrickplayParamsToSearch(
    searchParams: URLSearchParams,
    params: TrickplayParams,
): void {
    const metadata = buildTrickplayMetadata(params);
    searchParams.set('trickplay_width', String(params.width));
    searchParams.set('trickplay_height', String(metadata.height));
    searchParams.set('trickplay_interval', String(params.interval));
    searchParams.set('trickplay_count', String(params.count)); // Required by parseTrickplayParams
    searchParams.set('trickplay_tile_width', String(params.tileWidth));
    searchParams.set('trickplay_tile_height', String(params.tileHeight));
    if (params.fileId) {
        searchParams.set('fileId', params.fileId);
    }
}

// ============================================================================
// AUTH HELPERS
// ============================================================================

/**
 * Extract authentication parameters from URL query string.
 *
 * @param url - URL with query parameters
 * @returns Auth params object
 */
export function extractAuthParams(url: URL): AuthParams {
    const jellyfinCompat = !url.pathname.includes('/api/') && /\/j\//.test(url.pathname);
    return {
        grant: jellyfinCompat ? null : url.searchParams.get('grant'),
        playbackSessionId: url.searchParams.get('PlaySessionId'),
        ...(jellyfinCompat ? { apiKey: url.searchParams.get('api_key') } : {}),
    };
}

/**
 * Add auth parameters to URLSearchParams.
 * Propagates grants; api_key is reserved for Jellyfin compatibility.
 *
 * @param searchParams - URLSearchParams to modify
 * @param auth - Auth parameters to add
 */
export function addAuthToSearchParams(searchParams: URLSearchParams, auth: AuthParams): void {
    if (auth.playbackSessionId && !searchParams.has('PlaySessionId'))
        searchParams.set('PlaySessionId', auth.playbackSessionId);
    if (auth.grant) {
        searchParams.set('grant', auth.grant);
    } else if (auth.apiKey) {
        searchParams.set('api_key', auth.apiKey);
    }
}

/**
 * Pin the playback identity onto a self-referencing playlist URL.
 *
 * The muxed master's EXT-X-STREAM-INF points back at the SAME endpoint with
 * `hlsPlaylist=media`, so the follow-up request re-enters startHlsPlayback and
 * re-derives the ENTIRE playback config from that URL alone. The segment params
 * it is built from carry only session/auth/seek/profile, so every field below is
 * otherwise lost — and the second request then computes a different config from
 * the first, which the existing-job check reads as "the client changed something"
 * and answers by tearing down FFmpeg and respawning it.
 *
 * Concretely, when these are dropped:
 *   - `plan`       → resolvedPlan is undefined, so the codec fallbacks below have
 *                    nothing real to fall back to.
 *   - `videoCodec` → with burn-in active this trips `burnInNeedsRealCodec`, whose
 *                    chain bottoms out at a hardcoded 'hevc'. Observed on prod:
 *                    existingOutputCodec h264 → newOutputCodec hevc, respawning
 *                    the job as HEVC while the master already advertised avc1.
 *   - `audioCodec` → flips forceAudioTranscode.
 *   - subtitle     → resolves to "no burn-in", respawning without the subtitle.
 *
 * Same reasoning as the neighbouring `hlsAudioMode` pin: anything the follow-up
 * request cannot re-derive on its own has to travel in the URL.
 *
 * @param searchParams - URLSearchParams to modify
 * @param identity - The first request's resolved playback identity
 */
export function addPlaybackIdentityToSearchParams(
    searchParams: URLSearchParams,
    identity: {
        planId?: string;
        videoCodec?: string;
        audioCodec?: string;
        subtitleBurnIn?: { absoluteIndex: number };
    },
): void {
    if (identity.planId) searchParams.set('plan', identity.planId);
    if (identity.videoCodec) searchParams.set('videoCodec', identity.videoCodec);
    if (identity.audioCodec) searchParams.set('audioCodec', identity.audioCodec);
    if (identity.subtitleBurnIn) {
        searchParams.set('SubtitleStreamIndex', String(identity.subtitleBurnIn.absoluteIndex));
        searchParams.set('SubtitleMethod', 'Encode');
    }
}

// ============================================================================
// FILE WAITING HELPERS
// ============================================================================

/**
 * Wait for a file to exist with configurable timeout and polling.
 *
 * @param filePath - Path to the file to wait for
 * @param options - Wait options (timeout, polling interval, abort check)
 * @returns Result indicating if file exists and how long we waited
 */
export async function waitForFile(
    filePath: string,
    options: WaitForFileOptions,
): Promise<WaitForFileResult> {
    const {
        timeout,
        pollInterval = 100,
        shouldAbort,
        onProgress,
        progressInterval = 5000,
    } = options;

    const startTime = Date.now();
    let lastProgressTime = startTime;

    while (Date.now() - startTime < timeout) {
        // Check if file exists
        try {
            await fs.access(filePath);
            return {
                exists: true,
                waitTimeMs: Date.now() - startTime,
                aborted: false,
            };
        } catch {
            // File doesn't exist yet
        }

        // Check if we should abort (e.g., job errored)
        if (shouldAbort?.()) {
            return {
                exists: false,
                waitTimeMs: Date.now() - startTime,
                aborted: true,
            };
        }

        // Progress callback
        const now = Date.now();
        if (onProgress && now - lastProgressTime >= progressInterval) {
            lastProgressTime = now;
            onProgress(now - startTime);
        }

        // Wait before next poll
        await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
        exists: false,
        waitTimeMs: Date.now() - startTime,
        aborted: false,
    };
}

/**
 * Read file if it exists, with optional wait.
 * Convenience wrapper around waitForFile + fs.readFile.
 *
 * @param filePath - Path to the file
 * @param options - Wait options (set timeout to 0 for no waiting)
 * @returns File buffer or null if not found/timeout
 */
export async function readFileWithWait(
    filePath: string,
    options: WaitForFileOptions,
): Promise<Buffer | null> {
    // If timeout is 0, just try to read directly
    if (options.timeout === 0) {
        try {
            return await fs.readFile(filePath);
        } catch {
            return null;
        }
    }

    const result = await waitForFile(filePath, options);
    if (!result.exists) {
        return null;
    }

    try {
        return await fs.readFile(filePath);
    } catch {
        return null;
    }
}

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

/** Standard CORS headers for HLS responses */
export const HLS_CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-Lumastra-Diagnostic-Code, X-Lumastra-Diagnostic-Id',
} as const;

/**
 * Create standard HLS response headers.
 *
 * @param contentType - MIME type for the response
 * @param cacheControl - Cache-Control header value
 * @param contentLength - Optional content length
 * @returns Headers object
 */
export function createHlsResponseHeaders(
    contentType: string,
    cacheControl: string,
    contentLength?: number,
): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': cacheControl,
    };
    if (contentLength !== undefined) {
        headers['Content-Length'] = contentLength.toString();
    }
    return headers;
}

/**
 * Create headers for binary segment response with optional Range support.
 *
 * @param contentType - MIME type
 * @param fileSize - Total file size
 * @param range - Optional range (start, end) for partial content
 * @returns Headers object and status code
 */
export function createSegmentResponseHeaders(
    contentType: string,
    fileSize: number,
    range?: { start: number; end: number },
): { headers: Record<string, string>; status: number } {
    if (range) {
        const contentLength = range.end - range.start + 1;
        return {
            status: 206,
            headers: {
                'Content-Type': contentType,
                'Content-Length': contentLength.toString(),
                'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'max-age=3600',
            },
        };
    }

    return {
        status: 200,
        headers: {
            'Content-Type': contentType,
            'Content-Length': fileSize.toString(),
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'max-age=3600',
        },
    };
}

/**
 * Parse HTTP Range header.
 *
 * @param rangeHeader - Range header value (e.g., "bytes=0-1023")
 * @param fileSize - Total file size for validation
 * @returns Parsed range or null if invalid
 */
export function parseRangeHeader(
    rangeHeader: string | null,
    fileSize: number,
): { start: number; end: number } | null {
    if (!rangeHeader) return null;

    // Suffix range `bytes=-N`: the last N bytes (RFC 9110 §14.1.2). Players use it
    // to read an MP4's trailing moov box before they start playback.
    const suffix = rangeHeader.match(/bytes=-(\d+)/);
    if (suffix) {
        const length = parseInt(suffix[1], 10);
        if (length <= 0 || fileSize === 0) return null;
        return { start: Math.max(0, fileSize - length), end: fileSize - 1 };
    }

    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) return null;

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    // Validate range
    if (start >= fileSize || end < start) return null;

    return {
        start,
        end: Math.min(end, fileSize - 1),
    };
}

// ============================================================================
// SEEK / START-TIME HELPERS
// ============================================================================

/**
 * Parse seek position from URL query parameters.
 *
 * Reads `seek` first (raw seconds, parseFloat), then falls back to
 * `StartTimeTicks` (Jellyfin ticks divided by 10,000,000).
 * Returns undefined when no param is present, the value is 0, or the
 * result is NaN.
 *
 * @param searchParams - URLSearchParams from the request URL
 * @returns Seek position in seconds, or undefined
 */
export function parseSeekSeconds(searchParams: URLSearchParams): number | undefined {
    const seekRaw = searchParams.get('seek');
    if (seekRaw !== null) {
        const seconds = parseFloat(seekRaw);
        if (!Number.isNaN(seconds) && seconds > 0) {
            return seconds;
        }
        return undefined;
    }

    const ticksRaw = searchParams.get('StartTimeTicks');
    if (ticksRaw !== null) {
        const ticks = parseFloat(ticksRaw);
        if (!Number.isNaN(ticks) && ticks > 0) {
            return ticks / 10_000_000;
        }
    }

    return undefined;
}

// ============================================================================
// HLS PLAYLIST POLLING HELPERS
// ============================================================================

/**
 * Wait for an HLS playlist file to appear on disk with non-zero size.
 *
 * Polls the file system at `pollIntervalMs` intervals until the file exists
 * and has a non-zero size, or until `timeoutMs` elapses.
 *
 * @param outputDir - Directory where the playlist will be written
 * @param playlistName - Filename of the playlist (e.g. 'master.m3u8')
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param pollIntervalMs - Polling interval in milliseconds (default: 200)
 * @param shouldAbort - Optional predicate polled each iteration; when it returns
 *   true the wait stops early and returns false (e.g. FFmpeg already died, so
 *   waiting the full timeout for a playlist that will never appear is pointless).
 * @returns true if the file appeared within the timeout, false otherwise
 */
export async function waitForHlsPlaylist(
    outputDir: string,
    playlistName: string,
    timeoutMs: number,
    pollIntervalMs: number = 200,
    shouldAbort?: () => boolean,
): Promise<boolean> {
    const filePath = `${outputDir}/${playlistName}`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const stat = await fs.stat(filePath);
            if (stat.size > 0) {
                return true;
            }
        } catch {
            // Not ready yet (file doesn't exist or is inaccessible)
        }
        if (shouldAbort?.()) {
            return false;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return false;
}

/** The one query serializer used by Live TV and audiobook playlist builders. */
export function hlsAuthQuery(url: URL): string {
    const params = new URLSearchParams();
    addAuthToSearchParams(params, extractAuthParams(url));
    const query = params.toString();
    return query ? `?${query}` : '';
}
