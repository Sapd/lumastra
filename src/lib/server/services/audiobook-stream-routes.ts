// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Handler bodies for the audiobook byte-proxy routes.
 *
 * Lives outside `src/routes` because a SvelteKit `+server.ts` may export only
 * reserved names, so a colocated test cannot import a helper from it and cannot
 * itself be called `+server.test.ts`. The route files are thin re-exports; the
 * behaviour under test is here.
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import type { RequestEvent } from '@sveltejs/kit';
import {
    authenticate as authenticateAccount,
    requireScope,
    scopeGranted,
} from '../tasks/api-auth.js';
import { extractAuthParams, addAuthToSearchParams } from '../utils/hls-request-utils.js';
import { getSessionById } from '../database/queries/play-sessions.queries.js';
import { UUID_RE_LOOSE } from '$lib/utils/id-patterns.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import { getDb } from '../database/connection.js';
import { getClientIpStrictFromRequest } from '../utils/client-ip.js';
import {
    authenticateAudiobookStream,
    extractStreamToken,
    type AudiobookStreamAuthResult,
} from './audiobook-stream-auth.js';
import {
    absFilePath,
    absHlsPath,
    AudiobookProxyError,
    proxyAudiobookBytes,
} from './audiobook-byte-proxy.service.js';
import {
    acquireAudiobookRemuxSlot,
    AUDIOBOOK_REMUX_CONTENT_TYPE,
    startAudiobookRemux,
} from './audiobook-remux.service.js';
import { getAudiobookFileCodec } from '../database/queries/audiobooks.queries.js';
import {
    audiobookRemuxJobId,
    getTranscodeJobPersistenceService,
} from './transcode-job-persistence.service.js';
import { config } from '../config.js';
import { problem, type ProblemCode } from '../api/problem.js';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('AudiobookStreamRoute');

/** Pre-stream failures share the API problem contract; audio is success-only. */
function fail(status: number, message: string): Response {
    const code: ProblemCode =
        status === 400 || status === 416
            ? 'validation_failed'
            : status === 401
              ? 'unauthorized'
              : status === 403
                ? 'forbidden'
                : status === 404
                  ? 'not_found'
                  : status === 503
                    ? 'dependency_unavailable'
                    : status === 502
                      ? 'bad_gateway'
                      : 'internal_error';
    return problem(code, { status, error: message, headers: { 'Cache-Control': 'no-store' } });
}

function failFromAuth(result: Exclude<AudiobookStreamAuthResult, { ok: true }>): Response {
    const messages: Record<string, string> = {
        missing_token: 'A stream token is required',
        invalid_token: 'Stream token is invalid, expired, or scoped to another item',
        not_an_audiobook: 'Not found',
        // Deliberately indistinguishable from not_an_audiobook: a distinct
        // message would tell a prober whether a guessed session id exists.
        unknown_session: 'Not found',
        no_abs_link: 'This account has no AudiobookShelf link',
        scope_required: 'A media scope is required',
        database_unavailable: 'Database unavailable',
        abs_unavailable: 'AudiobookShelf is temporarily unreachable',
    };
    return fail(result.status, messages[result.reason] ?? 'Forbidden');
}

/**
 * SvelteKit serves HEAD by running the GET handler, and the node adapter then
 * consumes the whole body and discards it. Left as a hardcoded GET upstream, a
 * HEAD on a 1.6 GB m4b would pull the entire book out of AudiobookShelf to
 * answer a request that carries no body — a cheap bandwidth amplifier.
 */
function upstreamMethod(event: RequestEvent): 'GET' | 'HEAD' {
    return event.request.method === 'HEAD' ? 'HEAD' : 'GET';
}

