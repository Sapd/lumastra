// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The audiobook remux — one ffmpeg, one file, straight into the response body.
 *
 * ## What it is for
 *
 * AudiobookShelf direct-plays an E-AC-3 track inside an `.m4b` because its
 * `checkCanDirectPlay` matches bare container MIME types and the container says
 * `audio/mp4`. Chromium then fails with `EncodingError: Unable to decode audio
 * data`; WebKit plays it. 39 of 3384 files in the measured library are in that
 * state (2 books). This module is the fix: re-encode the one file the listener
 * is on into AAC and pipe it.
 *
 * "Remux" is the name the design gave it, but the operation is a **re-encode**:
 * no browser decodes E-AC-3 in any container (measured — see
 * `$lib/shared/audiobook-remux-codecs.ts`), so moving the same stream into a
 * different box would change nothing. Only the audio is touched; there is
 * nothing else in the file.
 *
 * ## Deliberately NOT the video HLS pipeline
 *
 * Segments, trickplay, ABR ladders, master playlists, generation promotion and
 * seek-storm handling all exist to serve a picture that can be scrubbed frame
 * by frame. A book is one continuous mono/stereo stream a listener moves through
 * in 30-second skips. Routing it through the video pipeline would buy nothing
 * and inherit its entire failure surface. One process, one pipe.
 *
 * ## THE SEEK CONSEQUENCE — restart-on-seek, and why
 *
 * A piped ffmpeg output has no length and no byte↔time map, so it cannot answer
 * `Range`. The response is therefore `200` + `Accept-Ranges: none`, and a seek
 * is a **new request** with a new `startSeconds` — `-ss` before `-i`, which
 * makes ffmpeg seek the INPUT rather than decode-and-discard.
 *
 * The alternative was a pre-transcoded cached artifact. Measured, against the
 * real library, this is why it lost:
 *
 * | | restart-on-seek (chosen) | pre-transcoded artifact |
 * | --- | --- | --- |
 * | first audio after a seek | **1.7 s** (measured, `-ss 1800` into a 266 MB file) | the whole file must encode first |
 * | disk | none | ~1.6 GB of books ×N listeners, plus an eviction policy |
 * | new state to get wrong | none | ready/partial/failed per artifact, cross-replica sharing, cache invalidation on file replacement |
 * | in-file scrub inside buffered audio | ✗ re-request | ✓ |
 *
 * The artifact variant is the video pipeline again, rebuilt smaller, for two
 * books. And the thing it buys — Range seeking — the client does not need: the
 * player already restarts the element at a file offset on every cross-file seek
 * and knows every track's duration from the timeline, so it never asks the
 * element how long the stream is. What it gives up is a scrub *within already
 * buffered* audio, which costs one 1.7 s re-request.
 *
 * `-ss` is cheap only because the input is HTTP with Range support. Measured on
 * the same 266 MB file, seeking to 45 minutes:
 *
 * - `-ss 2700 -i <http url>` → **0.85 s wall, 0.19 s CPU**
 * - `curl … | ffmpeg -ss 2700 -i pipe:0` → **8.56 s wall, 2.74 s CPU**, and the
 *   whole 266 MB pulled
 *
 * So the input is fetched by ffmpeg over HTTP, not piped in from Node. The cost
 * of that choice is documented at {@link buildAudiobookRemuxArgs}.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { Logger } from '../utils/logger.js';
import { getMediaFormatWhitelist } from '../utils/media-format-whitelist.js';

const logger = Logger.for('AudiobookRemux');

/**
 * Output codec and container.
 *
 * ADTS AAC, not fragmented MP4: it needs no header rewrite to be streamable,
 * every engine measured reports `audio/aac` playable (Chrome `"probably"`,
 * WebKit `"maybe"`), and the music transcode path already serves live ADTS with
 * `Accept-Ranges: none` in production — so this is a proven shape here, not a
 * new one.
 *
 * The encoder is ffmpeg's built-in `aac`, never `libfdk_aac`: jellyfin-ffmpeg
 * (the production binary, fetched at boot per the Dockerfile) is a GPL build
 * without fdk, and a codec that is absent on the deployed binary would fail
 * every request on the box it matters on.
 */
export const AUDIOBOOK_REMUX_CONTENT_TYPE = 'audio/aac';

/**
 * 128 kbit/s stereo.
 *
 * The sources are 768 kbit/s 6-channel E-AC-3 full-cast productions (measured);
 * 128 k AAC is transparent enough for spoken word with music and effects, and
 * keeps a phone on mobile data comfortable. Fixed rather than derived from the
 * source: a per-file bitrate would make the job's cost unpredictable for the
 * admin surface without improving anything audible.
 */
