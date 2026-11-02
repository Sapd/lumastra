// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Transcoding extension handlers
//
// Implements the OpenSubsonic `transcoding` extension v1:
//   POST /rest/getTranscodeDecision.view?mediaId=<uuid>&mediaType=song
//     body: ClientInfo JSON
//     returns: subsonic-response with `transcodeDecision` object
//
//   GET /rest/getTranscodeStream.view?mediaId=&mediaType=song&transcodeParams=&offset=
//     returns: raw audio bytes (Content-Type per chosen codec)
//
// Decision flow:
//   1. Probe source (codec, container, bitrate, samplerate, channels).
//   2. Call `decideTranscode(client, source)` which returns
//      { canDirectPlay, canTranscode, transcodeReason, chosenTarget }.
//   3. If canTranscode and chosenTarget present, sign an opaque
//      `transcodeParams` token (HMAC) embedding the chosen codec/bitrate
//      plus a fingerprint of (path, mtime, srcCodec) so source mutations
//      invalidate the token.
//
// Stream flow:
//   1. Verify token signature + expiry + mediaId match.
//   2. Re-probe source. If fingerprint differs, error 70 (token stale).
//   3. Upsert a play_sessions row (shared util — same key as /stream),
//      then delegate to MusicTranscodeService.streamFor.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';

import { subsonicError, subsonicOk } from '$lib/server/subsonic-compat/serializers/response.js';
import type { SubsonicAuthContext, SubsonicHandler } from '$lib/server/subsonic-compat/types.js';
import { getParam } from '$lib/server/subsonic-compat/helpers.js';
import { CORS_HEADERS } from '$lib/server/subsonic-compat/constants.js';
import {
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
} from '$lib/server/utils/bounded-body-reader.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { upsertTranscodeSession } from '$lib/server/subsonic-compat/utils/transcode-session.js';
import { getTrackDetail } from '$lib/server/database/queries/music.queries.js';
import { checkSubsonicMediaAccess } from '$lib/server/subsonic-compat/media-access.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import {
    getMusicTranscodeService,
    signTranscodeToken,
    verifyTranscodeToken,
    decideTranscode,
    probeAudioSource,
    clampBitrate,
} from '$lib/server/services/music-transcode/index.js';
import type {
    ClientInfo as DecisionClientInfo,
    MediaProfile,
} from '$lib/server/services/music-transcode/decision.js';
import { config, features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

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

// ─── Spec → decision adapter ─────────────────────────────────────────────────
//
// The OpenSubsonic ClientInfo spec uses:
//   directPlayProfiles: [{ containers: string[], audioCodecs: string[], ... }]
//   transcodingProfiles: [{ container: string, audioCodec: string, ... }]
//
// while our decision module expects a flat list of { container, codec } pairs
// for each. Expand container × codec arrays here so callers can pass the raw
// spec-shape body unchanged.

interface SpecDirectPlayProfile {
    containers?: unknown;
    audioCodecs?: unknown;
    // Some clients send singular fields instead of arrays — accept both shapes.
    container?: unknown;
    audioCodec?: unknown;
}

interface SpecTranscodingProfile {
    container?: unknown;
    audioCodec?: unknown;
    // Plural variants for clients that mirror the directPlay shape.
    containers?: unknown;
    audioCodecs?: unknown;
}

interface SpecClientInfo {
    name?: unknown;
    platform?: unknown;
    maxAudioBitrate?: unknown;
    maxTranscodingAudioBitrate?: unknown;
    directPlayProfiles?: unknown;
    transcodingProfiles?: unknown;
}

/**
 * Coerce an unknown value into a non-empty string[] of values, or null if it
 * isn't an array. Empty array also returns null so callers can fall back to
 * a singular field.
 */
function toStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return out.length > 0 ? out : null;
}

function expandDirectPlay(profiles: unknown): MediaProfile[] {
    if (!Array.isArray(profiles)) return [];
    const out: MediaProfile[] = [];
    for (const raw of profiles) {
        if (!raw || typeof raw !== 'object') continue;
        const p = raw as SpecDirectPlayProfile;
        // Accept either plural arrays (spec shape) or singular fields (legacy
        // clients seen in the wild that send container/audioCodec directly).
        const containers =
            toStringArray(p.containers) ??
            (typeof p.container === 'string' && p.container.length > 0 ? [p.container] : []);
        const codecs =
            toStringArray(p.audioCodecs) ??
            (typeof p.audioCodec === 'string' && p.audioCodec.length > 0 ? [p.audioCodec] : []);
        if (containers.length === 0 || codecs.length === 0) continue;
        for (const container of containers) {
            for (const codec of codecs) {
                out.push({ container, codec });
            }
        }
    }
    return out;
}

