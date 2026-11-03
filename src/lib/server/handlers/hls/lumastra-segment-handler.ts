// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { extractAuthParams, addAuthToSearchParams } from '$lib/server/utils/hls-request-utils.js';
/**
 * Shared HLS Segment Handler
 *
 * Core logic for serving FFmpeg-generated HLS segments and playlists.
 * Used by both /api/v1 and /j/ (jellyfin-compat) endpoints.
 * AuthN/AuthZ for the URL's item is the caller's responsibility (each mount
 * runs its own auth gate before calling in here). This module additionally
 * owns the job->item BINDING check (fix plan 6, C1): every resident/persisted
 * transcode job and preview session it serves must belong to the item the
 * caller's gate actually checked — see `checkJobItemBinding` and
 * `services/hls/job-item-binding.ts`. Without it, a caller authorized for
 * item X could reach another user's job/session for item Y just by knowing
 * (or being handed) Y's PlaySessionId.
 *
 * Routes handled:
 * - master.m3u8 - Custom master playlist with subtitle/trickplay entries
 * - stream_X/index.m3u8 - Audio/video media playlists
 * - stream_X/init_X.mp4 - Init segments
 * - stream_X/segment_XXXXX.m4s - Media segments
 * - subs_X/... - Subtitle playlists and segments (delegated)
 * - trickplay.m3u8 - Trickplay playlist (delegated)
 * - iframe.m3u8, iframe_XXXXX.ts - I-frame playlists and segments (delegated)
 *
 * Sliding Window:
 * - Tracks segment access to determine playback position
 * - Old segments are cleaned up automatically (see ffmpeg-transcode.service.ts)
 * - Returns 410 Gone for deleted segments (client should restart stream)
 */

import { ShutdownInterruptedError } from '$lib/server/lifecycle/shutdown-interrupted.js';
import { shuttingDownResponse } from '$lib/server/lifecycle/web-shutdown.js';
import { Logger } from '$lib/server/utils/logger.js';
import { verifyPlaySessionOwnership } from '$lib/server/services/hls/play-session-ownership.js';
import {
    getFFmpegTranscodeService,
    getLastKeyframeFileIndex,
} from '$lib/server/services/ffmpeg-transcode.service.js';
import {
    getCurrentPodName,
    getTranscodeJobPersistenceService,
} from '$lib/server/services/transcode-job-persistence.service.js';
import type { TranscodeJob } from '$lib/server/services/transcoding/types.js';
import { config, features } from '$lib/server/config.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import * as segmentDeliveryFailures from '$lib/server/services/segment-delivery-failure.service.js';
import { playbackTelemetryService } from '$lib/server/services/playback-telemetry.service.js';
import {
    defaultAudioAbsoluteIndex,
    resolveAudioTrackByAbsoluteIndex,
} from '$lib/shared/stream-index.js';
import type { AudioTrackInfo } from '$lib/server/utils/hls-audio-injection.js';
import { planHlsSegmentAction } from '$lib/server/services/hls/segment-action-planner.js';
import { applyStaleSegmentGuard } from '$lib/server/services/hls/stale-segment-guard.js';
import { serveHlsSegmentFile } from '$lib/server/services/hls/segment-file-responder.js';
import {
    createMissingHlsFileResponse,
    isTranscodeJobDead,
    waitForInitSegment,
} from '$lib/server/services/hls/segment-availability.js';
import { buildHlsSegmentRequestState } from '$lib/server/services/hls/segment-request-state.js';
import { serveMuxedRootAsset } from '$lib/server/services/hls/muxed-root-asset.js';
import { deduplicatedHlsSeek } from '$lib/server/services/hls/seek-coordinator.js';
import {
    clearRepeatedSegmentRequest,
    noteRepeatedSegmentRequest,
    shouldLogStaleAudioRequestWarning,
} from '$lib/server/services/hls/segment-request-tracker.js';
import {
    clearSeekTimestamp,
    getLastSeekTimestamp,
    pruneExpiredSeekTimestamps,
    setLastSeekTimestamp,
} from '$lib/server/services/hls/seek-cooldown-tracker.js';
import {
    logSegmentTrace,
    maybeLogStaleAudioRequest,
    maybeLogSyncTrace,
} from '$lib/server/services/hls/segment-diagnostics.js';
import {
    classifyHlsSegmentRequest,
    recordHlsSeekTraceRequest,
    recordHlsSeekTraceServed,
} from '$lib/server/services/hls/seek-trace-collector.js';
import { resolveHlsSegmentGenerationRoute } from '$lib/server/services/hls/segment-generation-route.js';
import { restoreHlsJobIfMissing } from '$lib/server/services/hls/job-restoration.js';
import { isOutputMarkerPath } from '$lib/server/services/hls/output-marker.js';
import {
    getPreviewSession,
    type PreviewSession,
} from '$lib/server/services/preview-session.service.js';
import { getPreviewCacheStore } from '$lib/server/services/preview-cache.store.js';
import {
    buildBoundItemIds,
    isBoundToItem,
    isRawPreviewCacheSessionId,
    PREVIEW_CACHE_JOB_PREFIX,
    truncateForLog,
} from '$lib/server/services/hls/job-item-binding.js';
import { buildStreamDiagnosticHeaders } from '$lib/server/services/hls/stream-diagnostics.js';
import {
    createDeletedSegmentResponse,
    createSegmentNotFoundResponse,
    createTailCacheSegmentResponse,
    executeBackwardSeekAction,
    executeForwardSeekAction,
    waitForCurrentSegmentFile,
    createSegmentNotReadyResponse,
    type ForwardSeekBranch,
    type SegmentResponseContext,
} from '$lib/server/services/hls/segment-action-executor.js';
import { isGopModeJob } from '$lib/server/services/hls/gop-mode.js';
import { buildGopGridManifest } from '$lib/server/services/hls/vod-playlist.js';
import {
    parseSegmentPath,
    extractSegmentNumber,
    getSegmentFilename,
    isPathInsideDirectory,
} from '$lib/server/utils/hls-segment-utils.js';
import {
    generateMasterPlaylist,
    calculateEstimatedBandwidth,
    localizedRenditionNames,
    manifestAudioTracks,
    RENDITION_NAMES_PATH,
    resolveSyntheticIframes,
    type MasterPlaylistOptions,
    resolveMasterHevcMain10,
} from '$lib/server/utils/hls-master-playlist.js';
import {
    isDistinctStreamDuration,
    resolveEffectiveStreamDuration,
} from '$lib/server/utils/hls-stream-duration.js';
import {
    addVodMarkers,
    generateCompleteVodManifest,
    generateFullVodManifest,
    initSegmentNameForStreamDir,
    parseFFmpegManifest,
    rewriteMediaPlaylist,
} from '$lib/server/services/hls/vod-playlist.js';
import {
    parseSubtitlePath,
    handleSubtitlePlaylist,
    handleSubtitleSegment,
    createSubtitleErrorResponse,
} from '$lib/server/handlers/hls/subtitle-handler.js';
import { handleTrickplayPlaylist } from '$lib/server/handlers/hls/trickplay-handler.js';
import {
    handleIFramePlaylist,
    handleSyntheticIFrameSegment,
    parseIFrameSegmentPath,
} from '$lib/server/handlers/hls/iframe-handler.js';
import { isPastProducedEnd, uniformSegmentCount } from '$lib/server/utils/hls-segment-grid.js';
import { lookupEndSegment } from '$lib/server/services/hls/end-segment-cache.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export { generateVodPlaylist } from '$lib/server/services/hls/vod-playlist.js';
// Re-exported so existing importers (this module used to define both) keep
// working unchanged — the implementation now lives in play-session-ownership.ts
// so playback.service.ts can import it statically (fix plan D-HLS-3).
export {
    verifyPlaySessionOwnership,
    __resetSessionOwnerCacheForTests,
} from '$lib/server/services/hls/play-session-ownership.js';

const logger = Logger.for('HlsLumastraSegmentHandler');

// ================================================================
// CONSTANTS
// ================================================================

/** CORS headers for all responses */
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers':
        'X-Lumastra-Offset, X-Lumastra-Actual, X-Lumastra-Ready, X-Lumastra-Seeking, X-Lumastra-Stream, X-Lumastra-SeekCount, X-Lumastra-SeekTrigger, X-Lumastra-Progress, X-Lumastra-Deleted, X-Lumastra-CanSeek, X-Lumastra-Branch, X-Lumastra-Mode, X-Lumastra-TargetDuration, X-Lumastra-Generation, X-Lumastra-GenerationRole, X-Lumastra-SessionGenerations, X-Lumastra-Session-Terminal, X-Lumastra-Diagnostic-Code, X-Lumastra-Diagnostic-Id',
} as const;

/** Content type mapping by file extension */
const CONTENT_TYPES: Record<string, string> = {
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.m4s': 'video/mp4',
    '.mp4': 'video/mp4',
    '.ts': 'video/mp2t',
};

// `PREVIEW_CACHE_JOB_PREFIX` (job-item-binding.ts) is the job-id prefix the
// shared preview-cache artifact runs under (mirrors `resolveJobPlaySessionId`).
// For a cache-backed viewer, `jobPlaySessionId` is `preview-cache-<cacheKey>`,
// so `slice(PREVIEW_CACHE_JOB_PREFIX.length)` recovers the cache key.

/**
 * Serve a cache-backed preview request directly from its COMPLETE on-disk
 * artifact when the in-memory transcode job is absent — instead of returning
 * `410 "Session expired"` and reverting the hover preview to its backdrop.
 *
 * Why this is needed: a preview cache artifact (`preview-cache-<key>`) is a
 * fixed, complete VOD once its `.ready` marker exists — every segment/init
 * file is on disk and segment indices are 1:1 with the VOD manifest (single
 * generation from the seek bucket, `segmentOffset = 0`, nothing deleted). The
 * in-memory job that serving normally depends on is NOT DB-persisted, so it can
 * be reaped or not-yet-re-warmed while a viewer is mid-playback; the normal
 * path then hits `restoreHlsJobIfMissing`, finds no DB row, and 410s. Reading
 * the finished bytes straight from disk fixes that WITHOUT spawning a second
 * FFmpeg into the shared artifact dir (which would overwrite the very files an
 * active viewer is reading — the corruption hazard the review flagged).
 *
 * Scope: the artifact's master playlist, per-stream media playlists, and
 * segment/init files — everything a cache-backed preview session requests.
 * Serving the master from disk is what lets a `ready` artifact be played with
 * NO in-memory job at all, so createPreview no longer has to re-warm (spawn a
 * second FFmpeg over) a complete artifact just to satisfy serveMasterPlaylist —
 * that re-warm rewrote segment files in place under active viewers and produced
 * truncated reads → hls.js fatal mediaError → hover preview reverting to its
 * backdrop (prod 2026-07-17). Returns null (fall through) unless the artifact
 * is complete AND holds the requested file, so it never changes behavior for
 * live/warming previews or real playback.
 */
/**
 * Query params every child URI of a playlist must carry: HLS clients do NOT
 * inherit the playlist URL's query, so the viewer's PlaySessionId and the
 * caller's auth token (native AVPlayer can only authenticate via ?grant=)
 * are appended explicitly.
 */
function buildChildPlaylistParams(url: URL, playSessionId: string): URLSearchParams {
    const params = new URLSearchParams();
    params.set('PlaySessionId', playSessionId);
    addAuthToSearchParams(params, extractAuthParams(url));
    return params;
}

/**
 * The master of a MUXED rendition is its own media playlist.
 *
 * Muxed FFmpeg output is one flat rendition — root `index.m3u8`, `init_0.mp4`,
 * `segment_N.m4s` — with no master and no `stream_N/` directories. Previews
 * have been muxed since 2026-08-26 (a50588665), but their `master.m3u8` was
 * still answered with the DEMUX master (stream_0 video + stream_N audio), so
 * every init/segment request 503/404'd: ~22% of preview artifacts on prod,
 * i.e. every item first previewed after that date. hls.js accepts a media
 * playlist at the master URL — playback.service's muxed web path serves the
 * bare media playlist the same way — and its relative URIs resolve to the
 * root files both serving paths already handle.
 */
function muxedMasterResponse(
    content: string,
    params: URLSearchParams,
    complete: boolean,
): Response {
    const rewritten = rewriteMediaPlaylist(content, params);
    return new Response(complete ? addVodMarkers(rewritten) : rewritten, {
        status: 200,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': CONTENT_TYPES['.m3u8'],
            'Cache-Control': 'private, no-cache',
        },
    });
}

