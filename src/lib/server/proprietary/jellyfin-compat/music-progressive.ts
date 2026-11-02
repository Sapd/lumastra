// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * A progressive audio encode through the music transcode service, as the /j
 * audio routes serve it: `/Audio/{itemId}/universal` (progressive decision) and
 * `/Audio/{itemId}/stream.{container}` (a container the file is not).
 *
 * The session id carries the `player:` prefix: a Jellyfin client reports the
 * listen itself via /Sessions/Playing, so the encode must not open a second
 * play_sessions row. Byte ranges are honoured (AVPlayer's progressive reader
 * reconnects mid-track with `bytes=N-`; a 200 from byte 0 would replay the
 * start mid-song).
 */

import { stat } from 'node:fs/promises';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getMusicTranscodeService } from '$lib/server/services/music-transcode/index';
import { PLAYER_SESSION_PREFIX } from '$lib/server/services/music-transcode/types';
import type { MusicCodec } from '$lib/server/services/music-transcode/types';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:MusicProgressive');

export interface MusicProgressiveRequest {
    itemId: string;
    /** Resolved, readable path of the source file. */
    sourcePath: string;
    codec: MusicCodec;
    /** Already clamped to the codec's ladder. */
    bitrateKbps: number;
    /** Whole seconds into the track. */
    timeOffset: number;
    /** Extra response headers (e.g. what was encoded). */
    headers?: Record<string, string>;
}

export async function streamMusicProgressive(
    event: RequestEvent,
    sql: postgres.Sql,
    req: MusicProgressiveRequest,
): Promise<Response> {
    const user = event.locals.user;
    const { itemId, codec } = req;
    try {
        const sourceMtimeMs = (await stat(req.sourcePath)).mtimeMs;
        const result = await getMusicTranscodeService(sql).streamFor({
            trackUuid: itemId,
            sourcePath: req.sourcePath,
            sourceMtimeMs,
            codec,
            bitrateKbps: req.bitrateKbps,
            timeOffset: req.timeOffset,
            session: {
                // No play_sessions row: the client reports this listen itself.
                sessionId: `${PLAYER_SESSION_PREFIX}${user.userId}:${itemId}`,
                userId: user.userId,
                deviceId: `jellyfin-${event.locals.jfDevice?.deviceId ?? user.username}`,
                source: 'api',
            },
            abortSignal: event.request.signal,
            rangeHeader: event.request.headers.get('range'),
        });
        return new Response(result.body, {
            status: result.status,
            headers: {
                'Content-Type': result.contentType,
                ...(result.contentLength !== null
                    ? { 'Content-Length': String(result.contentLength) }
                    : {}),
                ...(result.contentRange ? { 'Content-Range': result.contentRange } : {}),
                'Accept-Ranges': result.acceptRanges,
                ...req.headers,
            },
        });
    } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 416) {
            const size = (err as { size?: number }).size;
            return new Response(null, {
                status: 416,
                headers: size !== undefined ? { 'Content-Range': `bytes */${size}` } : {},
            });
        }
        if (status === 415) {
            return new Response('The stored file is not playable audio.', { status: 415 });
        }
        if (status === 503) {
            return new Response('Server busy, try again in a few seconds.', {
                status: 503,
                headers: { 'Retry-After': '5' },
            });
        }
        logger.error('Progressive audio transcode failed', err as Error, { itemId, codec });
        return ApiResponses.error('Transcode failed');
    }
}
