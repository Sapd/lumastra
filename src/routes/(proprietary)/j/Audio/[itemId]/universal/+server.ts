// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin Compat: Universal Audio
 *
 * GET|HEAD /Audio/{itemId}/universal (Jellyfin UniversalAudioController). The
 * client says what it can play (`container=…`, `maxStreamingBitrate`, …) and
 * the server picks the delivery — see `universal-audio.ts` for the decision.
 * Callers: Finamp, jellyfin-web's audio player, the Jellyfin Kotlin SDK
 * (`universalAudioApi`).
 *
 * - Direct play: the file through `handleStreamFile` (200/206, byte ranges),
 *   exactly what `/Audio/{id}/stream` serves.
 * - `transcodingProtocol=hls`: the HLS master playlist itself (200,
 *   `application/vnd.apple.mpegurl`), as Jellyfin answers — produced by our
 *   `/Videos/{id}/master.m3u8` route, the same one PlaybackInfo's audio
 *   TranscodingUrl names. Its segment URLs are absolute (`/j/Videos/{id}/hls/…`),
 *   so they resolve from this URL too.
 * - Otherwise a progressive transcode through the music transcode service
 *   (mp3 / AAC / m4a / Opus; byte ranges honoured, like the native music
 *   stream), shared with /Audio/{id}/stream.{container} (music-progressive.ts).
 *   Its id carries the `player:` prefix: the Jellyfin client reports the
 *   listen itself via /Sessions/Playing, so this must not open a second
 *   play_sessions row. With music transcoding off, the HLS path is used; with
 *   FFmpeg missing too, a file that is not a clean direct-play match is a 415.
 *
 * HEAD answers the decision's headers without starting a transcode.
 * Remote/redirected sources do not exist in Lumastra, so `enableRedirection` /
 * `enableRemoteMedia` have nothing to act on. `userId` is ignored: like every
 * /j route this acts for the signed-in user.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleStreamFile } from '$lib/server/proprietary/jellyfin-compat/stream-file-handler';
import { disarmSilentStart } from '$lib/server/proprietary/jellyfin-compat/silent-start';
import { getJfToken } from '$lib/server/proprietary/jellyfin-compat/utils';
import {
    describeAudioSource,
    pickAudioFile,
} from '$lib/server/proprietary/jellyfin-compat/audio-source';
import {
    decideUniversalAudio,
    parseUniversalAudioRequest,
    type UniversalAudioDecision,
    type UniversalAudioRequest,
} from '$lib/server/proprietary/jellyfin-compat/universal-audio';
import { getDb } from '$lib/server/database';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import type { MediaFileRow } from '$lib/server/database/queries/media-files.queries';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { config, features } from '$lib/server/config';
import {
    clampBitrate,
    defaultBitrateFor,
    mimeFor,
} from '$lib/server/services/music-transcode/index';
import { validatePlayToken } from '$lib/server/proprietary/jellyfin-compat/play-token';
import { isStreamLimitRequestBanned } from '$lib/server/proprietary/jellyfin-compat/stream-limit-access';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service';
import { streamMusicProgressive } from '$lib/server/proprietary/jellyfin-compat/music-progressive';

const logger = Logger.for('JellyfinCompat:UniversalAudio');

type Sql = NonNullable<ReturnType<typeof getDb>>;

/**
 * Music transcoding off: a file that is not a clean direct-play match (container,
 * codec AND limits — decideUniversalAudio already said so) goes to HLS when
 * FFmpeg is there; without FFmpeg nothing here can make it playable → null (415).
 * Serving it anyway on a merely listed container handed out ALAC for `m4a|aac`
 * and 24/192 FLAC past maxAudioSampleRate.
 */
function deliverable(
    decision: UniversalAudioDecision,
    req: UniversalAudioRequest,
): UniversalAudioDecision | null {
    if (decision.kind !== 'progressive' || config.FEATURE_MUSIC_TRANSCODE) return decision;
    if (!features.ffmpegAvailable) return null;
    return { kind: 'hls', audioCodec: req.audioCodec ?? 'aac' };
}

/**
 * Headers the master.m3u8 sub-request carries over: auth, and the client-IP
 * headers. Without the latter its getClientIp saw only the sub-request, so the
 * stream policy and caps were recorded against the proxy. Whether they are
 * trusted is still decided by the same peer (TRUSTED_PROXY_IPS).
 */
const FORWARDED_HEADERS = [
    'authorization',
    'x-emby-authorization',
    'x-emby-token',
    'x-mediabrowser-token',
    'x-forwarded-for',
    'x-real-ip',
    'forwarded',
];

