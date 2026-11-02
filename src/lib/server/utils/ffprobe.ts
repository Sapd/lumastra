// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FFprobe Utilities for Media Analysis
 *
 * Probes local media files (any path ffprobe accepts, not Jellyfin-specific)
 * for stream, format, HDR, keyframe and chapter information used throughout
 * playback, transcoding and library scanning.
 */

import { execFile, spawn } from 'child_process';
import { extname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'util';
import { config } from '../config.js';
import { Logger } from './logger.js';
import { isRecord } from '$lib/utils/data-extraction';
import {
    type AbsoluteStreamIndex,
    type AudioRelativeIndex,
    asAbsoluteStreamIndex,
    asAudioRelativeIndex,
} from '$lib/shared/stream-index';
import { dvBaseLayerIsHdr } from '../services/transcoding/types.js';
import { ffprobeLibraryInputArgs } from './library-input-guard.js';
import { MEDIA_PROTOCOL_WHITELIST } from './media-protocol-whitelist.js';
import { mediaEndFromStreams, reconcileRuntimeSeconds } from './media-duration.js';

const execFileAsync = promisify(execFile);
const logger = Logger.for('FFprobe');

/**
 * Node enforces `maxBuffer` independently on stdout AND stderr (default
 * 1 MB). `-v error` means stderr is no longer guaranteed near-empty — a
 * corrupt file whose demuxer trial-decode emits many AV_LOG_ERROR lines can
 * exceed the default and SIGTERM the child, turning a probe that used to
 * succeed under `-v quiet` into `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. Applied
 * explicitly to every execFileAsync-based probe below so that headroom is a
 * deliberate choice, not the accidental 1 MB default.
 */
const FFPROBE_MAX_BUFFER = 8 * 1024 * 1024;

// ============================================================================
// Types for FFprobe JSON output
// ============================================================================

interface FFprobeStreamDisposition {
    default?: number;
    dub?: number;
    original?: number;
    comment?: number;
    lyrics?: number;
    karaoke?: number;
    forced?: number;
    hearing_impaired?: number;
    visual_impaired?: number;
    clean_effects?: number;
    attached_pic?: number;
    timed_thumbnails?: number;
}

interface FFprobeStreamTags {
    language?: string;
    title?: string;
    [key: string]: string | undefined;
}

interface FFprobeStream {
    index: number;
    codec_name?: string;
    codec_type?: string;
    channels?: number;
    channel_layout?: string;
    sample_rate?: string;
    bit_rate?: string;
    /** Seconds; present for mp4/ts streams, absent for MKV (see tags.DURATION). */
    duration?: string;
    disposition?: FFprobeStreamDisposition;
    tags?: FFprobeStreamTags;
    // Video-specific fields
    width?: number;
    height?: number;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    pix_fmt?: string;
    color_space?: string;
    color_transfer?: string;
    color_primaries?: string;
    refs?: number;
    profile?: string;
    level?: number;
    closed_captions?: number;
    /** 'progressive' | 'tt' | 'bb' | 'tb' | 'bt' | 'unknown' (absent for non-video) */
    field_order?: string;
    side_data_list?: Array<Record<string, unknown>>;
}

interface FFprobeFormat {
    filename?: string;
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
}

/** MKV stores per-stream averages in mkvmerge statistics tags, not bit_rate. */
function streamBitrate(stream: FFprobeStream): number | null {
    for (const value of [stream.bit_rate, stream.tags?.BPS, stream.tags?.['BPS-eng']]) {
        const bitrate = Number(value);
        if (Number.isFinite(bitrate) && bitrate > 0) return Math.round(bitrate);
    }
    return null;
}

/**
 * A forced/"signs" track carries only the handful of cues that translate foreign
 * dialogue or on-screen text, so it is small in absolute terms…
 */
const FORCED_SUBTITLE_MAX_CUES = 250;
/** …and dwarfed by the full track for the same language. */
const FORCED_SUBTITLE_SIBLING_RATIO = 5;

/**
 * Read a per-track cue count out of the container's statistics tags.
 *
 * mkvmerge stamps NUMBER_OF_FRAMES (sometimes language-suffixed, e.g.
 * `NUMBER_OF_FRAMES-eng`) into each track, so this costs nothing beyond the
 * header read ffprobe already does — no demux. Returns undefined when the tag is
 * absent, which is the common case for non-mkvmerge containers.
 */
function subtitleCueCount(stream: FFprobeStream): number | undefined {
    const tags = stream.tags;
    if (!tags) return undefined;
    const key = Object.keys(tags).find((k) => /^NUMBER_OF_FRAMES(-|$)/i.test(k));
    const raw = key === undefined ? undefined : tags[key];
    // Strict digits-only: Number.parseInt('1,234') silently yields 1, which would
    // drag a large track under the forced ceiling.
    if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Infer which subtitle streams are forced when the container does not say so.
 *
 * The `forced` disposition flag is authoritative but frequently unset — plenty of
 * remuxes ship a forced/signs track with no flag, no title, and the same language
 * as the full track, leaving them indistinguishable in a track picker. Burning one
 * in then looks identical to "subtitles are broken": you get a few dozen cues
 * across a whole film.
 *
 * A track is inferred forced only when a same-language sibling proves it is the
 * small one — both an absolute ceiling and a ratio against the largest track in
 * its language group must hold. A language with a single subtitle track is never
 * inferred, since there is nothing to compare against; that stays conservative and
 * simply leaves the flag as the container reported it.
 */
export function inferForcedSubtitleIndexes(streams: FFprobeStream[]): Set<number> {
    const inferred = new Set<number>();
    const byLanguage = new Map<string, Array<{ index: number; cues: number }>>();

    for (const s of streams) {
        const cues = subtitleCueCount(s);
        if (cues === undefined) continue;
        // An untagged track has no established sibling relationship — bucketing
        // every such track under 'und' would compare unrelated subtitle sets.
        const language = s.tags?.language?.toLowerCase();
        if (!language) continue;
        const group = byLanguage.get(language) ?? [];
        group.push({ index: s.index, cues });
        byLanguage.set(language, group);
    }

    for (const group of byLanguage.values()) {
        if (group.length < 2) continue;
        const largest = Math.max(...group.map((t) => t.cues));
        const smallest = Math.min(...group.map((t) => t.cues));
        // Flag at most ONE track per language. `isForced` also drives DEFAULT=YES on
        // the HLS rendition, and a group carrying two DEFAULT=YES members is invalid
        // — so with e.g. [30, 40, 2000] cues, only the 30 qualifies. A tie for
        // smallest is ambiguous, so nothing is inferred.
        if (group.filter((t) => t.cues === smallest).length > 1) continue;
        const candidate = group.find((t) => t.cues === smallest);
        if (
            candidate &&
            candidate.cues <= FORCED_SUBTITLE_MAX_CUES &&
            largest >= candidate.cues * FORCED_SUBTITLE_SIBLING_RATIO
        ) {
            inferred.add(candidate.index);
        }
    }

    return inferred;
}

interface FFprobeOutput {
    streams?: FFprobeStream[];
    format?: FFprobeFormat;
}

const isFFprobeStream = (value: unknown): value is FFprobeStream =>
    isRecord(value) && typeof value.index === 'number';

const isFFprobeFormat = (value: unknown): value is FFprobeFormat => isRecord(value);

// ============================================================================
// Container normalization
// ============================================================================

/**
 * Derive the canonical container name from a file path's extension.
 *
 * ffprobe's `format_name` is NOT safe for container compatibility checks because
 * it uses internal demuxer names, not file extensions:
 *   - MKV files report `"matroska,webm"` — comma-separated, falsely matches WebM caps
 *   - MP4 files report `"mov,mp4,m4a,3gp,3g2,mj2"` — not usable as-is
 *
 * Always pass the container through this function before calling checkCompatibility().
 * Returns null for unknown/unmapped extensions so the caller can fall back gracefully.
 */
export function containerFromExtension(filePath: string): string | null {
    const ext = extname(filePath).toLowerCase();
    const MAP: Record<string, string> = {
        '.mkv': 'mkv',
        '.webm': 'webm',
        '.mp4': 'mp4',
        '.m4v': 'mp4',
        '.mov': 'mov',
        '.avi': 'avi',
        '.ts': 'ts',
        '.m2ts': 'ts',
        '.mpg': 'mpeg',
        '.mpeg': 'mpeg',
    };
    return MAP[ext] ?? null;
}

export interface AudioStreamInfo {
    /** Index within audio streams (0-based, for -map 0:a:N). Display / mapping only — NEVER the wire selection value. */
    audioRelativeIndex: AudioRelativeIndex;
    /** Absolute stream index in file (includes video, subs). Canonical wire/selection value. */
    absoluteIndex: AbsoluteStreamIndex;
    /** Audio codec (aac, ac3, dts, etc.) */
    codec: string;
    /** Number of audio channels */
    channels: number;
    /** Channel layout (stereo, 5.1, etc.) */
    channelLayout?: string;
    /** Sample rate in Hz */
    sampleRate?: number;
    /** Bit rate in bps */
    bitRate?: number;
    /** Language code (ISO 639) */
    language?: string;
    /** Stream title/name */
    title?: string;
    /**
     * Codec profile string (e.g. "Dolby Digital Plus + Dolby Atmos", "DTS-HD MA").
     * Best-effort — ffprobe only populates it for some codecs. Used downstream
     * to infer Atmos for the quality badge.
     */
    profile?: string;
    /** Whether this is the default audio track */
    isDefault: boolean;
    /** Whether this audio track is a visual-impaired / audio-description track */
    isVisualImpaired: boolean;
}

/**
 * Get a short version of a file path for logging (last 2 components).
 */
function getShortPath(filePath: string): string {
    return filePath.split('/').slice(-2).join('/');
}

// ============================================================================
// Full media probe types and function
// ============================================================================

export interface VideoStreamInfo {
    index: number;
    codec: string; // e.g. 'h264', 'hevc', 'av1'
    width: number;
    height: number;
    fps: number | null; // frames per second
    pixelFormat: string | null; // e.g. 'yuv420p', 'yuv420p10le'
    colorPrimaries: string | null; // e.g. 'bt2020', 'bt709'
    colorTransfer: string | null; // e.g. 'smpte2084', 'bt709'
    refFrames: number | null; // small integer, often 1-4
    bitrate: number | null; // bits/sec
    hdr: 'hdr10' | 'hdr10plus' | 'hlg' | 'dovi' | 'dovi_hdr10' | 'sdr';
    colorSpace: string | null;
    profile: string | null;
    /** Codec level (e.g. 51 for H.264 Level 5.1, 153 for HEVC Level 5.1). */
    level: number | null;
    /** FFmpeg -master_display string extracted from side_data, e.g. "G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)" */
    masterDisplay: string | null;
    /** FFmpeg -max_cll string extracted from side_data, e.g. "1000,400" */
    maxCll: string | null;
    /** Dolby Vision profile number (5, 7, 8) from DOVI configuration record */
    dvProfile?: number;
    /** Dolby Vision level from DOVI configuration record */
    dvLevel?: number;
    /** Dolby Vision base layer signal compatibility ID (1=HDR10, 2=SDR, 4=HLG) */
    dvBlSignalCompatibilityId?: number;
    /** Whether the video stream carries embedded closed captions (CEA-608/708) */
    closedCaptions: boolean;
    /**
     * ffprobe `field_order` as reported ('progressive', 'tt', 'bb', 'tb', 'bt',
     * 'unknown'), null/absent when ffprobe did not report one. See
     * isInterlacedFieldOrder().
     */
    fieldOrder?: string | null;
}

export interface SubtitleStreamInfo {
    index: number;
    codec: string; // e.g. 'subrip', 'ass', 'dvd_subtitle'
    language: string | null;
    title: string | null;
    isDefault: boolean;
    isForced: boolean;
    /** Whether this subtitle track is a hearing-impaired / SDH track */
    isHearingImpaired: boolean;
}

export interface MediaProbeResult {
    success: boolean;
    error?: string;
    /**
     * Why a failed probe failed (set only when `success` is false). See
     * {@link classifyProbeFailure} for how each kind is recognised.
     */
    failureKind?: ProbeFailureKind;
    video: VideoStreamInfo | null;
    audioStreams: AudioStreamInfo[];
    subtitleStreams: SubtitleStreamInfo[];
    duration: number | null; // seconds
    container: string | null; // e.g. 'matroska,webm', 'mov,mp4,m4a,3gp,3g2,mj2'
    fileSize: number | null; // bytes
    /**
     * File-level (container) bitrate from ffprobe format.bit_rate.
     * Covers all streams combined. Prefer this over video.bitrate for the
     * media_files.total_bitrate column. May be null for some MKV containers.
     */
    formatBitrate: number | null;
    /**
     * Chapters from the same ffprobe run. Set only when the probe was made with
     * `{ chapters: true }` (see {@link probeMediaFile}); an empty array means the
     * file has no chapters.
     */
    chapters?: ChapterInfo[];
}

/**
 * Why a `probeMediaFile` call failed.
 *
 * - `aborted` — the caller's AbortSignal fired; says nothing about the file.
 * - `reference-demuxer` — a reference-following demuxer (concat, hls, dash,
 *   imf) logged an error: the file is a playlist/manifest body, and any
 *   "Invalid data" that follows describes a file it REFERENCES, not this one.
 * - `invalid-data` — ffprobe ran to completion and rejected the file's own
 *   content as not a readable/recognised container.
 * - `transient` — everything else: the probe timed out (a FIFO, a spun-down
 *   disk), ffprobe could not be spawned (bad `FFPROBE_PATH`), or it exited
 *   with an I/O, permission or not-found error. None of these is a verdict on
 *   the file's bytes, so a caller must not record one as a property of the file
 *   (the misdiagnosis `trickplay-generator.service.ts` documents for
 *   `container_unreadable`).
 */
export type ProbeFailureKind = 'aborted' | 'reference-demuxer' | 'invalid-data' | 'transient';

/**
 * An av_log line from one of the reference-following demuxers. FFmpeg prefixes
 * every such line with `[<demuxer name> @ 0x…] `, always at the start of the
 * line. ffprobe's own `<path>: <error>` lines start with the path as it was
 * passed, and every caller passes an absolute path (leading `/`), so anchoring
 * to the line start keeps a directory named `[concat @ x]` from matching.
 */
const REFERENCE_DEMUXER_LINE = /^\[(?:concat|hls|dash|imf) @ /m;

/**
 * ffprobe's final stderr line for a file whose CONTENT it rejected:
 * `<path>: <AVERROR text>`. Only the LAST non-empty line is tested, anchored at
 * its end, so a folder named after one of these texts (`…/Invalid data found
 * when processing input (2020)/x.mkv: Permission denied`) stays transient. The
 * texts are `libavutil/error.c`'s AVERROR_INVALIDDATA, AVERROR_DEMUXER_NOT_FOUND
 * and AVERROR_PATCHWELCOME.
 */
const INVALID_DATA_LAST_LINE =
    /: (?:Invalid data found when processing input|Demuxer not found|Not yet implemented in FFmpeg, patches welcome)$/;

/**
 * Classify a `probeMediaFile` failure from the error `execFile` rejected with.
 *
 * The structured fields decide everything they can: `name === 'AbortError'`
 * (`code: 'ABORT_ERR'`) for an abort; `killed`/`signal` for the timeout
 * kill; a STRING `code` (e.g. `'ENOENT'`, with `syscall: 'spawn …'`) for a
 * spawn failure — a child that ran and exited carries a NUMERIC exit code
 * instead. ffprobe reports every failure with the same exit status, so the
 * rest is read from stderr: a reference-demuxer line anywhere
 * ({@link REFERENCE_DEMUXER_LINE}), then the anchored last line
 * ({@link INVALID_DATA_LAST_LINE}).
 */
export function classifyProbeFailure(error: unknown): ProbeFailureKind {
    if (!(error instanceof Error)) return 'transient';
    const e = error as Error & {
        code?: unknown;
        killed?: unknown;
        signal?: unknown;
        stderr?: unknown;
    };
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return 'aborted';
    const stderr = typeof e.stderr === 'string' ? e.stderr : '';
    if (REFERENCE_DEMUXER_LINE.test(stderr)) return 'reference-demuxer';
    if (e.killed === true || (typeof e.signal === 'string' && e.signal !== '')) {
        return 'transient';
    }
    if (typeof e.code !== 'number') return 'transient';
    const lines = stderr.split('\n').map((l) => l.trimEnd());
    const lastLine = lines.filter((l) => l !== '').at(-1) ?? '';
    return INVALID_DATA_LAST_LINE.test(lastLine) ? 'invalid-data' : 'transient';
}

/**
 * Parse an FFprobe frame rate fraction string (e.g. "24000/1001") into a number.
 * Returns null if the string is missing, "0/0", or unparseable.
 */
function parseFrameRate(rate: string | undefined): number | null {
    if (!rate) return null;
    const slashIdx = rate.indexOf('/');
    if (slashIdx === -1) {
        const n = parseFloat(rate);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    const num = parseInt(rate.substring(0, slashIdx), 10);
    const den = parseInt(rate.substring(slashIdx + 1), 10);
    if (!den || !Number.isFinite(num) || !Number.isFinite(den)) return null;
    const fps = num / den;
    return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

/**
 * Parse a fraction string like "13250/50000" to a number.
 * Returns null if unparseable.
 */
function parseFraction(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const slashIdx = value.indexOf('/');
    if (slashIdx === -1) {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : null;
    }
    const num = parseInt(value.substring(0, slashIdx), 10);
    const den = parseInt(value.substring(slashIdx + 1), 10);
    if (!den || !Number.isFinite(num) || !Number.isFinite(den)) return null;
    return num / den;
}

/**
 * Normalize an ffprobe color-tag string to either a clean value or null.
 * ffprobe emits "unknown", "reserved", "N/A", and "" for missing/unmappable
 * color metadata on SDR sources; we don't want those leaking to clients.
 */
export function normalizeColorTag(value: string | undefined): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const lowered = trimmed.toLowerCase();
    if (
        lowered === 'unknown' ||
        lowered === 'reserved' ||
        lowered === 'n/a' ||
        lowered === 'unspecified' ||
        lowered === 'und'
    ) {
        return null;
    }
    return lowered;
}

/**
 * Derive video bit depth from an FFprobe pixel-format string.
 *
 * Planar formats: yuv420p10le, gbrp10le — "p10"/"p12" before the le/be suffix.
 * Hardware formats: p010le, p210le — "p" + subsampling digit + depth.
 * Must NOT match nv12 (8-bit chroma format) or yuv410p/yuv411p (subsampling
 * digits, 8-bit). A recognized format without a depth marker is 8-bit;
 * missing/empty input returns undefined (depth unknown).
 */
export function deriveBitDepthFromPixelFormat(
    pixelFormat: string | null | undefined,
): number | undefined {
    if (!pixelFormat) return undefined;
    if (/(?:^p.?|p)12(le|be)?$/.test(pixelFormat)) return 12;
    if (/(?:^p.?|p)10(le|be)?$/.test(pixelFormat)) return 10;
    return 8;
}

/**
 * Extract HDR10 mastering display metadata from FFprobe side_data_list.
 *
 * Looks for "Mastering display metadata" entries and formats them into the
 * FFmpeg `-master_display` string format: G(x,y)B(x,y)R(x,y)WP(x,y)L(max,min)
 *
 * FFprobe reports coordinates as fractions of /50000 and luminance as fractions
 * of /10000. These are already in the units FFmpeg expects, so we just need
 * the numerators.
 */
export function extractMasterDisplay(
    sideDataList: Array<Record<string, unknown>> | undefined,
): string | null {
    if (!sideDataList) return null;
    const entry = sideDataList.find((sd) => sd.side_data_type === 'Mastering display metadata');
    if (!entry) return null;

    const gx = parseFraction(entry.green_x);
    const gy = parseFraction(entry.green_y);
    const bx = parseFraction(entry.blue_x);
    const by = parseFraction(entry.blue_y);
    const rx = parseFraction(entry.red_x);
    const ry = parseFraction(entry.red_y);
    const wpx = parseFraction(entry.white_point_x);
    const wpy = parseFraction(entry.white_point_y);
    const maxLum = parseFraction(entry.max_luminance);
    const minLum = parseFraction(entry.min_luminance);

    // All fields required
    if (
        gx === null ||
        gy === null ||
        bx === null ||
        by === null ||
        rx === null ||
        ry === null ||
        wpx === null ||
        wpy === null ||
        maxLum === null ||
        minLum === null
    ) {
        return null;
    }

    // FFmpeg expects integer values in the native units:
    // chromaticity as numerator of /50000, luminance as numerator of /10000
    const toChroma = (v: number): number => Math.round(v * 50000);
    const toLum = (v: number): number => Math.round(v * 10000);

    return (
        `G(${toChroma(gx)},${toChroma(gy)})` +
        `B(${toChroma(bx)},${toChroma(by)})` +
        `R(${toChroma(rx)},${toChroma(ry)})` +
        `WP(${toChroma(wpx)},${toChroma(wpy)})` +
        `L(${toLum(maxLum)},${toLum(minLum)})`
    );
}

/**
 * Extract content light level metadata from FFprobe side_data_list.
 * Returns the FFmpeg `-max_cll` format: "MaxCLL,MaxFALL"
 */
export function extractMaxCll(
    sideDataList: Array<Record<string, unknown>> | undefined,
): string | null {
    if (!sideDataList) return null;
    const entry = sideDataList.find((sd) => sd.side_data_type === 'Content light level metadata');
    if (!entry) return null;

    const maxContent =
        typeof entry.max_content === 'number'
            ? entry.max_content
            : typeof entry.max_content === 'string'
              ? parseInt(entry.max_content, 10)
              : null;
    const maxAverage =
        typeof entry.max_average === 'number'
            ? entry.max_average
            : typeof entry.max_average === 'string'
              ? parseInt(entry.max_average, 10)
              : null;

    if (
        maxContent === null ||
        !Number.isFinite(maxContent) ||
        maxAverage === null ||
        !Number.isFinite(maxAverage)
    )
        return null;
    return `${maxContent},${maxAverage}`;
}

/**
 * Extract Dolby Vision metadata from FFprobe DOVI configuration record.
 */
function extractDoviInfo(sideDataList?: Array<Record<string, unknown>>): {
    dvProfile: number;
    dvLevel: number;
    dvBlSignalCompatibilityId: number;
} | null {
    const doviRecord = sideDataList?.find(
        (sd) => sd.side_data_type === 'DOVI configuration record',
    );
    if (!doviRecord) return null;
    const dvProfile = typeof doviRecord.dv_profile === 'number' ? doviRecord.dv_profile : undefined;
    if (dvProfile === undefined) return null;
    return {
        dvProfile,
        dvLevel: typeof doviRecord.dv_level === 'number' ? doviRecord.dv_level : 6,
        dvBlSignalCompatibilityId:
            typeof doviRecord.dv_bl_signal_compatibility_id === 'number'
                ? doviRecord.dv_bl_signal_compatibility_id
                : 0,
    };
}

/**
 * Detect HDR type from FFprobe stream metadata.
 * Checks profile name, color_transfer, and side_data_list for DOVI config records.
 */
export function detectHdr(
    colorTransfer: string | undefined,
    profile: string | undefined,
    sideDataList?: Array<Record<string, unknown>>,
): VideoStreamInfo['hdr'] {
    const p = profile?.toLowerCase() ?? '';
    // Check Dolby Vision first — profile check must precede smpte2084 because
    // DV Profile 8 (dual-layer) uses HDR10 base layer and reports smpte2084
    // color_transfer alongside a DV codec profile name.
    const doviInfo = extractDoviInfo(sideDataList);

    const isDovi =
        p.includes('dovi') ||
        p.startsWith('dvh') ||
        p.startsWith('dve') ||
        colorTransfer?.toLowerCase().includes('dovi') ||
        doviInfo !== null;

    if (isDovi) {
        // Whether DV can degrade gracefully is decided by the base-layer signal
        // compatibility id, NOT the profile number: 1 = HDR10 base, 2 = SDR base,
        // 4 = HLG base, 0 = none (pure DV, e.g. profile 5). Keying on `profile === 8`
        // missed profile 10 (DV over AV1), which is just as cross-compatible when its
        // compatibility id says so, and would have forced it into a needless
        // re-encode. Profile 8 remains the fallback for files probed before the
        // compatibility id was captured.
        // dovi_hdr10 here means "degrades to an HDR base layer, so it may be copied";
        // dovi means "must be re-encoded". dvBaseLayerIsHdr owns that rule — notably
        // it covers profile 10 (DV over AV1) and excludes the SDR-base 8.2 variant.
        return dvBaseLayerIsHdr(doviInfo?.dvBlSignalCompatibilityId ?? 0, doviInfo?.dvProfile)
            ? 'dovi_hdr10'
            : 'dovi';
    }
    if (colorTransfer === 'smpte2084' || colorTransfer === 'st2084') {
        // Distinguish HDR10+ from HDR10 by checking for dynamic metadata in side_data
        const hasHdr10Plus = sideDataList?.some(
            (sd) => typeof sd.side_data_type === 'string' && sd.side_data_type.includes('HDR10+'),
        );
        return hasHdr10Plus ? 'hdr10plus' : 'hdr10';
    }
    if (colorTransfer === 'arib-std-b67' || colorTransfer === 'hlg') return 'hlg';
    return 'sdr';
}

/**
 * Probe all streams of a media file using FFprobe.
 * Returns video, audio, and subtitle stream info plus container metadata.
 *
 * @param filePath - Path to the media file
 * @param timeoutMs - Timeout in milliseconds (default: 15000)
 * @param options.signal - Optional abort signal. When it fires the
 *   ffprobe child process is SIGKILL'd; callers see the failure as
 *   `success: false` with an AbortError message so a soft-budget drain
 *   exits instantly instead of waiting for the 15s timeout.
 */
/**
 * Pick the real primary video stream, skipping attached-picture streams.
 *
 * Embedded album/cover art is exposed by ffprobe as a `video` stream with
 * `disposition.attached_pic = 1` (typically mjpeg/png). It is NOT real video.
 * Treating it as such made music files look like they "have video", so the
 * media-probe keyframe stage probed them, found zero keyframes, and falsely
 * flagged them `no_keyframes` (20k+ false positives on a music library).
 */
/** ffprobe field orders that mean the stream carries interlaced fields. */
const INTERLACED_FIELD_ORDERS = new Set(['tt', 'bb', 'tb', 'bt']);

/**
 * Whether an ffprobe `field_order` describes interlaced video. `tt`/`bb` are
 * top/bottom field first coded+displayed in the same order, `tb`/`bt` coded in
 * one order and displayed in the other — all four need a deinterlacer.
 * 'progressive', 'unknown' and absent are treated as progressive: deinterlacing
 * progressive frames only softens them, so a missing signal must not trigger it.
 */
export function isInterlacedFieldOrder(fieldOrder: string | null | undefined): boolean {
    return !!fieldOrder && INTERLACED_FIELD_ORDERS.has(fieldOrder.toLowerCase());
}

export function selectPrimaryVideoStream<
    T extends { codec_type?: string; disposition?: { attached_pic?: number } },
>(streams: readonly T[]): T | undefined {
    return streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
}

/**
 * Parse one ffprobe keyframe CSV line ("pts_time,dts_time,flags").
 *
 * Returns the packet timestamp and whether it is a keyframe, or null if the
 * line carries no usable timestamp. AVI/mpeg4 packets report `pts_time` as
 * `N/A` but a usable `dts_time`; falling back to dts keeps their keyframes from
 * being dropped (which otherwise looks like zero keyframes → bogus
 * `no_keyframes` health issue).
 */
export function parseKeyframePacketLine(
    line: string,
): { time: number; isKeyframe: boolean } | null {
    const firstComma = line.indexOf(',');
    if (firstComma === -1) return null;
    const secondComma = line.indexOf(',', firstComma + 1);
    if (secondComma === -1) return null;
    let t = parseFloat(line.substring(0, firstComma));
    if (!Number.isFinite(t)) {
        t = parseFloat(line.substring(firstComma + 1, secondComma));
    }
    if (!Number.isFinite(t)) return null;
    return { time: t, isKeyframe: line.indexOf('K', secondComma) !== -1 };
}

/**
 * Library probe: streams, format and (with `chapters: true`) chapters, from one
 * ffprobe run. Without `chapters` the argument list is exactly the one the
 * scanner has always used.
 */
export async function probeMediaFile(
    filePath: string,
    timeoutMs = 15000,
    options: { signal?: AbortSignal; chapters?: boolean } = {},
): Promise<MediaProbeResult> {
    const ffprobePath = config.FFPROBE_PATH;
    const empty: MediaProbeResult = {
        success: false,
        video: null,
        audioStreams: [],
        subtitleStreams: [],
        duration: null,
        container: null,
        fileSize: null,
        formatBitrate: null,
    };

    try {
        const args = [
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_streams',
            '-show_format',
            ...(options.chapters ? ['-show_chapters'] : []),
            // P1+R2 residual (S-P1c): the media plane is local-disk-only —
            // see media-protocol-whitelist.ts — so the library probe never
            // needs anything beyond `file`.
            '-protocol_whitelist',
            MEDIA_PROTOCOL_WHITELIST,
            filePath,
        ];

        // Node's child_process accepts `{ signal }` natively — aborting
        // kills the subprocess. killSignal: 'SIGKILL' is required because
        // ffprobe traps SIGTERM and may continue processing for several
        // seconds; SIGKILL terminates it immediately so a soft-budget abort
        // exits the slot at once instead of dragging for up to 15 s.
        const { stdout } = await execFileAsync(ffprobePath, args, {
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: FFPROBE_MAX_BUFFER,
            ...(options.signal ? { signal: options.signal } : {}),
        });

        const parsed: unknown = JSON.parse(stdout);
        const data: FFprobeOutput = {};
        if (isRecord(parsed)) {
            const streams = parsed.streams;
            if (Array.isArray(streams)) {
                data.streams = streams.filter(isFFprobeStream);
            }
            const format = parsed.format;
            if (isFFprobeFormat(format)) {
                data.format = format;
            }
        }

        const allStreams = data.streams ?? [];
        const chapters = options.chapters
            ? mapFfprobeChapters(isRecord(parsed) ? parsed.chapters : undefined)
            : undefined;

        const videoStreamRaw = selectPrimaryVideoStream(allStreams);

        const audioStreamsRaw = allStreams.filter((s) => s.codec_type === 'audio');
        const subtitleStreamsRaw = allStreams.filter((s) => s.codec_type === 'subtitle');

        const video: VideoStreamInfo | null = videoStreamRaw
            ? {
                  index: videoStreamRaw.index,
                  codec: videoStreamRaw.codec_name ?? 'unknown',
                  width: videoStreamRaw.width ?? 0,
                  height: videoStreamRaw.height ?? 0,
                  fps:
                      parseFrameRate(videoStreamRaw.r_frame_rate) ??
                      parseFrameRate(videoStreamRaw.avg_frame_rate),
                  pixelFormat: videoStreamRaw.pix_fmt ?? null,
                  bitrate: streamBitrate(videoStreamRaw),
                  hdr: detectHdr(
                      videoStreamRaw.color_transfer,
                      videoStreamRaw.profile,
                      videoStreamRaw.side_data_list,
                  ),
                  colorSpace: normalizeColorTag(videoStreamRaw.color_space),
                  colorPrimaries: normalizeColorTag(videoStreamRaw.color_primaries),
                  colorTransfer: normalizeColorTag(videoStreamRaw.color_transfer),
                  refFrames:
                      typeof videoStreamRaw.refs === 'number' &&
                      Number.isFinite(videoStreamRaw.refs) &&
                      videoStreamRaw.refs > 0
                          ? videoStreamRaw.refs
                          : null,
                  profile: videoStreamRaw.profile ?? null,
                  level: typeof videoStreamRaw.level === 'number' ? videoStreamRaw.level : null,
                  masterDisplay: extractMasterDisplay(videoStreamRaw.side_data_list),
                  maxCll: extractMaxCll(videoStreamRaw.side_data_list),
                  ...extractDoviInfo(videoStreamRaw.side_data_list),
                  closedCaptions: videoStreamRaw.closed_captions === 1,
                  fieldOrder: videoStreamRaw.field_order ?? null,
              }
            : null;

        let audioIndex = 0;
        const audioStreams: AudioStreamInfo[] = audioStreamsRaw.map((s) => ({
            audioRelativeIndex: asAudioRelativeIndex(audioIndex++),
            absoluteIndex: asAbsoluteStreamIndex(s.index),
            codec: s.codec_name ?? 'unknown',
            channels: s.channels ?? 2,
            channelLayout: s.channel_layout,
            sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) : undefined,
            bitRate: streamBitrate(s) ?? undefined,
            language: s.tags?.language,
            title: s.tags?.title,
            profile: s.profile,
            isDefault: s.disposition?.default === 1,
            isVisualImpaired: s.disposition?.visual_impaired === 1,
        }));

        const inferredForced = inferForcedSubtitleIndexes(subtitleStreamsRaw);
        const subtitleStreams: SubtitleStreamInfo[] = subtitleStreamsRaw.map((s) => ({
            index: s.index,
            codec: s.codec_name ?? 'unknown',
            language: s.tags?.language ?? null,
            title: s.tags?.title ?? null,
            isDefault: s.disposition?.default === 1,
            isForced: s.disposition?.forced === 1 || inferredForced.has(s.index),
            isHearingImpaired: s.disposition?.hearing_impaired === 1,
        }));

        const format = data.format;
        const parsedDuration = format?.duration ? parseFloat(format.duration) : NaN;
        const containerDuration =
            Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null;
        const mediaEnd = mediaEndFromStreams(allStreams);
        const duration = reconcileRuntimeSeconds(containerDuration, mediaEnd);
        if (duration !== containerDuration && containerDuration !== null) {
            logger.warn('Container duration is implausible; using the video/audio duration', {
                filePath,
                containerDuration,
                mediaEnd,
            });
        }

        return {
            success: true,
            video,
            audioStreams,
            subtitleStreams,
            duration,
            container: format?.format_name ?? null,
            fileSize: format?.size ? parseInt(format.size, 10) : null,
            formatBitrate: format?.bit_rate ? parseInt(format.bit_rate, 10) : null,
            ...(chapters ? { chapters } : {}),
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const failureKind = classifyProbeFailure(error);
        logger.warn('Failed to probe media file', {
            filePath: getShortPath(filePath),
            error: errorMessage,
            failureKind,
        });
        return { ...empty, error: errorMessage, failureKind };
    }
}

// ============================================================================
// Fast stream-count probe
// ============================================================================

export interface StreamCounts {
    video: number;
    audio: number;
    subtitle: number;
    /**
     * `field_order` of the primary video stream (first non-cover-art video),
     * null when there is none or ffprobe reported none. Rides along on this
     * probe because media_streams has no field-order column: it is the only
     * place the transcode path learns that a native-library file is interlaced
     * (DVD rips, TV recordings) without a second ffprobe.
     */
    videoFieldOrder?: string | null;
}

/**
 * Cheap ffprobe call that just counts streams by type — used as a consistency
 * check against cached DB rows. Skips codec/HDR/format parsing to keep cost
 * low (~20-50ms typical), so it can run on every playback request. Also reads
 * the primary video stream's field order (codec parameters ffprobe fills while
 * opening the file anyway — no extra decode).
 */
export async function probeStreamCounts(
    filePath: string,
    timeoutMs: number = 5000,
    signal?: AbortSignal,
): Promise<StreamCounts | null> {
    const ffprobePath = config.FFPROBE_PATH;
    if (!ffprobePath) return null;

    try {
        const args = [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_type,field_order:stream_disposition=attached_pic',
            '-of',
            'json',
            ...(await ffprobeLibraryInputArgs()),
            filePath,
        ];
        const { stdout } = await execFileAsync(ffprobePath, args, {
            timeout: timeoutMs,
            signal,
            // Node enforces maxBuffer independently on stdout AND stderr, so
            // this cap also bounds the `-v error` diagnostic chatter a
            // corrupt/pathological file can emit on stderr, not just the
            // codec_type-only stdout payload the original comment reasoned
            // about. 2 MB comfortably covers both a many-stream BD payload
            // and a noisy demuxer error while still protecting against
            // runaway output — this probe runs on every playback request.
            maxBuffer: 2 * 1024 * 1024,
        });
        const counts: StreamCounts = { video: 0, audio: 0, subtitle: 0, videoFieldOrder: null };
        const parsed: unknown = JSON.parse(stdout);
        if (isRecord(parsed) && Array.isArray(parsed.streams)) {
            let primaryVideoSeen = false;
            for (const s of parsed.streams) {
                if (isRecord(s)) {
                    if (s.codec_type === 'video') {
                        const disposition = isRecord(s.disposition) ? s.disposition : undefined;
                        // Attached cover art is not a playable video track and
                        // is excluded from cached media_streams video rows.
                        if (disposition?.attached_pic === 1) continue;
                        counts.video++;
                        // Same "primary" rule as selectPrimaryVideoStream: an
                        // embedded cover (attached_pic) is never the picture we
                        // transcode, and reports itself as progressive.
                        if (!primaryVideoSeen) {
                            primaryVideoSeen = true;
                            counts.videoFieldOrder =
                                typeof s.field_order === 'string' ? s.field_order : null;
                        }
                    } else if (s.codec_type === 'audio') counts.audio++;
                    else if (s.codec_type === 'subtitle') counts.subtitle++;
                }
            }
        }
        return counts;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to probe stream counts', {
            filePath: getShortPath(filePath),
            error: errorMessage,
        });
        return null;
    }
}

// ============================================================================
// Keyframe probe
// ============================================================================

export interface KeyframeProbeResult {
    keyframes: number[];
    success: boolean;
    error?: string;
    /**
     * Highest video packet PTS (seconds) seen during the scan — i.e. where the
     * video actually ends. Present on success. The last KEYFRAME can sit a
     * whole GOP (x264 default ≈10 s) before the end, so health checks must
     * compare this, not the last keyframe, with the container duration.
     */
    lastPacketPts?: number;
}

export interface ProbeKeyframesOptions {
    /** Timeout in milliseconds (default: 120000 — 2 minutes) */
    timeoutMs?: number;
    /**
     * Called periodically with the latest packet PTS (in seconds) seen in
     * ffprobe stdout. Divide by the file's total duration to compute a 0..1
     * progress fraction.
     */
    onProgress?: (currentPts: number) => void;
    /** Minimum ms between onProgress callbacks (default: 500) */
    progressThrottleMs?: number;
    /**
     * External abort signal. When fired the ffprobe child process is
     * killed with SIGKILL and the promise resolves with
     * `{ success: false, error: 'aborted' }`. Used by the sync drain's
     * soft-budget machinery to stop keyframe probing (a single 2-hour
     * movie can otherwise hold the slot for 90s even after stop fires).
     */
    signal?: AbortSignal;
}

/**
 * Probe keyframe (I-frame) positions in a media file.
 * Returns an array of PTS values in seconds, sorted and deduplicated.
 *
 * Uses packet-level probing (reads packet metadata, not full decode).
 * Typical runtime: 10-30 seconds per file depending on file size.
 *
 * Supports streaming progress via `options.onProgress` — each call receives
 * the latest packet PTS, which can be divided by the known file duration
 * to derive a progress fraction.
 *
 * @param filePath - Path to the media file
 * @param options - Timeout / progress options
 */
export async function probeKeyframes(
    filePath: string,
    options: ProbeKeyframesOptions = {},
): Promise<KeyframeProbeResult> {
    const { timeoutMs = 120_000, onProgress, progressThrottleMs = 500, signal } = options;

    const ffprobePath = config.FFPROBE_PATH;
    const args = [
        '-select_streams',
        'v:0',
        '-show_entries',
        // dts_time is the fallback for containers (AVI/mpeg4) whose packets
        // report pts_time as N/A — see processLine.
        'packet=pts_time,dts_time,flags',
        '-of',
        'csv=p=0',
        '-v',
        'error',
        ...(await ffprobeLibraryInputArgs()),
        filePath,
    ];

    // 50MB stdout cap — keyframe packet output for a long file can be large.
    const MAX_STDOUT_BYTES = 50 * 1024 * 1024;

    // Fail fast if the caller already handed us an aborted signal — saves
    // spawning the subprocess only to kill it immediately.
    if (signal?.aborted) {
        return {
            keyframes: [],
            success: false,
            error: 'probeKeyframes: aborted before spawn',
        };
    }

    return new Promise<KeyframeProbeResult>((resolve) => {
        let proc: ReturnType<typeof spawn>;
        try {
            proc = spawn(ffprobePath, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (spawnErr) {
            const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
            logger.warn('Failed to spawn ffprobe for keyframes', {
                filePath: getShortPath(filePath),
                error: msg,
            });
            resolve({ keyframes: [], success: false, error: msg });
            return;
        }

        const seen = new Set<number>();
        const keyframes: number[] = [];
        let leftover = '';
        let maxPts = 0;
        let lastProgressAt = 0;
        let totalBytes = 0;
        let settled = false;
        let timedOut = false;
        let oversized = false;

        const reportProgress = (force = false): void => {
            if (!onProgress) return;
            const now = Date.now();
            if (!force && now - lastProgressAt < progressThrottleMs) return;
            lastProgressAt = now;
            try {
                onProgress(maxPts);
            } catch {
                // Callback errors must not break probing.
            }
        };

        const processLine = (line: string): void => {
            const parsed = parseKeyframePacketLine(line);
            if (!parsed) return;
            if (parsed.time > maxPts) maxPts = parsed.time;
            if (!parsed.isKeyframe) return;
            const rounded = Math.round(parsed.time * 1000) / 1000;
            if (!seen.has(rounded)) {
                seen.add(rounded);
                keyframes.push(rounded);
            }
        };

        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGKILL');
        }, timeoutMs);

        let aborted = false;
        const onAbort = (): void => {
            aborted = true;
            proc.kill('SIGKILL');
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        const finish = (result: KeyframeProbeResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(result);
        };

        proc.stdout?.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_STDOUT_BYTES) {
                oversized = true;
                proc.kill('SIGKILL');
                return;
            }
            leftover += chunk.toString('utf8');
            let nl: number;
            while ((nl = leftover.indexOf('\n')) !== -1) {
                processLine(leftover.substring(0, nl));
                leftover = leftover.substring(nl + 1);
            }
            reportProgress();
        });

        // Capture stderr (bounded) so a real ffprobe error propagates into the
        // failure result instead of being silently drained. Also prevents the
        // pipe from stalling if ffprobe writes more than the OS pipe buffer.
        // Decoded via a continuing StringDecoder (not a per-chunk
        // `toString('utf8')`) — a multi-byte UTF-8 character can legitimately
        // straddle two separate `data` events on a pipe, and decoding each
        // chunk in isolation would corrupt it into replacement characters.
        const MAX_STDERR_BYTES = 16 * 1024;
        let stderrTail = '';
        const stderrDecoder = new StringDecoder('utf8');
        proc.stderr?.on('data', (chunk: Buffer) => {
            stderrTail += stderrDecoder.write(chunk);
            if (stderrTail.length > MAX_STDERR_BYTES) {
                stderrTail = stderrTail.slice(-MAX_STDERR_BYTES);
            }
        });

        proc.on('error', (err) => {
            logger.warn('Failed to probe keyframes', {
                filePath: getShortPath(filePath),
                error: err.message,
            });
            finish({ keyframes: [], success: false, error: err.message });
        });

        proc.on('close', (code) => {
            if (aborted) {
                // Caller-initiated abort — not a failure to investigate.
                // Surface as failed (sync drain's classifier doesn't
                // distinguish; the admin already knows they pressed stop).
                finish({
                    keyframes: [],
                    success: false,
                    error: 'aborted by caller signal',
                });
                return;
            }
            if (oversized) {
                const msg = `ffprobe stdout exceeded ${MAX_STDOUT_BYTES} bytes`;
                logger.warn('Keyframe probe aborted', {
                    filePath: getShortPath(filePath),
                    reason: msg,
                });
                finish({ keyframes: [], success: false, error: msg });
                return;
            }
            if (timedOut) {
                const msg = `ffprobe timeout after ${timeoutMs}ms`;
                logger.warn('Keyframe probe timed out', {
                    filePath: getShortPath(filePath),
                });
                finish({ keyframes: [], success: false, error: msg });
                return;
            }
            if (code !== 0) {
                // ffprobe echoes the input path verbatim into stderr for
                // open/format errors (e.g. "<path>: No such file or
                // directory") — replace it with the short form before this
                // text is returned/persisted, matching every other
                // identifier logged in this file (getShortPath).
                const trimmedStderr = stderrTail
                    .trim()
                    .split(filePath)
                    .join(getShortPath(filePath));
                const msg = trimmedStderr
                    ? `ffprobe exited with code ${code}: ${trimmedStderr}`
                    : `ffprobe exited with code ${code}`;
                logger.warn('Keyframe probe failed', {
                    filePath: getShortPath(filePath),
                    code,
                    error: msg,
                });
                finish({ keyframes: [], success: false, error: msg });
                return;
            }

            // Flush any trailing line without a terminating newline.
            if (leftover.length > 0) {
                processLine(leftover);
                leftover = '';
            }

            keyframes.sort((a, b) => a - b);
            reportProgress(true);

            logger.debug('Probed keyframes', {
                filePath: getShortPath(filePath),
                count: keyframes.length,
            });

            finish({ keyframes, success: true, lastPacketPts: maxPts });
        });
    });
}

