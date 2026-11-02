// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FFmpeg arguments for demux copy-video GOP mode (services/hls/gop-grid.ts).
 *
 * The normal demux job is ONE hls output whose `-var_stream_map` carries every
 * audio track plus the video. GOP mode needs different cut rules per stream —
 * video at every keyframe (`-hls_time 0`), audio in ~0.5 s parts — and the hls
 * muxer's `hls_time` is per output. So the single-output argument list the
 * strategy already builds is split into two outputs of the same FFmpeg run:
 *
 *   audio  -map 0:a:*  … -var_stream_map (audio only) -master_pl_name master.m3u8
 *          <gen>/parts_%v/part_%06d.m4s, <gen>/parts_%v/index.m3u8
 *   video  -map 0:v:0  … -start_number <first keyframe index>
 *          <gen>/gop_<N>/gop_%06d.m4s, <gen>/gop_<N>/index.m3u8
 *
 * `parts_%v` (not `stream_%v/parts`) matters: hlsenc writes the master playlist
 * to the PARENT directory only when the playlist's own directory name contains
 * `%v`, and readiness/`isOutputComplete` look for `<gen>/master.m3u8`.
 *
 * Both outputs write source-absolute tfdt (`movflags=+frag_discont`, default
 * edit list — `use_editlist=0` makes seek generations relative again, measured).
 * The assembler (services/hls/gop-segment-assembler.ts) builds `stream_<i>/`.
 */

import * as path from 'path';

/** Hard-coded no-value options that can appear after the inputs. */
const NO_VALUE_OPTIONS = new Set([
    '-copyts',
    '-start_at_zero',
    '-vn',
    '-an',
    '-sn',
    '-dn',
    '-shortest',
]);
/** Global options: kept once, on the first (audio) output. */
const GLOBAL_OPTIONS = new Set(['-copyts', '-start_at_zero']);
/** HLS muxer options rebuilt per output (dropped from the shared set). */
const PER_OUTPUT_HLS_OPTIONS = new Set([
    '-hls_time',
    '-hls_segment_type',
    '-hls_fmp4_init_filename',
    '-hls_segment_options',
    '-hls_segment_filename',
    '-start_number',
    '-var_stream_map',
    '-master_pl_name',
]);

export const AUDIO_PART_SECONDS = 0.5;

export function gopVideoPartsDirName(videoStreamIndex: number): string {
    return `gop_${videoStreamIndex}`;
}

export function gopAudioPartsDirName(audioIndex: number): string {
    return `parts_${audioIndex}`;
}

export const GOP_VIDEO_PART_PREFIX = 'gop_';
export const GOP_AUDIO_PART_PREFIX = 'part_';

interface Option {
    flag: string;
    value?: string;
}

type StreamKind = 'audio' | 'video' | 'shared';

/** Stream-type options without a `:v`/`:a` specifier (FFmpeg aliases). */
const VIDEO_ALIASES = new Set(['-vtag', '-vcodec', '-vf', '-pix_fmt', '-r', '-aspect', '-vbsf']);
const AUDIO_ALIASES = new Set(['-atag', '-acodec', '-af', '-ab', '-ac', '-ar', '-absf']);

function classify(opt: Option): StreamKind {
    const { flag, value } = opt;
    if (flag === '-map') {
        if (value && /^\d+:v/.test(value)) return 'video';
        if (value && /^\d+:a/.test(value)) return 'audio';
        return 'shared';
    }
    if (AUDIO_ALIASES.has(flag)) return 'audio';
    if (VIDEO_ALIASES.has(flag)) return 'video';
    // Stream specifier `-opt:v…`, `-opt:a…`, or metadata/disposition `-opt:s:v…`.
    const spec = /^-[\w]+(?::s)?:([va])(?::|$)/.exec(flag);
    if (spec) return spec[1] === 'v' ? 'video' : 'audio';
    return 'shared';
}

function parseOptions(tokens: string[]): Option[] {
    const out: Option[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const flag = tokens[i];
        if (!flag.startsWith('-')) {
            throw new Error(`gop-output-args: unexpected bare token "${flag}" in output options`);
        }
        if (NO_VALUE_OPTIONS.has(flag)) {
            out.push({ flag });
        } else {
            out.push({ flag, value: tokens[++i] });
        }
    }
    return out;
}

function flatten(options: Option[]): string[] {
    return options.flatMap((o) => (o.value === undefined ? [o.flag] : [o.flag, o.value]));
}

