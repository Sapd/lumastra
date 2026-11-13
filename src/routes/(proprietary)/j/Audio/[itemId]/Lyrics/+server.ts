// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Compat: track lyrics (LyricsController).
 *
 * GET    /Audio/{itemId}/Lyrics             → LyricDto, 404 when the track has none
 * POST   /Audio/{itemId}/Lyrics?fileName=x  → store the request body as the track's
 *                                             lyrics (.lrc = synced, else plain)
 * DELETE /Audio/{itemId}/Lyrics             → 204, 404 when there was nothing to delete
 *
 * Lyrics are served from what Lumastra already stored (`readStoredLyrics`, never
 * LRCLIB on the request path). Writes need lyric management, which /j grants
 * admins only (`Policy.EnableLyricManagement = is_admin`), like Jellyfin's
 * `LyricManagement` policy. A delete stores the "looked, none" marker, so the
 * background LRCLIB task does not fetch the lyrics straight back.
 */

import { BODY_TOO_LARGE, readBoundedBodyText } from '$lib/server/utils/bounded-body-reader';
import { json, type RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { toJellyfinLyricDto } from '$lib/server/proprietary/jellyfin-compat/lyrics-dto';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getTrackDetail, type TrackDetailRow } from '$lib/server/database/queries/music.queries.js';
import {
    readStoredLyrics,
    saveUserLyrics,
    type ResolvedLyrics,
} from '$lib/server/services/music/lyrics.service.js';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('JellyfinCompat:Lyrics');

/** 256 KiB: an LRC file for the longest track is a few KiB. */
const MAX_LYRICS_BYTES = 256 * 1024;

/** The track behind the route, or the response to send instead. */
async function loadTrack(event: RequestEvent): Promise<TrackDetailRow | Response> {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const raw = (event.params as { itemId?: string }).itemId?.trim() ?? '';
    if (!raw) return ApiResponses.badRequest('Item ID is required');
    if (!isUuid(raw)) return ApiResponses.notFound('Item not found');
    const itemId = normalizeUuid(raw);
    if (!(await checkMediaAccess(sql, itemId, event.locals.user))) {
        return ApiResponses.notFound('Item not found');
    }
    const track = await getTrackDetail(sql, itemId);
    return track ?? ApiResponses.notFound('Item not found');
}

function lyricDtoFor(
    track: TrackDetailRow,
    stored: ResolvedLyrics | null = readStoredLyrics(track),
): ReturnType<typeof toJellyfinLyricDto> {
    if (!stored) return null;
    return toJellyfinLyricDto(stored, {
        title: track.title,
        artist: track.track_artist_title ?? track.artist_title,
        album: track.album_title,
        runtimeSeconds: track.runtime_seconds,
    });
}

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    try {
        const track = await loadTrack(event);
        if (track instanceof Response) return track;
        const dto = lyricDtoFor(track);
        return dto ? json(dto) : ApiResponses.notFound('Lyrics not found');
    } catch (error) {
        logger.error('Failed to load lyrics', error as Error, { itemId: event.params.itemId });
        return ApiResponses.error('Failed to load lyrics');
    }
});

export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        if (!localsIsAdmin(event.locals))
            return ApiResponses.forbidden('Lyric management required');
        const fileName = getParam(event.url, 'FileName')?.trim();
        if (!fileName) return ApiResponses.badRequest('fileName is required');
        try {
            const track = await loadTrack(event);
            if (track instanceof Response) return track;
            const declared = Number(event.request.headers.get('content-length') ?? '0');
            if (declared > MAX_LYRICS_BYTES) return ApiResponses.payloadTooLarge();
            const body = await readBoundedBodyText(event.request, MAX_LYRICS_BYTES);
            if (body === BODY_TOO_LARGE) return ApiResponses.payloadTooLarge();
            if (!body.trim()) return ApiResponses.badRequest('Lyrics body is empty');
            const synced = /\.(e?lrc)$/i.test(fileName);
            const lyrics = {
                plain: synced ? null : body,
                synced: synced ? body : null,
                source: 'user',
                fetchedAt: new Date().toISOString(),
            };
            // Validate first: an .lrc with no timed lines must not replace what
            // the track has and then be reported as an error.
            const dto = lyricDtoFor(track, lyrics);
            if (!dto) return ApiResponses.badRequest('No lyric lines found in the uploaded file');
            await saveUserLyrics(getDb()!, track.id, {
                ...lyrics,
                format: synced ? 'lrc' : 'plain',
            });
            logger.info('Lyrics uploaded via /j', {
                username: event.locals.user?.username,
                trackId: track.id,
                synced,
            });
            return json(dto);
        } catch (error) {
            logger.error('Failed to upload lyrics', error as Error, {
                itemId: event.params.itemId,
            });
            return ApiResponses.error('Failed to upload lyrics');
        }
    },
    { mode: 'write' },
);

export const DELETE: RequestHandler = withJellyfinAuth(
    async (event) => {
        if (!localsIsAdmin(event.locals))
            return ApiResponses.forbidden('Lyric management required');
        try {
            const track = await loadTrack(event);
            if (track instanceof Response) return track;
            if (!readStoredLyrics(track)) return ApiResponses.notFound('Lyrics not found');
            await saveUserLyrics(getDb()!, track.id, {
                plain: null,
                synced: null,
                source: 'user',
                fetchedAt: new Date().toISOString(),
            });
            logger.info('Lyrics deleted via /j', {
                username: event.locals.user?.username,
                trackId: track.id,
            });
            return new Response(null, { status: 204 });
        } catch (error) {
            logger.error('Failed to delete lyrics', error as Error, {
                itemId: event.params.itemId,
            });
            return ApiResponses.error('Failed to delete lyrics');
        }
    },
    { mode: 'write' },
);
