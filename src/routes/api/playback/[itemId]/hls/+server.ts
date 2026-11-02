// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS Lumastra - Multi-Audio HLS Transcoding Endpoint
 *
 * Provides HLS streams with demuxed audio tracks using FFmpeg var_stream_map.
 * Designed for native tvOS AVPlayer with seamless audio track switching.
 *
 * Thin wrapper over HlsPlaybackService — parses URL params and delegates
 * the full transcoding pipeline to startHlsPlayback().
 */

import type { RequestHandler } from './$types';
import { features } from '$lib/server/config.js';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { problem } from '$lib/server/api/problem.js';
import { codeForStatus } from '$lib/server/utils/api-responses.js';
import { parseSeekSeconds, HLS_CORS_HEADERS } from '$lib/server/utils/hls-request-utils.js';
import {
    startHlsPlayback,
    HlsPlaybackError,
    MUXED_MEDIA_PLAYLIST_PARAM,
} from '$lib/server/services/hls/playback.service.js';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { base } from '$app/paths';
import type { HlsOutputConfig } from '$lib/server/services/transcoding/types';
import { withMediaAccess } from '$lib/server/middleware/media-access.js';
import { randomUUID } from 'node:crypto';
import { getClientIpFromRequest } from '$lib/server/utils/client-ip.js';
import {
    buildExplicitStreamDiagnosticHeaders,
    getPublicHlsDiagnosticCode,
} from '$lib/server/services/hls/stream-diagnostics.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    ALLOWED_VIDEO_CODEC_OVERRIDES,
    ALLOWED_AUDIO_CODEC_OVERRIDES,
    resolveCodecOverride,
} from './codec-override.js';
import { resolvePlaySessionId } from './session-id-resolution.js';
import { buildHlsSegmentUrlParts } from './segment-url-parts.js';
import {
    parseQualityCapParams,
    parseMaxAudioChannelsParam,
    isEmptyQualityCap,
} from '$lib/server/services/transcoding/quality-cap.js';

const logger = Logger.for('HlsPlaybackAPI');

// PlaySessionId resolution (charset check + substitute-on-mismatch) now lives
// in session-id-resolution.ts, pinned by session-id-resolution.test.ts. The
// charset itself moved to hls-request-utils.ts and is now also enforced
// inside startHlsPlayback (the seam all three callers share), so this
// route's own check is belt-and-suspenders, not the only guard.

// Client's stable localStorage device UUID (see device-id.ts: 'dashboard-<uuid>'),
// sent only for the stream-policy ghost exclusion — never stored. Kept to the
// same conservative charset as PlaySessionId.
const SAFE_DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function getStructuredPlaybackErrorCode(error: HlsPlaybackError): string | undefined {
    if (!error.message.startsWith('{')) return undefined;
    try {
        const body = JSON.parse(error.message) as { error?: unknown };
        return typeof body.error === 'string' ? body.error : undefined;
    } catch {
        return undefined;
    }
}

function getPlaybackErrorDetail(error: HlsPlaybackError): { text: string; retryAfter?: number } {
    if (!error.message.startsWith('{')) return { text: error.message };
    try {
        const body = JSON.parse(error.message) as { message?: unknown; retry_after?: unknown };
        return {
            text: typeof body.message === 'string' ? body.message : error.message,
            ...(typeof body.retry_after === 'number' ? { retryAfter: body.retry_after } : {}),
        };
    } catch {
        return { text: error.message };
    }
}