async function authenticate(
    event: RequestEvent,
    mediaId: string,
    opts: { absSessionId?: string } = {},
): Promise<AudiobookStreamAuthResult> {
    const sql = getDb();
    if (!sql) return { ok: false, status: 503, reason: 'database_unavailable' };

    if (event.locals?.authMethod !== 'stream_token' && event.locals?.user) {
        try {
            if (event.locals.principal) {
                if (!scopeGranted(event.locals.principal.scopes, 'media:read'))
                    return { ok: false, status: 403, reason: 'scope_required' };
            } else {
                const account = await authenticateAccount(event);
                requireScope(account, 'media:read', 'media:write');
            }
        } catch {
            return { ok: false, status: 403, reason: 'scope_required' };
        }
    }
    try {
        return await authenticateAudiobookStream({
            sql,
            token: extractStreamToken(event.request, event.url),
            mediaId,
            absSessionId: opts.absSessionId,
            playbackSessionId: event.url.searchParams.get('PlaySessionId') ?? undefined,
            liveUser: event.locals?.user,
            authenticatedUser:
                event.locals?.authMethod !== 'stream_token' ? event.locals?.user : undefined,
            // STRICT (security review P2): must agree with the strict IP the
            // grant was minted/renewed under (services/playback-grant),
            // or this per-segment validate() would compare against a value an
            // attacker can freely respoof via X-Forwarded-For when
            // TRUSTED_PROXY_IPS is unset — see client-ip.ts's getClientIpStrict.
            clientIp: getClientIpStrictFromRequest(event.request, event.getClientAddress),
        });
    } catch (error) {
        // A DB blip mid-book would otherwise escape as an unhandled 500. On a
        // path that runs once per six-second segment, "retry" (503) is the
        // truthful answer and the one a player can act on.
        logger.error('Audiobook stream auth failed', error as Error, { mediaId });
        return { ok: false, status: 503, reason: 'database_unavailable' };
    }
}

function handleProxyError(error: unknown, context: Record<string, unknown>): Response {
    if (error instanceof AudiobookProxyError) {
        // The X-Accel case is an operator misconfiguration, so it is logged at
        // the point of detection (in the proxy service) rather than here.
        return fail(error.status, error.message);
    }
    logger.error('Audiobook byte proxy failed', error as Error, context);
    return fail(502, 'Upstream failure');
}

/** Resolve public session/track addresses without returning ABS ids to a player. */
async function playbackAddress(event: RequestEvent): Promise<
    | {
          userId: string;
          mediaId: string;
          absSessionId: string;
          tracks: unknown;
      }
    | Response
    | null
> {
    const id = event.url.searchParams.get('PlaySessionId');
    const sql = getDb();
    if (!sql) return fail(503, 'Database unavailable');
    if (!id || !UUID_RE_LOOSE.test(id)) return null;
    let row: Awaited<ReturnType<typeof getSessionById>>;
    try {
        row = await getSessionById(sql, id);
    } catch (error) {
        logger.error('Could not resolve audiobook playback session', error as Error);
        return fail(503, 'Database unavailable');
    }
    if (
        !row ||
        row.media_id.toLowerCase() !== (event.params.mediaId ?? '').toLowerCase() ||
        row.source !== 'audiobookshelf' ||
        !row.source_session_id ||
        !['ACTIVE', 'PAUSED'].includes(row.status)
    )
        return null;
    return {
        userId: row.user_id,
        mediaId: row.media_id,
        absSessionId: row.source_session_id,
        tracks: isRecord(row.device_capabilities)
            ? row.device_capabilities.audiobookTracks
            : undefined,
    };
}

function addressedInode(tracks: unknown, index: string): string | null {
    if (!Array.isArray(tracks)) return null;
    const track: unknown = tracks.find(
        (candidate: unknown) => isRecord(candidate) && String(candidate.index) === index,
    );
    return isRecord(track) && typeof track.ino === 'string' ? track.ino : null;
}

/** All file addresses resolve from the committed session map, never from client ABS ids. */
async function resolveTrack(event: RequestEvent): Promise<
    | {
          auth: Extract<AudiobookStreamAuthResult, { ok: true }>;
          ino: string;
      }
    | Response
> {
    const invalid = validateQuery(event);
    if (invalid) return invalid;
    const address = await playbackAddress(event);
    if (address instanceof Response) return address;
    if (!address) {
        // Authenticate before answering "no such session": an unauthenticated
        // (or badly credentialed) caller must get the same 401 whether the
        // session is live, ended, foreign or invented, or the 401/404 split
        // becomes a session-existence oracle.
        const early = await authenticate(event, event.params.mediaId ?? '');
        return early.ok ? fail(404, 'Not found') : failFromAuth(early);
    }
    const auth = await authenticate(event, event.params.mediaId ?? '', {
        absSessionId: address.absSessionId,
    });
    if (!auth.ok) return failFromAuth(auth);
    const index = event.params.trackIndex ?? '';
    const ino =
        /^(0|[1-9]\d*)$/.test(index) && address.userId === auth.userId
            ? addressedInode(address.tracks, index)
            : null;
    if (!ino) return fail(404, 'Not found');
    return { auth, ino };
}

