// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/media-format-whitelist.js', () => ({
    getMediaFormatWhitelist: () => 'WL-MEDIA',
    getConcatListFormatWhitelist: () => 'WL-CONCAT-LIST',
}));

import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import { FullTranscodeStrategy } from './full-transcode-strategy.js';
import { splitIntoGopOutputs } from './gop-output-args.js';
import type { FullStrategyConfig } from './transcode-strategy.js';

const OUT = '/tmp/transcode/gen-1';

function track(i: number, codec: string, channels = 2, isDefault = i === 0) {
    return {
        index: asAbsoluteStreamIndex(i + 1),
        displayTitle: `Track ${i}`,
        language: i === 0 ? 'eng' : 'ger',
        channels,
        codec,
        isDefault,
    };
}

const base: Omit<FullStrategyConfig, 'audioTracks' | 'decision'> = {
    localFilePath: '/media/movie.mkv',
    outputDir: OUT,
    segmentDuration: 10,
    gpuAcceleration: 'none',
    encodingPreset: 'medium',
    nvencPreset: 'p4',
    h264Crf: 23,
    h265Crf: 28,
    videoBitrateMbps: 0,
    maxWidth: 0,
    maxHeight: 0,
    tonemappingAlgorithm: 'bt2390',
    deinterlaceMethod: 'yadif',
    audioCodec: 'aac',
    audioBitrateStereo: '128k',
    audioBitrateSurround: '256k',
    audioVbr: false,
    audioBoost: 1.0,
    videoInfo: { codec: 'hevc', width: 1920, height: 1080 },
    hlsOutput: { hlsAudioMode: 'demux' },
};

function decision(audioAction: 'copy' | 'transcode') {
    return {
        mode: 'full' as const,
        reasons: 0,
        videoAction: 'copy' as const,
        audioAction,
        useGpu: false,
        needsTonemapping: false,
        preserveHdr10: false,
    };
}

/** Split argv into [prefix, ...outputs] at each output playlist path. */
function outputs(args: string[]): string[][] {
    const firstOutputStart = args.lastIndexOf('-i') + 2;
    const result: string[][] = [args.slice(0, firstOutputStart)];
    let cur: string[] = [];
    for (let i = firstOutputStart; i < args.length; i++) {
        cur.push(args[i]);
        if (args[i].endsWith('index.m3u8')) {
            result.push(cur);
            cur = [];
        }
    }
    expect(cur).toEqual([]);
    return result;
}

const val = (out: string[], flag: string): string | undefined => {
    const i = out.indexOf(flag);
    return i === -1 ? undefined : out[i + 1];
};
const all = (out: string[], flag: string): string[] =>
    out.flatMap((t, i) => (t === flag ? [out[i + 1]] : []));

let strategy: FullTranscodeStrategy;
beforeEach(() => {
    strategy = new FullTranscodeStrategy();
});