/** Where a file's video and audio really end, from its last packets. */
export interface StreamTails {
    /** False when either subprocess failed; partial packets cannot disprove damage. */
    success?: boolean;
    /** Last video packet PTS in seconds; null when ffprobe reported none. */
    videoEnd: number | null;
    /** Last audio packet PTS in seconds; null when ffprobe reported none. */
    audioEnd: number | null;
    /** Whether the file has an audio stream at all. */
    hasAudio: boolean;
    /** ffprobe's stderr says the demuxer hit end-of-file early (a cut file). */
    endedPrematurely: boolean;
}

/** Matroska's premature-EOF line, plus the generic truncation wording. */
const PREMATURE_END_PATTERN = /File ended prematurely|truncat|end of file reached prematurely/i;

/**
 * One seek-to-end ffprobe pass over a single stream. The `999999%` interval
 * seeks to the file's end and reads packets from there to EOF, so the last
 * line is the stream's last packet. A packet count (`999999%+#1`) would stop
 * at the first packet after the seek, which is the last KEYFRAME (x264's
 * default ~10 s GOP): measured on a 20 s clip, it reported 10.0 s for a video
 * that runs to 19.96 s. Only the tail is read, so the cost stays one seek.
 */
async function probeStreamTail(
    filePath: string,
    streamSpecifier: 'v:0' | 'a',
    showEntries: string,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<{ pts: number | null; streamPresent: boolean; stderr: string; success: boolean }> {
    const ffprobePath = config.FFPROBE_PATH;
    const args = [
        '-v',
        'error',
        '-select_streams',
        streamSpecifier,
        '-read_intervals',
        '999999%',
        '-show_entries',
        showEntries,
        '-of',
        'csv=p=0',
        ...(await ffprobeLibraryInputArgs()),
        filePath,
    ];
    let stdout: string;
    let stderr: string;
    let success = true;
    try {
        const result = await execFileAsync(ffprobePath, args, {
            timeout: timeoutMs,
            signal,
            maxBuffer: 2 * 1024 * 1024,
        });
        stdout = result.stdout;
        stderr = result.stderr;
    } catch (err) {
        // A non-zero exit still carries what ffprobe printed before it failed:
        // a cut file often exits non-zero AFTER reporting its last packet.
        success = false;
        const partial = err as { stdout?: unknown; stderr?: unknown };
        stdout = typeof partial.stdout === 'string' ? partial.stdout : '';
        stderr = typeof partial.stderr === 'string' ? partial.stderr : '';
    }

    let pts: number | null = null;
    let streamPresent = false;
    for (const raw of stdout.split('\n')) {
        const line = raw.trim();
        if (line === '') continue;
        const packet = /^(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?|N\/A))?$/.exec(line);
        if (packet)
            pts = Math.max(
                pts ?? -Infinity,
                Number(packet[1]) + (packet[2] && packet[2] !== 'N/A' ? Number(packet[2]) : 0),
            );
        else if (line === 'audio' || line === 'video') streamPresent = true;
    }
    return { pts, streamPresent, stderr, success };
}

