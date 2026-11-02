// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Audio HLS on the /j surface (DynamicHlsController's audio routes):
 *
 *   GET /Audio/{itemId}/master.m3u8  → master playlist, one AAC variant → main.m3u8
 *   GET /Audio/{itemId}/main.m3u8    → VOD media playlist (starts the transcode)
 *   GET /Audio/{itemId}/hls1/{playlistId}/{segment} → segments
 *
 * The transcode is the HLS engine's audio-only rung (`videoCodec: 'none'`,
 * `buildAudioOnlyArgs`: AAC stereo in MPEG-TS), the same rung Lumastra's own
 * player uses. Like `/Videos/{itemId}/master.m3u8` the media playlist is
 * pre-generated from the runtime, so the response does not wait for FFmpeg;
 * its segment URIs are moved from the video segment route to `hls1/main/` so
 * the whole ladder stays under `/Audio/{itemId}`.
 *
 * As in Jellyfin, the master does no work: it validates the request and points
 * at main.m3u8 with the same query, so the transcode starts once, on main.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { config, features } from '$lib/server/config';
import { getMediaItemById } from '$lib/server/database/queries/catalog-operations.queries';
import { parseSeekSeconds } from '$lib/server/utils/hls-request-utils';
import { startHlsPlayback, HlsPlaybackError } from '$lib/server/services/hls/playback.service';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service';
import { getClientIp } from '$lib/server/utils/client-ip';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries';
import { JELLYFIN_COMPAT_DEVICE_ID } from '$lib/server/services/transcoding/session-key';
import { MAX_MAX_AUDIO_CHANNELS } from '$lib/server/services/transcoding/quality-cap';
import { validatePlayToken } from './play-token';
import { jellyfinCompatDeviceId } from './playback-utils';
import { disarmSilentStart } from './silent-start';
import { getJfToken, getParam } from './utils';

const logger = Logger.for('JellyfinCompat:AudioHls');

/** The audio-only rung's fixed encode (`buildAudioOnlyArgs`: AAC-LC 128k stereo). */
const AUDIO_HLS_BANDWIDTH = 128_000;
const AUDIO_HLS_CODECS = 'mp4a.40.2';

const HLS_HEADERS = {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
};

/** Where main.m3u8's segment URIs point; `main` is the Jellyfin playlistId. */
export function audioSegmentBase(itemId: string): string {
    return `/j/Audio/${itemId}/hls1/main`;
}

/**
 * The pre-generated VOD playlist lists its segments under the video segment
 * route (`/j/Videos/{id}/hls/`); move them under `/j/Audio/{id}/hls1/main/`.
 * Both routes serve the same job — this only keeps the URLs Jellyfin-shaped.
 */
export function rewriteSegmentUris(playlist: string, itemId: string): string {
    return playlist.split(`/j/Videos/${itemId}/hls/`).join(`${audioSegmentBase(itemId)}/`);
}

/**
 * The master playlist: one audio-only variant pointing at main.m3u8 with the
 * request's own query (and the session token, for players that do not send
 * auth headers on follow-up requests). Pure; exported for tests.
 */
export function buildAudioMasterPlaylist(query: URLSearchParams, apiKey: string): string {
    const params = new URLSearchParams(query);
    if (apiKey && !params.has('api_key') && !params.has('ApiKey')) params.set('api_key', apiKey);
    const qs = params.toString();
    return [
        '#EXTM3U',
        `#EXT-X-STREAM-INF:BANDWIDTH=${AUDIO_HLS_BANDWIDTH},AVERAGE-BANDWIDTH=${AUDIO_HLS_BANDWIDTH},CODECS="${AUDIO_HLS_CODECS}"`,
        `main.m3u8${qs ? `?${qs}` : ''}`,
        '',
    ].join('\n');
}

/** MediaSourceId → a media_files id of this item (raw UUID or a play-token). */
async function mediaSourceFileId(raw: string | null): Promise<string | undefined> {
    const value = raw?.trim();
    if (!value) return undefined;
    if (isUuid(value)) return normalizeUuid(value);
    return (await validatePlayToken(value))?.fileId ?? undefined;
}

/** `MaxAudioChannels` / `TranscodingMaxAudioChannels`: the tighter one wins. */
function channelCap(url: URL): number | undefined {
    const caps = ['TranscodingMaxAudioChannels', 'MaxAudioChannels', 'AudioChannels']
        .map((name) => getParam(url, name)?.trim() ?? '')
        .filter((raw) => /^\d+$/.test(raw))
        .map(Number)
        .filter((n) => n > 0);
    return caps.length > 0 ? Math.min(...caps, MAX_MAX_AUDIO_CHANNELS) : undefined;
}