/** Resident MUXED job: answer master.m3u8 with FFmpeg's root media playlist. */
async function serveMuxedJobMaster(
    job: TranscodeJob,
    playSessionId: string,
    url: URL,
): Promise<Response> {
    const indexPath = path.join(job.outputDir, 'index.m3u8');
    const deadline = Date.now() + SEGMENT_WAIT_TIMEOUT_MS;
    while (true) {
        try {
            const content = await fs.readFile(indexPath, 'utf-8');
            if (content.includes('#EXTINF')) {
                return muxedMasterResponse(
                    content,
                    buildChildPlaylistParams(url, playSessionId),
                    content.includes('#EXT-X-ENDLIST'),
                );
            }
        } catch {
            // Not written yet — FFmpeg emits it after the first segment.
        }
        if (isTranscodeJobDead(job) || Date.now() >= deadline) {
            // Same contract as the demux path's not-ready playlist: 503 +
            // Retry-After is retried by hls.js and AVFoundation; 404 is not.
            return new Response('Playlist not ready — transcode is starting', {
                status: 503,
                headers: { ...CORS_HEADERS, 'Retry-After': '1', 'Cache-Control': 'no-store' },
            });
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
}

async function tryServeCompletePreviewFromDisk(opts: {
    cacheKey: string;
    segmentPath: string;
    url: URL;
    playSessionId: string;
}): Promise<Response | null> {
    const { cacheKey, segmentPath, url, playSessionId } = opts;
    if (!cacheKey) return null;

    const dir = getPreviewCacheStore().dirFor(cacheKey);

    // Only serve a COMPLETE artifact. A warming/absent artifact falls through:
    // during warming the in-memory job is normally still resident (so we never
    // reach here), and if it isn't, the rare race is left to the normal path.
    try {
        await fs.access(path.join(dir, '.ready'));
    } catch {
        return null;
    }

    const normalizedPath = path.normalize(segmentPath);
    if (normalizedPath.includes('..')) return null;
    const filePath = path.join(dir, normalizedPath);
    if (!isPathInsideDirectory(filePath, dir)) return null;

    const ext = path.extname(normalizedPath).toLowerCase();

    // Per-stream media playlist (stream_N/index.m3u8): read FFmpeg's on-disk
    // manifest, rewrite segment URLs with this request's query params, and mark
    // it VOD (the artifact is complete). Mirrors serveMediaPlaylist's fallback
    // branch so the bytes match what the resident-job path would produce.
    if (ext === '.m3u8') {
        let content: string;
        try {
            content = await fs.readFile(filePath, 'utf-8');
        } catch {
            // A muxed (flat) artifact has no master.m3u8 — its master is the
            // root media playlist. See muxedMasterResponse.
            if (normalizedPath !== 'master.m3u8') return null;
            try {
                const index = await fs.readFile(path.join(dir, 'index.m3u8'), 'utf-8');
                return muxedMasterResponse(
                    index,
                    buildChildPlaylistParams(url, playSessionId),
                    true,
                );
            } catch {
                return null;
            }
        }
        if (normalizedPath === 'master.m3u8') {
            // FFmpeg's on-disk master references the variant playlists with bare
            // relative URIs (stream_N/index.m3u8). Those resolve to the right
            // /api/playback/... path against this request's URL, but HLS clients
            // do NOT inherit query params — append the viewer's PlaySessionId AND
            // the caller's auth token to every URI so the child requests carry
            // both. A client that can only authenticate via the URL (native
            // AVPlayer on tvOS, which can't set HTTP headers and uses ?grant=)
            // 401s on the child playlists/segments otherwise. Mirrors the token
            // pass-through in serveMasterPlaylist (resident-job path) and the VOD
            // endpoint's buildHlsSegmentUrlParts. The token also flows onward to
            // the segment URIs because the media-playlist branch below rewrites
            // them from this same url.searchParams (rewriteMediaPlaylist).
            content = rewriteMediaPlaylist(
                content,
                buildChildPlaylistParams(url, playSessionId),
                url.origin,
            );
            return new Response(content, {
                status: 200,
                headers: {
                    ...CORS_HEADERS,
                    'Content-Type': CONTENT_TYPES['.m3u8'],
                    'Cache-Control': 'private, no-cache',
                    'X-Lumastra-Preview-Static': 'master',
                },
            });
        }
        content = addVodMarkers(rewriteMediaPlaylist(content, url.searchParams, url.origin));
        return new Response(content, {
            status: 200,
            headers: {
                ...CORS_HEADERS,
                'Content-Type': CONTENT_TYPES['.m3u8'],
                'Cache-Control': 'private, no-cache',
                'X-Lumastra-Preview-Static': 'playlist',
            },
        });
    }

    // Segment / init file: served 1:1 from the complete artifact.
    const isSegment = ext === '.m4s' || ext === '.ts';
    const isInit = ext === '.mp4' && normalizedPath.includes('init_');
    if (isSegment || isInit) {
        let bytes: Buffer;
        try {
            bytes = await fs.readFile(filePath);
        } catch {
            // Missing file on a "complete" artifact — let the normal path decide.
            return null;
        }
        bandwidthTracker.trackHlsSegmentForSession(playSessionId, bytes.length);
        return new Response(new Uint8Array(bytes), {
            status: 200,
            headers: {
                ...CORS_HEADERS,
                'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
                // Complete artifact segments are immutable and content-addressed.
                // `private` excludes shared/proxy caches on this forward-auth
                // authenticated, ACAO:* surface; browser caching still applies.
                'Cache-Control': 'private, max-age=31536000, immutable',
                'X-Lumastra-Preview-Static': 'segment',
            },
        });
    }

    return null;
}

/** Timeout for waiting for segments after a seek (ms) */
const SEEK_WAIT_TIMEOUT_MS = config.HLS_SEEK_WAIT_TIMEOUT_MS;

/** Timeout for waiting for segments during normal playback (ms) */
const SEGMENT_WAIT_TIMEOUT_MS = config.HLS_SEGMENT_WAIT_TIMEOUT_MS;

/** Timeout for waiting for segments during I-frame scrubbing (ms) */
const IFRAME_WAIT_TIMEOUT_MS = config.HLS_IFRAME_WAIT_TIMEOUT_MS;

/** Polling interval when waiting for segments (ms) */
const POLL_INTERVAL_MS = config.HLS_SEGMENT_POLL_INTERVAL_MS;

/** Logging interval during long waits (ms) */
const LOG_INTERVAL_MS = config.HLS_SEGMENT_LOG_INTERVAL_MS;

/**
 * FFmpeg typically produces its first segment within 2-3s of starting.
 * 5s gives ~2x margin to cover slow disks or large files, while staying
 * well under the 10s SEGMENT_WAIT_TIMEOUT_MS for normal playback.
 */
const SEEK_COOLDOWN_MS = config.HLS_SEEK_COOLDOWN_MS;

const PRUNE_THRESHOLD = 500;

const REPEATED_SEGMENT_WINDOW_MS = config.HLS_REPEATED_SEGMENT_WINDOW_MS;
const REPEATED_SEGMENT_PRESSURE_THRESHOLD = config.HLS_REPEATED_SEGMENT_PRESSURE_THRESHOLD;
const REPEATED_PRESSURE_FORWARD_SEEK_THRESHOLD =
    config.HLS_REPEATED_PRESSURE_FORWARD_SEEK_THRESHOLD;
const STALE_AUDIO_WARNING_COOLDOWN_MS = config.HLS_STALE_AUDIO_WARNING_COOLDOWN_MS;
const STALE_AUDIO_REQUEST_AHEAD_THRESHOLD = config.HLS_STALE_AUDIO_REQUEST_AHEAD_THRESHOLD;
const FAR_FROM_ORIGIN_THRESHOLD = config.HLS_FAR_FROM_ORIGIN_THRESHOLD;

// ================================================================
// PUBLIC INTERFACE
// ================================================================

/**
 * Context for the shared HLS segment handler.
 * Callers provide auth-stripped request info and a basePath for URL rewriting.
 */
export interface HlsSegmentContext {
    /** Media item ID */
    itemId: string;
    /** Rest parameter from [...path] — e.g., 'stream_0/segment_00000.m4s' */
    segmentPath: string;
    /** Full request URL (for query parameters) */
    url: URL;
    /** Original request (for Range headers) */
    request: Request;
    /**
     * Base path prefix for URL rewriting in playlists.
     * - /api/v1 uses `base` from $app/paths (e.g., '' or '/app')
     * - /j/ uses '/j' so segment URLs route through the jellyfin-compat endpoint
     */
    basePath: string;
    /**
     * Authenticated username from `locals.user.username`.
     * When provided, the handler verifies that the PlaySessionId belongs to this
     * user and returns 404 if the session is owned by someone else.
     * Omit for unauthenticated paths — today that's only the showcase mount
     * (anonymous token principal, ownership check skipped entirely); /j DOES
     * pass a username (the Jellyfin-compat forward-auth user).
     */
    username?: string;
    /**
     * Resolved internal media_items.id for `itemId`. On `/api/v1` (and its
     * `/api` cookie mirror) this comes from `withIdResolution`'s
     * `locals.resolvedIds.internalId` and is `undefined` when the URL id is a
     * syntactically valid but unknown UUID — both `withLibraryAccess` and
     * `withAgeGate` skip their checks in that case, so this handler is the
     * only remaining gate. `/j` and showcase never run id-resolution
     * middleware; both pass their raw URL param instead, on the (route-local)
     * assumption that it already IS the internal id.
     *
     * Two duties: (1) scopes a caller-supplied trickplay `fileId` to THIS
     * item for the synthetic I-frame handlers (the route middleware only
     * gates the path itemId, not this query param) — omitting it makes any
     * fileId unresolvable there, same as a missing sql connection; (2) is one
     * of the two id spellings (`internalId`, raw `itemId`) a job/session must
     * belong to for the job->item binding check (fix plan 6, C1) —
     * omitting/empty FAILS CLOSED (404) there, it does not skip the check.
     */
    internalId?: string;
    /** Mount label for binding-rejection warn logs only (`'api'`, `'j'`,
     *  `'showcase'`, …) — never behavior-affecting. */
    mount?: string;
}

/** Result of resolving a request's PlaySessionId to the id the transcode job
 *  actually runs under, plus the viewer's own PreviewSession record (when one
 *  was found) — the single lookup both the cache-artifact translation and the
 *  C1 job->item binding check (below) need, done once. */
export interface ResolvedJobPlaySession {
    jobPlaySessionId: string;
    /** The caller's own PreviewSession record. Undefined for real playback,
     *  and for a preview PlaySessionId with no record (warm-up window, or an
     *  unrecognized/forged id — e.g. a raw `preview-cache-*` value). */
    previewSession?: PreviewSession;
}

/**
 * Resolve the id that transcode-job/dir/warming lookups should use for this request.
 *
 * A cache-backed preview has TWO ids: the viewer's own `preview-<item>-<millis>`
 * PlaySessionId (session ownership, telemetry, bandwidth tracking, heartbeat — all
 * stay keyed on this), and the shared FFmpeg artifact job, which runs under
 * `preview-cache-<cacheKey>` (see createPreview in preview-session.service.ts).
 * `transcodeService.getJob(viewerPlaySessionId)` is always undefined for a cache
 * viewer — the job is registered under the artifact id. Every lookup that needs
 * the actual job/output-dir/segment-offset state must use the artifact id instead.
 *
 * For a non-cache preview (no cacheKey) and for real playback, `jobPlaySessionId`
 * is `playSessionId` unchanged — behavior for those paths is untouched.
 *
 * Also returns the `PreviewSession` record itself (fix plan 6, C1): the
 * caller needs it for the job->item binding check and previously looked it up
 * a second time there — one `getPreviewSession` call now serves both.
 */
export async function resolveJobPlaySessionId(
    playSessionId: string,
    isPreviewSession: boolean,
): Promise<ResolvedJobPlaySession> {
    if (!isPreviewSession) {
        return { jobPlaySessionId: playSessionId };
    }
    const previewSession = await getPreviewSession(playSessionId);
    if (previewSession?.cacheKey) {
        return { jobPlaySessionId: `preview-cache-${previewSession.cacheKey}`, previewSession };
    }
    return { jobPlaySessionId: playSessionId, previewSession };
}

/**
 * C1 (fix plan 6): does the job/session this request would serve belong to
 * the item the caller's auth gate already checked?
 *
 * Runs BEFORE subtitle/trickplay/I-frame dispatch and before any job lookup
 * that could serve bytes or extend a job's lifetime — see research §7. Three
 * cases, in order:
 *
 * 1. A raw `preview-cache-<hash>` PlaySessionId: no legitimate client ever
 *    sends this literal value (it only appears in the `streamUrl` the SERVER
 *    hands a cache-backed viewer as its OWN, different, `preview-<item>-…`
 *    id) — reject outright.
 * 2. A preview PlaySessionId with a `PreviewSession` record: compare the
 *    VIEWER's own `session.itemId`, never the shared artifact job's
 *    `config.itemId` — a preview-cache artifact is keyed by file, not item,
 *    and `media_file_items` is M:N (two episodes can share one recording), so
 *    the artifact's `config.itemId` is whichever viewer warmed it, not
 *    necessarily this one's.
 * 3. Otherwise (real playback, or a preview PlaySessionId with no record —
 *    warm-up window / unrecognized id): compare the RESIDENT job's
 *    `config.itemId`, looked up with `getJobByPlaySession` — never `getJob`,
 *    which refreshes `lastAccessedAt` and writes the DB, so a request this
 *    function is about to reject would otherwise keep a foreign job alive.
 *
 * Returns a 404 `Response` to short-circuit the caller, or `null` to
 * continue. `bound === null` means `internalId` was missing/empty and FAILS
 * CLOSED — this happens on `/api/v1` for a syntactically valid but unknown
 * UUID, where both `withLibraryAccess` and `withAgeGate` silently skip.
 */
function checkJobItemBinding(opts: {
    playSessionId: string;
    jobPlaySessionId: string;
    isPreviewSession: boolean;
    previewSession: PreviewSession | undefined;
    bound: ReadonlySet<string> | null;
    getResidentJob: (playSessionId: string) => TranscodeJob | undefined;
    itemId: string;
    internalId: string | undefined;
    mount: string | undefined;
    segmentPath: string;
}): Response | null {
    const {
        playSessionId,
        jobPlaySessionId,
        isPreviewSession,
        previewSession,
        bound,
        getResidentJob,
        itemId,
        internalId,
        mount,
        segmentPath,
    } = opts;

    const logRejection = (reason: string, extra: Record<string, unknown>): void => {
        logger.warn('Job->item binding rejected request', {
            reason,
            playSessionId: truncateForLog(playSessionId),
            requestItemId: truncateForLog(itemId),
            internalId: truncateForLog(internalId),
            mount,
            ...extra,
        });
    };

    if (!bound) {
        logRejection('internalId-missing', {});
        return createErrorResponse(segmentPath, 'Not found', 404);
    }

    // Case-insensitive (see `isRawPreviewCacheSessionId`): an UPPERCASE
    // `PREVIEW-CACHE-<hash>` would otherwise skip this reject and fall through
    // to the resident-job lookup below, which WOULD find the artifact (the Map
    // lookup folds case) — reachable, not merely defensive. The master route
    // refuses the same ids through the same predicate (`startHlsPlayback`).
    if (isRawPreviewCacheSessionId(playSessionId)) {
        logRejection('raw-preview-cache-id', {});
        return createErrorResponse(segmentPath, 'Not found', 404);
    }

    if (isPreviewSession && previewSession) {
        if (!isBoundToItem(previewSession.itemId, bound)) {
            logRejection('preview-session-foreign-item', {
                sessionItemId: truncateForLog(previewSession.itemId),
            });
            return createErrorResponse(segmentPath, 'Not found', 404);
        }
        return null;
    }

    const resident = getResidentJob(jobPlaySessionId);
    if (resident && !isBoundToItem(resident.config.itemId, bound)) {
        logRejection('resident-job-foreign-item', {
            jobItemId: truncateForLog(resident.config.itemId),
        });
        return createErrorResponse(segmentPath, 'Not found', 404);
    }
    return null;
}

/**
 * Shared HLS segment handler — serves segments, playlists, subtitles, trickplay, and I-frames.
 *
 * Supports:
 * - Offset translation for sliding window cleanup
 * - Forward/backward seek detection with FFmpeg restart
 * - Cross-pod job restoration from database
 * - Range requests for I-frame scrubbing
 * - VOD manifest generation for full seek support
 */
export async function handleHlsSegment(ctx: HlsSegmentContext): Promise<Response> {
    const response = await serveHlsSegment(ctx);
    // Record every non-2xx here rather than at each `return` inside
    // serveHlsSegment: the branches are many and grow, and a diagnostic that
    // silently stops covering a new one is worse than none. Fire-and-forget —
    // recordFailure returns void and swallows its own errors, so a diagnostics
    // write can never turn a served segment into a failed one.
    //
    // A stray 404 here is not cosmetic on Apple clients: AVFoundation reads it
    // as "resource does not exist", penalty-boxes the variant
    // (CoreMediaErrorDomain -12938) and never retries — one response becomes a
    // permanent stall. That is the failure this table exists to make visible.
    segmentDeliveryFailures.recordFailure({
        playSessionId: ctx.url.searchParams.get('PlaySessionId'),
        status: response.status,
        segmentPath: ctx.segmentPath,
    });
    return response;
}

async function serveHlsSegment(ctx: HlsSegmentContext): Promise<Response> {
    const { itemId, segmentPath, url, request, basePath, username, internalId, mount } = ctx;

    const playSessionId = url.searchParams.get('PlaySessionId');
    if (!playSessionId) {
        logger.error('Missing PlaySessionId for segment request', undefined, {
            itemId,
            path: segmentPath,
        });
        return createErrorResponse(segmentPath, 'Missing PlaySessionId', 400);
    }

    // Verify session ownership when an authenticated username is provided.
    // Returns 404 (not 403) to avoid leaking session existence.
    if (username) {
        const owned = await verifyPlaySessionOwnership(playSessionId, username);
        if (!owned) {
            logger.warn('Play session ownership mismatch', {
                playSessionId: playSessionId.slice(0, 8),
                username,
            });
            return createErrorResponse(segmentPath, 'Not found', 404);
        }
    }

    // Check feature flag — preview sessions bypass this since they manage
    // their own FFmpeg jobs independently of the ffmpegAvailable check.
    // Case-insensitive, consistent with the `preview-cache-` reject below
    // (fix round 2 minor): checked and safe — a real preview id is always
    // server-minted lowercase (`preview-${resolvedItemId}-${Date.now()}-…`,
    // preview-session.service.ts), so this never changes classification for
    // a legitimate viewer id. For an uppercase-prefixed id no client
    // legitimately sends, `getPreviewSession` below still finds no record
    // (its own lookup is keyed on the exact string), so `previewSession`
    // stays undefined and `jobPlaySessionId` stays the unchanged raw string
    // either way — the binding check still falls through to the SAME
    // resident-job branch. The only observable effect is exempting such an
    // id from the `ffmpegAvailable` 503 below; it is NOT rejected outright:
    // it still goes through the case-insensitive `preview-cache-` reject and
    // the resident-job binding check right after, so it is bound to the
    // requested item like any real-playback id (a job for another item gets
    // 404). Pinned by the "isPreviewSession case-fold" seam cases.
    const isPreviewSession = playSessionId.toLowerCase().startsWith('preview-');
    if (!features.ffmpegAvailable && !isPreviewSession) {
        return createErrorResponse(segmentPath, 'Multi-audio HLS feature is not enabled', 503);
    }

    // For a cache-backed preview viewer, translate to the shared artifact job's
    // id ONCE here, then thread it through every transcode-job/dir/warming/offset
    // lookup below. Ownership checks, telemetry, bandwidth tracking, and logging
    // stay keyed on the viewer's own `playSessionId` — see resolveJobPlaySessionId.
    // Also returns the viewer's PreviewSession record — the job->item binding
    // check right below needs it and this is now its only lookup.
    const { jobPlaySessionId, previewSession } = await resolveJobPlaySessionId(
        playSessionId,
        isPreviewSession,
    );

    // A cache-backed preview artifact is a FIXED single-generation VOD window:
    // segments 0..N are produced once, numbered from 0, and Task 4's
    // single-generation guard REJECTS in-place seeks on these jobs. There is no
    // per-viewer seeking — a viewer that attaches to an already-warmed artifact
    // and requests a segment "behind" the offset must be served from the artifact
    // dir (or wait if still warming), NOT routed into the seek-trigger path. That
    // path calls seekToSegment(viewerId), which returns false (the job lives under
    // the artifact id), and the backward branch would surface a hard 503 to the
    // client. Suppress BOTH seek triggers for cache-backed sessions so the flow
    // falls through to the normal serve-file / wait-current path. True exactly when
    // a cacheKey resolved the artifact id; false (→ identical behavior) for
    // non-cache previews and real playback.
    const isCacheBacked = isPreviewSession && jobPlaySessionId !== playSessionId;

    const transcodeService = getFFmpegTranscodeService();
    const jobPersistence = getTranscodeJobPersistenceService();

    // ================================================================
    // JOB->ITEM BINDING (fix plan 6, C1): before ANY sub-resource dispatch
    // and before any job lookup that could serve bytes or extend a foreign
    // job's lifetime. See checkJobItemBinding's doc comment for the full
    // rationale and case-by-case reasoning.
    // ================================================================
    const bound = buildBoundItemIds(internalId, itemId);
    const bindingRejection = checkJobItemBinding({
        playSessionId,
        jobPlaySessionId,
        isPreviewSession,
        previewSession,
        bound,
        getResidentJob: (id) => transcodeService.getJobByPlaySession(id),
        itemId,
        internalId,
        mount,
        segmentPath,
    });
    if (bindingRejection) return bindingRejection;
    // A CACHE-BACKED preview session was already bound above via its OWN
    // `PreviewSession.itemId` — never via `job.config.itemId` (the shared
    // artifact's job legitimately belongs to a DIFFERENT item than this
    // viewer's, M:N `media_file_items`; see checkJobItemBinding). The final
    // belt-and-braces re-check below must not re-apply the resident-job
    // comparison to that already-verified case, or it would false-404 the
    // legitimate M:N case.
    //
    // Deliberately narrower than "any preview with a record": a NON-cache
    // preview's job legitimately has `config.itemId === previewSession.itemId`
    // (research §2 — trailer child / Next-Up episode both use `resolvedItemId`
    // on both sides), so re-checking `job.config.itemId` there costs nothing
    // and keeps the belt-and-braces guard live for that case too (fix round 1,
    // Important-adjacent minor: don't broaden the exemption past what the
    // M:N artifact case actually needs).
    const boundVerifiedViaPreviewSession = isCacheBacked && previewSession !== undefined;

    // ================================================================
    // SUBTITLE HANDLING: subs_X/index.m3u8 and subs_X/seg_XXXXX.vtt
    // Delegated to hls-subtitle-handler.ts
    // ================================================================
    const subtitleInfo = parseSubtitlePath(segmentPath);
    if (subtitleInfo) {
        const subtitleIndexStr = url.searchParams.get('SubtitleIndex');
        const fileId = url.searchParams.get('fileId');

        if (!subtitleIndexStr || !fileId) {
            logger.error('Missing SubtitleIndex or fileId for subtitle request', undefined, {
                itemId,
                path: segmentPath,
                subtitleIndex: subtitleIndexStr,
                fileId,
                fileName: subtitleInfo.fileName,
                fullUrl: url.toString(),
            });
            return createSubtitleErrorResponse(subtitleInfo.segmentNumber, 400);
        }

        const subtitleIndex = parseInt(subtitleIndexStr, 10);

        if (subtitleInfo.fileName === 'index.m3u8') {
            return handleSubtitlePlaylist(itemId, playSessionId, subtitleIndex, url);
        } else if (subtitleInfo.segmentNumber !== null) {
            return handleSubtitleSegment(
                itemId,
                playSessionId,
                subtitleIndex,
                fileId,
                subtitleInfo.segmentNumber,
                url,
                internalId,
            );
        }
    }

    // ================================================================
    // TRICKPLAY HANDLING: trickplay.m3u8
    // Delegated to hls-trickplay-handler.ts
    // ================================================================
    if (segmentPath === 'trickplay.m3u8') {
        return handleTrickplayPlaylist(itemId, url);
    }

    // ================================================================
    // I-FRAME PLAYLIST HANDLING: iframe.m3u8
    // Delegated to hls-iframe-handler.ts
    // ================================================================
    if (segmentPath === 'iframe.m3u8') {
        return handleIFramePlaylist(itemId, playSessionId, url, internalId);
    }

    // ================================================================
    // SYNTHETIC I-FRAME SEGMENT HANDLING: iframe_XXXXX.ts
    // Delegated to hls-iframe-handler.ts
    // ================================================================
    const iframeIndex = parseIFrameSegmentPath(segmentPath);
    if (iframeIndex !== null) {
        return handleSyntheticIFrameSegment(itemId, iframeIndex, url, internalId);
    }

    // Declared outside the try so the catch block can read `job?.config?.deviceId`
    // for best-effort proxy-error telemetry even when serving throws mid-flight.
    let job: TranscodeJob | undefined;

    try {
        job = transcodeService.getJob(jobPlaySessionId);

        // Non-owner segment-route hijack (security review follow-up I1): a
        // RESIDENT job with no persisted `play_sessions` row (`/j` dashless
        // ids, the showcase principal) is gated ONLY by
        // `verifyPlaySessionOwnership` above, which ALLOWS a row-absent
        // session through (the warm-up-window allowance) — and for these ids
        // the row never lands, so that allowance is permanent. Without this,
        // a caller who can merely access the item could ride someone else's
        // dashless session id and trigger the forward/backward seek below
        // (executeForwardSeekAction / executeBackwardSeekAction ->
        // seekToSegment), which kills and restarts the OWNER's FFmpeg at the
        // CALLER's position — repeatable, so the owner's stream thrashes.
        // Exact comparison, same rationale as playback.service.ts's arm 2
        // (case-folding could merge two distinct accounts).
        //
        // Excluded on purpose:
        //  - `jobPlaySessionId !== playSessionId` (a cache-backed preview
        //    artifact): `job.config.username` there is whoever warmed the
        //    SHARED artifact, not this viewer — comparing would false-reject
        //    a second, legitimate viewer riding the same artifact (the M:N
        //    ruling this file's binding check already carves out above).
        //  - `username` undefined: only the showcase route passes none.
        //    Showcase-vs-showcase stays under ruling S-C1b (no principal
        //    binding for RIDING a job, as opposed to STOPPING one); its
        //    master route already refuses a cross-principal STOP via arm 2
        //    in `startHlsPlayback`.
        //  - a job that becomes resident ONLY via `restoreHlsJobIfMissing`
        //    below (i.e. `job` is still undefined here): that path loads the
        //    row from the DB, and `verifyPlaySessionOwnership` above (the
        //    arm-1 equivalent) refused a row owned by someone else before this
        //    line ever ran — but a `/j` PlaySessionId has no play_sessions row
        //    (it passes there as "row absent") while its transcode row IS
        //    restorable, so `restoreHlsJobIfMissing` also checks the transcode
        //    row's own owner against `username` before restoring.
        if (
            job &&
            jobPlaySessionId === playSessionId &&
            username &&
            job.config.username !== username
        ) {
            logger.warn('Resident job ownership mismatch — refusing before any seek/serve', {
                playSessionId: truncateForLog(playSessionId),
                username,
                jobOwner: truncateForLog(job.config.username),
                mount,
            });
            return createErrorResponse(segmentPath, 'Not found', 404);
        }

        // ================================================================
        // RENDITION-NAME DICTIONARY: rendition-names.json
        // The master's EXT-X-SESSION-DATA points here (HLS draft, Appendix
        // E.1); Apple's players read it to label non-primary audio renditions
        // in the viewer's language. After the ownership guard, like every
        // other sub-path of a resident job.
        // ================================================================
        if (segmentPath === RENDITION_NAMES_PATH) {
            const tracks = manifestAudioTracks(
                job?.config?.audioTracks ?? [],
                job?.config?.maxAudioChannels,
                job?.transcodeDecisionResult?.audioAction === 'copy',
            );
            const dictionary = localizedRenditionNames(tracks, selectedAudioTrackFor(url, job));
            return new Response(JSON.stringify(dictionary), {
                status: 200,
                headers: {
                    ...CORS_HEADERS,
                    'Content-Type': 'application/json; charset=utf-8',
                    // No resident job (restart, other pod): an empty answer must not stick.
                    'Cache-Control': job ? 'private, max-age=300' : 'no-store',
                },
            });
        }

        // Cache-backed preview whose shared artifact job isn't resident (reaped,
        // or not-yet-re-warmed while a viewer is mid-playback). Preview jobs are
        // not DB-persisted, so restoreHlsJobIfMissing below would 410 → the hover
        // preview flashes then reverts to backdrop. If the on-disk artifact is
        // complete, serve the finished bytes straight from disk instead (no
        // FFmpeg re-spawn → no corruption of files an active viewer is reading).
        if (!job && isCacheBacked) {
            const served = await tryServeCompletePreviewFromDisk({
                cacheKey: jobPlaySessionId.slice(PREVIEW_CACHE_JOB_PREFIX.length),
                segmentPath,
                url,
                playSessionId,
            });
            if (served) return served;
        }

        // NOTE: `playSessionId` here (not jobPlaySessionId) only matters when `job`
        // is undefined (job-restoration.ts short-circuits to `{ job: options.job }`
        // whenever a job was already found) — i.e. cross-pod DB-persisted restore.
        // Preview PlaySessionIds are never persisted (not UUIDs — see
        // `transcode-job-persistence.service.ts`), so this path applies to
        // `/api`-family and `/j` jobs only; `internalId`/`itemId` give
        // job-restoration.ts what it needs for its own job->item binding check
        // (fix plan 6, C1 — see job-item-binding.ts) on the row it loads.
        const restoreResult = await restoreHlsJobIfMissing({
            job,
            itemId,
            internalId,
            mount,
            playSessionId,
            username,
            segmentPath,
            corsHeaders: CORS_HEADERS,
            contentTypes: CONTENT_TYPES,
            currentPodName: getCurrentPodName(),
            restoreWaitTimeoutMs: 30_000,
            restorePollIntervalMs: 500,
            jobPersistence,
            transcodeService,
            accessFile: (pathToAccess) => fs.access(pathToAccess),
            readFile: (pathToRead) => fs.readFile(pathToRead),
            trackHlsSegment: (bytes) =>
                bandwidthTracker.trackHlsSegmentForSession(playSessionId, bytes),
            logInfo: (message, metadata) => logger.info(message, metadata),
            logWarn: (message, metadata) => logger.warn(message, metadata),
            logError: (message, error, metadata) => logger.error(message, error, metadata),
        });

        if (restoreResult.response) {
            return restoreResult.response;
        }
        job = restoreResult.job;

        if (!job) {
            // Should not happen - either job exists or we returned above
            logger.error('Job is undefined after restoration attempt', undefined, {
                playSessionId,
                itemId,
            });
            return new Response('Internal error', {
                status: 500,
                headers: CORS_HEADERS,
            });
        }

        // Belt-and-braces (fix plan 6, C1): re-assert the binding on the job
        // actually about to be served, just before its file path is built. The
        // checks above already cover the resident-job and restore-from-DB
        // cases; this is a cheap final guard against any path that reaches
        // here with a job this function didn't itself resolve/verify. Skipped
        // when the binding was already verified against the PREVIEW SESSION's
        // own itemId (see boundVerifiedViaPreviewSession above) — re-applying
        // the resident-job comparison there would wrongly reject the
        // legitimate cache-backed M:N case (artifact job.config.itemId is
        // whichever viewer warmed it, not necessarily this one's item).
        if (!boundVerifiedViaPreviewSession && !isBoundToItem(job.config.itemId, bound)) {
            logger.warn('Job->item binding rejected request', {
                reason: 'post-restore-foreign-item',
                playSessionId: truncateForLog(playSessionId),
                requestItemId: truncateForLog(itemId),
                internalId: truncateForLog(internalId),
                jobItemId: truncateForLog(job.config.itemId),
                mount,
            });
            return createErrorResponse(segmentPath, 'Not found', 404);
        }

        // Security: Validate path doesn't escape output directory
        const normalizedPath = path.normalize(segmentPath);
        // The output marker (hls/output-marker.ts) is bookkeeping, not an asset.
        if (normalizedPath.includes('..') || isOutputMarkerPath(normalizedPath)) {
            logger.warn('Path traversal attempt blocked', {
                playSessionId,
                path: segmentPath,
            });
            return new Response('Invalid path', {
                status: 400,
                headers: CORS_HEADERS,
            });
        }

        let filePath = path.join(job.outputDir, normalizedPath);

        // Verify file is within output directory (before any offset translation)
        if (!isPathInsideDirectory(filePath, job.outputDir)) {
            logger.warn('Path escapes output directory', {
                playSessionId,
                filePath,
                outputDir: job.outputDir,
            });
            return new Response('Invalid path', {
                status: 400,
                headers: CORS_HEADERS,
            });
        }

        // Determine file extension for type checks
        const ext = path.extname(filePath).toLowerCase();
        const isSegment = ext === '.m4s' || ext === '.ts';
        const isInitSegment = ext === '.mp4' && normalizedPath.includes('init_');
        const segExt = job.config.hlsOutput?.hlsContainer === 'mpegts' ? 'ts' : 'm4s';
        const isMuxedRootInitSegment =
            job.config.hlsOutput?.hlsAudioMode === 'muxed' &&
            !normalizedPath.includes('/') &&
            isInitSegment;

        if (isMuxedRootInitSegment) {
            return serveMuxedRootAsset({
                job,
                playSessionId: jobPlaySessionId,
                normalizedPath,
                contentType: CONTENT_TYPES[ext] || 'application/octet-stream',
                isInitSegment,
                corsHeaders: CORS_HEADERS,
                waitTimeoutMs: SEGMENT_WAIT_TIMEOUT_MS,
                pollIntervalMs: POLL_INTERVAL_MS,
                getJobByPlaySession: (sessionId) => transcodeService.getJobByPlaySession(sessionId),
                readFile: (pathToRead) => fs.readFile(pathToRead),
                trackHlsSegment: (bytes) =>
                    bandwidthTracker.trackHlsSegmentForSession(playSessionId, bytes),
                logWarn: (message, metadata) => logger.warn(message, metadata),
            });
        }

        // Check if this is a segment file and parse its info
        const segmentInfo = parseSegmentPath(normalizedPath);
        const requestedSegmentNum = extractSegmentNumber(normalizedPath);
        const generationRouteResult = await resolveHlsSegmentGenerationRoute({
            job,
            playSessionId: jobPlaySessionId,
            normalizedPath,
            filePath,
            isSegment,
            segmentInfo,
            requestedSegmentNum,
            segmentExtension: ext.slice(1),
            fallbackSegmentExtension: segExt,
            corsHeaders: CORS_HEADERS,
            transcodeService,
            accessFile: (pathToAccess) => fs.access(pathToAccess),
            // Same test as isIframeRequest below: a byte-range segment request
            // is a scrub thumbnail and never moves the session.
            allowReclaim: !(isSegment && request.headers.get('Range')?.startsWith('bytes=')),
            logInfo: (message, metadata) => logger.info(message, metadata),
            logWarn: (message, metadata) => logger.warn(message, metadata),
        });
        if (generationRouteResult.response) {
            return generationRouteResult.response;
        }
        job = generationRouteResult.job;
        filePath = generationRouteResult.filePath;
        const segmentGenerationRoute = generationRouteResult.segmentGenerationRoute;

        job.lastAccessedAt = new Date();

        // Detect I-frame requests (byte-range requests for scrubbing thumbnails)
        // These should NEVER trigger seeks - they're just for preview thumbnails
        const rangeHeader = request.headers.get('Range');
        const isIframeRequest = isSegment && rangeHeader && rangeHeader.startsWith('bytes=');

        const segmentState = buildHlsSegmentRequestState({
            job,
            segmentInfo,
            isSegment,
            requestedSegmentNum,
            adapter: {
                getSegmentOffsetForJob: (currentJob) =>
                    transcodeService.getSegmentOffsetForJob(currentJob),
                getStreamSegmentOffsetForJob: (currentJob, streamDir) =>
                    transcodeService.getStreamSegmentOffsetForJob(currentJob, streamDir),
                getStreamTargetDurationForJob: (currentJob, streamDir) =>
                    transcodeService.getStreamTargetDurationForJob(currentJob, streamDir),
                // A preview grant serves a fixed clip, including when the preview cache is off.
                // Segment requests must never restart its encoder elsewhere in the full input.
                canStreamTriggerSeekForJob: (currentJob, streamDir) =>
                    !isPreviewSession &&
                    transcodeService.canStreamTriggerSeekForJob(currentJob, streamDir),
                isSegmentDeletedForJob: (currentJob, streamDir, actualIndex) =>
                    transcodeService.isSegmentDeletedForJob(currentJob, streamDir, actualIndex),
            },
        });
        const {
            globalSegmentOffset,
            streamDirName,
            isVideoTranscoded,
            segmentOffset,
            actualSegmentIndex,
            segmentWasDeleted,
            jobSegmentDuration,
            streamTargetDuration,
            canSeek,
            currentProgressForDiagnostics,
        } = segmentState;

        // In demux mode with copy-mode video, the VOD playlist numbers video in
        // uniform steps (same offset as audio) but lists FFmpeg's REAL duration
        // for every produced file: entry N describes file N - offset. Serve
        // exactly that file. Re-deriving the file from time (offset + N * 10 s)
        // is not a bijection over 1-17 s keyframe files — it skipped short files
        // entirely (AVPlayer froze the picture for their length while audio
        // played on) and served a neighbour twice, and it contradicted the
        // EXTINF the client was given.
        const videoStreamDir = `stream_${job.config.audioTracks?.length ?? 0}`;
        // GOP mode files are assembled on the keyframe grid already: entry N is
        // file N - offset on every stream, no translation.
        const isDemuxCopyVideo =
            isSegment &&
            !isGopModeJob(job!) &&
            !isVideoTranscoded &&
            job!.config.hlsOutput?.hlsAudioMode === 'demux' &&
            job!.transcodeDecisionResult?.videoAction === 'copy' &&
            streamDirName === videoStreamDir &&
            job!.keyframeData != null &&
            job!.keyframeData.length > 0 &&
            (job!.config.totalDurationSeconds ?? 0) > 0;

        // Reusable translator: uniform actual index → FFmpeg file index, clamped
        // to the generation's last keyframe file (the uniform grid can list one
        // more entry than FFmpeg writes). Shared across initial path
        // construction, wait loop, and seek executors. Capture values now
        // because `job` is `let` and TypeScript can't narrow inside closures
        // over mutable bindings.
        let uniformToKeyframeFile: ((uniformActualIdx: number) => number) | undefined;
        if (isDemuxCopyVideo) {
            const lastFile = getLastKeyframeFileIndex(
                job!.config.startTimeSeconds ?? 0,
                job!.keyframeData!,
                job!.config.totalDurationSeconds!,
                job!.segmentDurationSeconds,
            );
            uniformToKeyframeFile = (uniformActualIdx: number): number =>
                Math.min(uniformActualIdx, lastFile);
        }

        const fileSegmentIndex =
            uniformToKeyframeFile && actualSegmentIndex >= 0
                ? uniformToKeyframeFile(actualSegmentIndex)
                : actualSegmentIndex;

        const responseContext: SegmentResponseContext = {
            job,
            segmentOffset,
            requestedSegmentNum,
            actualSegmentIndex,
            streamDirName,
            // Debug-header-only identity (X-Lumastra-SessionGenerations etc.) — uses
            // the artifact id so the headers reflect the job that's actually serving
            // this request. Does not affect ownership/telemetry/bandwidth, which stay
            // keyed on the viewer's own `playSessionId` elsewhere in this function.
            playSessionId: jobPlaySessionId,
            canSeek,
            streamTargetDuration,
            corsHeaders: CORS_HEADERS,
            buildDebugHeaders: (debug) =>
                buildSegmentDebugHeaders(
                    debug.job,
                    debug.segmentOffset,
                    debug.requestedSegmentNum,
                    debug.actualSegmentIndex,
                    debug.streamDirName,
                    transcodeService,
                    debug.playSessionId,
                    {
                        branch: debug.branch,
                        canSeek: debug.canSeek,
                        streamTargetDuration: debug.streamTargetDuration,
                    },
                ),
        };
        const preFileAction = planHlsSegmentAction({
            isSegment,
            isIframeRequest,
            requestedSegmentNum,
            actualSegmentIndex,
            segmentOffset,
            canSeek,
            fileExists: false,
            isDeleted: segmentWasDeleted,
            jobStatus: job.status,
            jobIsSeeking: job.isSeeking,
        });

        if (isSegment) {
            logSegmentTrace({
                logger,
                job,
                playSessionId,
                streamDirName,
                requestedSegmentNum,
                actualSegmentIndex,
                segmentOffset,
                globalSegmentOffset,
                canSeek,
                streamTargetDuration,
                isVideoTranscoded,
                segmentGenerationRoute,
            });
        }

        if (preFileAction.type === 'gone_deleted' && segmentInfo) {
            logger.info('Segment was deleted (sliding window), client should restart', {
                playSessionId,
                path: segmentPath,
                streamDir: segmentInfo.streamDir,
                requestedSegment: segmentInfo.segmentIndex,
                actualSegment: actualSegmentIndex,
            });

            return createDeletedSegmentResponse(responseContext);
        }

        if (isSegment) {
            maybeLogSyncTrace({
                logger,
                job,
                playSessionId,
                streamDirName,
                requestedSegmentNum,
                actualSegmentIndex,
                segmentOffset,
                globalSegmentOffset,
                streamTargetDuration,
                canSeek,
            });
        }

        const isStaleGhostAudioRequest =
            isSegment &&
            requestedSegmentNum >= 0 &&
            !canSeek &&
            job.generationRole === 'current' &&
            job.seekCount > 0 &&
            actualSegmentIndex >= 0 &&
            requestedSegmentNum - segmentOffset >= STALE_AUDIO_REQUEST_AHEAD_THRESHOLD &&
            requestedSegmentNum - currentProgressForDiagnostics >=
                STALE_AUDIO_REQUEST_AHEAD_THRESHOLD;

        if (isSegment) {
            maybeLogStaleAudioRequest({
                logger,
                job,
                playSessionId,
                streamDirName,
                requestedSegmentNum,
                actualSegmentIndex,
                segmentOffset,
                currentProgressForDiagnostics,
                canSeek,
                staleAudioRequestAheadThreshold: STALE_AUDIO_REQUEST_AHEAD_THRESHOLD,
                shouldLogWarning: (sessionId, streamDir, segmentNum, offset) =>
                    shouldLogStaleAudioRequestWarning({
                        playSessionId: sessionId,
                        streamDir,
                        requestedSegmentNum: segmentNum,
                        segmentOffset: offset,
                        cooldownMs: STALE_AUDIO_WARNING_COOLDOWN_MS,
                    }),
            });
        }

        // If segment is before current offset, user is seeking backward
        // Trigger re-transcode from the backward position
        // SKIP for I-frame requests - they're just for thumbnails, not actual playback seeks
        // SKIP for non-authoritative streams (audio in demuxed mode)
        // SKIP for cache-backed previews entirely (see !isCacheBacked note below) —
        // they are a fixed VOD artifact with no per-viewer seeking; falling through
        // serves the requested segment from the artifact dir (or waits if warming).
        // `preFileAction` is planned with `fileExists: false` because the stat
        // happens further down, so a below-offset request would re-transcode
        // before anyone looked at the disk. For an absolute-numbered (transcoded)
        // generation that content can genuinely be there: a restore resuming at
        // the viewer's position (see `resolveRestoreResumeStart`) leaves real
        // segments behind its offset. Consult the filesystem first and let the
        // normal path serve it — `planHlsSegmentAction` makes the same call once
        // `fileExists` is known.
        //
        // Cold path by construction: this only runs on backward-seek candidates,
        // i.e. a user scrubbing back, never on the per-segment steady state. The
        // name is safe to derive directly because transcoded generations number
        // files absolutely (`fileSegmentIndex === requestedSegmentNum`).
        let backwardSegmentIsOnDisk = false;
        if (
            preFileAction.type === 'trigger_seek' &&
            preFileAction.direction === 'backward' &&
            !isCacheBacked &&
            isVideoTranscoded &&
            isSegment &&
            requestedSegmentNum >= 0
        ) {
            try {
                const backwardStat = await fs.stat(
                    path.join(
                        path.dirname(filePath),
                        getSegmentFilename(requestedSegmentNum, segExt),
                    ),
                );
                backwardSegmentIsOnDisk = backwardStat.size > 0;
            } catch {
                // Absent — the backward seek below is the correct recovery.
            }
        }

        if (
            preFileAction.type === 'trigger_seek' &&
            preFileAction.direction === 'backward' &&
            !isCacheBacked &&
            !backwardSegmentIsOnDisk
        ) {
            // playSessionId (not jobPlaySessionId) is intentional here: this seek
            // path only runs for non-cache previews / real playback (isCacheBacked
            // is false), where playSessionId IS the job id. A cache-backed request
            // never reaches this branch — its artifact is a fixed single-generation
            // VOD window and cannot be seeked in place (Task 4 guard), so routing it
            // here would call seekToSegment(viewerId) → false → a hard 503 to the
            // client. Suppressed above via !isCacheBacked; served from the artifact
            // dir instead.
            return executeBackwardSeekAction({
                responseContext,
                job,
                playSessionId,
                requestedSegmentNum,
                segmentOffset,
                normalizedPath,
                segExt,
                streamDirName,
                streamTargetDuration,
                isVideoTranscoded,
                segmentInfoStreamDir: segmentInfo?.streamDir,
                seekCooldownMs: SEEK_COOLDOWN_MS,
                forwardSeekThreshold: config.FFMPEG_FORWARD_SEEK_THRESHOLD,
                seekWaitTimeoutMs: SEEK_WAIT_TIMEOUT_MS,
                pollIntervalMs: 150,
                logIntervalMs: LOG_INTERVAL_MS,
                getLastSeekTimestamp,
                setLastSeekTimestamp: (sessionId, timestamp) =>
                    setLastSeekTimestamp(sessionId, timestamp),
                clearSeekTimestamp,
                pruneExpiredSeekTimestamps: () =>
                    pruneExpiredSeekTimestamps({
                        pruneThreshold: PRUNE_THRESHOLD,
                        maxAgeMs: SEEK_COOLDOWN_MS * 2,
                    }),
                deduplicatedSeek: (sessionId, targetSegmentIndex, segmentDurationSeconds) =>
                    deduplicatedHlsSeek({
                        playSessionId: sessionId,
                        targetSegmentIndex,
                        segmentDurationSeconds,
                        fallbackSegmentDurationSeconds: config.FFMPEG_SEGMENT_DURATION,
                        transcodeService,
                    }),
                getJobByPlaySession: (sessionId) => transcodeService.getJobByPlaySession(sessionId),
                getStreamSegmentOffsetForJob: (currentJob, streamDir) =>
                    transcodeService.getStreamSegmentOffsetForJob(currentJob, streamDir),
                recordSegmentAccessForJob: (currentJob, streamDir, segmentIndex) =>
                    transcodeService.recordSegmentAccessForJob(currentJob, streamDir, segmentIndex),
                onSegmentServed: (served) =>
                    recordHlsSeekTraceServed({
                        logger,
                        job: served.job,
                        playSessionId,
                        streamDirName: served.streamDir,
                        requestedSegmentNum: served.requestedSegment,
                        actualSegmentIndex: served.actualSegment,
                        segmentOffset: served.segmentOffset,
                        waitMs: served.waitMs,
                    }),
                translateToFileIndex: uniformToKeyframeFile,
            });
        }

        // Fast-bail for non-authoritative streams (audio in demuxed mode) with
        // negative segment indices. These create garbage filenames (segment_0-230.m4s)
        // that can never exist. Video handles backward seeks via shouldTriggerBackwardSeek,
        // but audio falls through here.
        //
        // We intentionally do NOT fast-bail "far ahead" segments. The wait loop
        // handles those correctly — FFmpeg may just be slightly behind the player.
        // Previous attempts to fast-bail far-ahead segments caused false 404s
        // during normal sequential playback.
        if (
            preFileAction.type === 'not_found' &&
            preFileAction.branch === 'negative_non_authoritative'
        ) {
            return createSegmentNotFoundResponse(responseContext, preFileAction.branch);
        }

        // Translate segment number using offset (and keyframe mapping for demux video)
        // If offset=100 and request is for segment_00100, we serve segment_00000
        // For demux copy-mode video, fileSegmentIndex may differ from actualSegmentIndex
        // because uniform segment numbers are mapped to keyframe file indices.
        let actualFilePath = filePath;
        if (isSegment && requestedSegmentNum >= 0 && (segmentOffset > 0 || isDemuxCopyVideo)) {
            const actualSegmentName = getSegmentFilename(fileSegmentIndex, segExt);
            actualFilePath = path.join(path.dirname(filePath), actualSegmentName);
        }

        const repeatedRequestCount =
            isSegment && requestedSegmentNum >= 0 && streamDirName
                ? noteRepeatedSegmentRequest({
                      playSessionId,
                      streamDir: streamDirName,
                      requestedSegmentNum,
                      windowMs: REPEATED_SEGMENT_WINDOW_MS,
                  })
                : 1;
        const isRepeatedSegmentPressure =
            repeatedRequestCount >= REPEATED_SEGMENT_PRESSURE_THRESHOLD;

        let fileExists = false;
        let preReadBuffer: Buffer | undefined;
        try {
            // Size, not mere existence. FFmpeg creates a file and fills it a
            // moment later, so an existence check succeeds while the file is
            // still 0 bytes — and we then answer 200 with an empty body. For an
            // init segment that is the worst possible answer: AVPlayer counts it
            // as SUCCESS, never configures a decoder, and the item sits at
            // status=unknown forever with no error callback (just a spinner).
            // No valid init or media segment is ever 0 bytes.
            const stat = await fs.stat(actualFilePath);
            fileExists = stat.size > 0;
        } catch {
            // File doesn't exist yet
        }

        // GOP mode fails closed: once the assembler refused to build a shifted
        // entry, nothing past the last exact one will ever appear in this
        // generation. 410 makes the client restart from its position (a fresh
        // generation and assembler) instead of waiting on a file that never comes.
        // A job that was started in GOP mode but lost its keyframes (a restore
        // without them) must not fall back to the legacy mapping either: the
        // client already holds the grid playlist.
        const gopFailClosedReason =
            job.config.gopSegments === true
                ? isGopModeJob(job)
                    ? job.gopBroken
                    : 'GOP-mode job without keyframe data'
                : undefined;
        if (isSegment && !fileExists && gopFailClosedReason) {
            logger.warn('GOP mode: generation broken, asking the client to restart', {
                ps: playSessionId.slice(0, 8),
                stream: streamDirName,
                req: requestedSegmentNum,
                reason: gopFailClosedReason,
            });
            return createDeletedSegmentResponse(responseContext);
        }

        if (
            isSegment &&
            requestedSegmentNum >= 0 &&
            !fileExists &&
            isRepeatedSegmentPressure &&
            (repeatedRequestCount === REPEATED_SEGMENT_PRESSURE_THRESHOLD ||
                repeatedRequestCount % 5 === 0)
        ) {
            logger.warn('Segment request pressure detected', {
                ps: playSessionId.slice(0, 8),
                stream: streamDirName,
                req: requestedSegmentNum,
                actual: actualSegmentIndex,
                offset: segmentOffset,
                progress: currentProgressForDiagnostics,
                ahead: requestedSegmentNum - currentProgressForDiagnostics,
                canSeek,
                generation: job.generationIndex,
                generationRole: job.generationRole,
                routeReason: segmentGenerationRoute?.reason ?? 'unrouted',
                repeatedRequestCount,
            });
        }

        // Past the end of the timeline. A transcode numbers files absolutely
        // (-start_number) and cuts every rendition on the job's grid (forced
        // keyframes for video; audio splits on any packet), so an index the
        // playlist never listed has no content. Answer 404 here, before the tail cache below
        // could hand out a different segment's bytes for it. Copy mode is left
        // alone: its video lists keyframe-derived entries, not this grid.
        if (
            isSegment &&
            !isIframeRequest &&
            isVideoTranscoded &&
            requestedSegmentNum >= 0 &&
            (job.config.totalDurationSeconds ?? 0) > 0 &&
            // A rendition FFmpeg reports on a different cadence is not on this
            // grid; leave it to the normal path rather than risk a false 404.
            (!streamTargetDuration || Math.abs(streamTargetDuration - jobSegmentDuration) <= 1)
        ) {
            const gridCount = uniformSegmentCount(
                job.config.totalDurationSeconds!,
                jobSegmentDuration,
            );
            let pastEnd = requestedSegmentNum >= gridCount;
            // The last listed entry can still be one FFmpeg never writes: a
            // container that outlasts the video by more than the grid folds.
            // Only a generation that read its input to the end can say so — a
            // stop we caused closes the manifest too, and there the missing
            // segment must still be produced (seek/wait below), not refused.
            if (
                !pastEnd &&
                !fileExists &&
                job.reachedEndOfInput === true &&
                requestedSegmentNum >= gridCount - 1
            ) {
                try {
                    const produced = await fs.readFile(
                        path.join(path.dirname(actualFilePath), 'index.m3u8'),
                        'utf-8',
                    );
                    pastEnd = isPastProducedEnd(produced, requestedSegmentNum, gridCount);
                } catch {
                    // No manifest yet: FFmpeg has not got there, normal path.
                }
            }
            if (pastEnd) {
                logger.info('Segment past the end of the timeline', {
                    ps: playSessionId.slice(0, 8),
                    stream: streamDirName,
                    req: requestedSegmentNum,
                    gridCount,
                });
                return createSegmentNotFoundResponse(responseContext, 'past_end');
            }
        }

        const staleGuardResult = await applyStaleSegmentGuard({
            responseContext,
            job,
            playSessionId: jobPlaySessionId,
            fileExists,
            isSegment,
            canSeek,
            actualSegmentIndex,
            requestedSegmentNum,
            segmentOffset,
            actualFilePath,
            sourceFilePath: filePath,
            segExt,
            streamDirName,
            isVideoTranscoded,
            staleProgressMargin: 50,
            seekWaitTimeoutMs: 5000,
            seekPollIntervalMs: 100,
            getSegmentOffset: (sessionId) => transcodeService.getSegmentOffset(sessionId),
            getStreamSegmentOffset: (sessionId, streamDir) =>
                transcodeService.getStreamSegmentOffset(sessionId, streamDir),
            statFile: (pathToStat) => fs.stat(pathToStat),
            accessFile: (pathToAccess) => fs.access(pathToAccess),
        });
        if (staleGuardResult.response) return staleGuardResult.response;
        fileExists = staleGuardResult.fileExists;
        actualFilePath = staleGuardResult.actualFilePath;

        // Transcode throttle: note where the player is, and continue a paused
        // FFmpeg right away if this request has to wait for it.
        if (isSegment && !isIframeRequest && !isCacheBacked) {
            transcodeService.recordSegmentRequestForJob(
                job,
                streamDirName,
                requestedSegmentNum,
                streamTargetDuration || jobSegmentDuration,
                fileExists,
            );
        }

        const lastServedForStream = job.lastServedSegment.get(streamDirName) ?? -1;
        const isFirstStreamAccess = lastServedForStream < 0;
        const isSequentialPlayback =
            lastServedForStream >= 0 && requestedSegmentNum - lastServedForStream <= 5;
        // GOP mode numbers every rendition on the keyframe grid, so its tail is
        // the grid's; its tail cache holds `segment` entries keyed by grid index.
        const gopTailGrid = isGopModeJob(job) ? transcodeService.getGopGrid?.(job) : null;
        const streamTotalForTail = gopTailGrid
            ? gopTailGrid.count
            : job.config.totalDurationSeconds
              ? uniformSegmentCount(
                    job.config.totalDurationSeconds,
                    streamTargetDuration || jobSegmentDuration,
                )
              : undefined;
        const isTailProbe =
            streamTotalForTail !== undefined && requestedSegmentNum >= streamTotalForTail - 3;
        // The tail cache answers only the playlist entry it holds; any other
        // tail index takes the normal wait / 404 path (end-segment-cache.ts).
        const tailCacheGrid = {
            totalSeconds: job.config.totalDurationSeconds ?? 0,
            segmentSeconds: streamTargetDuration || jobSegmentDuration,
        };
        const tailCacheBuffer =
            isTailProbe && segmentInfo
                ? lookupEndSegment(
                      job.endSegmentCache,
                      segmentInfo.streamDir,
                      requestedSegmentNum,
                      tailCacheGrid,
                  )
                : undefined;
        const postFileAction = planHlsSegmentAction({
            isSegment,
            isIframeRequest,
            requestedSegmentNum,
            actualSegmentIndex,
            segmentOffset,
            canSeek,
            fileExists,
            isDeleted: false,
            jobStatus: job.status,
            jobIsSeeking: job.isSeeking,
            isVideoTranscoded,
            isSequentialPlayback,
            isFirstStreamAccess,
            currentProgress: currentProgressForDiagnostics,
            forwardSeekThreshold: config.FFMPEG_FORWARD_SEEK_THRESHOLD,
            // Cache-backed previews never restart FFmpeg, and a skipped seek
            // does not fall back to the wait — keep them on wait_current.
            transcodeSpeed: isCacheBacked ? undefined : job.transcodeSpeed,
            segmentDurationSeconds: streamTargetDuration || jobSegmentDuration,
            farFromOriginThreshold: FAR_FROM_ORIGIN_THRESHOLD,
            isRepeatedSegmentPressure,
            repeatedPressureForwardSeekThreshold: REPEATED_PRESSURE_FORWARD_SEEK_THRESHOLD,
            isTailProbe,
            hasTailCache: tailCacheBuffer !== undefined,
        });

        if (isSegment && requestedSegmentNum >= 0) {
            recordHlsSeekTraceRequest({
                logger,
                job,
                playSessionId,
                streamDirName,
                requestedSegmentNum,
                actualSegmentIndex,
                segmentOffset,
                route: segmentGenerationRoute,
                classifiers: classifyHlsSegmentRequest({
                    isTailProbe,
                    isStaleGhostAudio: isStaleGhostAudioRequest,
                    hasRetainedMiss: (segmentGenerationRoute?.retainedFileMiss?.length ?? 0) > 0,
                    routeReason: segmentGenerationRoute?.reason,
                    willWaitForCurrent: postFileAction.type === 'wait_current',
                    isRepeatedSegmentPressure,
                }),
            });
        }

        let currentWaitMs = 0;

        // SKIP for cache-backed previews (see !isCacheBacked note above the backward
        // branch) — a fixed VOD artifact has no per-viewer seeking; fall through to
        // the wait-current / serve-file path instead of triggering a re-transcode.
        if (
            postFileAction.type === 'trigger_seek' &&
            postFileAction.direction === 'forward' &&
            !isCacheBacked
        ) {
            // playSessionId (not jobPlaySessionId) is intentional — same reasoning as
            // the backward branch: this only runs for non-cache previews / real
            // playback, where playSessionId IS the job id.
            const forwardSeekResult = await executeForwardSeekAction({
                responseContext,
                job,
                playSessionId,
                requestedSegmentNum,
                segmentOffset,
                currentProgress: currentProgressForDiagnostics,
                fileExists,
                actualFilePath,
                normalizedPath,
                segExt,
                streamDirName,
                streamTargetDuration,
                isVideoTranscoded,
                branch: postFileAction.branch as ForwardSeekBranch,
                seekCooldownMs: SEEK_COOLDOWN_MS,
                forwardSeekThreshold: config.FFMPEG_FORWARD_SEEK_THRESHOLD,
                seekWaitTimeoutMs: SEEK_WAIT_TIMEOUT_MS,
                pollIntervalMs: POLL_INTERVAL_MS,
                logIntervalMs: LOG_INTERVAL_MS,
                getLastSeekTimestamp,
                setLastSeekTimestamp: (sessionId, timestamp) =>
                    setLastSeekTimestamp(sessionId, timestamp),
                clearSeekTimestamp,
                pruneExpiredSeekTimestamps: () =>
                    pruneExpiredSeekTimestamps({
                        pruneThreshold: PRUNE_THRESHOLD,
                        maxAgeMs: SEEK_COOLDOWN_MS * 2,
                    }),
                deduplicatedSeek: (sessionId, targetSegmentIndex, segmentDurationSeconds) =>
                    deduplicatedHlsSeek({
                        playSessionId: sessionId,
                        targetSegmentIndex,
                        segmentDurationSeconds,
                        fallbackSegmentDurationSeconds: config.FFMPEG_SEGMENT_DURATION,
                        transcodeService,
                    }),
                getJobByPlaySession: (sessionId) => transcodeService.getJobByPlaySession(sessionId),
                getStreamSegmentOffsetForJob: (currentJob, streamDir) =>
                    transcodeService.getStreamSegmentOffsetForJob(currentJob, streamDir),
                translateToFileIndex: uniformToKeyframeFile,
            });
            if (forwardSeekResult.response) return forwardSeekResult.response;
            job = forwardSeekResult.job;
            responseContext.job = job;
            fileExists = forwardSeekResult.fileExists;
            actualFilePath = forwardSeekResult.actualFilePath;
            currentWaitMs = forwardSeekResult.waitMs;
            preReadBuffer = forwardSeekResult.fileContent;
        }

        // Serve cached end-of-stream segments instantly (hls.js VOD duration probe).
        // After a seek, FFmpeg restarts from the new position and hasn't produced
        // the end yet. hls.js blocks audio playback until the last segment arrives.
        // The cached segment has valid PTS (~end of file) regardless of seek position.
        if (postFileAction.type === 'serve_tail_cache' && segmentInfo) {
            // The buffer the plan was made from: serve_tail_cache never swaps
            // the job, and a retire clearing the map meanwhile must not turn
            // the planned answer into a silent wait.
            const cached = tailCacheBuffer;
            if (cached) {
                logger.info('Serving end-segment from cache (VOD duration probe)', {
                    playSessionId,
                    stream: segmentInfo.streamDir,
                    segment: requestedSegmentNum,
                    streamTotal: streamTotalForTail,
                    cachedSize: cached.length,
                });
                recordHlsSeekTraceServed({
                    logger,
                    job,
                    playSessionId,
                    streamDirName,
                    requestedSegmentNum,
                    actualSegmentIndex,
                    segmentOffset,
                    waitMs: 0,
                });
                return createTailCacheSegmentResponse({
                    corsHeaders: CORS_HEADERS,
                    contentType: ext === '.ts' ? 'video/mp2t' : 'video/mp4',
                    cached,
                });
            }
        }

        // Wait for segments that aren't ready yet
        // Allow the wait loop when the job is mid-seek (isSeeking=true) even if
        // the status is briefly 'stopped' — seekToSegment() kills FFmpeg (→ 'stopped')
        // before restarting it. Without this, concurrent requests from other streams
        // see 'stopped' and immediately 404 instead of triggering their own seek.
        if (postFileAction.type === 'wait_current') {
            const waitResult = await waitForCurrentSegmentFile({
                job,
                playSessionId: jobPlaySessionId,
                requestedSegmentNum,
                actualSegmentIndex,
                segmentOffset,
                actualFilePath,
                sourceFilePath: filePath,
                segExt,
                streamDirName,
                streamTargetDuration,
                jobSegmentDuration,
                canSeek,
                isIframeRequest,
                isRepeatedSegmentPressure,
                repeatedRequestCount,
                isVideoTranscoded,
                waitTimeoutMs: SEGMENT_WAIT_TIMEOUT_MS,
                seekWaitTimeoutMs: SEEK_WAIT_TIMEOUT_MS,
                iframeWaitTimeoutMs: IFRAME_WAIT_TIMEOUT_MS,
                pollIntervalMs: POLL_INTERVAL_MS,
                getJobByPlaySession: (sessionId) => transcodeService.getJobByPlaySession(sessionId),
                getSegmentOffset: (sessionId) => transcodeService.getSegmentOffset(sessionId),
                getStreamSegmentOffset: (sessionId, streamDir) =>
                    transcodeService.getStreamSegmentOffset(sessionId, streamDir),
                clearSeekTimestamp,
                translateToFileIndex: uniformToKeyframeFile,
                restartAtRequestedSegment: () =>
                    transcodeService.seekToSegment(
                        jobPlaySessionId,
                        requestedSegmentNum,
                        streamTargetDuration,
                        undefined,
                        true,
                    ),
            });
            if (waitResult.retryAfterRecovery) {
                return createSegmentNotReadyResponse(responseContext, 'segment_grid_recovery');
            }
            fileExists = waitResult.fileExists;
            actualFilePath = waitResult.actualFilePath;
            currentWaitMs = waitResult.waitMs;
        }

        // Use the translated file path for serving
        filePath = actualFilePath;

        fileExists = await waitForInitSegment({
            fileExists,
            isInitSegment,
            job,
            playSessionId: jobPlaySessionId,
            normalizedPath,
            filePath,
            timeoutMs: 10_000,
            pollIntervalMs: 200,
            // Rejects a 0-byte file so the poll keeps waiting: FFmpeg creates the
            // init before filling it, and serving the empty file would look like
            // success to the client (see the stat check above).
            accessFile: async (pathToAccess) => {
                const stat = await fs.stat(pathToAccess);
                if (stat.size === 0) throw new Error('init segment is empty');
            },
            getJobByPlaySession: (sessionId) => transcodeService.getJobByPlaySession(sessionId),
            clearSeekTimestamp,
            logDebug: (message, metadata) => logger.debug(message, metadata),
        });

        // Media playlists are generated, not just read from disk: master.m3u8 is
        // synthesized by serveMasterPlaylist, and each stream's index.m3u8 is
        // synthesized by serveMediaPlaylist as a full VOD manifest from duration
        // info — even when FFmpeg has not yet written its on-disk manifest (the
        // brief window while a job is starting or being recreated). Gating .m3u8
        // on the FFmpeg file's existence here would 404 the rendition during that
        // window, which native HLS (Safari/AVPlayer) treats as fatal ("media
        // failed to decode"). Only segment/init files require the file to exist.
        if (!fileExists && job.shutdownKillRequested && job.killRequested) {
            throw new ShutdownInterruptedError();
        }
        if (!fileExists && ext !== '.m3u8') {
            if (isSegment && requestedSegmentNum >= 0) {
                recordHlsSeekTraceRequest({
                    logger,
                    job,
                    playSessionId,
                    streamDirName,
                    requestedSegmentNum,
                    actualSegmentIndex,
                    segmentOffset,
                    route: segmentGenerationRoute,
                    countRequest: false,
                    classifiers: classifyHlsSegmentRequest({
                        isTailProbe,
                        isStaleGhostAudio: isStaleGhostAudioRequest,
                        hasRetainedMiss:
                            (segmentGenerationRoute?.retainedFileMiss?.length ?? 0) > 0,
                        routeReason: segmentGenerationRoute?.reason,
                        willWaitForCurrent: false,
                        isRepeatedSegmentPressure,
                        isMissing404: true,
                    }),
                });
            }
            return createMissingHlsFileResponse({
                responseContext,
                job,
                playSessionId,
                filePath,
                segmentPath,
                isSegment,
                isInitSegment,
                segmentInfo,
                requestedSegmentNum,
                segmentOffset,
                currentProgress: currentProgressForDiagnostics,
                isIframeRequest: Boolean(isIframeRequest),
                streamDirName,
                streamTargetDuration,
                jobSegmentDuration,
                contentType: ext === '.ts' ? 'video/mp2t' : 'video/mp4',
                corsHeaders: CORS_HEADERS,
                logInfo: (message, metadata) => logger.info(message, metadata),
                logWarn: (message, metadata) => logger.warn(message, metadata),
                logDebug: (message, metadata) => logger.debug(message, metadata),
            });
        }

        // Determine content type
        const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

        // ================================================================
        // SPECIAL HANDLING: master.m3u8
        // ================================================================
        if (normalizedPath === 'master.m3u8') {
            if (job.config.hlsOutput?.hlsAudioMode === 'muxed') {
                return serveMuxedJobMaster(job, playSessionId, url);
            }
            return serveMasterPlaylist(job, itemId, playSessionId, url, basePath);
        }

        // `job` is narrowed to TranscodeJob here (guarded above and reassigned to a
        // non-optional value); capture it in a const so the onSegmentServed closure
        // below sees the narrowed type rather than the let binding's declared union.
        const resolvedJob = job;

        // For stream-specific media playlists, generate appropriate manifest based on transcoding state
        if (ext === '.m3u8') {
            // serveMediaPlaylist keys ALL of its internal lookups (getVodManifestInfo,
            // getStreamTargetDuration/setStreamTargetDuration, getJobByPlaySession) on
            // this id — it must be the artifact id, not the viewer id, for a cache-
            // backed preview.
            return serveMediaPlaylist(
                resolvedJob,
                jobPlaySessionId,
                filePath,
                url,
                transcodeService,
            );
        }

        return serveHlsSegmentFile({
            responseContext,
            job: resolvedJob,
            playSessionId,
            segmentPath,
            filePath,
            contentType,
            rangeHeader,
            segmentInfo,
            requestedSegmentNum,
            isVideoTranscoded,
            streamTargetDuration,
            jobSegmentDuration,
            preReadBuffer,
            readFile: (pathToRead) => fs.readFile(pathToRead),
            clearRepeatedSegmentRequest,
            getStreamSegmentOffsetForJob: (currentJob, streamDir) =>
                transcodeService.getStreamSegmentOffsetForJob(currentJob, streamDir),
            recordSegmentAccessForJob: (currentJob, streamDir, segmentIndex) =>
                transcodeService.recordSegmentAccessForJob(currentJob, streamDir, segmentIndex),
            trackHlsSegment: (bytes) =>
                bandwidthTracker.trackHlsSegmentForSession(playSessionId, bytes),
            onSegmentServed: (served) =>
                recordHlsSeekTraceServed({
                    logger,
                    job: resolvedJob,
                    playSessionId,
                    streamDirName: served.streamDir,
                    requestedSegmentNum: served.requestedSegment,
                    actualSegmentIndex: served.actualSegment,
                    segmentOffset: served.segmentOffset,
                    waitMs: currentWaitMs,
                }),
            logDebug: (message, metadata) => logger.debug(message, metadata),
        });
    } catch (error) {
        if (error instanceof ShutdownInterruptedError) {
            logger.info('HLS segment interrupted by shutdown', { playSessionId });
            const response = shuttingDownResponse();
            for (const [name, value] of Object.entries(CORS_HEADERS)) {
                response.headers.set(name, value);
            }
            return response;
        }
        logger.error('Segment serving error', error as Error, {
            itemId,
            path: segmentPath,
        });
        // Record the proxy failure as a server telemetry event (fire-and-forget).
        // deviceId is best-effort — `job` may be undefined if the failure
        // happened before it was resolved. Never let this throw into the catch.
        try {
            const deviceId = job?.config?.deviceId;
            void playbackTelemetryService
                .record(
                    playSessionId,
                    'server',
                    'proxy_error',
                    1,
                    deviceId ? { deviceId } : undefined,
                )
                .catch(() => {
                    /* best-effort telemetry — never affects playback */
                });
        } catch {
            /* best-effort telemetry — never affects playback */
        }
        return new Response('Internal error', {
            status: 500,
            headers: CORS_HEADERS,
        });
    }
}

/**
 * CORS preflight response for HLS endpoints.
 * Shared between /api/v1 and /j/ routes.
 */
export function handleHlsOptions(): Response {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Authorization, X-Emby-Token',
            'Access-Control-Max-Age': '86400',
        },
    });
}

