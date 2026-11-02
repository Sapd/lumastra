// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Shared music stream route handler factory
//
// Both /api/music/tracks/[id]/stream and /api/v1/music/tracks/[id]/stream
// are ~95% identical. This module extracts the shared logic so each route
// file becomes a thin 4-5 line wrapper.

import { z } from 'zod';
import { problem } from '$lib/server/api/problem.js';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { ShutdownInterruptedError } from '$lib/server/lifecycle/shutdown-interrupted.js';
import { shuttingDownResponse } from '$lib/server/lifecycle/web-shutdown.js';
import { Logger } from '$lib/server/utils/logger.js';
import { deriveSurface } from '$lib/server/api/play-surface.js';
import { parseRangeHeader } from '$lib/server/utils/hls-request-utils.js';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { negotiateAudio } from './negotiation.js';
import { extname } from 'node:path';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { features } from '$lib/server/config.js';
import {
    getMusicTranscodeService,
    containerFor,
} from '$lib/server/services/music-transcode/index.js';
import { resolveStreamSource, probeAudioSourceCached } from './stream-source.js';
import {
    PLAYER_SESSION_PREFIX,
    SYNTHETIC_SESSION_PREFIX,
} from '$lib/server/services/music-transcode/types.js';
import { upsertTranscodeSession } from '$lib/server/subsonic-compat/utils/transcode-session.js';
import { hasLivePlayerMusicSession } from '$lib/server/database/queries/play-sessions.queries.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';

const MAX_STREAM_FILE_SIZE = 500 * 1024 * 1024; // 500MB

/**
 * Rate limit for the download path only.
 *
 * This route is a bespoke `+server.ts`, not a `defineEndpoint` def, so it has
 * no def-level limit of any kind. A smart-downloads sweep is the first
 * workload that will ever drive it in bulk. The limit is scoped to
 * `download=1` deliberately: applying it to the route as a whole would
 * throttle ordinary playback.
 *
 * 300 requests per 600s window is the same 1800/hour average as a naive
 * "900 per hour" limit, but on a SHORTER fixed window rather than a
 * fixed hour-aligned one: 300 / 600s * 3600 = 1800/hour, comfortably above a
 * full first fill (~1200 tracks, see MAX_WANT in the candidates def).
 * `checkRateLimit` buckets by `floor(now / windowSeconds)` (see
 * valkey-rate-limit.ts) — this is a FIXED window, not a rolling one, so a
 * client can burst up to the full 300-request budget right before a bucket
 * boundary and another 300 right after, i.e. up to 600 requests in a short
 * span straddling the boundary. The short window matters because a
 * capacity-class 503 from the transcode cap still consumes a rate-limit
 * token without moving any bytes — on a 1-hour window a 503 storm could wall
 * a client out for up to an hour; on this 600s window the same client
 * recovers in at most 10 minutes regardless of where in the window it lands.
 */
export const DOWNLOAD_RATE_LIMIT_MAX = 300;
export const DOWNLOAD_RATE_LIMIT_WINDOW_S = 600;

export function downloadRateLimitKey(userId: string): string {
    return `music:stream-download:${userId}`;
}

/**
 * The download-only rate-limit gate, extracted out of the GET handler so it
 * can be exercised directly in tests. Reaching this point through the real
 * handler requires driving DB lookups, media-access checks, and file-system
 * resolution first, none of which this guard cares about — testing the
 * extracted function instead keeps the coverage of "does the limiter fire,
 * and only for downloads" independent of that unrelated setup.
 *
 * Called at the exact same point the inline check used to occupy: right
 * after `isDownload` is known, before any transcode slot is acquired.
 * It does NOT run before all file work: `resolveStreamSource` (track lookup,
 * `checkMediaAccess`, and `resolveMediaPath` — a DB lookup plus a filesystem
 * stat, cached briefly per user and track) runs
 * earlier in the handler, because `isDownload` itself isn't known until the
 * request URL is parsed later on. This gate bounds the transcode-slot cost
 * of a sweep, not the DB/filesystem cost of one — a request that fails here
 * has already paid for those. Returns a 429 Response to short-circuit the
 * request when over budget, or null to let the handler continue.
 */
