// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildRenditionArgs, parseProgressPct, resolveRung } from './ffmpeg-args';
import { getDownloadRung } from '$lib/shared/download-rungs';

const rung = getDownloadRung('720p')!;

function args(overrides: Partial<Parameters<typeof buildRenditionArgs>[0]> = {}): string[] {
    return buildRenditionArgs({
        inputPath: '/data/movies/film.mkv',
        outputPath: '/cache/out.partial.mp4',
        rung,
        audioIndex: 2,
        isHdr: false,
        ...overrides,
    });
}

/** Value that follows a flag, e.g. valueOf(a, '-b:v'). */
function valueOf(list: string[], flag: string): string | undefined {
    const i = list.indexOf(flag);
    return i === -1 ? undefined : list[i + 1];
}

describe('buildRenditionArgs', () => {
    it('produces a single progressive MP4, not HLS', () => {
        const a = args();
        expect(valueOf(a, '-f')).toBe('mp4');
        expect(a).not.toContain('hls');
    });

    // Without faststart the file is unplayable until the final byte, which
    // defeats resumable downloading.
    it('puts the moov atom at the front', () => {
        expect(valueOf(args(), '-movflags')).toBe('+faststart');
    });

    it('encodes universally-decodable h264 High + AAC', () => {
        const a = args();
        expect(valueOf(a, '-c:v')).toBe('libx264');
        expect(valueOf(a, '-profile:v')).toBe('high');
        expect(valueOf(a, '-pix_fmt')).toBe('yuv420p');
        expect(valueOf(a, '-c:a')).toBe('aac');
        expect(valueOf(a, '-ac')).toBe('2');
    });

    it('maps the first video stream and the chosen absolute audio index', () => {
        const a = args({ audioIndex: 3 });
        const maps = a.reduce<string[]>(
            (acc, v, i) => (v === '-map' ? [...acc, a[i + 1]] : acc),
            [],
        );
        expect(maps).toContain('0:v:0');
        expect(maps).toContain('0:3');
    });

    it('drops subtitle and data streams', () => {
        const a = args();
        expect(a).toContain('-sn');
        expect(a).toContain('-dn');
    });

    // A silent film has no audio stream. `-map 0:0` would map the VIDEO track a
    // second time and `-c:a aac` would then try to encode it as audio; ffmpeg
    // dies minutes in, which the user sees as a mysterious failed download.
    it('omits audio entirely when the source has no audio track', () => {
        const a = args({ audioIndex: null });
        expect(a).toContain('-an');
        expect(valueOf(a, '-c:a')).toBeUndefined();
        expect(a).not.toContain('-ac');
        expect(a).not.toContain('-b:a');
        expect(a).not.toContain('-ar');
        // Only the video map survives. `-map_chapters` is a distinct flag, so
        // the literal `-map` appears exactly once.
        expect(a.filter((x) => x === '-map')).toHaveLength(1);
        expect(a).toContain('0:v:0');
        expect(a.some((x) => /^0:\d+$/.test(x))).toBe(false);
    });

    // Chapters and faststart are audio-independent and offline players use both.
    it('keeps chapters and faststart on a video-only encode', () => {
        const a = args({ audioIndex: null });
        expect(valueOf(a, '-map_chapters')).toBe('0');
        expect(valueOf(a, '-movflags')).toBe('+faststart');
    });

    it('still maps and encodes audio when a track exists', () => {
        const a = args({ audioIndex: 2 });
        expect(a).not.toContain('-an');
        expect(a).toContain('0:2');
        expect(valueOf(a, '-c:a')).toBe('aac');
    });

    it('targets the rung bitrate with capped VBR', () => {
        const a = args();
        expect(valueOf(a, '-b:v')).toBe(String(rung.videoBitrate));
        expect(Number(valueOf(a, '-maxrate'))).toBeGreaterThan(rung.videoBitrate);
        expect(Number(valueOf(a, '-bufsize'))).toBeGreaterThan(rung.videoBitrate);
        expect(valueOf(a, '-b:a')).toBe(String(rung.audioBitrate));
    });

    // Upscaling costs bytes and adds no detail.
    it('clamps the scale filter to downscale-only, with an escaped comma', () => {
        const vf = valueOf(args(), '-vf')!;
        expect(vf).toContain(`scale=-2:'min(ih\\,${rung.height})'`);
    });

    it('omits tone mapping for an SDR source', () => {
        expect(valueOf(args(), '-vf')).not.toContain('tonemapx');
    });

    // zscale aborts on Dolby Vision and never reaches 8-bit; tonemapx is the fix.
    it('tone-maps an HDR source with tonemapx to 8-bit bt709', () => {
        const vf = valueOf(args({ isHdr: true }), '-vf')!;
        expect(vf).toContain('tonemapx=');
        expect(vf).toContain('format=yuv420p');
        expect(vf).toContain('m=bt709');
        // Tone mapping must precede the scale.
        expect(vf.indexOf('tonemapx')).toBeLessThan(vf.indexOf('scale='));
    });

    it('emits machine-readable progress', () => {
        expect(valueOf(args(), '-progress')).toBe('pipe:1');
    });

    it('passes paths as inert array values', () => {
        const a = args({ inputPath: "/data/a b/it's.mkv" });
        expect(a).toContain("/data/a b/it's.mkv");
    });
});