/**
 * Where the video and audio of a file really end, and whether the file is cut
 * short. Runs ffprobe twice (video and audio), each reading the last packet.
 *
 * Never throws: an ffprobe that cannot run or fails yields nulls and `false`,
 * so callers keep their existing behaviour rather than failing a probe.
 */
export async function probeStreamTails(
    filePath: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<StreamTails> {
    const { timeoutMs = 30_000, signal } = options;
    try {
        const [video, audio] = await Promise.all([
            probeStreamTail(filePath, 'v:0', 'packet=pts_time,duration_time', timeoutMs, signal),
            // stream=codec_type is listed for the audio run only: it is the one
            // way to tell "no audio stream" from "audio stream, no packet read".
            probeStreamTail(
                filePath,
                'a',
                'stream=codec_type:packet=pts_time,duration_time',
                timeoutMs,
                signal,
            ),
        ]);
        return {
            success: video.success && audio.success,
            videoEnd: video.pts,
            audioEnd: audio.pts,
            hasAudio: audio.streamPresent,
            endedPrematurely:
                PREMATURE_END_PATTERN.test(video.stderr) ||
                PREMATURE_END_PATTERN.test(audio.stderr),
        };
    } catch {
        return {
            success: false,
            videoEnd: null,
            audioEnd: null,
            hasAudio: false,
            endedPrematurely: false,
        };
    }
}

// ============================================================================
// Chapter types
// ============================================================================

export interface ChapterInfo {
    index: number;
    title: string | null;
    startTimeMs: number;
    endTimeMs: number;
}

export interface ChapterProbeResult {
    chapters: ChapterInfo[];
    durationMs: number;
    /**
     * False when ffprobe could not be run or its output could not be read. Then
     * `chapters` is empty because nothing was learned, not because the file has
     * none; a caller that stores "probed, no chapters" must check this first.
     */
    success: boolean;
}

/**
 * Map ffprobe's `chapters` array (from `-show_chapters`) to {@link ChapterInfo}.
 * Shared by {@link probeMediaFile} and {@link probeChapters} so both read a
 * file's chapters the same way.
 */
export function mapFfprobeChapters(raw: unknown): ChapterInfo[] {
    const list: unknown[] = Array.isArray(raw) ? raw : [];
    return list.filter(isRecord).map((ch, idx) => {
        const tags = isRecord(ch.tags) ? ch.tags : {};
        const title = typeof tags.title === 'string' ? tags.title : null;
        const startTimeMs = Math.round((parseFloat(String(ch.start_time ?? '0')) || 0) * 1000);
        const endTimeMs = Math.round((parseFloat(String(ch.end_time ?? '0')) || 0) * 1000);
        return { index: idx, title, startTimeMs, endTimeMs };
    });
}

/**
 * Probe a media file for chapter metadata.
 * Returns chapter names and timestamps — useful for episode identification.
 */
export async function probeChapters(
    filePath: string,
    timeoutMs = 10000,
    options: { signal?: AbortSignal } = {},
): Promise<ChapterProbeResult> {
    const ffprobePath = config.FFPROBE_PATH;
    const args = [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_chapters',
        '-show_entries',
        'format=duration',
        ...(await ffprobeLibraryInputArgs()),
        filePath,
    ];

    try {
        // Node's child_process accepts `{ signal }` natively — aborting
        // kills the subprocess. killSignal: 'SIGKILL' is required because
        // ffprobe traps SIGTERM and may continue processing for several
        // seconds; SIGKILL terminates it immediately so a soft-budget abort
        // exits the slot at once instead of dragging for up to `timeoutMs`.
        const { stdout } = await execFileAsync(ffprobePath, args, {
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: FFPROBE_MAX_BUFFER,
            ...(options.signal ? { signal: options.signal } : {}),
        });

        const parsed: unknown = JSON.parse(stdout);
        if (!isRecord(parsed)) {
            return { chapters: [], durationMs: 0, success: false };
        }

        const format = isRecord(parsed.format) ? parsed.format : {};
        const durationMs = Math.round((parseFloat(String(format.duration ?? '0')) || 0) * 1000);
        const chapters = mapFfprobeChapters(parsed.chapters);

        return { chapters, durationMs, success: true };
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn('Chapter probe failed', {
            filePath: getShortPath(filePath),
            error: errorMessage,
        });
        return { chapters: [], durationMs: 0, success: false };
    }
}

// ============================================================================
// Raw probe (returns unparsed ffprobe JSON)
// ============================================================================

export interface RawProbeResult {
    data: Record<string, unknown>;
    success: true;
}

/**
 * Run ffprobe on a file and return the full raw JSON output
 * (streams, format, chapters). No interpretation or mapping.
 *
 * Used by the admin UI to inspect a file's raw metadata.
 */
export async function probeRaw(filePath: string, timeoutMs = 30_000): Promise<RawProbeResult> {
    const ffprobePath = config.FFPROBE_PATH;

    const args = [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        '-show_chapters',
        ...(await ffprobeLibraryInputArgs()),
        filePath,
    ];

    const { stdout } = await execFileAsync(ffprobePath, args, {
        timeout: timeoutMs,
        maxBuffer: FFPROBE_MAX_BUFFER,
    });

    return {
        data: JSON.parse(stdout) as Record<string, unknown>,
        success: true,
    };
}

// ============================================================================
// probeStreams / probeFormat
//
// M3 (fix plan 6, Task 7 fix round 2): NOT actually plugin-facing — the
// `PluginFFmpegClient` interface (`plugins/types/base-plugin.ts`) that would
// expose these to a plugin's `ctx.ffmpeg` has no implementation (`runner.ts`
// only ever reports a boolean `ffmpeg` capability flag, never constructs a
// real client). The one real caller is `probeAudioSource`
// (`services/music-transcode/source-metadata.ts`).
// ============================================================================

export interface StreamsProbeResult {
    video: VideoStreamInfo[];
    audio: AudioStreamInfo[];
    subtitle: SubtitleStreamInfo[];
}

/**
 * Probe all streams in a media file.
 * Returns categorized video, audio, and subtitle stream arrays.
 * Unlike probeMediaFile() which returns only the first video stream,
 * this returns ALL video streams (useful for files with multiple video tracks).
 */
export async function probeStreams(
    filePath: string,
    timeoutMs = 15000,
): Promise<StreamsProbeResult> {
    const ffprobePath = config.FFPROBE_PATH;

    try {
        // F1c (fix plan 6, Task 7 fix round 1): same local-disk-only
        // guarantee as probeMediaFile — see media-protocol-whitelist.ts.
        const args = [
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_streams',
            '-protocol_whitelist',
            MEDIA_PROTOCOL_WHITELIST,
            ...(await ffprobeLibraryInputArgs()),
            filePath,
        ];

        const { stdout } = await execFileAsync(ffprobePath, args, {
            timeout: timeoutMs,
            maxBuffer: FFPROBE_MAX_BUFFER,
        });

        const parsed: unknown = JSON.parse(stdout);
        const allStreams: FFprobeStream[] = [];
        if (isRecord(parsed)) {
            const streams = parsed.streams;
            if (Array.isArray(streams)) {
                allStreams.push(...streams.filter(isFFprobeStream));
            }
        }

        const videoStreamsRaw = allStreams.filter((s) => s.codec_type === 'video');
        const audioStreamsRaw = allStreams.filter((s) => s.codec_type === 'audio');
        const subtitleStreamsRaw = allStreams.filter((s) => s.codec_type === 'subtitle');

        const video: VideoStreamInfo[] = videoStreamsRaw.map((s) => ({
            index: s.index,
            codec: s.codec_name ?? 'unknown',
            width: s.width ?? 0,
            height: s.height ?? 0,
            fps: parseFrameRate(s.r_frame_rate) ?? parseFrameRate(s.avg_frame_rate),
            pixelFormat: s.pix_fmt ?? null,
            bitrate: streamBitrate(s),
            hdr: detectHdr(s.color_transfer, s.profile, s.side_data_list),
            colorSpace: normalizeColorTag(s.color_space),
            colorPrimaries: normalizeColorTag(s.color_primaries),
            colorTransfer: normalizeColorTag(s.color_transfer),
            refFrames:
                typeof s.refs === 'number' && Number.isFinite(s.refs) && s.refs > 0 ? s.refs : null,
            profile: s.profile ?? null,
            level: typeof s.level === 'number' ? s.level : null,
            masterDisplay: extractMasterDisplay(s.side_data_list),
            maxCll: extractMaxCll(s.side_data_list),
            closedCaptions: s.closed_captions === 1,
            fieldOrder: s.field_order ?? null,
        }));

        let audioIndex = 0;
        const audio: AudioStreamInfo[] = audioStreamsRaw.map((s) => ({
            audioRelativeIndex: asAudioRelativeIndex(audioIndex++),
            absoluteIndex: asAbsoluteStreamIndex(s.index),
            codec: s.codec_name ?? 'unknown',
            channels: s.channels ?? 2,
            channelLayout: s.channel_layout,
            sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) : undefined,
            bitRate: streamBitrate(s) ?? undefined,
            language: s.tags?.language,
            title: s.tags?.title,
            profile: s.profile,
            isDefault: s.disposition?.default === 1,
            isVisualImpaired: s.disposition?.visual_impaired === 1,
        }));

        const inferredForced = inferForcedSubtitleIndexes(subtitleStreamsRaw);
        const subtitle: SubtitleStreamInfo[] = subtitleStreamsRaw.map((s) => ({
            index: s.index,
            codec: s.codec_name ?? 'unknown',
            language: s.tags?.language ?? null,
            title: s.tags?.title ?? null,
            isDefault: s.disposition?.default === 1,
            isForced: s.disposition?.forced === 1 || inferredForced.has(s.index),
            isHearingImpaired: s.disposition?.hearing_impaired === 1,
        }));

        return { video, audio, subtitle };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to probe streams', {
            filePath: getShortPath(filePath),
            error: errorMessage,
        });
        throw error;
    }
}