export async function checkDownloadRateLimit(
    isDownload: boolean,
    userId: string,
): Promise<Response | null> {
    if (!isDownload) return null;

    const rl = await checkRateLimit(
        downloadRateLimitKey(userId),
        DOWNLOAD_RATE_LIMIT_MAX,
        DOWNLOAD_RATE_LIMIT_WINDOW_S,
    );
    if (!rl.allowed) {
        return new Response('Too many download requests', {
            status: 429,
            headers: {
                'Retry-After': String(Math.max(1, Math.ceil(rl.resetAt - Date.now() / 1000))),
            },
        });
    }
    return null;
}

const AUDIO_MIME_TYPES: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.opus': 'audio/ogg; codecs=opus',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac',
    '.aiff': 'audio/aiff',
    '.alac': 'audio/mp4',
};

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
};

// Validate syntax before probing or negotiating: malformed client input is 400,
// while valid constraints that the source cannot satisfy are 422.
const numericQuery = z.string().trim().min(1).transform(Number);
const MusicStreamQuerySchema = z.object({
    format: z.enum(['mp3', 'opus', 'aac', 'm4a', 'raw']).optional(),
    bitrateKbps: numericQuery.pipe(z.number().int().positive()).optional(),
    maxBitrateKbps: numericQuery
        .pipe(z.number().int().nonnegative())
        .transform((value) => (value === 0 ? undefined : value))
        .optional(),
    startPositionSeconds: numericQuery.pipe(z.number().finite().nonnegative()).optional(),
});

function hasNegotiationQuery(params: URLSearchParams): boolean {
    return ['format', 'bitrateKbps', 'maxBitrateKbps', 'startPositionSeconds'].some((key) =>
        params.has(key),
    );
}

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

export interface MusicStreamRouteOptions {
    /** play_sessions.source — distinguishes API origins in session queries */
    source: 'api' | 'public-api';
    /**
     * play_sessions.device_id. A function receiving the username allows
     * per-user device IDs so that the admin/sessions view can show distinct
     * rows for concurrent users on the same endpoint.
     */
    deviceId: (username: string) => string;
    /** Logger name shown in server logs and error traces */
    loggerName: string;
}

/**
 * A fixed-format encode for callers that promise one output whatever the
 * source is (the cluster shuffle stream: MP3, 44.1 kHz, stereo, no ID3 — see
 * buildMp3EncodeArgs). Unlike `?format=mp3`, which direct-plays an MP3
 * source untouched (its own sample rate, channels and cover-art tag), this
 * ALWAYS encodes, and answers 503 rather than falling back to the original.
 */
export interface ForcedMp3 {
    bitrateKbps: number;
    /** Extra response headers (track metadata). */
    headers: Record<string, string>;
}

/** Everything {@link MusicStreamHandlers.serveTrack} reads from the request event. */
type StreamEvent = Pick<RequestEvent, 'request' | 'locals'>;

export interface MusicStreamHandlers {
    GET: RequestHandler;
    HEAD: RequestHandler;
    /**
     * The GET body, callable in-process for a track the caller already chose.
     * The caller is responsible for auth; access to the track is still
     * checked here.
     */
    serveTrack: (event: StreamEvent, trackId: string, forced?: ForcedMp3) => Promise<Response>;
}

/**
 * Factory that returns GET and HEAD RequestHandlers for a music stream route.
 * Both /api/music and /api/v1/music use this; they differ only in the
 * three options above.
 */