describe('buildRenditionArgs — hardware acceleration', () => {
    const qsv = {
        encoder: 'h264_qsv',
        initArgs: [],
        needsHwUpload: false,
        preset: 'veryfast',
        pixFmt: 'nv12',
    };
    const vaapi = {
        encoder: 'h264_vaapi',
        initArgs: ['-vaapi_device', '/dev/dri/renderD128'],
        needsHwUpload: true,
        preset: null,
        pixFmt: null,
    };

    it('uses the hardware encoder when a plan is supplied', () => {
        expect(valueOf(args({ hw: qsv }), '-c:v')).toBe('h264_qsv');
    });

    it('still falls back to libx264 with no plan', () => {
        expect(valueOf(args({ hw: null }), '-c:v')).toBe('libx264');
    });

    // The output contract does not change with the encoder — the artifact has to
    // stay universally decodable however it was produced.
    it('keeps H.264 High and the same bitrate target on the GPU', () => {
        const a = args({ hw: qsv });
        expect(valueOf(a, '-profile:v')).toBe('high');
        expect(valueOf(a, '-b:v')).toBe(String(rung.videoBitrate));
        expect(valueOf(a, '-f')).toBe('mp4');
        expect(valueOf(a, '-movflags')).toBe('+faststart');
    });

    // THE load-bearing assertion, and a measured one: `-hwaccel qsv` on prod
    // produced hardware frames the software scaler could not ingest, failing with
    // the same auto_scale/-22 signature as the -color_range HDR incident. Decode
    // stays on the CPU so the filter chain cannot diverge from the software path.
    it('never asks for hardware decode', () => {
        expect(args({ hw: qsv })).not.toContain('-hwaccel');
        expect(args({ hw: qsv })).not.toContain('-hwaccel_output_format');
        expect(args({ hw: vaapi, isHdr: true })).not.toContain('-hwaccel');
    });

    it('tone-maps on the CPU even with a GPU plan', () => {
        const vf = valueOf(args({ hw: qsv, isHdr: true }), '-vf')!;
        expect(vf).toContain('tonemapx=');
        expect(vf).toContain('format=yuv420p');
    });

    it('puts device init args before the input', () => {
        const a = args({ hw: vaapi });
        expect(a.indexOf('-vaapi_device')).toBeLessThan(a.indexOf('-i'));
    });

    // VA-API's encoder takes an opaque surface; the others accept system memory.
    it('uploads to a VA-API surface only at the very end of the chain', () => {
        const vf = valueOf(args({ hw: vaapi, isHdr: true }), '-vf')!;
        expect(vf.endsWith('format=nv12,hwupload')).toBe(true);
        expect(vf.indexOf('scale=')).toBeLessThan(vf.indexOf('hwupload'));
    });

    // Stated, not inferred: yuv420p on QSV makes ffmpeg auto-select nv12 and
    // insert a converter, and implicit format negotiation around a hardware
    // encoder is how the -22 failures in this codebase started.
    it('gives each encoder the pixel format it actually wants', () => {
        expect(valueOf(args({ hw: qsv }), '-pix_fmt')).toBe('nv12');
        expect(valueOf(args({ hw: null }), '-pix_fmt')).toBe('yuv420p');
    });

    it('does not force a software pixel format onto a VA-API surface', () => {
        expect(args({ hw: vaapi })).not.toContain('-pix_fmt');
    });

    it('omits -preset for an encoder with no preset vocabulary', () => {
        expect(args({ hw: vaapi })).not.toContain('-preset');
        expect(valueOf(args({ hw: qsv }), '-preset')).toBe('veryfast');
    });
});

describe('parseProgressPct', () => {
    it('converts out_time_us against the duration', () => {
        // 30s into a 60s title.
        expect(parseProgressPct('out_time_us=30000000\n', 60_000)).toBe(50);
    });

    // out_time_ms is an ffmpeg misnomer — it is microseconds. Reading it as
    // milliseconds would report 1000x and fill the bar instantly.
    it('treats out_time_ms as microseconds too', () => {
        expect(parseProgressPct('out_time_ms=30000000\n', 60_000)).toBe(50);
    });

    it('takes the last block in a multi-block chunk', () => {
        const chunk = 'out_time_us=10000000\nprogress=continue\nout_time_us=45000000\n';
        expect(parseProgressPct(chunk, 60_000)).toBe(75);
    });

    it('caps below 100 so only a verified artifact reports complete', () => {
        expect(parseProgressPct('out_time_us=99000000\n', 60_000)).toBe(99);
    });

    it('returns null without a position or a duration', () => {
        expect(parseProgressPct('progress=continue\n', 60_000)).toBeNull();
        expect(parseProgressPct('out_time_us=1000\n', null)).toBeNull();
        expect(parseProgressPct('out_time_us=1000\n', 0)).toBeNull();
    });
});

describe('resolveRung', () => {
    it('resolves a published rung', () => {
        expect(resolveRung('1080p')?.height).toBe(1080);
    });

    it('rejects anything off the ladder', () => {
        expect(resolveRung('2160p')).toBeNull();
        expect(resolveRung('../etc/passwd')).toBeNull();
    });
});