/** The HLS master playlist from /Videos/{id}/master.m3u8, answered in place. */
async function serveHlsMaster(
    event: RequestEvent,
    itemId: string,
    file: MediaFileRow,
    req: UniversalAudioRequest,
    audioCodec: string,
    isHead: boolean,
): Promise<Response> {
    const headers = {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
    };
    if (isHead) return new Response(null, { status: 200, headers });

    const params = new URLSearchParams({ MediaSourceId: file.id, AudioCodec: audioCodec });
    // Only the client's own id: without one, master.m3u8 mints its own — and
    // its silent-start disarm must never act on an id we invented.
    if (req.playSessionId) params.set('PlaySessionId', req.playSessionId);
    if (req.maxStreamingBitrate) {
        params.set('MaxStreamingBitrate', String(req.maxStreamingBitrate));
    }
    if (req.startTimeTicks > 0) params.set('StartTimeTicks', String(req.startTimeTicks));
    if (req.transcodingAudioChannels) {
        params.set('TranscodingMaxAudioChannels', String(req.transcodingAudioChannels));
    }
    if (req.maxAudioChannels) params.set('MaxAudioChannels', String(req.maxAudioChannels));
    const apiKey = getJfToken(event.locals as unknown as Record<string, unknown>);
    if (apiKey) params.set('api_key', apiKey);

    // This route's own mount prefix (`/j`), so the sub-request hits the sibling route.
    const path = event.url.pathname;
    const prefix = path.slice(0, path.toLowerCase().lastIndexOf('/audio/'));
    const forward = new Headers();
    for (const name of FORWARDED_HEADERS) {
        const value = event.request.headers.get(name);
        if (value) forward.set(name, value);
    }
    const res = await event.fetch(`${prefix}/Videos/${itemId}/master.m3u8?${params}`, {
        headers: forward,
    });
    if (!res.ok) return res;
    return new Response(await res.text(), { status: 200, headers });
}

async function serveProgressive(
    event: RequestEvent,
    sql: Sql,
    itemId: string,
    file: MediaFileRow,
    req: UniversalAudioRequest,
    decision: Extract<UniversalAudioDecision, { kind: 'progressive' }>,
    isHead: boolean,
): Promise<Response> {
    const { codec } = decision;
    const contentType = mimeFor(codec);
    if (isHead) {
        return new Response(null, {
            status: 200,
            headers: { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' },
        });
    }

    const pathInfo = await resolveMediaPath(file.file_path, { skipLocalAccessCheck: true }, sql);
    if (!pathInfo?.isAccessible) {
        return ApiResponses.error(`Media file not accessible: ${pathInfo?.reason ?? 'unknown'}`);
    }
    return streamMusicProgressive(event, sql, {
        itemId,
        sourcePath: pathInfo.containerPath,
        codec,
        bitrateKbps:
            decision.bitrate !== null
                ? clampBitrate(codec, Math.floor(decision.bitrate / 1000))
                : defaultBitrateFor(codec),
        timeOffset: Math.floor(req.startTimeTicks / 10_000_000),
    });
}

async function handleUniversal(event: RequestEvent, isHead: boolean): Promise<Response> {
    const itemId = event.params.itemId ?? '';
    if (!isUuid(itemId)) return ApiResponses.notFound('Media');

    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const user = event.locals.user;
    if (!(await checkMediaAccess(sql, itemId, user))) return ApiResponses.notFound('Media');

    const req = parseUniversalAudioRequest(event.url.searchParams);

    // Fetching the stream means playback is happening: stand the silent-start
    // detector down, as the /Audio/{id}/stream route does.
    void disarmSilentStart({
        playSessionId: req.playSessionId,
        username: user?.username ?? null,
        itemId,
        userId: user?.userId ?? null,
        deviceId: event.locals.jfDevice?.deviceId ?? req.deviceId,
    });

    try {
        const file = await pickAudioFile(sql, itemId, req.mediaSourceId);
        if (!file) return ApiResponses.notFound('Media');

        const source = await describeAudioSource(sql, file);
        const decision = deliverable(decideUniversalAudio(req, source), req);
        if (!decision) {
            return new Response(
                JSON.stringify({
                    error: 'This file cannot be played by the client and transcoding is unavailable',
                }),
                { status: 415, headers: { 'Content-Type': 'application/json' } },
            );
        }
        logger.debug('Universal audio decision', {
            itemId,
            container: source.container,
            codec: source.codec,
            decision: decision.kind,
        });

        if (
            user?.userId &&
            (await isStreamLimitRequestBanned(
                event,
                user.userId,
                req.mediaSourceId
                    ? ((await validatePlayToken(req.mediaSourceId)) ?? undefined)
                    : undefined,
            ))
        ) {
            return ApiResponses.kicked(0);
        }

        // A user inside a kick cooldown gets no new stream. The HLS path is
        // checked by master.m3u8 itself (as the /Videos and /Audio stream routes do).
        if (decision.kind !== 'hls' && user?.username) {
            const kick = await checkSessionKickCooldown(user.username);
            if (kick.kicked) return ApiResponses.kicked(kick.remainingSeconds!);
        }

        switch (decision.kind) {
            case 'direct': {
                // The exact file chosen above, whatever spelling the client used.
                event.url.searchParams.delete('MediaSourceId');
                event.url.searchParams.set('mediaSourceId', file.id);
                const res = await handleStreamFile(event);
                if (!isHead) return res;
                // Same headers, no body: close the file stream it opened.
                await res.body?.cancel().catch(() => undefined);
                return new Response(null, { status: res.status, headers: res.headers });
            }
            case 'hls':
                return await serveHlsMaster(event, itemId, file, req, decision.audioCodec, isHead);
            case 'progressive':
                return await serveProgressive(event, sql, itemId, file, req, decision, isHead);
        }
    } catch (err) {
        logger.error('Universal audio failed', err as Error, { itemId });
        return ApiResponses.error('Failed to stream audio');
    }
}

export const GET: RequestHandler = withJellyfinAuth((event) => handleUniversal(event, false), {
    pat: 'deny',
});
export const HEAD: RequestHandler = withJellyfinAuth((event) => handleUniversal(event, true), {
    pat: 'deny',
});
