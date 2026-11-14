// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /Audio/{itemId}/stream.{container}` (AudioController.GetAudioStreamByContainer).
 *
 * - `static=true` → the original file, exactly like `/Audio/{itemId}/stream`
 *   (play-token auth, the kick cooldown; see audio-stream.ts).
 * - A clean direct match → the original file (`handleStreamFile`): the file
 *   (the one `MediaSourceId` names, else the default) is in the requested
 *   container AND carries the codec that container means (universal-audio.ts
 *   `isCleanDirectMatch`: `stream.opus` is never a Vorbis .ogg, `stream.m4a`
 *   never ALAC), no bitrate cap below the source's bitrate, no start offset.
 * - Otherwise mp3 / aac / m4a|mp4 / ogg|opus → a progressive encode through the
 *   music transcode service (`streamMusicProgressive`, shared with
 *   `/Audio/{itemId}/universal`): cached, range-capable once encoded, counted
 *   against the music transcode concurrency cap.
 * - With music transcoding switched off (FEATURE_MUSIC_TRANSCODE), or for a
 *   container the service cannot produce (flac, wav, …), a clean direct match
 *   is served as-is even with a start offset (the player seeks), and anything
 *   else is a 415: a progressive URL cannot fall back to HLS.
 * - A user inside a kick cooldown gets a 403 on every branch.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { getDb } from '$lib/server/database';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';
import {
    clampBitrate,
    defaultBitrateFor,
    containerFor,
} from '$lib/server/services/music-transcode/index';
import type { UserContext } from '$lib/server/types';
import { describeAudioSource, pickAudioFile } from './audio-source';
import { kickedResponse } from './audio-stream';
import { streamMusicProgressive } from './music-progressive';
import { disarmSilentStart } from './silent-start';
import { handleStreamFile } from './stream-file-handler';
import { isCleanDirectMatch, musicCodecForContainer } from './universal-audio';
import { getParam } from './utils';

const logger = Logger.for('JellyfinCompat:AudioStreamContainer');

/** `stream.MP3` / `stream.mp3` → `mp3`; null for anything not a plain token. */
export function normalizeContainer(raw: string | undefined): string | null {
    const value = raw?.trim().toLowerCase() ?? '';
    return /^[a-z0-9]{1,8}$/.test(value) ? value : null;
}

/** Bitrate cap in kbps from `AudioBitRate` / `MaxStreamingBitrate` (bps), if any. */
export function requestedKbps(url: URL): number | null {
    const caps = ['AudioBitRate', 'MaxStreamingBitrate']
        .map((name) => getParam(url, name)?.trim() ?? '')
        .filter((raw) => /^\d+$/.test(raw))
        .map((raw) => Math.round(Number(raw) / 1000))
        .filter((kbps) => kbps > 0);
    return caps.length > 0 ? Math.min(...caps) : null;
}

/** `StartTimeTicks` → whole seconds. */
function startSeconds(url: URL): number {
    const raw = getParam(url, 'StartTimeTicks')?.trim() ?? '';
    return /^\d+$/.test(raw) ? Math.floor(Number(raw) / 10_000_000) : 0;
}

function unsupported(message: string): Response {
    return new Response(JSON.stringify({ error: message }), {
        status: 415,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * The non-static branches: a clean direct match or a progressive encode.
 * Session only — the route file wraps it in `withJellyfinAuth(…, { pat: 'deny' })`.
 */
export async function serveAudioStreamByContainer(
    event: RequestEvent,
    container: string,
): Promise<Response> {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const raw = (event.params as { itemId?: string }).itemId?.trim() ?? '';
    if (!isUuid(raw)) return ApiResponses.notFound('Media');
    const trackId = normalizeUuid(raw);
    const user = event.locals.user as UserContext;

    // Library + age gate; 404 so a hidden track's existence doesn't leak.
    if (!(await checkMediaAccess(sql, trackId, user))) return ApiResponses.notFound('Media');
    const kicked = await kickedResponse(user.username);
    if (kicked) return kicked;

    const file = await pickAudioFile(sql, trackId, getParam(event.url, 'MediaSourceId'));
    if (!file) return ApiResponses.notFound('Media');
    const source = await describeAudioSource(sql, file);

    const kbps = requestedKbps(event.url);
    const timeOffset = startSeconds(event.url);
    const clean = isCleanDirectMatch(container, source.container, source.codec);
    // A cap only matters below the source: clients send e.g. 140000000 as "no limit".
    const underCap = kbps === null || source.bitrate === null || source.bitrate <= kbps * 1000;
    const transcodeOn = config.FEATURE_MUSIC_TRANSCODE;
    // The codec a progressive encode would produce; null for flac, wav, …
    const codec = musicCodecForContainer(container);

    // A start offset needs an encode, unless none is possible (transcoding
    // off, or a container the service cannot produce): then the clean file
    // goes out as-is and the player seeks, rather than a 415 for a file it
    // can play.
    if (clean && underCap && (timeOffset === 0 || !transcodeOn || !codec)) {
        // The exact file judged above, whatever spelling the client used.
        event.url.searchParams.delete('MediaSourceId');
        event.url.searchParams.set('mediaSourceId', file.id);
        void disarmSilentStart({
            playSessionId: getParam(event.url, 'PlaySessionId'),
            username: user.username ?? null,
            itemId: trackId,
            userId: user.userId ?? null,
            deviceId: event.locals.jfDevice?.deviceId ?? null,
        });
        return handleStreamFile(event);
    }

    if (!transcodeOn) {
        return unsupported(
            'This file is not a direct match for the requested container and music transcoding is off',
        );
    }
    if (!codec) return unsupported(`Transcoding to "${container}" is not supported`);
    const bitrateKbps = clampBitrate(codec, kbps ?? defaultBitrateFor(codec));

    const pathInfo = await resolveMediaPath(file.file_path, { skipLocalAccessCheck: true }, sql);
    if (!pathInfo?.isAccessible) {
        logger.warn('Audio source unavailable', { trackId, reason: pathInfo?.reason });
        return ApiResponses.serviceUnavailable('Media file is not reachable right now');
    }

    void disarmSilentStart({
        playSessionId: getParam(event.url, 'PlaySessionId'),
        username: user.username ?? null,
        itemId: trackId,
        userId: user.userId ?? null,
        deviceId: event.locals.jfDevice?.deviceId ?? null,
    });

    return streamMusicProgressive(event, sql, {
        itemId: trackId,
        sourcePath: pathInfo.containerPath,
        codec,
        bitrateKbps,
        timeOffset,
        headers: {
            'X-Audio-Codec': codec,
            'X-Audio-Container': containerFor(codec),
            'X-Audio-Bitrate-Kbps': String(bitrateKbps),
            'Access-Control-Allow-Origin': '*',
        },
    });
}

/** `Static=true`: the original bytes whatever the extension says (Jellyfin does the same). */
export function isStaticAudioRequest(url: URL): boolean {
    return (getParam(url, 'Static') ?? '').toLowerCase() === 'true';
}