function expandTranscoding(profiles: unknown): MediaProfile[] {
    if (!Array.isArray(profiles)) return [];
    const out: MediaProfile[] = [];
    for (const raw of profiles) {
        if (!raw || typeof raw !== 'object') continue;
        const p = raw as SpecTranscodingProfile;
        // Spec says transcoding profiles use singular container/audioCodec —
        // but accept plural too so clients that copy the directPlay shape
        // still parse correctly.
        const containers =
            toStringArray(p.containers) ??
            (typeof p.container === 'string' && p.container.length > 0 ? [p.container] : []);
        const codecs =
            toStringArray(p.audioCodecs) ??
            (typeof p.audioCodec === 'string' && p.audioCodec.length > 0 ? [p.audioCodec] : []);
        if (containers.length === 0 || codecs.length === 0) continue;
        for (const container of containers) {
            for (const codec of codecs) {
                out.push({ container, codec });
            }
        }
    }
    return out;
}

function toNumberOrUndefined(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return value;
}

/**
 * Map an OpenSubsonic-shape ClientInfo body to the flat MediaProfile lists
 * the decision module consumes. Returns null when the body is not a JSON
 * object — caller should error 10 in that case.
 */
function adaptClientInfo(raw: unknown): DecisionClientInfo | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as SpecClientInfo;
    return {
        name: typeof c.name === 'string' ? c.name : 'unknown',
        platform: typeof c.platform === 'string' ? c.platform : 'unknown',
        directPlayProfiles: expandDirectPlay(c.directPlayProfiles),
        transcodingProfiles: expandTranscoding(c.transcodingProfiles),
        maxAudioBitrate: toNumberOrUndefined(c.maxAudioBitrate),
        maxTranscodingAudioBitrate: toNumberOrUndefined(c.maxTranscodingAudioBitrate),
    };
}

// ─── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Short fingerprint of the source file's identity, embedded in the token.
 * If the file is replaced or transcoded since the decision was issued, the
 * fingerprint mismatches on the stream request and we error 70 — the client
 * must re-decide. Using (path, mtimeMs, srcCodec) catches the common cases
 * (file overwritten, metadata tag re-encoded) without needing a full hash.
 */
function fingerprint(srcPath: string, mtimeMs: number, srcCodec: string): string {
    return createHash('sha256')
        .update(`${srcPath}|${mtimeMs}|${srcCodec}`)
        .digest('hex')
        .slice(0, 16);
}

// ─── Body reader ─────────────────────────────────────────────────────────────

/**
 * C22/C26 fix-round-1 review finding: this was a bare `event.request.json()`
 * — the fifth hand-written reader outside every body cap, "the same class,
 * authenticated" as the C26 finding text names it. A `ClientInfo` body is a
 * handful of codec-capability fields; it is never legitimately large.
 */
const MAX_CLIENT_INFO_BODY_BYTES = 16 * 1024;

