// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `-format_whitelist` value for the video-transcode input
 * (`FFmpegArgsBuilder.addInputFile` / `addConcatInputFile`,
 * `services/transcoding/ffmpeg-args-builder.ts`): every demuxer the RUNNING
 * ffmpeg binary has, minus the ones that open further inputs named by the
 * file's own content (fix plan 6, final wave F4).
 *
 * Why: the playlist sniff (`utils/playlist-sniff.ts`, `transcoding/input-guard.ts`)
 * reads the input and THEN ffmpeg opens it. A file rewritten into an ffconcat
 * or MPD body in between is demuxed by concat/dash, which read the files that
 * body names — `-protocol_whitelist file` does not stop a `file`-only chain.
 * With this list those demuxers are never selected: FFmpeg checks the whitelist
 * after probing, for auto-probed and forced `-f` inputs alike, and a probe
 * that picks an unlisted demuxer is a hard "Format not on whitelist" with no
 * fallback (libavformat/demux.c, n7.1). hls/dash/concat/imf copy the list into
 * their nested opens (`ff_copy_whiteblacklists`).
 *
 * Why enumerated, not a static list: the legitimate container set is
 * open-ended, and a static list refuses real media the moment it misses one —
 * the audiobook remux's static list shipped refusing real `.amr` books
 * (`a81a3e769`); for video the same miss fails every playback of that file.
 * Subtracting a small, known set from what the binary actually has cannot miss
 * a container the binary can play.
 *
 * NOT applied to the scanner's ffprobe: its refusal classification needs
 * ffprobe to NAME the playlist demuxer it picked.
 *
 * If enumeration fails (binary missing, timeout, unrecognised output) this
 * returns null and the caller sets no whitelist — the pre-F4 behaviour, still
 * covered by the sniff — rather than failing every transcode.
 */

import { execFile, execFileSync } from 'node:child_process';
import { config } from '../config.js';
import { Logger } from './logger.js';

const logger = Logger.for('MediaFormatWhitelist');

/**
 * Demuxers that open further inputs named by the content they parse.
 * `sdp` opens the RTP streams it describes; `sap` opens an SDP (only chosen
 * for `sap:` URLs, excluded as the same family). `webm_dash_manifest` parses
 * without opening segments; `image2` expands a pattern from the FILENAME, not
 * the content — both stay.
 */
export const REFERENCE_FOLLOWING_DEMUXERS: ReadonlySet<string> = new Set([
    'hls',
    'dash',
    'concat',
    'imf',
    'sdp',
    'sap',
]);

/**
 * What a whitelist value this module returns is made of (demuxer names are
 * `[a-z0-9_]`, joined by commas). The concat-list writer and its reader
 * (`buildConcatListContent` / `parseConcatListContent`) accept exactly this
 * inside the per-part `option format_whitelist '…'` line.
 */
export const FORMAT_WHITELIST_VALUE = /^[\w,-]+$/;

/** The concat demuxer — kept for the app's own concat-list input only. */
const CONCAT = 'concat';

/**
 * One row of `ffmpeg -demuxers`, after the `---` separator. cmdutils prints
 * `" %c%c%c %-15s %s"`: a space, the D/E/d flag columns (a space where unset),
 * a space, the name (comma-joined aliases, e.g. `mov,mp4,m4a,3gp,3g2,mj2` or
 * `video4linux2,v4l2`; a name longer than 15 is followed by one space), then
 * the description. Device rows (`D d`) are demuxers too.
 */
const DEMUXER_ROW = /^ D[E. ][d. ] (\S+)(?: |$)/;

/**
 * Demuxer names from `ffmpeg -hide_banner -demuxers` output, one entry per
 * row (aliases stay comma-joined, which `-format_whitelist` matches per token).
 * Only rows after the `---` separator count: the legend above it
 * (` D.. = Demuxing supported`) has the same shape. Returns null when there is
 * no separator or no row — output this parser does not recognise.
 */
export function parseDemuxerNames(output: string): string[] | null {
    const lines = output.split('\n');
    const sep = lines.findIndex((l) => /^\s*-{3,}\s*$/.test(l));
    if (sep === -1) return null;
    const names: string[] = [];
    for (const line of lines.slice(sep + 1)) {
        const m = DEMUXER_ROW.exec(line);
        if (m) names.push(m[1]);
    }
    return names.length > 0 ? names : null;
}

/**
 * The whitelist value for `names`: every row none of whose aliases is a
 * reference-following demuxer, except `concat` when `allowConcat`.
 */