export interface GopOutputOptions {
    outputDir: string;
    audioTrackCount: number;
    /** Global keyframe index of the generation's first keyframe (`-start_number`). */
    videoStartKeyframe: number;
}

/**
 * Split a single-output demux argument list (as `FullTranscodeStrategy` builds
 * it, output pattern included) into the GOP-mode audio + video outputs.
 */
export function splitIntoGopOutputs(args: string[], o: GopOutputOptions): string[] {
    if (o.audioTrackCount < 1) {
        throw new Error('gop-output-args: GOP mode needs at least one audio track');
    }
    // Strip the trailing output pattern: -hls_segment_filename <seg> <playlist>.
    const n = args.length;
    if (args[n - 3] !== '-hls_segment_filename') {
        throw new Error('gop-output-args: expected the demux output pattern at the end');
    }
    const body = args.slice(0, n - 3);
    const lastInput = body.lastIndexOf('-i');
    if (lastInput === -1) throw new Error('gop-output-args: no input');
    const prefix = body.slice(0, lastInput + 2);
    const options = parseOptions(body.slice(lastInput + 2));

    const audio: Option[] = [];
    const video: Option[] = [];
    const globals: Option[] = [];
    const shared: Option[] = [];
    let hlsFlags = 'independent_segments+program_date_time+temp_file';
    let varStreamMap: string | undefined;
    for (const opt of options) {
        if (opt.flag === '-hls_flags') {
            hlsFlags = opt.value ?? hlsFlags;
            continue;
        }
        if (opt.flag === '-var_stream_map') varStreamMap = opt.value;
        if (PER_OUTPUT_HLS_OPTIONS.has(opt.flag)) continue;
        if (GLOBAL_OPTIONS.has(opt.flag)) {
            globals.push(opt);
            continue;
        }
        const kind = classify(opt);
        if (kind === 'audio') audio.push(opt);
        else if (kind === 'video') video.push(opt);
        else shared.push(opt);
    }

    // The assembler treats a part as complete once its name exists: FFmpeg must
    // write parts under a temporary name and rename them when closed.
    if (!hlsFlags.split('+').includes('temp_file')) hlsFlags += '+temp_file';

    // Audio entries of the original var_stream_map, in order; the video entry
    // (`v:0,…`) moves to its own output.
    const audioMap = (varStreamMap ?? '')
        .split(' ')
        .filter((entry) => entry.startsWith('a:'))
        .join(' ');
    if (!audioMap) throw new Error('gop-output-args: no audio entries in -var_stream_map');

    const segmentOptions = ['-hls_segment_options', 'movflags=+frag_discont'];
    const videoIndex = o.audioTrackCount;
    const videoDir = path.join(o.outputDir, gopVideoPartsDirName(videoIndex));
    const audioDir = path.join(o.outputDir, 'parts_%v');

    const audioOutput = [
        ...flatten(audio),
        ...flatten(globals),
        ...flatten(shared),
        '-hls_time',
        String(AUDIO_PART_SECONDS),
        '-hls_segment_type',
        'fmp4',
        '-hls_fmp4_init_filename',
        // hlsenc substitutes %v in the init name only with 2+ variant streams;
        // a single audio track would get a file literally named `init_%v.mp4`.
        o.audioTrackCount === 1 ? 'init_0.mp4' : 'init_%v.mp4',
        ...segmentOptions,
        '-hls_flags',
        hlsFlags,
        '-var_stream_map',
        audioMap,
        '-master_pl_name',
        'master.m3u8',
        '-hls_segment_filename',
        path.join(audioDir, `${GOP_AUDIO_PART_PREFIX}%06d.m4s`),
        path.join(audioDir, 'index.m3u8'),
    ];

    const videoOutput = [
        ...flatten(video),
        ...flatten(shared),
        // 0: cut at EVERY keyframe. hlsenc compares `pts - start >= hls_time * n`,
        // so any positive value merges keyframes denser than it on average.
        '-hls_time',
        '0',
        '-hls_segment_type',
        'fmp4',
        '-hls_fmp4_init_filename',
        `init_${videoIndex}.mp4`,
        ...segmentOptions,
        '-hls_flags',
        hlsFlags,
        '-start_number',
        String(o.videoStartKeyframe),
        '-hls_segment_filename',
        path.join(videoDir, `${GOP_VIDEO_PART_PREFIX}%06d.m4s`),
        path.join(videoDir, 'index.m3u8'),
    ];

    return [...prefix, ...audioOutput, ...videoOutput];
}
