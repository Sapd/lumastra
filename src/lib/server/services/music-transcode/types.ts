// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A transcode target. This is a codec+container pair, not just a codec:
 * `aac` is raw ADTS and `m4a` is the same AAC bitstream inside an MP4
 * container. They are separate members on purpose — the container is what
 * decides whether a downloaded file opens at all (AVFoundation refuses raw
 * ADTS from disk), and modelling it here means every exhaustive switch,
 * the cache key, and the cache file extension are all forced to account for
 * it rather than silently reusing the ADTS entry.
 */
export type MusicCodec = 'mp3' | 'opus' | 'aac' | 'm4a';

/**
 * Narrow an arbitrary string to a codec this service can actually encode.
 *
 * `config.MUSIC_TRANSCODE_DEFAULT_CODEC` is a plain string — the settings UI
 * offers a select, but an env var does not go through it — and both callers
 * used to reach the encoder via `as MusicCodec`, which asserts rather than
 * checks. A typo there produced ffmpeg args for a codec that does not exist,
 * failing at spawn time on every request instead of at config load.
 */
export function parseMusicCodec(value: string | null | undefined): MusicCodec | null {
    return value === 'mp3' || value === 'opus' || value === 'aac' || value === 'm4a' ? value : null;
}

export interface EncodeArgsInput {
    srcPath: string;
    bitrateKbps: number;
    timeOffset: number; // seconds, 0 = start
}

export interface StreamCopySeekArgsInput {
    cachedPath: string;
    codec: MusicCodec;
    timeOffset: number;
    /**
     * Where to write. Required for `m4a` and rejected as a pipe: the mp4
     * muxer seeks back over its own output, which stdout cannot do. Omit for
     * every other codec — they stream straight to `pipe:1`.
     */
    outPath?: string;
}

import type { UserId } from '$lib/shared/user-id';

export interface AacExtraOptions {
    hasFdkAac: boolean;
}

/**
 * Prefix marking a session id that is NOT a `play_sessions` row.
 *
 * A download must not register as playback — the session upsert writes an
 * ACTIVE row and closes the user's other music sessions, so pulling an album
 * for offline use would log twelve plays and tear down whatever is actually
 * playing. Downloads therefore get a synthetic id purely to key the transcode
 * service's slot and dedup bookkeeping.
 *
 * Anything that persists a session id must check for this first:
 * `active_transcode_jobs.play_session_id` is `uuid NOT NULL` with an FK to
 * `play_sessions`, so a synthetic id can neither be cast nor referenced.
 */
export const SYNTHETIC_SESSION_PREFIX = 'download:';

/**
 * Prefix for a transcode that OUR OWN player is fetching while it already
 * reports the listen through `/play-sessions/{id}` (a `Lumastra Music` row).
 *
 * A second row for the same listen showed up in Active Streams as a separate
 * "Subsonic" stream and counted against the user's stream cap: the iOS app
 * preloads the NEXT track into its idle deck, so the extra row was always one
 * track ahead of what was audible. The player's own row is the listen; this
 * id only keys the transcode service's slot and dedup bookkeeping, exactly
 * like a download's.
 */
export const PLAYER_SESSION_PREFIX = 'player:';

/** True when this id keys bookkeeping only and has no `play_sessions` row. */
export function isSyntheticSessionId(sessionId: string): boolean {
    return (
        sessionId.startsWith(SYNTHETIC_SESSION_PREFIX) ||
        sessionId.startsWith(PLAYER_SESSION_PREFIX)
    );
}

export interface SessionContext {
    /** play_sessions.id (UUID), or a {@link SYNTHETIC_SESSION_PREFIX} id. */
    sessionId: string;
    userId: UserId;
    /** Client name / token id */
    deviceId: string;
    source: 'subsonic' | 'subsonic-tx' | 'api' | 'public-api';
}

export interface TranscodeStreamRequest {
    trackUuid: string;
    sourcePath: string;
    sourceMtimeMs: number;
    /** Duration of the selected source file, in seconds. */
    durationSeconds?: number;
    sourceSize?: number;
    /** Source bitrate in bits per second, when known. */
    sourceBitrate?: number;
    codec: MusicCodec;
    /** Already clamped to the codec's allowed bitrate ladder. */
    bitrateKbps: number;
    /** Seconds, 0 = start. */
    timeOffset: number;
    session: SessionContext;
    /**
     * Inbound request's abort signal (e.g. `request.signal` from the route
     * handler). Wired into the service's internal AbortController so a
     * client disconnect during slot-acquisition, cache-wait, or encoding
     * releases delivery promptly. Shared progressive encodes retain their
     * slot for a short reconnect grace period after the last reader leaves.
     */
    abortSignal?: AbortSignal;
    /**
     * The request's raw `Range` header. Set — even to `null` — only by a
     * caller that turns a 206 result (and a `status: 416` error) into a
     * response; leave it `undefined` and the service never advertises or
     * honours ranges.
     *
     * Known-duration MP3 ranges can tail a CBR encode while it is still running.
     * Other cold ranges wait for a finished file.
     */
    rangeHeader?: string | null;
}

export interface TranscodeStreamResult {
    body: ReadableStream<Uint8Array>;
    contentType: string;
    /** Length of THIS body — the slice, for a 206. */
    contentLength: number | null;
    acceptRanges: 'bytes' | 'none';
    /** 206 with `contentRange` when a range was served; 200 otherwise. */
    status: 200 | 206;
    contentRange?: string;
    cacheState: 'live' | 'seek' | 'cached' | 'dedup';
}