/** Checks shared by master and main; a Response means stop and send it. */
async function preflight(event: RequestEvent): Promise<{ itemId: string } | Response> {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const raw = (event.params as { itemId?: string }).itemId?.trim();
    if (!raw) return ApiResponses.badRequest('Item ID is required');
    if (!isUuid(raw)) return ApiResponses.notFound('Media');
    const itemId = normalizeUuid(raw);
    if (!features.ffmpegAvailable) {
        return new Response('HLS transcoding is not enabled', { status: 503 });
    }
    if (!(await checkMediaAccess(sql, itemId, event.locals.user))) {
        return ApiResponses.notFound('Media');
    }
    const username = event.locals.user?.username;
    if (username) {
        const kick = await checkSessionKickCooldown(username);
        if (kick.kicked) return ApiResponses.kicked(kick.remainingSeconds!);
    }
    void disarmSilentStart({
        playSessionId: getParam(event.url, 'PlaySessionId'),
        username: username ?? null,
        itemId,
        userId: event.locals.user?.userId ?? null,
        deviceId: event.locals.jfDevice?.deviceId ?? null,
    });
    return { itemId };
}

export async function handleAudioMasterPlaylist(event: RequestEvent): Promise<Response> {
    const checked = await preflight(event);
    if (checked instanceof Response) return checked;
    const sql = getDb()!;
    // A track with no file has nothing to transcode: answer now, not on main.
    const files = await getFilesForMediaItem(sql, checked.itemId);
    if (files.length === 0) return ApiResponses.notFound('Media');
    const apiKey = getJfToken(event.locals as unknown as Record<string, unknown>);
    return new Response(buildAudioMasterPlaylist(event.url.searchParams, apiKey), {
        status: 200,
        headers: HLS_HEADERS,
    });
}

export async function handleAudioMediaPlaylist(event: RequestEvent): Promise<Response> {
    const checked = await preflight(event);
    if (checked instanceof Response) return checked;
    const { itemId } = checked;
    const { url } = event;
    const sql = getDb()!;

    try {
        const playSessionId = getParam(url, 'PlaySessionId') ?? randomUUID().replace(/-/g, '');
        const audioIndexRaw = getParam(url, 'AudioStreamIndex');
        const audioStreamIndex =
            audioIndexRaw !== null && /^\d+$/.test(audioIndexRaw.trim())
                ? parseInt(audioIndexRaw, 10)
                : undefined;

        // A version only matters when the track has several files.
        const files = await getFilesForMediaItem(sql, itemId);
        const requestedFile = await mediaSourceFileId(getParam(url, 'MediaSourceId'));
        const picked = requestedFile ? files.find((f) => f.id === requestedFile) : undefined;
        const fileId = files.length > 1 || (requestedFile && !picked) ? requestedFile : undefined;
        const pickedDuration = Number(picked?.duration_seconds);

        const mediaItem = await getMediaItemById(sql, itemId);
        const durationOverride =
            files.length > 1 && Number.isFinite(pickedDuration) && pickedDuration > 0
                ? pickedDuration
                : mediaItem &&
                    'runtime_seconds' in mediaItem &&
                    typeof mediaItem.runtime_seconds === 'number'
                  ? mediaItem.runtime_seconds
                  : undefined;

        const apiKey =
            getJfToken(event.locals as unknown as Record<string, unknown>) ||
            (getParam(url, 'api_key') ?? '');
        const segmentParams = new URLSearchParams();
        segmentParams.set('PlaySessionId', playSessionId);
        if (apiKey) segmentParams.set('api_key', apiKey);

        const seekSeconds = parseSeekSeconds(url.searchParams) ?? 0;
        const userId = event.locals.user?.userId;
        const result = await startHlsPlayback({
            sql,
            itemId,
            username: event.locals.user?.username ?? 'unknown',
            deviceId: JELLYFIN_COMPAT_DEVICE_ID,
            userId,
            ipAddress: getClientIp(event),
            policyDeviceId: userId
                ? jellyfinCompatDeviceId(event.locals.jfDevice?.deviceId, userId)
                : undefined,
            policyMediaId: itemId,
            playSessionId,
            hlsOutput: { hlsContainer: 'mpegts', hlsAudioMode: 'muxed', hlsPlaylistType: 'vod' },
            videoCodec: 'none',
            seekSeconds: seekSeconds > 0 ? seekSeconds : undefined,
            fileId,
            audioStreamIndex,
            maxAudioChannels: channelCap(url),
            segmentBase: audioSegmentBase(itemId),
            segmentParams,
            muxedPlaylistKind: 'media',
            durationOverride,
            preGenerateVod: true,
            segmentDuration:
                config.FFMPEG_SEGMENT_DURATION > 0 ? config.FFMPEG_SEGMENT_DURATION : 6,
            apiKey: apiKey || undefined,
        });

        let content = rewriteSegmentUris(result.playlistBody, itemId);
        if (content.includes('#EXT-X-ENDLIST')) {
            content = content.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
        }
        return new Response(content, { status: 200, headers: HLS_HEADERS });
    } catch (err) {
        if (err instanceof HlsPlaybackError) {
            if (err.statusCode === 404) return ApiResponses.notFound(err.message);
            return new Response(err.message, {
                status: err.statusCode,
                headers: err.retryHeaders,
            });
        }
        logger.error('Failed to generate audio HLS playlist', undefined, { itemId, error: err });
        return ApiResponses.error('Failed to generate audio HLS playlist');
    }
}
