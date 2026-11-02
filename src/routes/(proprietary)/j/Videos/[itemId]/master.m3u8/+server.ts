// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { disarmSilentStart } from '$lib/server/proprietary/jellyfin-compat/silent-start';
import { config, features } from '$lib/server/config';
import { getMediaItemById } from '$lib/server/database/queries/catalog-operations.queries';
import { parseSeekSeconds } from '$lib/server/utils/hls-request-utils';
import { startHlsPlayback, HlsPlaybackError } from '$lib/server/services/hls/playback.service';
import type { HlsOutputConfig } from '$lib/server/services/transcoding/types';
import { randomUUID } from 'node:crypto';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service';
import { getClientIp } from '$lib/server/utils/client-ip';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { resolveMediaSourceFileId } from '$lib/server/proprietary/jellyfin-compat/media-source-id';
import {
    getFilesForMediaItem,
    getOwnerItemForFile,
} from '$lib/server/database/queries/media-files.queries';
import { jellyfinCompatDeviceId } from '$lib/server/proprietary/jellyfin-compat/playback-utils';
import { JELLYFIN_COMPAT_DEVICE_ID } from '$lib/server/services/transcoding/session-key';
import { MAX_MAX_AUDIO_CHANNELS } from '$lib/server/services/transcoding/quality-cap';

const logger = Logger.for('JellyfinCompat:HlsMaster');

/**
 * The version to transcode, from `MediaSourceId`. PlaybackInfo's TranscodingUrl
 * carries the raw media_files id; a client that builds the URL itself sends
 * `MediaSource.Id`, which PlaybackInfo issues as a file token. Unknown values
 * yield undefined (the item's default file). A file that does not belong to the
 * item is refused downstream: resolvePlaybackSelection finds no match → 404.
 */
/**
 * What `MediaSourceId` selects, translated to the engine's options:
 * - a version (one of several files) → `fileId`, and that file's own duration
 *   for the playlist (an extended cut is not the item's runtime);
 * - one part of a multi-part (CD1/CD2) item → the same: just that part. /j
 *   exposes the parts the way Jellyfin does (PartCount + AdditionalParts,
 *   multi-part.ts), so the app plays part 2 as the next item in its queue;
 *   concatenating here played the rest of the movie twice. Only a request
 *   without MediaSourceId still gets the engine's whole-movie concat.
 * - a single-file item → nothing: there is no choice, and a `fileId` forces a
 *   full ffprobe on every master request.
 */
async function versionChoice(
    sql: NonNullable<ReturnType<typeof getDb>>,
    itemId: string,
    fileId: string | undefined,
): Promise<{ fileId?: string; durationSeconds?: number }> {
    if (!fileId) return {};
    const files = await getFilesForMediaItem(sql, itemId);
    const picked = files.find((f) => f.id === fileId);
    // Unknown here (or another item's file): let the engine refuse it (404).
    if (!picked) return { fileId };
    if (files.length < 2) return {};
    const duration = Number(picked.duration_seconds);
    return {
        fileId,
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    };
}

/**
 * File tokens are UUIDs too, so the token is looked up before the value is
 * taken as a raw file id (resolveMediaSourceFileId).
 */
async function mediaSourceFileId(raw: string | null): Promise<string | undefined> {
    return (await resolveMediaSourceFileId(raw)) ?? undefined;
}