export function createMusicStreamHandlers(opts: MusicStreamRouteOptions): MusicStreamHandlers {
    const logger = Logger.for(opts.loggerName);

    const serveTrack = async (
        { request, locals }: StreamEvent,
        rawTrackId: string | undefined,
        forced?: ForcedMp3,
    ): Promise<Response> => {
        if (!locals.user) return ApiResponses.unauthorized();

        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable');

        if (!rawTrackId) return ApiResponses.badRequest('Missing track ID');
        const trackId = rawTrackId;
        // Track lookup + library/age gate + path resolution, cached briefly
        // per (user, track) across a track start's burst of ranged
        // requests — see stream-source.ts.
        const source = await resolveStreamSource(sql, trackId, locals.user);
        if (source.kind === 'not_found') {
            return source.reason === 'no_file_path'
                ? ApiResponses.notFound('Audio file path not available for this track')
                : ApiResponses.notFound('Track');
        }
        if (source.kind === 'unavailable') {
            return ApiResponses.error(`Audio file not accessible: ${source.reason}`);
        }
        const { containerPath, fileSize } = source;

        const ext = extname(containerPath).toLowerCase();
        const contentType = AUDIO_MIME_TYPES[ext] ?? 'application/octet-stream';

        const rangeHeader = request.headers.get('range');

        logger.debug('Audio stream request', {
            username: locals.user.username,
            trackId: trackId,
            hasRange: !!rangeHeader,
            fileSize,
        });

        // ── Transcode branch ────────────────────────────────────────────
        // Public starts and GET/HEAD delivery share negotiateAudio. Subsonic
        // retains its separate protocol adapter and query names.
        const url = new URL(request.url);
        // A download is a file transfer, not playback: it must not open a
        // play session, close the user's other music sessions, or be
        // reported as a play. See the `isDownload` use below.
        const downloadRaw = url.searchParams.get('download');
        const isDownload = !forced && (downloadRaw === '1' || downloadRaw === 'true');

        // Rate limit the download path only — see DOWNLOAD_RATE_LIMIT_MAX
        // and checkDownloadRateLimit. Placed as early as `isDownload` can
        // be known (it depends on parsing the request URL, done just
        // above) and before any transcode slot is acquired — but NOT
        // before all file work: the track/access/path-resolution lookups
        // above already ran. This bounds the transcode-slot cost of a
        // sweep, not its DB/filesystem cost. Gated on the same
        // `isDownload` flag used below so a sweep can never throttle
        // ordinary playback. (No `&& locals.user` guard needed: it's
        // already enforced above and by requireAuth — `locals.user` is
        // non-optional by type at this point.)
        const rateLimitResponse = await checkDownloadRateLimit(isDownload, locals.user.userId);
        if (rateLimitResponse) return rateLimitResponse;

        /**
         * `download=1` has to survive every exit below, not just the
         * transcoding one. `format=raw`, the feature flag being off, and a
         * no conversion request all fall through to direct-play, and those returned a hardcoded `inline` — so the
         * browser played the track instead of saving it, with no filename.
         */
        const dispositionFor = (extension: string): string =>
            isDownload ? `attachment; filename="${trackId}${extension}"` : 'inline';

        if (forced && !features.musicTranscode) {
            return new Response('Transcoding is disabled on this server.', {
                status: 503,
                headers: { ...CORS_HEADERS },
            });
        }

        if (
            !forced &&
            ['maxBitRate', 'bitrate', 'timeOffset'].some((key) => url.searchParams.has(key))
        )
            return problem('validation_failed', {
                status: 400,
                error: 'Use maxBitrateKbps, bitrateKbps and startPositionSeconds',
            });
        const query = MusicStreamQuerySchema.safeParse(
            forced ? {} : Object.fromEntries(url.searchParams),
        );
        if (!query.success)
            return problem('validation_failed', {
                status: 400,
                error: 'Invalid audio negotiation query',
            });
        let sourceBitrate: number | undefined;
        let audioDecision: ReturnType<typeof negotiateAudio> | undefined;
        if (forced || hasNegotiationQuery(url.searchParams)) {
            try {
                const metadata = await probeAudioSourceCached(source);
                sourceBitrate = metadata.bitrate;
                audioDecision = negotiateAudio(metadata, {
                    ...query.data,
                    ...(forced
                        ? {
                              format: 'mp3',
                              bitrateKbps: forced.bitrateKbps,
                              requestedMethod: 'audio_transcode' as const,
                          }
                        : {}),
                    transcodeEnabled: features.musicTranscode,
                });
            } catch (error) {
                if (error && typeof error === 'object' && 'status' in error && error.status === 415)
                    return new Response('The stored file is not playable audio.', { status: 415 });
                return ApiResponses.unprocessableEntity(
                    error instanceof Error ? error.message : 'Audio incompatible',
                );
            }
        }
        const actualHeaders: Record<string, string> = audioDecision
            ? {
                  'X-Audio-Codec': audioDecision.codec,
                  'X-Audio-Container': audioDecision.container,
                  'X-Audio-Bitrate-Kbps': String(audioDecision.bitrateKbps),
              }
            : {};
        if (audioDecision?.target) {
            const codec = audioDecision.target;
            const bitrateKbps = audioDecision.bitrateKbps;
            const timeOffset = forced ? 0 : (query.data.startPositionSeconds ?? 0);
            // A download must not register as playback. The
            // upsert below writes an ACTIVE play_sessions row AND
            // closes the user's other music sessions, so fetching a
            // 12-track album for offline use would log 12 plays and
            // repeatedly tear down whatever is actually playing.
            // The transcode service only needs a stable id to key
            // its slot/dedup bookkeeping, so downloads get a
            // synthetic one that never touches play_sessions —
            // recognisable by its prefix, which is what keeps it
            // out of the uuid-typed job table.
            //
            // The same goes for our own player when it already
            // reports the listen through /play-sessions/{id}: the
            // iOS app preloads the NEXT track through this route, so
            // a row here showed a second "Subsonic" stream one track
            // ahead of the audible one and took a second slot of the
            // stream cap. `surface` is self-declared attribution
            // (play-surface.ts), so it is never trusted alone: the
            // live player row it defers to is metered, so a client
            // that fakes a first-party surface gains nothing.
            // A forced encode (the cluster shuffle stream) keeps its
            // row: it feeds devices that never report a listen.
            //
            // Known limit: the check is per user, not per device or
            // track. The stream request carries no player identity,
            // and the preloaded track is not yet known to the server.
            const surface = deriveSurface(locals.principal);
            // A start grant already owns the metered row and the work key.
            const grantSession = locals.streamingSession;
            const boundPlaybackSessionId =
                !isDownload &&
                !forced &&
                grantSession?.userId === locals.user.userId &&
                grantSession.mediaItemId === trackId
                    ? grantSession.playbackSessionId
                    : undefined;
            const reportedByPlayer =
                !boundPlaybackSessionId &&
                !isDownload &&
                !forced &&
                surface !== 'third_party_api' &&
                (await hasLivePlayerMusicSession(sql, locals.user.userId).catch((err: unknown) => {
                    logger.warn(
                        'Live player session lookup failed; recording the transcode as its own session',
                        {
                            trackId,
                            err: err instanceof Error ? err.message : String(err),
                        },
                    );
                    return false;
                }));
            const playSessionId =
                boundPlaybackSessionId ??
                (isDownload
                    ? `${SYNTHETIC_SESSION_PREFIX}${locals.user.userId}:${trackId}`
                    : reportedByPlayer
                      ? `${PLAYER_SESSION_PREFIX}${locals.user.userId}:${trackId}`
                      : await upsertTranscodeSession({
                            sql,
                            // /api/music routes don't share session keys
                            // with Subsonic scrobble (different source='music'),
                            // so the key only needs to be stable per user.
                            // play_sessions.user_id is the users.id UUID (mig 16.46.0).
                            authUserId: locals.user.userId,
                            clientName: null,
                            trackId: trackId,
                            codec,
                            bitrateKbps,
                            timeOffset: timeOffset ?? 0,
                            source: 'music',
                            // OUR player, not Subsonic — derived from
                            // the caller so a web listen and a native
                            // listen do not collapse into one bucket.
                            surface,
                        }));

            if (!playSessionId && forced) {
                // A forced encode promised its format; the
                // original file would break that promise.
                return new Response('Server busy, try again in a few seconds.', {
                    status: 503,
                    headers: { 'Retry-After': '5', ...CORS_HEADERS },
                });
            }
            if (!playSessionId) {
                // Session upsert failed; fall through to direct-play rather
                // than hard-failing the request.
                logger.warn('Transcode session upsert failed; falling back to direct-play', {
                    trackId: trackId,
                });
            } else {
                // Stat the file to get mtimeMs for the cache key. We defer
                // this single stat() to here so the direct-play path (which
                // uses the resolved fileSize) never pays the extra syscall.
                const fileStats = await stat(containerPath);
                const service = getMusicTranscodeService(sql);
                try {
                    const result = await service.streamFor({
                        trackUuid: trackId,
                        sourcePath: containerPath,
                        sourceMtimeMs: fileStats.mtimeMs,
                        durationSeconds: source.durationSeconds,
                        sourceSize: source.fileSize,
                        sourceBitrate,
                        codec,
                        bitrateKbps,
                        timeOffset: timeOffset ?? 0,
                        session: {
                            sessionId: playSessionId,
                            userId: locals.user.userId,
                            deviceId: opts.deviceId(locals.user.username),
                            source: opts.source,
                        },
                        abortSignal: request.signal,
                        // Honoured: AVPlayer's progressive reader
                        // reconnects mid-track with `bytes=N-`, and
                        // a 200 from byte 0 to that plays the song's
                        // start in the middle of the song.
                        rangeHeader,
                    });

                    // For known-size results (cached path) report the full
                    // length up front; for live-encode (null contentLength)
                    // wrap the stream so each chunk is counted as it flows.
                    const body =
                        result.contentLength !== null ? result.body : trackStreamBytes(result.body);
                    if (result.contentLength !== null) {
                        bandwidthTracker.trackDirectPlay(result.contentLength);
                    }

                    return new Response(body, {
                        status: result.status,
                        headers: {
                            'Content-Type': result.contentType,
                            ...(result.contentLength !== null
                                ? {
                                      'Content-Length': String(result.contentLength),
                                  }
                                : {}),
                            ...(result.contentRange
                                ? { 'Content-Range': result.contentRange }
                                : {}),
                            'Accept-Ranges': result.acceptRanges,
                            'Content-Disposition': dispositionFor(
                                `.${containerFor(codec) === 'mp4' ? 'm4a' : containerFor(codec)}`,
                            ),
                            // What was ACTUALLY encoded, so a client
                            // can label the quality rung honestly
                            // instead of guessing. These differ from
                            // the request whenever the ladder clamps
                            // (e.g. bitrate=100 -> 96) or the source
                            // was already smaller than asked for.
                            'X-Audio-Codec': audioDecision.codec,
                            'X-Audio-Container': containerFor(codec),
                            'X-Audio-Bitrate-Kbps': String(bitrateKbps),
                            ...forced?.headers,
                            ...CORS_HEADERS,
                        },
                    });
                } catch (err) {
                    if (err instanceof ShutdownInterruptedError) {
                        logger.info('Music transcode interrupted by shutdown', { trackId });
                        const response = shuttingDownResponse();
                        for (const [name, value] of Object.entries(CORS_HEADERS)) {
                            response.headers.set(name, value);
                        }
                        return response;
                    }
                    const status = (err as { status?: number })?.status;
                    if (status === 410) {
                        return problem('gone', {
                            error: 'Playback session ended while queued',
                            headers: { ...CORS_HEADERS },
                        });
                    }
                    if (status === 415) {
                        // PlaylistSourceRefusedError: the stored
                        // file is a playlist/manifest body.
                        logger.warn('Music transcode refused a non-audio source', {
                            trackId: trackId,
                            err: err instanceof Error ? err.message : String(err),
                        });
                        return new Response('The stored file is not playable audio.', {
                            status: 415,
                            headers: { ...CORS_HEADERS },
                        });
                    }
                    if (status === 416) {
                        const size = (err as { size?: number }).size;
                        return new Response(null, {
                            status: 416,
                            headers: {
                                ...(size !== undefined
                                    ? { 'Content-Range': `bytes */${size}` }
                                    : {}),
                                ...CORS_HEADERS,
                            },
                        });
                    }
                    if (status === 503) {
                        return new Response('Server busy, try again in a few seconds.', {
                            status: 503,
                            headers: {
                                'Retry-After': '5',
                                ...CORS_HEADERS,
                            },
                        });
                    }
                    logger.error(
                        'Music transcode service failure',
                        err instanceof Error ? err : new Error(String(err)),
                        { trackId: trackId },
                    );
                    return new Response('Transcode failed', {
                        status: 500,
                        headers: { ...CORS_HEADERS },
                    });
                }
            }
        }
        // ── End transcode branch ────────────────────────────────────────

        // Guard against OOM from large uncompressed files (WAV/FLAC) on
        // the buffered direct-play path only. Transcode paths stream from
        // ffmpeg and never buffer the whole file, so the guard is not
        // needed there and would incorrectly 400 large lossless files that
        // ffmpeg can stream just fine.
        if (fileSize > MAX_STREAM_FILE_SIZE) {
            return ApiResponses.badRequest('File too large for direct streaming');
        }

        if (!rangeHeader) {
            // Read file into memory — audio files are typically 3-15 MB,
            // acceptable for buffered delivery which works reliably with
            // browser <audio> elements (Node streams don't).
            const buffer = await readFile(containerPath);
            bandwidthTracker.trackDirectPlay(buffer.length);
            return new Response(buffer, {
                status: 200,
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': String(buffer.length),
                    'Accept-Ranges': 'bytes',
                    'Content-Disposition': dispositionFor(ext),
                    ...CORS_HEADERS,
                    ...actualHeaders,
                },
            });
        }

        const range = parseRangeHeader(rangeHeader, fileSize);
        if (!range) {
            return new Response(null, {
                status: 416,
                headers: {
                    'Content-Range': `bytes */${fileSize}`,
                    ...CORS_HEADERS,
                    ...actualHeaders,
                },
            });
        }

        const { start, end } = range;
        const chunkSize = end - start + 1;
        const node = createReadStream(containerPath, { start, end, signal: request.signal });
        const body = Readable.toWeb(node, {
            // Bound the web queue in bytes, rather than Node's default
            // chunk count (which can eagerly queue an entire large range).
            strategy: {
                highWaterMark: 64 * 1024,
                size: (chunk: Uint8Array): number => chunk.byteLength,
            },
        }) as ReadableStream<Uint8Array>;
        bandwidthTracker.trackDirectPlay(chunkSize);
        return new Response(body, {
            status: 206,
            headers: {
                'Content-Type': contentType,
                'Content-Length': String(chunkSize),
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Disposition': dispositionFor(ext),
                ...CORS_HEADERS,
                ...actualHeaders,
            },
        });
    };

    const GET: RequestHandler = requireAuth(
        withErrorHandler((event) => serveTrack(event, event.params.id)),
    );

    const HEAD: RequestHandler = requireAuth(
        withErrorHandler(async ({ params, request, locals }) => {
            if (!locals.user) return ApiResponses.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return new Response(null, { status: 503 });

            if (!params.id) return new Response(null, { status: 400 });
            // Same lookups and cache as GET (library + age gate included).
            const source = await resolveStreamSource(sql, params.id, locals.user);
            if (source.kind !== 'ok') return new Response(null, { status: 404 });

            const ext = extname(source.containerPath).toLowerCase();
            const contentType = AUDIO_MIME_TYPES[ext] ?? 'application/octet-stream';

            const url = new URL(request.url);
            if (['maxBitRate', 'bitrate', 'timeOffset'].some((key) => url.searchParams.has(key)))
                return problem('validation_failed', {
                    status: 400,
                    error: 'Use maxBitrateKbps, bitrateKbps and startPositionSeconds',
                });
            const query = MusicStreamQuerySchema.safeParse(Object.fromEntries(url.searchParams));
            if (!query.success)
                return problem('validation_failed', {
                    status: 400,
                    error: 'Invalid audio negotiation query',
                });
            if (!hasNegotiationQuery(url.searchParams)) {
                return new Response(null, {
                    headers: {
                        'Content-Type': contentType,
                        'Content-Length': String(source.fileSize),
                        'Accept-Ranges': 'bytes',
                        ...CORS_HEADERS,
                    },
                });
            }
            let decision: ReturnType<typeof negotiateAudio>;
            try {
                decision = negotiateAudio(await probeAudioSourceCached(source), {
                    ...query.data,
                    transcodeEnabled: features.musicTranscode,
                });
            } catch (error) {
                if (error && typeof error === 'object' && 'status' in error && error.status === 415)
                    return new Response('The stored file is not playable audio.', { status: 415 });
                return ApiResponses.unprocessableEntity(
                    error instanceof Error ? error.message : 'Audio incompatible',
                );
            }
            const { mimeFor } = await import('./ffmpeg-args.js');
            return new Response(null, {
                status: 200,
                headers: {
                    'Content-Type': decision.target ? mimeFor(decision.target) : contentType,
                    ...(decision.target ? {} : { 'Content-Length': String(source.fileSize) }),
                    'Accept-Ranges': 'bytes',
                    'X-Audio-Codec': decision.codec,
                    'X-Audio-Container': decision.container,
                    'X-Audio-Bitrate-Kbps': String(decision.bitrateKbps),
                    ...CORS_HEADERS,
                },
            });
        }),
    );

    return { GET, HEAD, serveTrack };
}
