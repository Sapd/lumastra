// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Stream Handlers
// File streaming, download, cover art, and lyrics-by-song-id.

import {
    createNoFollowReadStream,
    resolveContainedMediaFile,
} from '$lib/server/utils/contained-fs.js';
import { stat as fsStat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, extname } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { subsonicError, subsonicOk } from '$lib/server/subsonic-compat/serializers/response.js';
import type { SubsonicAuthContext, SubsonicHandler } from '$lib/server/subsonic-compat/types.js';
import { getParam } from '$lib/server/subsonic-compat/helpers.js';
import {
    MAX_STREAM_FILE_SIZE,
    AUDIO_MIME_TYPES,
    CORS_HEADERS,
} from '$lib/server/subsonic-compat/constants.js';
import { getTrackDetail } from '$lib/server/database/queries/music.queries.js';
import { checkSubsonicMediaAccess } from '$lib/server/subsonic-compat/media-access.js';
import { refreshExternalSessionPresence } from '$lib/server/database/queries/play-sessions.queries.js';
import { upsertTranscodeSession } from '$lib/server/subsonic-compat/utils/transcode-session.js';
import { getImageProxyService } from '$lib/server/services/image-proxy/index.js';
import { parseRangeHeader } from '$lib/server/utils/hls-request-utils.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { parseLRC } from '$lib/utils/lrc-parser.js';
import { readStoredLyrics } from '$lib/server/services/music/lyrics.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { getMusicTranscodeService } from '$lib/server/services/music-transcode/index.js';
import {
    clampBitrate,
    defaultBitrateFor,
} from '$lib/server/services/music-transcode/bitrate-clamp.js';
import { probeAudioSource } from '$lib/server/services/music-transcode/source-metadata.js';
import type { MusicCodec } from '$lib/server/services/music-transcode/types.js';
import { parseMusicCodec } from '$lib/server/services/music-transcode/types.js';
import { attachmentDisposition } from '$lib/server/utils/content-disposition.js';

const logger = Logger.for('SubsonicCompat');

/**
 * Wrap a ReadableStream so every chunk is counted against the bandwidth
 * tracker. Used for live-encode paths where contentLength is unknown until
 * the stream finishes.
 */
function trackStreamBytes(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return stream.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller): void {
                bandwidthTracker.trackDirectPlay(chunk.byteLength);
                controller.enqueue(chunk);
            },
        }),
    );
}

/**
 * Parse a Subsonic `format` query param into a transcode target codec.
 * Returns null for `raw`, missing, empty, or unsupported values (caller
 * treats null as "no explicit target codec requested").
 */
function parseTargetCodec(format: string | null): MusicCodec | null {
    if (!format) return null;
    if (format === 'mp3' || format === 'opus' || format === 'aac') return format;
    return null;
}

interface MaybeTranscodeArgs {
    event: RequestEvent;
    auth: SubsonicAuthContext;
    sql: postgres.Sql;
    trackId: string;
    containerPath: string;
    contentDisposition: string;
}

/**
 * Inspect the request for OpenSubsonic transcode parameters
 * (`format`, `maxBitRate`, `timeOffset`) and, if transcoding is required,
 * route through `MusicTranscodeService`. Returns the streaming Response on
 * the transcode path or null when direct-play should be used.
 *
 * Decision tree:
 *   1. FEATURE_MUSIC_TRANSCODE disabled → null (direct-play)
 *   2. format=raw → null (raw wins over every other param per spec)
 *   3. timeOffset > 0 → transcode (need to seek)
 *   4. format ∈ {mp3,opus,aac} and source codec doesn't match → transcode
 *   5. maxBitRate set and probed source bitrate exceeds it → transcode
 *   6. Otherwise → null (direct-play)
 */