function validateQuery(event: RequestEvent): Response | null {
    if (
        ['session', 'trackIndex', 't', 'ino', 'path'].some((key) => event.url.searchParams.has(key))
    )
        return fail(400, 'Retired audiobook byte selector');
    const ids = event.url.searchParams.getAll('PlaySessionId');
    if (ids.length !== 1 || !UUID_RE_LOOSE.test(ids[0]))
        return fail(400, 'A Lumastra PlaySessionId is required');
    return null;
}

/** Direct file delivery preserves Range, If-Range and upstream validators. */
async function audiobookFile(event: RequestEvent): Promise<Response> {
    const resolved = await resolveTrack(event);
    if (resolved instanceof Response) return resolved;
    const { auth, ino } = resolved;
    try {
        return await proxyAudiobookBytes(
            {
                baseUrl: config.AUDIOURL,
                apiKey: auth.absApiKey,
                upstreamPath: absFilePath(auth.absItemId, ino),
            },
            event.request,
            { signal: event.request.signal, method: upstreamMethod(event) },
        );
    } catch (error) {
        return handleProxyError(error, { mediaId: event.params.mediaId, ino });
    }
}

/**
 * No single audio file is longer than this, so a larger offset is a malformed or
 * hostile request rather than a seek. Bounds what gets interpolated into an
 * ffmpeg `-ss`.
 */
const MAX_REMUX_START_SECONDS = 200_000;

/**
 * Parse `?startPositionSeconds=` — where in the FILE to start, seconds.
 *
 * Returns null for anything not a finite, in-range number. Absent means 0 (play
 * from the head), which is not the same as invalid: a client that omits it is
 * asking for the file, a client that sends `startPositionSeconds=NaN` has a bug worth reporting.
 */
function parseRemuxStart(raw: string | null): number | null {
    if (raw === null || raw === '') return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > MAX_REMUX_START_SECONDS) return null;
    return value;
}