// Exported for unit tests (transcode-client-info-body.test.ts) — the rest of
// this handler needs a real Postgres connection + filesystem probes, so the
// body-size behavior is tested against this function directly rather than
// through the full integration suite.
export async function readClientInfoBody(
    event: RequestEvent,
): Promise<unknown | typeof BODY_TOO_LARGE> {
    if (isDeclaredContentLengthOverCap(event.request, MAX_CLIENT_INFO_BODY_BYTES)) {
        return BODY_TOO_LARGE;
    }
    const bodyText = await readBoundedBodyText(event.request, MAX_CLIENT_INFO_BODY_BYTES);
    if (bodyText === BODY_TOO_LARGE) return BODY_TOO_LARGE;
    if (bodyText.trim() === '') return null;
    try {
        return JSON.parse(bodyText);
    } catch {
        return null;
    }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * POST /rest/getTranscodeDecision.view
 *
 * Inspects the client's playback capabilities (`ClientInfo` body) against the
 * source file and returns a transcoding decision. If transcoding is required
 * and supported, includes a signed `transcodeParams` opaque token that the
 * client must pass back to `getTranscodeStream`.
 */
export const handleGetTranscodeDecision: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    if (!features.musicTranscode) {
        return subsonicError(0, 'Music transcoding is disabled.', auth.format);
    }
    const mediaId = getParam(event, 'mediaId');
    const mediaType = getParam(event, 'mediaType');
    if (!mediaId) {
        return subsonicError(10, 'Required parameter "mediaId" is missing.', auth.format);
    }
    if (mediaType !== 'song') {
        // Spec also allows 'podcast' but Lumastra's transcode service is
        // music-only for now.
        return subsonicError(0, `Unsupported mediaType: ${mediaType ?? '<missing>'}`, auth.format);
    }

    if (!(await checkSubsonicMediaAccess(sql, mediaId, auth))) {
        return subsonicError(70, 'Song not found.', auth.format);
    }

    const track = await getTrackDetail(sql, mediaId);
    if (!track || !track.file_path) {
        return subsonicError(70, 'Song not found.', auth.format);
    }
    const pathInfo = await resolveMediaPath(track.file_path, { skipLocalAccessCheck: true }, sql);
    if (!pathInfo?.isAccessible) {
        return subsonicError(
            0,
            `Audio file not accessible: ${pathInfo?.reason ?? 'unknown'}`,
            auth.format,
        );
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
        stat = await fs.stat(pathInfo.containerPath);
    } catch (err) {
        logger.warn('getTranscodeDecision: stat failed', {
            trackId: mediaId,
            err: err instanceof Error ? err.message : String(err),
        });
        return subsonicError(0, 'Audio file not accessible.', auth.format);
    }

    const source = await probeAudioSource(pathInfo.containerPath);

    const rawBody = await readClientInfoBody(event);
    if (rawBody === BODY_TOO_LARGE) {
        return subsonicError(0, 'Request body is too large.', auth.format);
    }
    const client = adaptClientInfo(rawBody);
    if (!client) {
        return subsonicError(10, 'Request body must be a JSON ClientInfo object.', auth.format);
    }

    const decision = decideTranscode(client, source);

    let transcodeParams: string | null = null;
    if (decision.canTranscode && decision.chosenTarget) {
        const fp = fingerprint(pathInfo.containerPath, stat.mtimeMs, source.codec);
        const exp = Math.floor(Date.now() / 1000) + config.MUSIC_TRANSCODE_TOKEN_TTL_HOURS * 3600;
        const bitrate = clampBitrate(decision.chosenTarget.codec, decision.chosenTarget.bitrate);
        transcodeParams = signTranscodeToken({
            v: 1,
            mid: mediaId,
            mt: 'song',
            c: decision.chosenTarget.codec,
            ct: decision.chosenTarget.container,
            br: bitrate,
            fp,
            exp,
        });
    }

    // Source bitrate is bps; the spec's audioBitrate field is kbps.
    const sourceBitrateKbps = source.bitrate > 0 ? Math.round(source.bitrate / 1000) : 0;

    const payload: Record<string, unknown> = {
        transcodeDecision: {
            canDirectPlay: decision.canDirectPlay,
            canTranscode: decision.canTranscode,
            transcodeReason: decision.transcodeReason,
            transcodeParams,
            sourceStream: {
                protocol: 'http',
                container: source.container,
                codec: source.codec,
                audioChannels: source.channels,
                audioBitrate: sourceBitrateKbps,
                audioSamplerate: source.sampleRate,
                audioBitdepth: source.bitDepth,
            },
            transcodeStream: decision.chosenTarget
                ? {
                      protocol: 'http',
                      container: decision.chosenTarget.container,
                      codec: decision.chosenTarget.codec,
                      audioChannels: 2,
                      audioBitrate: clampBitrate(
                          decision.chosenTarget.codec,
                          decision.chosenTarget.bitrate,
                      ),
                      audioSamplerate: decision.chosenTarget.codec === 'opus' ? 48000 : 44100,
                      audioBitdepth: 16,
                  }
                : null,
        },
    };

    return subsonicOk(payload, auth.format);
};

/**
 * GET /rest/getTranscodeStream.view
 *
 * Verifies the opaque `transcodeParams` token, re-probes the source to ensure
 * the fingerprint still matches, then delegates to `MusicTranscodeService`
 * for the actual transcode. Returns the raw audio body (NOT a Subsonic
 * envelope — matches the existing /stream contract).
 */