const TARGET_BITRATE = '128k';

/**
 * Six channels down to two.
 *
 * The listener is on headphones or a phone speaker. Passing 5.1 through would
 * also defeat the point — AAC 5.1 in ADTS is far less universally decodable than
 * stereo, and the measured output (`ch=2`) is what Chrome accepted.
 */
const TARGET_CHANNELS = '2';

/**
 * `active_transcode_jobs.output_dir` is `NOT NULL`, and this job writes nothing
 * to disk.
 *
 * A sentinel rather than a plausible-looking path, for a specific reason: the
 * expired-job sweep in `ffmpeg-transcode.service.ts` recursively deletes
 * `output_dir` for rows it reaps, guarded only by `isPathInsideDirectory(dir,
 * FFMPEG_TRANSCODE_DIR)`. Anything that resolved inside the transcode root
 * would be `rm -rf`'d; anything that merely *looked* like a real directory would
 * mislead the admin UI, which renders this string verbatim. `(pipe)` cannot
 * resolve into the transcode root and says what it is.
 */
export const AUDIOBOOK_REMUX_OUTPUT_DIR = '(pipe)';

/**
 * Per-user, per-pod concurrency.
 *
 * Restart-on-seek means one listener dragging the scrubber can ask for several
 * encodes in a second, and each is a real ffmpeg. The cap bounds that without
 * needing a cluster round-trip: a per-pod bound is enough to stop one client
 * consuming a host, which is the failure this guards.
 *
 * Two, not one: a seek arrives while the previous stream is still being torn down
 * (the client's old `<audio>` src is dropped asynchronously), so a cap of one
 * would reject the seek that replaces it.
 */
const activeRemuxesByUser = new Map<string, number>();

/**
 * Take one slot, or null when the user is at the cap.
 *
 * The returned release is idempotent — the caller wires it to several terminal
 * events on purpose, because ffmpeg close, body cancel and abort are different
 * events and any of them can be the one that happens.
 */
export function acquireAudiobookRemuxSlot(userId: string): (() => void) | null {
    const cap = config.AUDIOBOOK_REMUX_MAX_PER_USER;
    if (cap <= 0) return () => {};

    const current = activeRemuxesByUser.get(userId) ?? 0;
    if (current >= cap) return null;
    activeRemuxesByUser.set(userId, current + 1);

    let released = false;
    return () => {
        if (released) return;
        released = true;
        const remaining = (activeRemuxesByUser.get(userId) ?? 1) - 1;
        if (remaining <= 0) activeRemuxesByUser.delete(userId);
        else activeRemuxesByUser.set(userId, remaining);
    };
}

/** Test-only: the slot map is module state and would leak across cases. */
export function _resetAudiobookRemuxSlots(): void {
    activeRemuxesByUser.clear();
}

/**
 * The demuxers ffmpeg may pick for the remux INPUT when the running binary's
 * own list cannot be enumerated.
 *
 * Normally {@link startAudiobookRemux} passes `getMediaFormatWhitelist()`
 * (`utils/media-format-whitelist.ts`): every demuxer the binary has minus the
 * reference-following ones (hls, dash, concat, imf, sdp, sap). That cannot miss
 * a real container — this hand-written list already did once (`.amr`,
 * `a81a3e769`). This list is the FALLBACK, never "no list": unlike the video
 * path, whose null means "no whitelist, the playlist sniff still covers it",
 * the remux reads an HTTP body nothing sniffs, so no list would reopen the
 * leak below.
 *
 * The input is an AudiobookShelf URL fetched with the LISTENER's key in
 * `-headers`, and ffmpeg chooses the demuxer from the body. A book whose content
 * is a manifest — DASH `<MPD` and IMF are detected by content alone, whatever
 * the file is called — makes ffmpeg fetch the segments it names from ANY host,
 * and the http layer sends the same `Authorization` header to each. Measured on
 * the production jellyfin-ffmpeg 7.1.4 (2026-09-26): an MPD served as a book
 * delivered `Bearer <key>` to a second host. HLS and ffconcat bodies take the
 * same nested-open path.
 *
 * A demuxer allowlist closes that; `-protocol_whitelist` cannot: the second host
 * is plain http, which the input itself needs, and `file://` is already refused
 * without one (an http input's nested opens inherit the http protocol's default
 * whitelist — measured).
 *
 * Covers every container AudiobookShelf serves as audio (m4b/m4a/mp4, mp3,
 * flac, ogg/opus/oga, aac, wma, wav, aiff, webm/mka, caf, awb, mpeg) plus the
 * raw streams of the remux codecs (ac3, eac3, dts, truehd, mlp). Measured: a
 * file of each, over HTTP with Range, remuxes byte-identically with and without
 * this list, including after `-ss`. A container missing here fails that one
 * remux with "Format not on whitelist" in the job's error — it never plays
 * something else.
 */