export interface FormatProbeResult {
    formatName: string | null;
    fileSize: number | null;
    bitrate: number | null;
    duration: number | null;
    tags: Record<string, string>;
}

/**
 * Probe container-level format info from a media file.
 * Returns format name, file size, bitrate, duration, and metadata tags
 * (title, encoder, creation_time, etc.).
 */
export async function probeFormat(filePath: string, timeoutMs = 15000): Promise<FormatProbeResult> {
    const ffprobePath = config.FFPROBE_PATH;

    try {
        // F1c (fix plan 6, Task 7 fix round 1): same local-disk-only
        // guarantee as probeMediaFile — see media-protocol-whitelist.ts.
        const args = [
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_format',
            '-protocol_whitelist',
            MEDIA_PROTOCOL_WHITELIST,
            ...(await ffprobeLibraryInputArgs()),
            filePath,
        ];

        const { stdout } = await execFileAsync(ffprobePath, args, {
            timeout: timeoutMs,
            maxBuffer: FFPROBE_MAX_BUFFER,
        });

        const parsed: unknown = JSON.parse(stdout);
        if (!isRecord(parsed)) {
            return {
                formatName: null,
                fileSize: null,
                bitrate: null,
                duration: null,
                tags: {},
            };
        }

        const format = isFFprobeFormat(parsed.format)
            ? (parsed.format as FFprobeFormat)
            : undefined;

        const rawTags = format && isRecord(format.tags) ? format.tags : {};
        const tags: Record<string, string> = {};
        for (const [key, val] of Object.entries(rawTags)) {
            if (typeof val === 'string') {
                tags[key] = val;
            }
        }

        return {
            formatName: format?.format_name ?? null,
            fileSize: format?.size ? parseInt(format.size, 10) : null,
            bitrate: format?.bit_rate ? parseInt(format.bit_rate, 10) : null,
            duration: format?.duration ? parseFloat(format.duration) : null,
            tags,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to probe format', {
            filePath: getShortPath(filePath),
            error: errorMessage,
        });
        throw error;
    }
}