export const GET: RequestHandler = requireAuth(
    withIdResolution(
        withMediaAccess(
            withErrorHandler(async ({ url, locals, request, getClientAddress }) => {
                const { internalId } = locals.resolvedIds ?? {};

                if (!features.ffmpegAvailable) {
                    return problem('dependency_unavailable', {
                        error: 'HLS transcoding is not available. Set FFMPEG_PATH in your environment.',
                        headers: HLS_CORS_HEADERS,
                    });
                }

                if (!internalId) {
                    return problem('not_found', {
                        error: 'Media not found',
                        headers: HLS_CORS_HEADERS,
                    });
                }

                const sql = await aiDbService.getSql();
                if (!sql) {
                    return problem('dependency_unavailable', {
                        error: 'Database unavailable',
                        headers: HLS_CORS_HEADERS,
                    });
                }

                const username = locals.user?.username;
                if (!username) {
                    return problem('unauthorized', {
                        headers: HLS_CORS_HEADERS,
                    });
                }

                const kickStatus = await checkSessionKickCooldown(username);
                if (kickStatus.kicked) {
                    // problem+json (403 forbidden) with retryAfter; CORS headers
                    // are forwarded so the HLS player can read the error body.
                    return problem('forbidden', {
                        error: `Kicked by admin. Try again in ${kickStatus.remainingSeconds!}s.`,
                        retryAfter: kickStatus.remainingSeconds!,
                        headers: HLS_CORS_HEADERS,
                    });
                }

                // Explicit codec overrides
                const videoCodecOverride = resolveCodecOverride(
                    url.searchParams.get('videoCodec'),
                    ALLOWED_VIDEO_CODEC_OVERRIDES,
                );
                const audioCodecOverride = resolveCodecOverride(
                    url.searchParams.get('audioCodec'),
                    ALLOWED_AUDIO_CODEC_OVERRIDES,
                );
                const planId = url.searchParams.get('plan') ?? undefined;

                // Per-request quality cap (VOD has exactly one HLS variant — no ABR
                // ladder to fall back to on a slow link). Invalid values are
                // silently ignored (parseQualityCapParams), and an empty cap is
                // passed through as undefined so it never appears in job identity
                // comparisons for requests that never asked for one.
                const parsedQualityCap = parseQualityCapParams(url.searchParams);
                const qualityCap = isEmptyQualityCap(parsedQualityCap)
                    ? undefined
                    : parsedQualityCap;
                // The client's declared channel cap (the `mc:` it sent to /info,
                // which /info bakes into its play_methods URLs). Separate from the
                // quality cap: it caps the audio encode only.
                const maxAudioChannels = parseMaxAudioChannelsParam(url.searchParams);

                // HLS output format overrides (optional — defaults to fMP4 demux EVENT)
                const hlsContainerParam = url.searchParams.get('hlsContainer');
                const hlsAudioModeParam = url.searchParams.get('hlsAudioMode');
                const hlsPlaylistTypeParam = url.searchParams.get('hlsPlaylistType');
                const hlsVersionParam = url.searchParams.get('hlsVersion');
                const hlsAudioTrackParam = url.searchParams.get('hlsAudioTrack');

                const hlsOutputOverride: HlsOutputConfig | undefined =
                    hlsContainerParam ||
                    hlsAudioModeParam ||
                    hlsPlaylistTypeParam ||
                    hlsVersionParam ||
                    hlsAudioTrackParam
                        ? {
                              hlsContainer:
                                  hlsContainerParam === 'mpegts'
                                      ? 'mpegts'
                                      : hlsContainerParam === 'fmp4'
                                        ? 'fmp4'
                                        : undefined,
                              hlsAudioMode:
                                  hlsAudioModeParam === 'muxed'
                                      ? 'muxed'
                                      : hlsAudioModeParam === 'demux'
                                        ? 'demux'
                                        : undefined,
                              hlsPlaylistType:
                                  hlsPlaylistTypeParam === 'vod'
                                      ? 'vod'
                                      : hlsPlaylistTypeParam === 'event'
                                        ? 'event'
                                        : undefined,
                              hlsVersion: (() => {
                                  const parsed = hlsVersionParam
                                      ? parseInt(hlsVersionParam, 10)
                                      : undefined;
                                  return parsed === 3 || parsed === 6 || parsed === 7
                                      ? parsed
                                      : undefined;
                              })(),
                              hlsAudioTrackIndex: (() => {
                                  const parsed = hlsAudioTrackParam
                                      ? parseInt(hlsAudioTrackParam, 10)
                                      : NaN;
                                  return Number.isInteger(parsed) && parsed >= 0
                                      ? parsed
                                      : undefined;
                              })(),
                          }
                        : undefined;

                // Device profile for transcode decisions (e.g. "apple-tv", "chrome")
                const deviceProfileId = url.searchParams.get('deviceProfile') ?? undefined;

                // The muxed master playlist points its EXT-X-STREAM-INF at this same
                // endpoint with `hlsPlaylist=media`, so that request must return the
                // media playlist itself rather than another master.
                const muxedPlaylistKind =
                    url.searchParams.get(MUXED_MEDIA_PLAYLIST_PARAM) === 'media'
                        ? ('media' as const)
                        : undefined;

                const seekSeconds = parseSeekSeconds(url.searchParams);
                const seekParam = url.searchParams.get('seek');

                const requestedEdition = url.searchParams.get('edition') ?? undefined;
                const requestedFileId = url.searchParams.get('fileId') ?? undefined;

                // Subtitle burn-in
                const subStreamIdx = url.searchParams.get('SubtitleStreamIndex');
                const subMethod = url.searchParams.get('SubtitleMethod');
                const subIdx = subStreamIdx !== null ? parseInt(subStreamIdx, 10) : NaN;
                const subtitleBurnIn =
                    !Number.isNaN(subIdx) && subIdx >= 0 && subMethod === 'Encode'
                        ? { streamIndex: subIdx, method: subMethod }
                        : undefined;

                // Use the client-provided PlaySessionId so retries and preview
                // sessions attach to the same transcode job. Preview session IDs
                // are not plain UUIDs, so accept any safe token instead of
                // forcing a UUID-only format. A malformed id is substituted with
                // a fresh one rather than rejected — see session-id-resolution.ts.
                const syntheticSessionId = resolvePlaySessionId(
                    url.searchParams.get('PlaySessionId'),
                    randomUUID,
                );

                // Client's stable device UUID, used only for the stream-policy ghost
                // exclusion (see HlsPlaybackRequest.policyDeviceId). Absence is handled
                // gracefully — enforcement still runs, just without the device exclusion.
                const rawDeviceId = url.searchParams.get('deviceId');
                const policyDeviceId =
                    rawDeviceId && SAFE_DEVICE_ID_RE.test(rawDeviceId) ? rawDeviceId : undefined;

                const { segmentBase, segmentParams } = buildHlsSegmentUrlParts(
                    base,
                    internalId,
                    syntheticSessionId,
                    locals,
                    seekParam,
                    deviceProfileId,
                    qualityCap,
                    maxAudioChannels,
                );

                try {
                    const result = await startHlsPlayback({
                        sql,
                        itemId: internalId,
                        username,
                        deviceId: 'lumastra-player',
                        userId: locals.user?.userId,
                        ipAddress: getClientIpFromRequest(request, getClientAddress),
                        policyDeviceId,
                        playSessionId: syntheticSessionId,
                        hlsOutput: hlsOutputOverride,
                        videoCodec: videoCodecOverride,
                        audioCodec: audioCodecOverride,
                        planId,
                        seekSeconds,
                        qualityCap,
                        maxAudioChannels,
                        fileId: requestedFileId,
                        edition: requestedEdition,
                        subtitleBurnIn,
                        segmentBase,
                        segmentParams,
                        deviceProfileId,
                        muxedPlaylistKind,
                        userAgent: request.headers.get('User-Agent') ?? undefined,
                        // The web player (this route without /v1) renders subtitles
                        // from its own <track> elements; see omitManifestSubtitles.
                        omitManifestSubtitles: !url.pathname.startsWith(`${base}/api/v1/`),
                    });

                    return new Response(result.playlistBody, {
                        status: 200,
                        headers: {
                            ...result.headers,
                            'Content-Type': result.contentType,
                        },
                    });
                } catch (err) {
                    if (err instanceof HlsPlaybackError) {
                        const errorCode = getStructuredPlaybackErrorCode(err);
                        const diagnosticHeaders = buildExplicitStreamDiagnosticHeaders(
                            getPublicHlsDiagnosticCode({
                                statusCode: err.statusCode,
                                errorCode,
                            }),
                        );
                        const diagnosticId = diagnosticHeaders['X-Lumastra-Diagnostic-Id'];
                        if (diagnosticId) {
                            logger.warn('Emitting stream diagnostic header', {
                                code: diagnosticHeaders['X-Lumastra-Diagnostic-Code'],
                                diagnosticId,
                                statusCode: err.statusCode,
                                route: 'manifest',
                            });
                        }
                        // problem+json like every other /api/v1 error; a structured
                        // startup failure keeps its machine code in `reason`.
                        const detail = getPlaybackErrorDetail(err);
                        return problem(codeForStatus(err.statusCode), {
                            status: err.statusCode,
                            error: detail.text,
                            ...(detail.retryAfter !== undefined
                                ? { retryAfter: detail.retryAfter }
                                : {}),
                            ...(errorCode ? { reason: errorCode } : {}),
                            headers: {
                                ...HLS_CORS_HEADERS,
                                ...diagnosticHeaders,
                                // Retry-After etc.; never let them reset the problem+json type.
                                ...Object.fromEntries(
                                    Object.entries(err.retryHeaders ?? {}).filter(
                                        ([name]) => name.toLowerCase() !== 'content-type',
                                    ),
                                ),
                            },
                        });
                    }
                    throw err;
                }
            }),
        ),
    ),
);

/**
 * OPTIONS for CORS preflight
 */
export const OPTIONS: RequestHandler = async () => {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Authorization, X-Emby-Token',
            'Access-Control-Max-Age': '86400',
        },
    });
};