/** AAC remux seeks use file-relative startPositionSeconds and an owned mapped track. */
async function audiobookRemux(event: RequestEvent): Promise<Response> {
    const resolved = await resolveTrack(event);
    if (resolved instanceof Response) return resolved;
    const { auth, ino } = resolved;
    const mediaId = event.params.mediaId ?? '';
    const startSeconds = parseRemuxStart(event.url.searchParams.get('startPositionSeconds'));
    if (startSeconds === null) return fail(400, 'Invalid start offset');

    // A HEAD must NOT spawn an encoder. SvelteKit answers HEAD by running this
    // GET handler and the node adapter then throws the body away — so an
    // unguarded HEAD is a free way to start ffmpeg jobs whose output nobody ever
    // reads. The headers below are the whole truthful answer to a HEAD anyway:
    // there is no length to report and no range to offer.
    if (event.request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: remuxHeaders() });
    }

    const releaseSlot = acquireAudiobookRemuxSlot(auth.userId);
    if (!releaseSlot) {
        const response = fail(503, 'Too many concurrent remuxes for this listener');
        response.headers.set('Retry-After', '2');
        return response;
    }

    const persistence = tryGetTranscodePersistence();
    const playSessionId = auth.playSessionId;

    // ── The exit can arrive BEFORE the job row exists ────────────────────────
    // `startAudiobookRemux` registers `proc.on('error', …)`, which for a spawn
    // failure (ENOENT/EACCES on FFMPEG_PATH) settles on the NEXT TICK — while this
    // handler still has two awaits to go before the INSERT. A genuinely fast
    // failure (ABS answering 401) lands in the same window. Finalising first meant
    // `UPDATE … WHERE play_session_id = $1 AND job_id = $2` matched nothing, its
    // discarded row count hid that, and the INSERT then wrote `status: 'running'`
    // with a live `ffmpeg_pid` for a process that was already dead — a row nothing
    // clears but the expired-job sweep.
    //
    // So the terminal result is HELD until the row it describes exists.
    type RemuxExit = { ok: boolean; code: number | null; error?: string };
    let jobRowSettled = false;
    let pendingExit: RemuxExit | null = null;

    const finalizeExit = (result: RemuxExit): void => {
        if (!persistence || !playSessionId) return;
        // The job id pins the terminal write to THIS encoder. A seek has already
        // replaced the row by the time a superseded ffmpeg exits, and an unguarded
        // write would mark the new stream stopped while it is still playing.
        void persistence.finalizeAudiobookRemuxJob(playSessionId, {
            ...result,
            jobId: audiobookRemuxJobId(ino, startSeconds),
        });
    };

    let stream;
    try {
        stream = startAudiobookRemux(
            {
                url: joinUpstreamUrl(config.AUDIOURL, absFilePath(auth.absItemId, ino)),
                apiKey: auth.absApiKey,
                startSeconds,
            },
            {
                signal: event.request.signal,
                onExit: (result) => {
                    releaseSlot();
                    if (!persistence || !playSessionId) return;
                    if (!jobRowSettled) {
                        pendingExit = result;
                        return;
                    }
                    finalizeExit(result);
                },
            },
        );
    } catch (error) {
        releaseSlot();
        logger.error('Audiobook remux failed to start', error as Error, { mediaId, ino });
        return fail(500, 'Could not start the remux');
    }

    // Registered AFTER the spawn so the row carries the real pid, and awaited so
    // the job is visible before the first byte reaches the client rather than
    // whenever a floating promise happens to land. A failure here is swallowed
    // inside the service: losing admin visibility must never cost a listener
    // their audio.
    if (persistence && playSessionId) {
        try {
            await persistence.recordAudiobookRemuxJob({
                playSessionId,
                mediaId,
                userId: auth.userId,
                deviceId: auth.playSessionDeviceId ?? 'unknown',
                ino,
                absItemId: auth.absItemId,
                // From the PERSISTED per-file codec, never from a query parameter:
                // what is inside the container is a property of the file. Read after
                // the spawn on purpose — an admin label must not delay audio, and it
                // must not be able to prevent it either.
                sourceCodec: await readPersistedCodec(mediaId, ino),
                startSeconds,
                ffmpegPid: stream.pid,
            });
        } finally {
            // `finally`, so an exit that arrived while this was in flight is still
            // applied when the INSERT itself failed. The UPDATE then matches zero
            // rows, which is the correct no-op — as opposed to leaving a `running`
            // row that outlives its process.
            jobRowSettled = true;
            if (pendingExit !== null) finalizeExit(pendingExit);
        }
    }

    return new Response(stream.body, { status: 200, headers: remuxHeaders() });
}

/**
 * The remux response headers.
 *
 * No `Content-Length` and `Accept-Ranges: none`, because both would be lies: the
 * length is unknown until the encode finishes and there is no byte↔time map to
 * serve a range from. Clients decide whether to attempt range requests from
 * exactly these two headers, so advertising them here is what produces the
 * "broken seek" class of bug rather than an honest restart.
 */
function remuxHeaders(): Record<string, string> {
    return {
        'Content-Type': AUDIOBOOK_REMUX_CONTENT_TYPE,
        'Accept-Ranges': 'none',
        // Per-listener authorised audio that is also non-deterministic (a
        // different `?startPositionSeconds=` yields different bytes). Nothing may keep it.
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
    };
}

/**
 * The persisted codec for the admin row, or `'unknown'`.
 *
 * Never fatal and never gating: an incomplete `audioFiles` map means we cannot
 * LABEL the job, not that the listener should be refused audio. And the route
 * deliberately does not require the codec to be one we flagged — the flag list is
 * a best-effort catalogue of what engines cannot decode, and "our list missed
 * this codec" is precisely the situation in which a client that asked for a remux
 * is right and we are wrong.
 */
async function readPersistedCodec(mediaId: string, ino: string): Promise<string> {
    const sql = getDb();
    if (!sql) return 'unknown';
    try {
        return (await getAudiobookFileCodec(sql, mediaId, ino)) ?? 'unknown';
    } catch (error) {
        logger.warn('Could not read the persisted codec for an audiobook remux', {
            mediaId,
            ino,
            error: String(error),
        });
        return 'unknown';
    }
}