async function maybeServeTranscoded(args: MaybeTranscodeArgs): Promise<Response | null> {
    const { event, auth, sql, trackId, containerPath, contentDisposition } = args;

    if (!config.FEATURE_MUSIC_TRANSCODE) return null;

    const formatParam = getParam(event, 'format');
    const maxBitRateRaw = getParam(event, 'maxBitRate');
    const timeOffsetRaw = getParam(event, 'timeOffset');

    // Spec: format=raw forces direct-play and overrides maxBitRate/timeOffset.
    if (formatParam === 'raw') return null;

    const targetCodec = parseTargetCodec(formatParam);
    // Subsonic spec: maxBitRate=0 means "no cap / unlimited". Treat any
    // non-positive value as null so we don't accidentally force transcoding
    // and then clamp to the codec minimum bitrate.
    const parsedMaxBitRate =
        maxBitRateRaw && Number.isFinite(parseInt(maxBitRateRaw, 10))
            ? parseInt(maxBitRateRaw, 10)
            : null;
    const maxBitRate = parsedMaxBitRate !== null && parsedMaxBitRate > 0 ? parsedMaxBitRate : null;
    const timeOffset =
        timeOffsetRaw && Number.isFinite(parseInt(timeOffsetRaw, 10))
            ? Math.max(0, parseInt(timeOffsetRaw, 10))
            : 0;

    // Quick exits: no transcode-influencing param present.
    if (!targetCodec && timeOffset === 0 && maxBitRate === null) {
        return null;
    }

    let needsTranscode = false;
    if (timeOffset > 0) needsTranscode = true;

    if (!needsTranscode && (targetCodec || maxBitRate !== null)) {
        // A container extension does not identify its codec (.ogg can be
        // Vorbis or Opus; .m4a can be ALAC or AAC). Share one probe for both
        // the explicit format and the bitrate decision.
        try {
            const src = await probeAudioSource(containerPath);
            if (targetCodec && src.codec !== targetCodec) needsTranscode = true;
            const srcKbps = src.bitrate > 0 ? Math.round(src.bitrate / 1000) : 0;
            if (maxBitRate !== null && srcKbps > 0 && srcKbps > maxBitRate) {
                needsTranscode = true;
            }
        } catch (err) {
            // An explicit format must not direct-play an unreadable source:
            // the transcode path's source guard refuses non-audio bodies (415).
            // A bitrate cap alone keeps the old direct-play fallback.
            if (targetCodec) needsTranscode = true;
            logger.warn(
                targetCodec
                    ? 'Source audio probe failed; deferring to the transcode source guard'
                    : 'Source audio probe failed; falling back to direct-play',
                {
                    trackId,
                    err: err instanceof Error ? err.message : String(err),
                },
            );
        }
    }

    if (!needsTranscode) return null;

    // Decide final codec + bitrate.
    // Checked, not asserted — see parseMusicCodec. This path matters most:
    // a Subsonic client sends maxBitRate and no format at all, so the
    // configured default is the ONLY thing choosing its container.
    const codec: MusicCodec =
        targetCodec ?? parseMusicCodec(config.MUSIC_TRANSCODE_DEFAULT_CODEC) ?? 'mp3';
    const requestedBitrate = maxBitRate ?? defaultBitrateFor(codec);
    const bitrateKbps = clampBitrate(codec, requestedBitrate);

    // The transcode service writes a row to `active_transcode_jobs` whose
    // `play_session_id` FK requires a play_sessions row to exist. Upsert one
    // here using the existing subsonic source key so multiple requests for
    // the same (user, track) reuse the same row (mirroring scrobble).
    const playSessionId = await upsertTranscodeSession({
        surface: 'subsonic',
        sql,
        authUserId: auth.userId,
        clientName: auth.clientName,
        trackId,
        codec,
        bitrateKbps,
        timeOffset,
    });
    if (!playSessionId) {
        // Fall through to direct-play rather than failing the request — the
        // transcode service requires a session row for its FK, but the
        // source file is still streamable byte-exact.
        return null;
    }

    let mtimeMs: number;
    try {
        const st = await fsStat(containerPath);
        mtimeMs = st.mtimeMs;
    } catch (err) {
        logger.error(
            'Failed to stat source for music transcode',
            err instanceof Error ? err : new Error(String(err)),
            { trackId, containerPath },
        );
        return null;
    }

    const service = getMusicTranscodeService(sql);
    try {
        const result = await service.streamFor({
            trackUuid: trackId,
            sourcePath: containerPath,
            sourceMtimeMs: mtimeMs,
            codec,
            bitrateKbps,
            timeOffset,
            session: {
                sessionId: playSessionId,
                userId: auth.userId,
                deviceId: `subsonic-${auth.username}`,
                source: 'subsonic',
            },
            abortSignal: event.request.signal,
        });

        // For known-size results (cached path) report the full length up
        // front; for live-encode (null contentLength) wrap the stream so
        // each chunk is counted as it flows through.
        const body = result.contentLength !== null ? result.body : trackStreamBytes(result.body);
        if (result.contentLength !== null) {
            bandwidthTracker.trackDirectPlay(result.contentLength);
        }

        return new Response(body, {
            status: 200,
            headers: {
                'Content-Type': result.contentType,
                ...(result.contentLength !== null
                    ? { 'Content-Length': String(result.contentLength) }
                    : {}),
                'Accept-Ranges': result.acceptRanges,
                'Content-Disposition': contentDisposition,
                ...CORS_HEADERS,
            },
        });
    } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 415) {
            // PlaylistSourceRefusedError: the stored file is a
            // playlist/manifest body, never transcoded.
            logger.warn('Music transcode refused a non-audio source', {
                trackId,
                err: err instanceof Error ? err.message : String(err),
            });
            const envelope = subsonicError(
                0,
                'The stored file is not playable audio.',
                auth.format,
            );
            return new Response(envelope.body, {
                status: 415,
                headers: { ...Object.fromEntries(envelope.headers), ...CORS_HEADERS },
            });
        }
        if (status === 503) {
            const envelope = subsonicError(
                0,
                'Server busy. Retry after a few seconds.',
                auth.format,
            );
            return new Response(envelope.body, {
                status: 503,
                headers: {
                    ...Object.fromEntries(envelope.headers),
                    'Retry-After': '5',
                    ...CORS_HEADERS,
                },
            });
        }
        logger.error(
            'Music transcode service failure',
            err instanceof Error ? err : new Error(String(err)),
            { trackId },
        );
        return subsonicError(0, 'Transcode failed.', auth.format);
    }
}