// ================================================================
// PRIVATE HELPERS
// ================================================================

/**
 * Return format-appropriate error response based on path type.
 * Prevents AVPlayer parse errors by returning valid WebVTT/HLS for subtitle paths.
 */
function createErrorResponse(
    segmentPath: string | undefined,
    message: string,
    status: number,
): Response {
    // Check if this looks like a subtitle request
    if (segmentPath?.endsWith('.vtt')) {
        // Extract segment number from path if possible (e.g., seg_00133.vtt)
        const segMatch = segmentPath.match(/seg_(\d+)\.vtt$/);
        const segmentNumber = segMatch ? parseInt(segMatch[1], 10) : 0;
        return createSubtitleErrorResponse(segmentNumber, status);
    } else if (segmentPath?.includes('subs_') && segmentPath?.endsWith('.m3u8')) {
        // Subtitle playlist - return valid empty HLS playlist
        return createSubtitleErrorResponse(null, status);
    }
    // Default: plain text for non-subtitle paths
    return new Response(message, { status, headers: CORS_HEADERS });
}

/**
 * Serve the custom master playlist with subtitle, trickplay, and I-frame entries.
 */
export function serveMasterPlaylist(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    job: any,
    itemId: string,
    playSessionId: string,
    url: URL,
    basePath: string,
): Response {
    const { fileId, videoInfo, trickplayInfo } = job.config;
    // The same downmix rule as the playback service's master and the dictionary.
    const audioTracks: AudioTrackInfo[] = manifestAudioTracks(
        job.config.audioTracks ?? [],
        job.config.maxAudioChannels,
        job.transcodeDecisionResult?.audioAction === 'copy',
    );

    // Build segment base URL using the provided basePath
    // For the token surface: basePath is `base` from $app/paths → e.g., '/api/v1/playback/{id}/hls'
    // For /j/: basePath is '/j' → not applicable (master.m3u8 is separate in /j/)
    // Determine API prefix from the URL path. The token mirror lives under
    // /api/v1/* and the cookie BFF under /api/*; check the versioned prefix
    // first so v1 segment URLs don't collapse onto the unversioned BFF route.
    const apiPrefix = url.pathname.startsWith('/api/v1/')
        ? 'api/v1'
        : url.pathname.startsWith('/api/')
          ? 'api'
          : url.pathname.startsWith('/j/')
            ? 'j'
            : 'api/v1';

    // The web route (/api/, not /api/v1/ or /j/) renders subtitles from the
    // page's own <track> elements. A SUBTITLES group in its master makes iOS
    // fail the load (MediaError 4), same rule as startHlsPlayback's
    // omitManifestSubtitles.
    const subtitleTracks = apiPrefix === 'api' ? undefined : job.config.subtitleTracks;

    // The client's chosen audio track wins over the job's: a demux job is never
    // restarted for a new track, so job.config can hold the first request's choice.
    const selectedAudioStreamIndex = selectedAudioTrackFor(url, job);

    let segmentBase: string;
    if (apiPrefix === 'j') {
        segmentBase = `/j/Videos/${itemId}/hls`;
    } else {
        segmentBase = `${basePath}/${apiPrefix}/playback/${itemId}/hls`;
    }

    // Build query params for segment URLs
    const segmentParams = new URLSearchParams();
    segmentParams.set('PlaySessionId', playSessionId);

    // Pass through authentication tokens
    addAuthToSearchParams(segmentParams, extractAuthParams(url));

    // Pass through debug_subs parameter if present
    const debugSubs = url.searchParams.get('debug_subs');
    if (debugSubs) {
        segmentParams.set('debug_subs', debugSubs);
    }

    // Calculate estimated bandwidth
    const estimatedBandwidth = calculateEstimatedBandwidth(videoInfo, audioTracks);

    // Check for trickplay/iframes opt-in query parameters
    const trickplayParam = url.searchParams.get('trickplay');
    const iframesParam = url.searchParams.get('iframes');

    // Determine audio codec for HLS manifest
    const transcodeDecision = job.transcodeDecisionResult;
    const isAudioCopied = transcodeDecision?.audioAction === 'copy';
    // The FILE'S DEFAULT track, not `audioTracks[0]`. Demux maps every audio
    // stream in array order, so there is no "selected" track here the way there
    // is for the muxed master — but a variant carries only ONE CODECS
    // attribute, and it has to describe the rendition that actually plays.
    // `generateMasterPlaylist` stamps DEFAULT=YES on `track.isDefault`, so on a
    // file whose default is not first that rendition is the default track. This
    // is also the other demux master's rule (hls/playback.service.ts), and the
    // two describe the same stream — they must not disagree.
    //
    // Known limitation, pre-existing: a file whose audio tracks differ in codec
    // is still described by a single one of them.
    const primaryAudioCodec = resolveAudioTrackByAbsoluteIndex<AudioTrackInfo>(
        audioTracks,
        defaultAudioAbsoluteIndex(audioTracks),
    ).track?.codec;

    const playlistOptions: MasterPlaylistOptions = {
        includeTrickplay: trickplayParam === 'jpeg',
        // AVPlayer cannot request the I-frame variant itself, so decide for it.
        // Check both signals, as playback.service.ts does for the muxed master:
        // deviceProfile is a query param and can be dropped on a re-request, so
        // the User-Agent is the more durable of the two.
        syntheticIframes: resolveSyntheticIframes({
            deviceProfileId: job.config.deviceProfileId,
            userAgent: job.config.userAgent,
            iframesParam,
        }),
        audioCodec: isAudioCopied ? primaryAudioCodec : 'aac',
        isAudioCopied,
        // MPEG-TS demux manifests must signal in-band codec forms (hev1/dvhe).
        hlsContainer: job.config.hlsOutput?.hlsContainer ?? 'fmp4',
        selectedAudioStreamIndex,
    };

    // The manifest profile_idc must match the real bitstream — see
    // resolveMasterHevcMain10. This site was already fully job-derived; it now
    // shares the derivation with the playback service so the two cannot drift
    // apart again by editing one of them.
    const outputHevcMain10 = resolveMasterHevcMain10(job);
    const playlistVideoInfo = videoInfo ? { ...videoInfo, outputHevcMain10 } : videoInfo;

    // Generate our custom master playlist with subtitle and trickplay entries
    const masterContent = generateMasterPlaylist(
        audioTracks,
        subtitleTracks,
        segmentBase,
        segmentParams,
        estimatedBandwidth,
        playlistVideoInfo,
        videoInfo?.outputCodec,
        itemId,
        fileId,
        trickplayInfo,
        playlistOptions,
    );

    logger.debug('Serving custom master playlist with subtitles and trickplay', {
        playSessionId,
        itemId,
        audioTracks: audioTracks.length,
        subtitleTracks: subtitleTracks?.length || 0,
        hasTrickplay: !!trickplayInfo,
        includeTrickplay: playlistOptions.includeTrickplay,
        syntheticIframes: playlistOptions.syntheticIframes,
    });

    return new Response(masterContent, {
        status: 200,
        headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
        },
    });
}