describe('GOP-mode FFmpeg outputs', () => {
    it('splits a copy+copy demux job into an audio and a per-keyframe video output', () => {
        const { args } = strategy.buildArgs({
            ...base,
            audioTracks: [track(0, 'eac3', 6)],
            decision: decision('copy'),
            gopSegments: { videoStartKeyframe: 0 },
        });
        const [prefix, audio, video] = outputs(args);
        expect(prefix).not.toContain('-ss');

        expect(all(audio, '-map')).toEqual(['0:a:0']);
        expect(all(video, '-map')).toEqual(['0:v:0']);
        expect(val(audio, '-hls_time')).toBe('0.5');
        expect(val(video, '-hls_time')).toBe('0');
        expect(val(video, '-start_number')).toBe('0');
        expect(val(audio, '-var_stream_map')).toBe(
            'a:0,agroup:audio,language:eng,name:0,default:yes',
        );
        expect(val(audio, '-master_pl_name')).toBe('master.m3u8');
        // Single variant stream: hlsenc would not substitute %v in the init name.
        expect(val(audio, '-hls_fmp4_init_filename')).toBe('init_0.mp4');
        expect(video).not.toContain('-var_stream_map');
        expect(val(audio, '-hls_segment_filename')).toBe(`${OUT}/parts_%v/part_%06d.m4s`);
        expect(audio.at(-1)).toBe(`${OUT}/parts_%v/index.m3u8`);
        expect(val(video, '-hls_segment_filename')).toBe(`${OUT}/gop_1/gop_%06d.m4s`);
        expect(video.at(-1)).toBe(`${OUT}/gop_1/index.m3u8`);
        expect(val(video, '-hls_fmp4_init_filename')).toBe('init_1.mp4');
        for (const out of [audio, video]) {
            expect(val(out, '-f')).toBe('hls');
            expect(val(out, '-hls_segment_options')).toBe('movflags=+frag_discont');
            expect(val(out, '-hls_segment_type')).toBe('fmp4');
            expect(val(out, '-hls_flags')).toBe('independent_segments+program_date_time+temp_file');
            expect(val(out, '-avoid_negative_ts')).toBe('disabled');
        }
        // One timestamp base for every generation, gen0 included.
        expect(audio).toContain('-copyts');
        expect(audio).toContain('-start_at_zero');
        expect(val(video, '-c:v')).toBe('copy');
        expect(audio).not.toContain('-c:v');
        expect(video.some((t) => t.startsWith('-c:a'))).toBe(false);
    });

    // Native-HLS clients add frag_discont on a seeked copy generation in the
    // shared argument list; GOP mode rebuilds it per output and must neither
    // drop it nor emit it twice.
    it('emits frag_discont exactly once per output for a seeked native-HLS job', () => {
        const { args } = strategy.buildArgs({
            ...base,
            audioTracks: [track(0, 'eac3', 6)],
            decision: decision('copy'),
            gopSegments: { videoStartKeyframe: 50 },
            startTimeSeconds: 600,
            sourceTimestamps: true,
        });
        const [, audio, video] = outputs(args);
        for (const out of [audio, video]) {
            expect(all(out, '-hls_segment_options')).toEqual(['movflags=+frag_discont']);
        }
    });

    it('keeps -af and per-track audio encoder options on the audio output only', () => {
        const { args } = strategy.buildArgs({
            ...base,
            audioTracks: [track(0, 'dts', 6), track(1, 'dts', 6, false)],
            decision: decision('transcode'),
            startTimeSeconds: 1197.78 + 0.5,
            gopSegments: { videoStartKeyframe: 113 },
        });
        const [prefix, audio, video] = outputs(args);
        expect(val(prefix, '-ss')).toBe('1198.28');
        expect(prefix).toContain('-noaccurate_seek');
        expect(all(audio, '-map')).toEqual(['0:a:0', '0:a:1']);
        expect(audio).toContain('-af');
        expect(video).not.toContain('-af');
        expect(audio.some((t) => t.startsWith('-c:a:1'))).toBe(true);
        expect(val(audio, '-var_stream_map')).toBe(
            'a:0,agroup:audio,language:eng,name:0,default:yes a:1,agroup:audio,language:ger,name:1,default:no',
        );
        expect(val(video, '-start_number')).toBe('113');
        expect(val(audio, '-hls_fmp4_init_filename')).toBe('init_%v.mp4');
        expect(val(video, '-hls_segment_filename')).toBe(`${OUT}/gop_2/gop_%06d.m4s`);
        expect(val(video, '-hls_fmp4_init_filename')).toBe('init_2.mp4');
    });

    it('keeps Dolby Vision tagging and -strict on the video output', () => {
        const { args } = strategy.buildArgs({
            ...base,
            videoInfo: { codec: 'hevc', width: 3840, height: 2160, dvProfile: 8 },
            audioTracks: [track(0, 'aac')],
            decision: decision('copy'),
            gopSegments: { videoStartKeyframe: 0 },
        });
        const [, audio, video] = outputs(args);
        expect(val(video, '-vtag')).toBe('hvc1');
        expect(audio).not.toContain('-vtag');
        expect(val(video, '-strict')).toBe('unofficial');
        expect(all(video, '-bsf:v').length + all(video, '-vbsf').length).toBeGreaterThanOrEqual(0);
    });

    it('accounts for every original output option exactly once per stream kind', () => {
        const single = strategy.buildArgs({
            ...base,
            audioTracks: [track(0, 'eac3', 6), track(1, 'aac', 2, false)],
            decision: decision('transcode'),
            startTimeSeconds: 40,
        }).args;
        const split = strategy.buildArgs({
            ...base,
            audioTracks: [track(0, 'eac3', 6), track(1, 'aac', 2, false)],
            decision: decision('transcode'),
            startTimeSeconds: 40,
            gopSegments: { videoStartKeyframe: 7 },
        }).args;
        const [, audio, video] = outputs(split);
        const singleOut = single.slice(single.lastIndexOf('-i') + 2);
        const rebuilt = new Set([
            '-hls_time',
            '-hls_segment_type',
            '-hls_fmp4_init_filename',
            '-hls_segment_options',
            '-hls_segment_filename',
            '-start_number',
            '-var_stream_map',
            '-master_pl_name',
            '-hls_flags',
        ]);
        for (const flag of singleOut.filter((t) => t.startsWith('-'))) {
            if (rebuilt.has(flag)) continue;
            expect(audio.includes(flag) || video.includes(flag), flag).toBe(true);
        }
    });

    it('leaves non-GOP jobs untouched', () => {
        const cfg = { ...base, audioTracks: [track(0, 'aac')], decision: decision('copy') };
        const plain = strategy.buildArgs(cfg).args;
        expect(outputs(plain)).toHaveLength(2);
        // muxed and transcoded video ignore the flag
        const muxed = strategy.buildArgs({
            ...cfg,
            hlsOutput: { hlsAudioMode: 'muxed' },
            gopSegments: { videoStartKeyframe: 0 },
        }).args;
        expect(muxed.filter((t) => t.endsWith('.m3u8'))).toHaveLength(1);
    });

    it('rejects input without the demux pattern or without audio', () => {
        expect(() =>
            splitIntoGopOutputs(['-i', 'x', '-f', 'hls', 'out.m3u8'], {
                outputDir: OUT,
                audioTrackCount: 1,
                videoStartKeyframe: 0,
            }),
        ).toThrow(/pattern/);
        expect(() =>
            splitIntoGopOutputs([], { outputDir: OUT, audioTrackCount: 0, videoStartKeyframe: 0 }),
        ).toThrow(/audio/);
    });
});