async function serveTrack(
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
    disposition: 'inline' | 'attachment',
): Promise<Response> {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }

    if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicError(70, 'Song not found.', auth.format);
    }

    const track = await getTrackDetail(sql, id);
    if (!track) {
        return subsonicError(70, 'Song not found.', auth.format);
    }
    const filePath = track.file_path;
    if (!filePath) {
        return subsonicError(70, 'Audio file path not available.', auth.format);
    }

    const pathInfo = await resolveMediaPath(filePath, { skipLocalAccessCheck: true }, sql);
    if (!pathInfo?.isAccessible) {
        return subsonicError(
            0,
            `Audio file not accessible: ${pathInfo?.reason ?? 'unknown'}`,
            auth.format,
        );
    }
    const containerPath = pathInfo.containerPath;
    const fileSize = pathInfo.fileSize;
    if (!fileSize) {
        return subsonicError(0, 'File size unavailable.', auth.format);
    }

    if (fileSize > MAX_STREAM_FILE_SIZE) {
        return subsonicError(0, 'File too large for streaming.', auth.format);
    }

    const ext = extname(containerPath).toLowerCase();
    const contentType = AUDIO_MIME_TYPES[ext] ?? 'application/octet-stream';
    // On-disk filenames are attacker-influenced (anyone who can add a file to a
    // library names it), and a `"` in one would close the quoted parameter early.
    const contentDisposition =
        disposition === 'attachment' ? attachmentDisposition(basename(containerPath)) : 'inline';

    logger.debug('Subsonic stream request', {
        username: auth.username,
        trackId: id,
        hasRange: !!event.request.headers.get('range'),
        fileSize,
    });

    // ─── OpenSubsonic transcode query params ─────────────────────────────────
    // Spec: format=raw forces direct-play (skip transcoding entirely).
    //       format=mp3|opus|aac picks a target codec.
    //       timeOffset (seconds) seeks into the source — only meaningful when
    //         transcoding (otherwise the file is delivered byte-exact).
    //       maxBitRate (kbps) caps the output bitrate — only triggers
    //         transcoding when the source exceeds it.
    //
    // Download endpoint always direct-plays the source (Subsonic spec).
    if (disposition !== 'attachment') {
        const transcodeResponse = await maybeServeTranscoded({
            event,
            auth,
            sql,
            trackId: id,
            containerPath,
            contentDisposition,
        });
        if (transcodeResponse) return transcodeResponse;
    }

    // The row was checked at scan time; a link swapped in since (for the file or a
    // directory above it) is re-contained, and the real path opened O_NOFOLLOW.
    const servePath = await resolveContainedMediaFile(containerPath, [], { parents: true });
    if (!servePath) {
        return subsonicError(70, 'Audio file not found.', auth.format);
    }

    const rangeHeader = event.request.headers.get('range');

    if (!rangeHeader) {
        bandwidthTracker.trackDirectPlay(fileSize);
        const nodeStream = await createNoFollowReadStream(servePath);
        return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
            status: 200,
            headers: {
                'Content-Type': contentType,
                'Content-Length': String(fileSize),
                'Accept-Ranges': 'bytes',
                'Content-Disposition': contentDisposition,
                ...CORS_HEADERS,
            },
        });
    }

    const range = parseRangeHeader(rangeHeader, fileSize);
    if (!range) {
        const envelope = subsonicError(0, 'Range not satisfiable.', auth.format);
        return new Response(envelope.body, {
            status: 416,
            headers: {
                ...Object.fromEntries(envelope.headers),
                'Content-Range': `bytes */${fileSize}`,
                ...CORS_HEADERS,
            },
        });
    }

    const { start, end } = range;
    const chunkSize = end - start + 1;
    const nodeStream = await createNoFollowReadStream(servePath, { start, end });

    bandwidthTracker.trackDirectPlay(chunkSize);
    return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
        status: 206,
        headers: {
            'Content-Type': contentType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Disposition': contentDisposition,
            ...CORS_HEADERS,
        },
    });
}