export const GET: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { params, url } = event;
        const sql = getDb();
        if (!sql) {
            return ApiResponses.error('Database unavailable');
        }

        const itemId = params.itemId;
        if (!itemId) {
            return ApiResponses.badRequest('Item ID is required');
        }

        if (!features.ffmpegAvailable) {
            return new Response('HLS transcoding is not enabled', {
                status: 503,
            });
        }

        // Library access + age gate
        const allowed = await checkMediaAccess(sql, itemId, event.locals.user);
        if (!allowed) {
            return ApiResponses.notFound('Media');
        }

        const username = event.locals.user?.username ?? 'unknown';
        if (username !== 'unknown') {
            const kickStatus = await checkSessionKickCooldown(username);
            if (kickStatus.kicked) {
                return ApiResponses.kicked(kickStatus.remainingSeconds!);
            }
        }

        // Playback is clearly happening: stand the silent-start detector down.
        // Only the client's own PlaySessionId counts (never the random fallback).
        void disarmSilentStart({
            playSessionId: getParam(url, 'PlaySessionId'),
            username: event.locals.user?.username ?? null,
            itemId,
            userId: event.locals.user?.userId ?? null,
            deviceId: event.locals.jfDevice?.deviceId ?? null,
        });

        try {
            const playSessionId = getParam(url, 'PlaySessionId') ?? randomUUID().replace(/-/g, '');

            const seekSeconds = parseSeekSeconds(url.searchParams) ?? 0;

            // Jellyfin-compatible HLS: MPEG-TS muxed VOD
            const audioStreamIndexStr = getParam(url, 'AudioStreamIndex');
            const audioStreamIndex =
                audioStreamIndexStr !== null ? parseInt(audioStreamIndexStr, 10) : undefined;

            // Subtitle burn-in: Jellyfin clients send SubtitleStreamIndex + SubtitleMethod=Encode
            const subStreamIdxStr = getParam(url, 'SubtitleStreamIndex');
            const subMethodStr = getParam(url, 'SubtitleMethod');
            const subStreamIdx = subStreamIdxStr !== null ? parseInt(subStreamIdxStr, 10) : NaN;
            const subtitleBurnIn =
                !Number.isNaN(subStreamIdx) && subStreamIdx >= 0 && subMethodStr === 'Encode'
                    ? { streamIndex: subStreamIdx, method: subMethodStr }
                    : undefined;

            // Channel cap: PlaybackInfo writes the transcoding profile's
            // MaxAudioChannels as TranscodingMaxAudioChannels; Jellyfin's own
            // stream endpoints also take MaxAudioChannels. The tighter one wins.
            const channelCaps = ['TranscodingMaxAudioChannels', 'MaxAudioChannels']
                .map((name) => getParam(url, name)?.trim() ?? '')
                .filter((raw) => /^\d+$/.test(raw))
                .map(Number)
                .filter((n) => n > 0);
            const maxAudioChannels =
                channelCaps.length > 0
                    ? Math.min(...channelCaps, MAX_MAX_AUDIO_CHANNELS)
                    : undefined;

            // The picked version. Without it every /j transcode used the item's
            // first file — the 2160p pick of a two-version movie played the 1080p
            // file, and a subtitle index that exists only in the 2160p file was
            // "missing", so its burn-in was skipped (prod 2026-10-02).
            const choice = await versionChoice(
                sql,
                itemId,
                await mediaSourceFileId(getParam(url, 'MediaSourceId')),
            );

            const targetVideoCodec = getParam(url, 'VideoCodec') ?? undefined;
            const targetAudioCodec = getParam(url, 'AudioCodec') ?? undefined;

            // API key for segment URL auth (VLC and similar players don't send headers)
            const apiKey =
                ((event.locals as unknown as Record<string, unknown>).jfToken as string) ??
                getParam(url, 'api_key') ??
                '';

            // Fetch runtime from DB to enable pre-generated VOD fast path
            const mediaItem = await getMediaItemById(sql, itemId);
            const durationOverride =
                choice.durationSeconds ??
                (mediaItem &&
                'runtime_seconds' in mediaItem &&
                typeof mediaItem.runtime_seconds === 'number'
                    ? mediaItem.runtime_seconds
                    : undefined);

            // Segment base routes through /j/ HLS segment endpoint so Jellyfin
            // clients can find the segments at the URL they expect
            const segmentBase = `/j/Videos/${itemId}/hls`;
            const segmentParams = new URLSearchParams();
            segmentParams.set('PlaySessionId', playSessionId);
            if (apiKey) {
                segmentParams.set('api_key', apiKey);
            }

            // Audio codec: force transcode unless client explicitly requests copy
            const forceAudioTranscode =
                targetAudioCodec !== undefined && targetAudioCodec.toLowerCase() !== 'copy';

            // Jellyfin-compat defaults — clients can override via query params
            const hlsOutput: HlsOutputConfig = {
                hlsContainer:
                    (url.searchParams.get('hlsContainer') as 'fmp4' | 'mpegts') ?? 'mpegts',
                hlsAudioMode:
                    (url.searchParams.get('hlsAudioMode') as 'demux' | 'muxed') ?? 'muxed',
                hlsPlaylistType:
                    (url.searchParams.get('hlsPlaylistType') as 'event' | 'vod') ?? 'vod',
                hlsVersion: (() => {
                    const parsed = parseInt(url.searchParams.get('hlsVersion') ?? '3', 10);
                    return parsed === 3 || parsed === 6 || parsed === 7 ? parsed : 3;
                })(),
            };

            const policyUserId = event.locals.user?.userId;
            // The DB session findOrCreateJellyfinSession creates stores the OWNING
            // item id as media_id (Sessions/Playing resolves file/version UUIDs via
            // getOwnerItemForFile). This route gets the raw itemId, which for the
            // version picker can be a file UUID — so resolve it the same way, else the
            // ghost exclusion below would miss and 429 the client's own stream.
            // This ownerItemId/policyMediaId resolution is ONLY for the stream-policy
            // check below — the `itemId` passed to startHlsPlayback further down
            // (which becomes `jobConfig.itemId`, the value the job->item binding
            // check compares segment requests against — fix plan 6, C1) is the raw
            // param unchanged. A genuine file/version UUID there 404s at
            // resolvePlaybackSelection (no files owned directly), so it never
            // reaches startJob; it is not a spelling a real job's itemId can hold.
            const ownerItemId = isUuid(itemId) ? await getOwnerItemForFile(sql, itemId) : null;
            const policyMediaId = ownerItemId ?? itemId;
            const result = await startHlsPlayback({
                sql,
                itemId,
                username,
                // Marks the job's PlaySessionId as NOT a play_sessions.id, so its
                // transcode row is persisted without a play_sessions stub.
                deviceId: JELLYFIN_COMPAT_DEVICE_ID,
                // Enforce the per-user stream limit at manifest time. PlaybackInfo does
                // NOT enforce it (only checkMediaAccess + kick-cooldown), and the
                // Sessions/Playing report path is not guaranteed to run before this —
                // so without this a client could start unlimited transcodes by
                // fetching master.m3u8 with fresh PlaySessionIds. policyDeviceId must
                // equal the device_id findOrCreateJellyfinSession stored, so the
                // client's own in-progress session for THIS item is excluded from the
                // count (no self-double-count); other concurrent items/streams still
                // count. Both sites derive it from jellyfinCompatDeviceId() — computing
                // it inline here is what made these two drift, and a miss means the
                // user is counted against themselves and 429s on their own stream.
                userId: policyUserId,
                ipAddress: getClientIp(event),
                policyDeviceId: policyUserId
                    ? jellyfinCompatDeviceId(event.locals.jfDevice?.deviceId, policyUserId)
                    : undefined,
                policyMediaId,
                playSessionId,
                hlsOutput,
                videoCodec:
                    targetVideoCodec === undefined || targetVideoCodec === 'copy'
                        ? 'copy'
                        : targetVideoCodec,
                audioCodec: forceAudioTranscode ? 'aac' : undefined,
                seekSeconds: seekSeconds > 0 ? seekSeconds : undefined,
                fileId: choice.fileId,
                audioStreamIndex,
                maxAudioChannels,
                subtitleBurnIn,
                segmentBase,
                segmentParams,
                durationOverride,
                preGenerateVod: true,
                segmentDuration:
                    config.FFMPEG_SEGMENT_DURATION > 0 ? config.FFMPEG_SEGMENT_DURATION : 6,
                apiKey: apiKey || undefined,
            });

            // Pre-gen VOD path: generateVodPlaylist already embeds /j/Videos/... URLs.
            // Fallback (wait-for-playlist) path: service rewrites segments using segmentBase
            // so URLs are already /j/Videos/{itemId}/hls/{segment}?PlaySessionId=...
            //
            // Apply EVENT → VOD upgrade for the fallback path when transcode is complete.
            // Pre-gen playlists already have VOD type so this is a no-op for them.
            let content = result.playlistBody;
            if (content.includes('#EXT-X-ENDLIST')) {
                content = content.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
            }

            return new Response(content, {
                status: 200,
                headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache',
                },
            });
        } catch (err) {
            if (err instanceof HlsPlaybackError) {
                if (err.statusCode === 404) {
                    return ApiResponses.notFound(err.message);
                }
                return new Response(err.message, {
                    status: err.statusCode,
                    headers: err.retryHeaders,
                });
            }
            logger.error('Failed to generate HLS master playlist', undefined, {
                itemId,
                error: err,
            });
            return ApiResponses.error('Failed to generate HLS master playlist');
        }
    },
    { pat: 'deny' },
);