/**
 * Serve a stream-specific media playlist (.m3u8) with appropriate VOD manifest handling.
 */
async function serveMediaPlaylist(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    job: any,
    playSessionId: string,
    filePath: string,
    url: URL,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transcodeService: any,
): Promise<Response> {
    const vodInfo = transcodeService.getVodManifestInfo(playSessionId);
    let content: string;

    // GOP mode: every rendition lists the full keyframe grid with exact
    // durations — independent of what any generation has produced so far.
    const gopGrid = transcodeService.getGopGrid?.(job);
    if (gopGrid) {
        content = buildGopGridManifest(
            gopGrid,
            initSegmentNameForStreamDir(path.dirname(filePath)),
            url.searchParams,
        );
        return new Response(content, {
            status: 200,
            headers: {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
            },
        });
    }

    // Discover and cache per-stream TARGETDURATION from FFmpeg manifest.
    // Video in remux mode has ~10s segments while audio has ~6s.
    const streamDir = path.dirname(filePath);
    const streamDirName = path.basename(streamDir);
    await cacheStreamTargetDuration(streamDir, streamDirName, playSessionId, transcodeService);

    // ── Degraded mode: copy-mode video without keyframes ──
    // When video is copied (not transcoded) and keyframe data is missing, the VOD
    // playlist would have synthetic uniform durations that drift from reality. Over
    // hundreds of segments, hls.js computes wrong segment numbers on seek.
    //
    // Degraded behavior: suppress VOD for this stream — serve FFmpeg's live EVENT
    // manifest instead. This limits seeking to already-produced segments but avoids
    // the wrong-segment infinite-loop bug entirely.
    const isCopyModeVideo = job.transcodeDecisionResult?.videoAction === 'copy';
    // Video is always the last output stream (after audio tracks)
    const videoStreamDir = `stream_${job.config.audioTracks.length}`;
    const isVideoStream = streamDirName === videoStreamDir;

    // All demux sub-playlists use uniform segment numbering — strip keyframe
    // durations from every stream. Safari/AVPlayer matches demuxed audio and
    // video by segment NUMBER, not PROGRAM-DATE-TIME. Different segment counts
    // (keyframe video ~1123 vs uniform audio ~1171) cause severe A/V desync
    // (200+ seconds at 2h in). The segment handler translates uniform indices
    // to keyframe FFmpeg files at serving time.
    //
    // The video playlist still lists FFmpeg's REAL durations for produced
    // files, so its TARGETDURATION must cover the longest keyframe segment from
    // the first fetch on — not jump once FFmpeg writes a long GOP (RFC 8216
    // forbids a changing TARGETDURATION; AVPlayer rejects EXTINF > it).
    const plannedKeyframeDurations: number[] | undefined = vodInfo?.keyframeSegmentDurations;
    const plannedKeyframeMax =
        isCopyModeVideo && isVideoStream && plannedKeyframeDurations
            ? plannedKeyframeDurations.reduce(
                  (max, d) => (Number.isFinite(d) && d > 0 ? Math.max(max, d) : max),
                  0,
              )
            : 0;
    const effectiveVodInfo = vodInfo
        ? {
              ...vodInfo,
              keyframeSegmentDurations: undefined,
              keyframeStreamOffset: undefined,
              minTargetDurationSeconds: plannedKeyframeMax > 0 ? plannedKeyframeMax : undefined,
          }
        : vodInfo;

    // Degraded mode: copy-mode video without ANY keyframe data at all.
    // Check against the original vodInfo, not effectiveVodInfo (which always
    // strips keyframe durations for uniform playlist alignment).
    const needsDegradedMode =
        isCopyModeVideo && isVideoStream && !vodInfo?.keyframeSegmentDurations;

    if (needsDegradedMode) {
        logger.warn(
            'DEGRADED MODE: Copy-mode video stream missing keyframe data — ' +
                'serving EVENT playlist instead of pre-generated VOD. ' +
                'Seeking limited to already-produced segments.',
            { playSessionId, stream: streamDirName },
        );
    }

    if (effectiveVodInfo && !needsDegradedMode) {
        // Always start the manifest from segment 0 to preserve the full timeline.
        // hls.js calculates seek positions from cumulative durations — if we
        // truncate the manifest to start at the offset, hls.js maps time T to
        // offset + T/segDuration instead of T/segDuration, doubling the offset
        // and causing cascading seeks (567 → 1133 → 1535).
        //
        // Segments before the offset are "phantom" (estimated durations, no FFmpeg data)
        // but hls.js never requests them because it only loads from the seek target forward.
        // The segment serving layer (translateToActualIndex) handles the offset→file mapping.
        const manifestStartSegment = 0;

        if (effectiveVodInfo.isComplete) {
            // Transcoding complete - use full VOD manifest with all segments
            // Wrap in try/catch: manifest may have been cleaned up
            let ffmpegManifest: string;
            try {
                ffmpegManifest = await fs.readFile(filePath, 'utf-8');
            } catch {
                // Manifest cleaned up — generate without it (use default init segment)
                ffmpegManifest = '';
            }
            content = generateCompleteVodManifest(
                ffmpegManifest,
                effectiveVodInfo,
                url.searchParams,
                manifestStartSegment,
                // FFmpeg's manifest may not carry EXT-X-MAP yet; name this
                // stream's own init rather than defaulting to stream 0's.
                initSegmentNameForStreamDir(streamDir),
            );
        } else {
            // Generate full VOD manifest with all expected segments
            content = await generateFullVodManifest(
                streamDir,
                effectiveVodInfo,
                url.searchParams,
                manifestStartSegment,
            );
        }
    } else {
        // No duration info - fall back to FFmpeg's manifest with URL rewriting
        // Wrap in try/catch: manifest may have been deleted by cleanup
        try {
            content = await fs.readFile(filePath, 'utf-8');
        } catch {
            // The manifest is absent for two very different reasons:
            //   • the transcode is still spinning up and FFmpeg has not written
            //     it yet (a PGS burn-in encode takes ~2s to emit the first
            //     segment, and FFmpeg only writes the .m3u8 after it), or
            //   • the session ended and cleanup removed it.
            //
            // Only the second is a real 404. AVFoundation treats 404 as "this
            // resource does not exist": it penalty-boxes the variant
            // (CoreMediaErrorDomain -12938) and never retries, so a startup-race
            // 404 becomes a permanent spinner on tvOS. While the job is alive,
            // answer 503 + Retry-After, which AVFoundation and hls.js both retry.
            const jobStillProducing = job.status !== 'stopped' && job.status !== 'error';
            if (jobStillProducing) {
                return new Response('Playlist not ready — transcode is starting', {
                    status: 503,
                    headers: {
                        'Retry-After': '1',
                        'Cache-Control': 'no-store',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }
            // best-effort: manifest deleted by cleanup → reported via 404 response.
            return new Response('Playlist no longer available', {
                status: 404,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }
        content = rewriteMediaPlaylist(content, url.searchParams, url.origin);

        // Convert the FFmpeg EVENT playlist to VOD once the clip is complete, so
        // players load it from the start instead of treating it as a live stream.
        //
        // `job.status === 'stopped'` catches the fresh-transcode case (this
        // replica's own FFmpeg has exited). But a CACHE-BACKED preview served off
        // a shared artifact whose in-memory job was reaped/re-warmed/startup-
        // scanned is NOT 'stopped' — yet its on-disk manifest is already complete
        // (FFmpeg wrote #EXT-X-ENDLIST). Without the VOD conversion those complete
        // clips go out as PLAYLIST-TYPE:EVENT, which Safari/AVPlayer treat as live
        // (jump to the live edge → play ~a frame → end → revert to backdrop) and
        // hls.js won't load a fragment from position 0. The already-present ENDLIST
        // is the authoritative "this clip is complete" signal, so key off it too.
        // (The hero preview is unaffected: its session stays genuinely live and
        // growing, so its manifest has no ENDLIST and correctly stays EVENT.)
        const manifestComplete = content.includes('#EXT-X-ENDLIST');
        if (job.status === 'stopped' || manifestComplete) {
            content = addVodMarkers(content);
        }
    }

    const responseHeaders: Record<string, string> = {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
    };

    // Signal degraded mode to the client so it can show a warning
    if (needsDegradedMode) {
        responseHeaders['X-Lumastra-Playback-Warning'] =
            'missing-keyframes: copy-mode video without keyframe data, seeking limited';
        responseHeaders['Access-Control-Expose-Headers'] = 'X-Lumastra-Playback-Warning';
    }

    return new Response(content, {
        status: 200,
        headers: responseHeaders,
    });
}

/**
 * Read and cache per-stream TARGETDURATION from FFmpeg's manifest.
 * Called when serving stream playlists so the segment handler can use
 * correct per-stream offsets later.
 */
async function cacheStreamTargetDuration(
    streamDir: string,
    streamDirName: string,
    playSessionId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transcodeService: any,
): Promise<void> {
    // Skip re-read if we already have a confirmed non-base duration.
    // The base duration is a preliminary value (no segment samples yet);
    // re-read so we can upgrade once real data arrives.
    const existing = transcodeService.getStreamTargetDuration(playSessionId, streamDirName);
    const jobForDuration = transcodeService.getJobByPlaySession(playSessionId);
    // GOP mode counts every stream in grid entries; never rescale by a stream's
    // target duration.
    if (jobForDuration && isGopModeJob(jobForDuration)) return;
    const jobBaseDuration =
        jobForDuration?.segmentDurationSeconds ?? config.FFMPEG_SEGMENT_DURATION;
    if (existing !== undefined && existing !== jobBaseDuration) return;

    try {
        const files = await fs.readdir(streamDir);
        const manifestFile = files.find((f: string) => f.endsWith('.m3u8'));
        if (manifestFile) {
            const manifest = await fs.readFile(path.join(streamDir, manifestFile), 'utf-8');
            const ffmpegData = parseFFmpegManifest(manifest);
            const effectiveDuration = resolveEffectiveStreamDuration(
                jobBaseDuration,
                ffmpegData.targetDuration,
                ffmpegData.segments,
            );
            if (effectiveDuration > 0) {
                transcodeService.setStreamTargetDuration(
                    playSessionId,
                    streamDirName,
                    effectiveDuration,
                );
                logger.debug('Cached stream target duration', {
                    playSessionId,
                    streamDir: streamDirName,
                    targetDuration: ffmpegData.targetDuration,
                    effectiveDuration,
                });
            }
        }
    } catch {
        // Manifest not ready yet — will be cached on next request
    }
}

/**
 * Build debug headers for segment responses.
 * These are read by the client-side HLS.js FRAG_LOADED handler
 * and logged to the browser console for seek diagnostics.
 */
function buildSegmentDebugHeaders(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    job: any,
    segmentOffset: number,
    requestedSegment: number,
    actualSegment: number,
    streamDir: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transcodeService: any,
    playSessionId: string,
    options?: {
        branch?: string;
        canSeek?: boolean;
        streamTargetDuration?: number;
    },
): Record<string, string> {
    const currentJob = job ?? transcodeService.getJobByPlaySession(playSessionId);
    const jobDuration = currentJob?.segmentDurationSeconds ?? config.FFMPEG_SEGMENT_DURATION;
    const targetDuration =
        options?.streamTargetDuration ??
        currentJob?.streamTargetDurations?.get(streamDir) ??
        jobDuration;
    const ready = currentJob?.segmentsReady ?? -1;
    const streamReady =
        ready >= 0 && isDistinctStreamDuration(targetDuration, jobDuration)
            ? Math.floor((ready * jobDuration) / targetDuration)
            : ready;
    const currentProgress = streamReady >= 0 ? streamReady + segmentOffset : segmentOffset;
    const deletedUpTo = currentJob?.deletedUpTo?.get(streamDir) ?? -1;
    const videoAction = currentJob?.transcodeDecisionResult?.videoAction ?? 'unknown';
    const audioAction = currentJob?.transcodeDecisionResult?.audioAction ?? 'unknown';
    const retainedGenerationCount =
        transcodeService.getRetainedJobsByPlaySession?.(playSessionId)?.length ?? 0;

    const diagnosticHeaders = buildStreamDiagnosticHeaders({
        branch: options?.branch,
    });
    if (diagnosticHeaders['X-Lumastra-Diagnostic-Id']) {
        logger.warn('Emitting stream diagnostic header', {
            code: diagnosticHeaders['X-Lumastra-Diagnostic-Code'],
            diagnosticId: diagnosticHeaders['X-Lumastra-Diagnostic-Id'],
            branch: options?.branch,
        });
    }

    return {
        'X-Lumastra-Offset': segmentOffset.toString(),
        'X-Lumastra-Actual': actualSegment.toString(),
        'X-Lumastra-Ready': ready.toString(),
        'X-Lumastra-Seeking': (currentJob?.isSeeking ?? false).toString(),
        'X-Lumastra-Stream': streamDir,
        'X-Lumastra-SeekCount': (currentJob?.seekCount ?? 0).toString(),
        'X-Lumastra-SeekTrigger': currentJob?.lastSeekTrigger ?? '',
        'X-Lumastra-Progress': currentProgress.toString(),
        'X-Lumastra-Deleted': deletedUpTo.toString(),
        'X-Lumastra-CanSeek': options?.canSeek === undefined ? '' : String(options.canSeek),
        'X-Lumastra-Branch': options?.branch ?? '',
        'X-Lumastra-Mode': `${videoAction}/${audioAction}`,
        'X-Lumastra-TargetDuration': targetDuration.toString(),
        'X-Lumastra-Generation': (currentJob?.generationIndex ?? -1).toString(),
        'X-Lumastra-GenerationRole': currentJob?.generationRole ?? '',
        'X-Lumastra-SessionGenerations': retainedGenerationCount.toString(),
        ...diagnosticHeaders,
    };
}

/**
 * The audio track the client asked for (`hlsAudioTrack`, absolute stream index),
 * else the one the job was started with. Shared by the master playlist and the
 * rendition-name dictionary so both describe the same renditions.
 */
function selectedAudioTrackFor(url: URL, job: TranscodeJob | undefined): number | undefined {
    const hlsAudioTrackParam = parseInt(url.searchParams.get('hlsAudioTrack') ?? '', 10);
    return Number.isInteger(hlsAudioTrackParam) && hlsAudioTrackParam >= 0
        ? hlsAudioTrackParam
        : job?.config.hlsOutput?.hlsAudioTrackIndex;
}