export const handleStream: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    // Keep the now-playing session alive while audio is flowing. Fire-and-forget:
    // the session key is auth.userId:trackId, matching what handleScrobble writes.
    const trackId = event.locals.subsonicBodyParams?.get('id') ?? event.url.searchParams.get('id');
    if (trackId) {
        void refreshExternalSessionPresence(sql, 'subsonic', `${auth.userId}:${trackId}`).catch(
            () => {},
        );
    }
    return serveTrack(event, auth, sql, 'inline');
};

export const handleDownload: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    return serveTrack(event, auth, sql, 'attachment');
};

export const handleGetCoverArt: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }

    // Gate by library + age before serving the image bytes. Without this a
    // Subsonic-authenticated user could fetch cover art (and confirm existence)
    // for any catalog id, including albums/tracks in a denied library group or
    // above their age rating. Collapse a denial to the same not-found error the
    // missing-art path returns so it can't be used as an existence oracle.
    if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicError(70, 'Cover art not found.', auth.format);
    }

    const service = getImageProxyService();
    const result = await service.getImageByCatalogId(id, 'poster');
    if (!result) {
        return subsonicError(70, 'Cover art not found.', auth.format);
    }
    return new Response(new Uint8Array(result.buffer), {
        headers: {
            'Content-Type': result.contentType,
            'Cache-Control': result.cacheControl,
            'Access-Control-Allow-Origin': '*',
        },
    });
};

export const handleGetLyricsBySongId: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }

    if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicOk({ lyricsList: { structuredLyrics: [] } }, auth.format);
    }

    const track = await getTrackDetail(sql, id);
    if (!track) {
        return subsonicOk({ lyricsList: { structuredLyrics: [] } }, auth.format);
    }

    const resolved = readStoredLyrics(track);
    if (!resolved) {
        return subsonicOk({ lyricsList: { structuredLyrics: [] } }, auth.format);
    }

    const { plain, synced } = resolved;
    const structuredLyrics = [];

    if (synced) {
        const { lines: parsed, metadata } = parseLRC(synced);
        const lang = metadata.la ?? metadata.lang ?? 'xxx';
        structuredLyrics.push({
            lang,
            synced: true,
            displayArtist: metadata.ar ?? track.artist_title ?? undefined,
            displayTitle: metadata.ti ?? track.title,
            line: parsed.map((l) => ({ start: l.startMs, value: l.text })),
        });
    }

    if (plain) {
        const lines = plain
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .map((l) => ({ value: l }));
        structuredLyrics.push({
            lang: 'xxx',
            synced: false,
            displayArtist: track.artist_title ?? undefined,
            displayTitle: track.title,
            line: lines,
        });
    }

    return subsonicOk({ lyricsList: { structuredLyrics } }, auth.format);
};