/**
 * The persistence service throws when `DATABASE_URL` is unset, and a book with a
 * valid stream token cannot have got here without a database — but constructing
 * it must still never be the reason audio stops. Absent persistence costs admin
 * visibility for that stream and nothing else.
 */
function tryGetTranscodePersistence(): ReturnType<typeof getTranscodeJobPersistenceService> | null {
    try {
        return getTranscodeJobPersistenceService();
    } catch (error) {
        logger.warn('Transcode job persistence unavailable; remux will not be visible in admin', {
            error: String(error),
        });
        return null;
    }
}

/**
 * Proxy an audiobook HLS resource using the fixed playback marker and public session id;
 * every playlist child explicitly carries the grant and playback-session pin.
 * The ABS session is checked against this listener's own playback row.
 */
async function audiobookHls(event: RequestEvent): Promise<Response> {
    const mediaId = event.params.mediaId ?? '';
    const pathToken = event.params.token ?? '';
    let sessionId = event.params.sessionId ?? '';
    const file = event.params.file ?? '';
    if (!mediaId || !sessionId || !file) return fail(400, 'Missing media id, session id, or file');

    const invalid = validateQuery(event);
    if (invalid) return invalid;
    if (pathToken !== 'playback' || event.url.searchParams.get('PlaySessionId') !== sessionId)
        return fail(404, 'Not found');
    const address = await playbackAddress(event);
    if (address instanceof Response) return address;
    if (!address) return fail(404, 'Not found');
    sessionId = address.absSessionId;
    const auth = await authenticate(event, mediaId, { absSessionId: sessionId });
    if (!auth.ok) return failFromAuth(auth);
    if (address.userId !== auth.userId) return fail(404, 'Not found');

    try {
        const response = await proxyAudiobookBytes(
            {
                baseUrl: config.AUDIOURL,
                apiKey: auth.absApiKey,
                upstreamPath: absHlsPath(sessionId, file),
            },
            event.request,
            { signal: event.request.signal, method: upstreamMethod(event) },
        );
        if (!file.endsWith('.m3u8') || event.request.method === 'HEAD' || !response.ok)
            return response;
        const authParams = extractAuthParams(event.url);
        const rewriteUri = (uri: string): string => {
            const child = new URL(uri, event.url);
            // ABS manifests contain local children; never disclose grants upstream.
            if (child.origin !== event.url.origin) return uri;
            if (pathToken === 'playback' && child.pathname.startsWith('/hls/')) {
                const upstreamPrefix = `/hls/${sessionId}/`;
                if (!child.pathname.startsWith(upstreamPrefix))
                    throw new Error('Foreign audiobook HLS session');
                const publicPrefix = event.url.pathname.slice(
                    0,
                    event.url.pathname.lastIndexOf('/') + 1,
                );
                child.pathname = publicPrefix + child.pathname.slice(upstreamPrefix.length);
            }
            if (!child.pathname.includes('/api/')) return uri;
            addAuthToSearchParams(child.searchParams, authParams);
            return `${child.pathname}${child.search}`;
        };
        const playlist = (await response.text())
            .split('\n')
            .map((line) => {
                if (!line.trim()) return line;
                if (!line.startsWith('#')) return rewriteUri(line.trim());
                return line.replace(
                    /URI="([^"]+)"/g,
                    (_match, uri: string) => `URI="${rewriteUri(uri)}"`,
                );
            })
            .join('\n');
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-range');
        headers.delete('content-encoding');
        return new Response(playlist, { status: response.status, headers });
    } catch (error) {
        return handleProxyError(error, { mediaId, sessionId, file });
    }
}

/** Explicit HEAD exports also strip problem bodies before the adapter sees them. */
function withoutHeadBody(event: RequestEvent, response: Response): Response {
    if (event.request.method !== 'HEAD') return response;
    void response.body?.cancel().catch(() => {});
    return new Response(null, { status: response.status, headers: response.headers });
}
export async function handleAudiobookFile(event: RequestEvent): Promise<Response> {
    return withoutHeadBody(event, await audiobookFile(event));
}
export async function handleAudiobookRemux(event: RequestEvent): Promise<Response> {
    return withoutHeadBody(event, await audiobookRemux(event));
}
export async function handleAudiobookHls(event: RequestEvent): Promise<Response> {
    return withoutHeadBody(event, await audiobookHls(event));
}