const FALLBACK_INPUT_FORMAT_WHITELIST = [
    'mov',
    'matroska',
    'mp3',
    'flac',
    'ogg',
    'aac',
    'asf',
    'wav',
    'aiff',
    'caf',
    // `amr` is the container a real `.amr`/`.awb` (with its `#!AMR` header)
    // demuxes as; `amrnb`/`amrwb` are the headerless raw streams.
    'amr',
    'amrwb',
    'amrnb',
    'mpeg',
    'ac3',
    'eac3',
    'dts',
    'truehd',
    'mlp',
].join(',');

export interface AudiobookRemuxSource {
    /** Fully-formed upstream URL of the ONE file being remuxed. */
    url: string;
    /** The listening user's ABS API key. */
    apiKey: string;
    /** Where in the FILE to start, seconds. 0 for the head. */
    startSeconds: number;
}

/**
 * Build the ffmpeg argv.
 *
 * Pure and exported so the argv is asserted directly — every mistake available
 * here (a dropped `-vn`, `-ss` landing *after* `-i` and so becoming an
 * output-side decode-and-discard, a missing `-map`) is invisible in a
 * higher-level test that only checks that bytes arrived.
 *
 * ## The credential is in the argv, and that is a trade-off, not an oversight
 *
 * ffmpeg has no way to take an HTTP header out of band — `-headers` is the only
 * mechanism — so the listener's ABS key is visible in `/proc/<pid>/cmdline` to
 * anything running as, or above, the app user on the same host. The two
 * alternatives were measured and both are worse:
 *
 *  - **Pipe the body in from Node** (no credential in argv): kills input
 *    seeking. 8.56 s and 266 MB per seek instead of 0.85 s and a few MB.
 *  - **Point ffmpeg at our own byte-proxy route** (a stream token in argv rather
 *    than the ABS key): the stream token is pinned to the client's IP, so a
 *    loopback fetch from ffmpeg fails validation by construction.
 *
 * The key is already in this process's config and in the database, and the
 * container runs a single user — so the exposure is to a local attacker who
 * already has code execution as that user. Documented rather than hidden.
 */
export function buildAudiobookRemuxArgs(
    source: AudiobookRemuxSource,
    /** `-format_whitelist` value; see {@link FALLBACK_INPUT_FORMAT_WHITELIST}. */
    inputFormatWhitelist: string = FALLBACK_INPUT_FORMAT_WHITELIST,
): string[] {
    if (!Number.isFinite(source.startSeconds) || source.startSeconds < 0) {
        throw new Error(`Invalid remux startSeconds: ${source.startSeconds}`);
    }
    return [
        '-hide_banner',
        '-loglevel',
        'error',
        // CRLF-terminated: that is what ffmpeg's http protocol expects, and a
        // bare \n is silently tolerated by some builds and not others.
        '-headers',
        `Authorization: Bearer ${source.apiKey}\r\n`,
        // A 40-hour book is a long-lived HTTP read; a dropped upstream socket
        // would otherwise end the stream mid-sentence and look to the listener
        // like the file simply stopped.
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5',
        // BEFORE -i, so ffmpeg seeks the input over HTTP Range. After -i this
        // same flag decodes the whole file up to the offset and throws it away
        // (measured: 8.56 s vs 0.85 s).
        ...(source.startSeconds > 0 ? ['-ss', String(source.startSeconds)] : []),
        // An INPUT option, so before -i. See FALLBACK_INPUT_FORMAT_WHITELIST.
        '-format_whitelist',
        inputFormatWhitelist,
        '-i',
        source.url,
        // `-vn` drops the embedded cover art, which ffmpeg presents as a video
        // stream. Without it the ADTS muxer is handed a stream it cannot write
        // and the whole job fails.
        '-vn',
        '-map',
        '0:a:0',
        '-c:a',
        'aac',
        '-b:a',
        TARGET_BITRATE,
        '-ac',
        TARGET_CHANNELS,
        '-f',
        'adts',
        'pipe:1',
    ];
}

export interface AudiobookRemuxStream {
    /** ffmpeg stdout, as a web stream for the Response body. */
    body: ReadableStream<Uint8Array>;
    /** For `active_transcode_jobs.ffmpeg_pid`; null if the spawn never got one. */
    pid: number | null;
    /** Terminate the process. Idempotent. */
    stop: () => void;
}