export const handleGetTranscodeStream: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    if (!features.musicTranscode) {
        return subsonicError(0, 'Music transcoding is disabled.', auth.format);
    }
    const mediaId = getParam(event, 'mediaId');
    const mediaType = getParam(event, 'mediaType');
    const transcodeParams = getParam(event, 'transcodeParams');
    const offsetParam = getParam(event, 'offset');

    if (!mediaId || !transcodeParams) {
        return subsonicError(10, 'Required parameters missing.', auth.format);
    }
    if (mediaType !== 'song') {
        return subsonicError(0, `Unsupported mediaType: ${mediaType ?? '<missing>'}`, auth.format);
    }

    const verify = verifyTranscodeToken(transcodeParams, mediaId);
    if (!verify.ok) {
        return subsonicError(70, `Invalid transcodeParams: ${verify.reason}`, auth.format);
    }
    const payload = verify.payload;

    if (!(await checkSubsonicMediaAccess(sql, mediaId, auth))) {
        return subsonicError(70, 'Song not found.', auth.format);
    }

    const track = await getTrackDetail(sql, mediaId);
    if (!track || !track.file_path) {
        return subsonicError(70, 'Song not found.', auth.format);
    }
    const pathInfo = await resolveMediaPath(track.file_path, { skipLocalAccessCheck: true }, sql);
    if (!pathInfo?.isAccessible) {
        return subsonicError(
            0,
            `Audio file not accessible: ${pathInfo?.reason ?? 'unknown'}`,
            auth.format,
        );
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
        stat = await fs.stat(pathInfo.containerPath);
    } catch (err) {
        logger.warn('getTranscodeStream: stat failed', {
            trackId: mediaId,
            err: err instanceof Error ? err.message : String(err),
        });
        return subsonicError(0, 'Audio file not accessible.', auth.format);
    }

    const source = await probeAudioSource(pathInfo.containerPath);

    // Fingerprint check — token is bound to the source file's identity.
    // Re-encoded or replaced files force the client to call getTranscodeDecision
    // again (which sees fresh metadata).
    const expectedFp = fingerprint(pathInfo.containerPath, stat.mtimeMs, source.codec);
    if (expectedFp !== payload.fp) {
        return subsonicError(
            70,
            'Source file changed; please request a new transcodeParams.',
            auth.format,
        );
    }

    // Parse offset (spec name) — falls back to 0.
    const timeOffset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : 0;

    // Mirror /stream's session-upsert. The MusicTranscodeService writes a
    // row to active_transcode_jobs whose play_session_id FK requires this row.
    const playSessionId = await upsertTranscodeSession({
        surface: 'subsonic',
        sql,
        authUserId: auth.userId,
        clientName: auth.clientName,
        trackId: mediaId,
        codec: payload.c,
        bitrateKbps: payload.br,
        timeOffset,
    });
    if (!playSessionId) {
        return subsonicError(0, 'Failed to record transcode session.', auth.format);
    }

    const service = getMusicTranscodeService(sql);
    try {
        const result = await service.streamFor({
            trackUuid: mediaId,
            sourcePath: pathInfo.containerPath,
            sourceMtimeMs: stat.mtimeMs,
            codec: payload.c,
            bitrateKbps: payload.br,
            timeOffset,
            session: {
                sessionId: playSessionId,
                userId: auth.userId,
                // Distinct deviceId from /stream so admin UI can tell the
                // two endpoints apart per (user, track).
                deviceId: `subsonic-tx-${auth.username}`,
                source: 'subsonic-tx',
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
                ...CORS_HEADERS,
            },
        });
    } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 415) {
            // PlaylistSourceRefusedError: the stored file is a
            // playlist/manifest body, never transcoded.
            logger.warn('Music transcode refused a non-audio source', {
                trackId: mediaId,
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
            // Log it: this used to return silently, so a client whose bulk
            // download was being rejected left no trace in the app log at all
            // and looked like a client-side network problem.
            logger.warn('getTranscodeStream rejected: transcode slots exhausted', {
                trackId: mediaId,
                username: auth.username,
                globalCap: config.MUSIC_TRANSCODE_MAX_CONCURRENT,
                perUserCap: config.MUSIC_TRANSCODE_MAX_PER_USER,
                waitMs: config.MUSIC_TRANSCODE_QUEUE_WAIT_MS,
            });
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
            'getTranscodeStream failure',
            err instanceof Error ? err : new Error(String(err)),
            { trackId: mediaId },
        );
        return subsonicError(0, 'Transcode failed.', auth.format);
    }
};