export function buildFormatWhitelist(names: readonly string[], allowConcat: boolean): string {
    return names
        .filter((name) =>
            name
                .split(',')
                .every(
                    (alias) =>
                        !REFERENCE_FOLLOWING_DEMUXERS.has(alias) ||
                        (allowConcat && alias === CONCAT),
                ),
        )
        .join(',');
}

/**
 * libavformat's version from `ffmpeg -version` (`libavformat    61.  7.103 / …`),
 * as [major, minor], or null when the line is missing.
 */
export function parseLibavformatVersion(output: string): [number, number] | null {
    const m = /^libavformat\s+(\d+)\.\s*(\d+)\./m.exec(output);
    return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * The concat demuxer reads a per-file `option` directive since FFmpeg commit
 * 0210c8fee2 (2021-07); 5.0 (libavformat 59.16.100) is the first release with
 * it, and 4.x rejects the whole list on the line ("unknown keyword"). A git
 * build between the two is treated as unsupported — it just gets no line.
 */
const CONCAT_PART_OPTIONS_MIN_LAVF: readonly [number, number] = [59, 16];

const PROBE_TIMEOUT_MS = 10_000;
/** After a failed probe, how long callers get null before the next try. */
const RETRY_AFTER_FAILURE_MS = 60_000;

interface ProbeSlot<T> {
    /** null = the probe failed at `at`; retried after RETRY_AFTER_FAILURE_MS. */
    value: T | null;
    at: number;
}

interface ProbeKind<T> {
    args: string[];
    parse: (stdout: string) => T | null;
    /** Keyed by binary path, so switching FFMPEG_PATH back and forth never re-probes. */
    slots: Map<string, ProbeSlot<T>>;
    inFlight: Map<string, Promise<void>>;
}

const DEMUXERS: ProbeKind<string[]> = {
    args: ['-hide_banner', '-demuxers'],
    parse: parseDemuxerNames,
    slots: new Map(),
    inFlight: new Map(),
};
const LAVF_VERSION: ProbeKind<[number, number]> = {
    args: ['-hide_banner', '-version'],
    parse: parseLibavformatVersion,
    slots: new Map(),
    inFlight: new Map(),
};

const EXEC_OPTIONS = {
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
} as const;

function isSettled<T>(slot: ProbeSlot<T> | undefined): slot is ProbeSlot<T> {
    return !!slot && (slot.value !== null || Date.now() - slot.at < RETRY_AFTER_FAILURE_MS);
}

function settle<T>(
    kind: ProbeKind<T>,
    ffmpegPath: string,
    stdout: string | null,
    error?: unknown,
): ProbeSlot<T> {
    const value = stdout === null ? null : kind.parse(stdout);
    if (value === null) {
        logger.warn(
            `\`ffmpeg ${kind.args.join(' ')}\` failed; transcode inputs get no -format_whitelist from it`,
            {
                ffmpegPath,
                error:
                    error === undefined
                        ? 'unrecognised output'
                        : error instanceof Error
                          ? error.message
                          : String(error),
            },
        );
    }
    const slot = { value, at: Date.now() };
    kind.slots.set(ffmpegPath, slot);
    return slot;
}

/**
 * The cached probe result for this binary, probing SYNCHRONOUSLY only when
 * nothing prepared it: every spawn path awaits {@link prepareMediaFormatWhitelist}
 * first, so on the request path this is a cache read. (A sync spawn blocks the
 * whole event loop — up to the timeout if the binary hangs.)
 */
function probeSync<T>(kind: ProbeKind<T>, ffmpegPath: string): T | null {
    // No path, no binary: null without spawning.
    if (!ffmpegPath) return null;
    const cached = kind.slots.get(ffmpegPath);
    if (isSettled(cached)) return cached.value;
    try {
        return settle(
            kind,
            ffmpegPath,
            execFileSync(ffmpegPath, kind.args, {
                ...EXEC_OPTIONS,
                stdio: ['ignore', 'pipe', 'ignore'],
            }),
        ).value;
    } catch (error) {
        return settle(kind, ffmpegPath, null, error).value;
    }
}

function probeAsync<T>(kind: ProbeKind<T>, ffmpegPath: string): Promise<void> {
    if (isSettled(kind.slots.get(ffmpegPath))) return Promise.resolve();
    const pending = kind.inFlight.get(ffmpegPath);
    if (pending) return pending;
    const run = new Promise<void>((resolve) => {
        try {
            execFile(ffmpegPath, kind.args, EXEC_OPTIONS, (error, stdout) => {
                settle(kind, ffmpegPath, error ? null : stdout, error ?? undefined);
                resolve();
            });
        } catch (error) {
            settle(kind, ffmpegPath, null, error);
            resolve();
        }
    }).finally(() => kind.inFlight.delete(ffmpegPath));
    kind.inFlight.set(ffmpegPath, run);
    return run;
}

/**
 * Enumerate the binary's demuxers and libavformat version WITHOUT blocking the
 * event loop, so the synchronous getters below (called from the args builder)
 * read a warm cache. Awaited before every transcode spawn builds its argv
 * (`ffmpeg-transcode.service.ts`) and before the concat list is written
 * (`hls/playback.service.ts`). Never rejects; concurrent callers share one run.
 *
 * Returns null when there is nothing to wait for (no path, or both probes
 * settled), so the warm path adds no await: `const r = prepare…(); if (r) await r;`.
 */
export function prepareMediaFormatWhitelist(
    ffmpegPath: string = config.FFMPEG_PATH,
): Promise<void> | null {
    if (!ffmpegPath) return null;
    if (
        isSettled(DEMUXERS.slots.get(ffmpegPath)) &&
        isSettled(LAVF_VERSION.slots.get(ffmpegPath))
    ) {
        return null;
    }
    return Promise.all([
        probeAsync(DEMUXERS, ffmpegPath),
        probeAsync(LAVF_VERSION, ffmpegPath),
    ]).then(() => undefined);
}

const warnedEmpty = new Set<string>();

/**
 * `list`, or null when it is empty: a build whose every demuxer is excluded
 * would otherwise yield "", which the builder skips as "no whitelist" —
 * silently unprotected. Null says the same thing, with a warning.
 */
function nonEmpty(list: string, ffmpegPath: string): string | null {
    if (list) return list;
    if (!warnedEmpty.has(ffmpegPath)) {
        warnedEmpty.add(ffmpegPath);
        logger.warn(
            'This ffmpeg has only reference-following demuxers; transcode inputs get no -format_whitelist',
            { ffmpegPath },
        );
    }
    return null;
}

/**
 * `-format_whitelist` for a library media file input, or null when the
 * running binary's demuxers could not be enumerated (set no whitelist then).
 */
export function getMediaFormatWhitelist(ffmpegPath: string = config.FFMPEG_PATH): string | null {
    const names = probeSync(DEMUXERS, ffmpegPath);
    return names ? nonEmpty(buildFormatWhitelist(names, false), ffmpegPath) : null;
}

/**
 * `-format_whitelist` for the app's own concat-list input (`-f concat`): the
 * same list plus `concat`. FFmpeg copies it into every part's open, so a part
 * is still refused hls/dash/imf/sdp/sap — but not concat; see
 * {@link getConcatPartFormatWhitelist}.
 */
export function getConcatListFormatWhitelist(
    ffmpegPath: string = config.FFMPEG_PATH,
): string | null {
    const names = probeSync(DEMUXERS, ffmpegPath);
    return names ? nonEmpty(buildFormatWhitelist(names, true), ffmpegPath) : null;
}

/**
 * The media list for a per-part `option format_whitelist` line in the app's
 * concat list (`buildConcatListContent`, hls/playback.service.ts). The list
 * given to `-f concat` has to keep `concat` and every part's open inherits
 * it, so without this a part rewritten into an ffconcat body is followed; the
 * option overrides the inherited list for that part. The input guard's sniff
 * cannot cover it: the demuxer opens each part lazily, when playback reaches
 * it — minutes to hours after the spawn the sniff ran before.
 *
 * Null when the media list is null (then no option line), and when the binary's
 * libavformat predates the directive (a line there would fail the list).
 */
export function getConcatPartFormatWhitelist(
    ffmpegPath: string = config.FFMPEG_PATH,
): string | null {
    const media = getMediaFormatWhitelist(ffmpegPath);
    if (!media) return null;
    const lavf = probeSync(LAVF_VERSION, ffmpegPath);
    if (!lavf) return null;
    const [minMajor, minMinor] = CONCAT_PART_OPTIONS_MIN_LAVF;
    const supported = lavf[0] > minMajor || (lavf[0] === minMajor && lavf[1] >= minMinor);
    return supported ? media : null;
}

/** Test seam: forget the cached probes, any failure back-off and warnings. */
export function resetMediaFormatWhitelistCache(): void {
    for (const kind of [DEMUXERS, LAVF_VERSION] as ProbeKind<unknown>[]) {
        kind.slots.clear();
        kind.inFlight.clear();
    }
    warnedEmpty.clear();
}