export interface AudiobookRemuxOptions {
    /** Aborted when the client disconnects. */
    signal?: AbortSignal;
    /**
     * Called once when the process is done.
     *
     * `ok` is false ONLY for a genuine failure. A client that simply stops
     * listening makes us SIGTERM ffmpeg, and ffmpeg then exits **255** with
     * `Immediate exit requested` (measured) — recording that as an error would
     * paint every normal pause red in the admin surface.
     */
    onExit?: (result: { ok: boolean; code: number | null; error?: string }) => void;
    /** Injected in tests. */
    spawnImpl?: typeof spawn;
    /** Injected in tests; defaults to `config.FFMPEG_PATH`. */
    ffmpegPath?: string;
}

/**
 * Spawn one remux and hand back its stdout as a web stream.
 *
 * The process is killed on client disconnect, on body cancellation and on
 * stream error — all three, because all three happen: a listener closing a tab,
 * a seek superseding the request, and a network drop are different events and
 * only the first arrives as an abort.
 */
export function startAudiobookRemux(
    source: AudiobookRemuxSource,
    options: AudiobookRemuxOptions = {},
): AudiobookRemuxStream {
    const doSpawn = options.spawnImpl ?? spawn;
    const binary = options.ffmpegPath ?? config.FFMPEG_PATH;
    // Enumerated for the binary that will actually run (cached per path).
    const args = buildAudiobookRemuxArgs(
        source,
        getMediaFormatWhitelist(binary) ?? FALLBACK_INPUT_FORMAT_WHITELIST,
    );

    // `stdio: ['ignore', 'pipe', 'pipe']` types stdin as null and stdout/stderr as
    // non-null Readables, which is exactly the shape wanted: ffmpeg reads stdin by
    // default and would otherwise compete with the parent process for it, while
    // stdout must be a stream and not `| null`.
    const proc: ChildProcessByStdio<null, Readable, Readable> = doSpawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    /**
     * True only when WE asked the process to die.
     *
     * Kept strictly separate from "the pipe closed", which also happens on every
     * normal and every failed exit. Conflating the two — e.g. by wiring `stop`
     * to stdout's `close` event — makes a genuine non-zero ffmpeg exit arrive
     * with the flag already set, and the job is then recorded as a clean stop.
     * That is a silent-success bug of exactly the shape this integration keeps
     * producing, so it is spelled out rather than left to reading order.
     */
    let killRequested = false;
    let settled = false;
    let stderrTail = '';

    const stop = (): void => {
        if (killRequested) return;
        killRequested = true;
        if (!proc.killed) proc.kill('SIGTERM');
    };

    proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2048);
    });

    const settle = (result: { ok: boolean; code: number | null; error?: string }): void => {
        if (settled) return;
        settled = true;
        options.onExit?.(result);
    };

    proc.on('error', (error) => {
        // Spawn failure (ENOENT on the ffmpeg binary, EACCES) — the stream never
        // produced a byte, so this IS an error however the caller stopped.
        logger.error('Audiobook remux could not start ffmpeg', error, { binary });
        settle({ ok: false, code: null, error: error.message });
    });

    proc.on('close', (code) => {
        // `killRequested` is the whole distinction between "the listener stopped
        // listening" and "the encode broke". See AudiobookRemuxOptions.onExit.
        if (killRequested || code === 0) {
            settle({ ok: true, code });
            return;
        }
        logger.warn('Audiobook remux ffmpeg exited non-zero', { code, stderrTail });
        settle({ ok: false, code, error: stderrTail || `ffmpeg exited ${code}` });
    });

    if (options.signal) {
        if (options.signal.aborted) stop();
        else options.signal.addEventListener('abort', stop, { once: true });
    }

    const stdout = proc.stdout;
    const body = Readable.toWeb(stdout) as ReadableStream<Uint8Array>;

    // A consumer that cancels the body destroys this Readable, which closes it
    // WITHOUT an `end`. Left unkilled, ffmpeg would go on encoding into a pipe
    // nobody drains for the rest of the book. `end` before `close` is the normal
    // EOF path and must NOT count as a cancellation — that is the difference
    // between "the tab went away" and "ffmpeg finished/failed on its own".
    let sawEnd = false;
    stdout.once('end', () => {
        sawEnd = true;
    });
    stdout.once('close', () => {
        if (!sawEnd) stop();
    });
    stdout.once('error', stop);

    return { body, pid: proc.pid ?? null, stop };
}
