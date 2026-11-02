// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AMD (radeonsi) hevc_vaapi/av1_vaapi need 64x16-aligned frames: at 1920x1080 the
 * stream carries two conflicting SPS (green rows; AVFoundation can't open it), and
 * AV1 gets dark edges. See FFmpegArgsBuilder.alignAmdVaapiEncodeSurface().
 *
 * The exact graphs asserted here were run on a Radeon 760M (jellyfin-ffmpeg 7.1.4-3,
 * Debian FFmpeg 7.1.5; Mesa 25.0.7 and 26.1.6): 1920x1080 → 1920x1088 at SAR 136:135
 * (DAR still 16:9), one consistent SPS, AVFoundation decodes it, no green/black edge.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const gpu = vi.hoisted(() => ({ vendor: vi.fn<(device: string) => string>() }));
vi.mock('./gpu-identity.js', () => ({ readDeviceNodeVendorId: gpu.vendor }));
vi.mock('../../utils/media-format-whitelist.js', () => ({
    getMediaFormatWhitelist: () => 'WL-MEDIA',
    getConcatListFormatWhitelist: () => 'WL-CONCAT-LIST',
}));

import { config } from '../../config.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import { FFmpegArgsBuilder } from './ffmpeg-args-builder.js';
import { FullTranscodeStrategy } from './full-transcode-strategy.js';
import type { FullStrategyConfig } from './transcode-strategy.js';

const AMD = '0x1002';
const INTEL = '0x8086';
const ALIGN = 'setsar=sar,scale_vaapi=w=ceil(iw/64)*64:h=ceil(ih/16)*16';

function vf(args: string[]): string {
    const i = args.indexOf('-vf');
    return i === -1 ? '' : args[i + 1];
}

describe('AMD VA-API HEVC/AV1 encode alignment', () => {
    beforeEach(() => {
        gpu.vendor.mockReset();
        gpu.vendor.mockReturnValue(AMD);
    });

    it.each(['hevc_vaapi', 'av1_vaapi'])(
        'appends the 64x16 align as the LAST filter before %s on AMD',
        (encoder) => {
            const b = new FFmpegArgsBuilder();
            b.enableHwAccel('vaapi', '/dev/dri/renderD128');
            b.setVideoCodec(encoder);
            // The quality-cap / even-dimension scale the strategy adds comes first;
            // the align must follow it, or the encoder would see an unaligned size.
            b.setVideoScale(1920, 1080);
            const args = b.build();

            expect(vf(args)).toBe(`scale_vaapi=w=1920:h=1080,${ALIGN}`);
        },
    );

    it('reads the vendor of the device the encode actually runs on', () => {
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('vaapi', '/dev/dri/renderD129');
        b.setVideoCodec('hevc_vaapi');
        b.build();

        expect(gpu.vendor).toHaveBeenCalledWith('/dev/dri/renderD129');
    });

    // h264_vaapi on AMD is clean (verified); scaling it would only cost quality.
    it('leaves h264_vaapi alone', () => {
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('vaapi', '/dev/dri/renderD128');
        b.setVideoCodec('h264_vaapi');
        b.setVideoScale(1920, 1080);

        expect(b.build().join(' ')).not.toContain('ceil(iw/64)');
    });

    it.each([
        ['Intel iHD', INTEL],
        ['an unreadable sysfs (macOS / no /sys)', ''],
    ])('leaves %s alone', (_label, vendor) => {
        gpu.vendor.mockReturnValue(vendor);
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('vaapi', '/dev/dri/renderD128');
        b.setVideoCodec('hevc_vaapi');
        b.setVideoScale(1920, 1080);

        expect(vf(b.build())).toBe('scale_vaapi=w=1920:h=1080');
    });

    it('never touches a non-VA-API HEVC encoder, whatever the GPU vendor', () => {
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('qsv', '/dev/dri/renderD128');
        b.setVideoCodec('hevc_qsv');

        expect(b.build().join(' ')).not.toContain('ceil(iw/64)');
        expect(gpu.vendor).not.toHaveBeenCalled();
    });

    // AMD HDR: no hardware tonemap on radeonsi, so everything runs in software and
    // the upload is at the TAIL. scale_vaapi needs a VA-API surface → after it.
    it('goes after the tail upload of the software-HDR path', () => {
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('vaapi', '/dev/dri/renderD128', { vaapiSoftwareTonemap: true });
        b.setVideoCodec('hevc_vaapi');
        b.setVideoScale(1920, 1080);
        const chain = vf(b.build());

        expect(chain.endsWith(`hwupload,${ALIGN}`)).toBe(true);
    });

    it('goes after the head upload of the software-decode bridge', () => {
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('vaapi', '/dev/dri/renderD128', { softwareDecodeBridge: true });
        b.setVideoCodec('hevc_vaapi');
        b.setVideoScale(1920, 1080);

        expect(vf(b.build())).toBe(`format=nv12,hwupload,scale_vaapi=w=1920:h=1080,${ALIGN}`);
    });

    // Burn-in moves the chain into -filter_complex; a -vf beside it makes FFmpeg
    // refuse to start ("Simple and complex filtering cannot be used together").
    it('lands inside -filter_complex after the burn-in upload, with no -vf', () => {
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('vaapi', '/dev/dri/renderD128');
        b.addInputFile('/media/movie.mkv');
        b.mapVideo(0, 0);
        b.setVideoCodec('hevc_vaapi');
        b.setVideoScale(1920, 1080);
        b.enableSubtitleBurnIn(3);
        const args = b.build();

        expect(args).not.toContain('-vf');
        const graph = args[args.indexOf('-filter_complex') + 1];
        expect(graph.endsWith(`hwupload,${ALIGN}[vout]`)).toBe(true);
    });

    it('is applied once even if build() runs twice', () => {
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('vaapi', '/dev/dri/renderD128');
        b.setVideoCodec('hevc_vaapi');
        b.build();
        const chain = vf(b.build());

        expect(chain.split('ceil(iw/64)').length - 1).toBe(1);
    });

    // No VA-API hwaccel = no VA-API surface; scale_vaapi would break the graph.
    it('does nothing when the frames never reach a VA-API surface', () => {
        const b = new FFmpegArgsBuilder();
        b.setVideoCodec('hevc_vaapi');

        expect(b.build().join(' ')).not.toContain('ceil(iw/64)');
        expect(gpu.vendor).not.toHaveBeenCalled();
    });

    // The transcode service passes no device (vaapiDevice: undefined), so the
    // builder falls back to VAAPI_DEVICE — the node -vaapi_device names too.
    it('checks VAAPI_DEVICE when no device is passed', () => {
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('vaapi');
        b.setVideoCodec('hevc_vaapi');
        const args = b.build();

        expect(gpu.vendor).toHaveBeenCalledWith(config.VAAPI_DEVICE);
        expect(args[args.indexOf('-vaapi_device') + 1]).toBe(config.VAAPI_DEVICE);
    });

    it.each([
        ['HDR source tone-mapped before the overlay', { tonemapHdrToSdr: true }, false],
        ['10-bit HDR10 output (overlay format=auto, p010 upload)', undefined, true],
    ] as const)('burn-in, %s: align still lands before [vout]', (_label, opts, hdr10) => {
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('vaapi', '/dev/dri/renderD128');
        b.addInputFile('/media/movie.mkv');
        b.mapVideo(0, 0);
        b.setVideoCodec('hevc_vaapi');
        if (hdr10) b.enableHdr10Output({ outputRange: 'HDR10' });
        b.enableSubtitleBurnIn(3, opts);
        const args = b.build();
        const graph = args[args.indexOf('-filter_complex') + 1];

        expect(graph.endsWith(`hwupload,${ALIGN}[vout]`), graph).toBe(true);
        if (hdr10) expect(graph).toContain('format=p010le,hwupload');
    });

    it('burn-in graph is aligned once even if build() runs twice', () => {
        const b = new FFmpegArgsBuilder();
        b.enableHwAccel('vaapi', '/dev/dri/renderD128');
        b.addInputFile('/media/movie.mkv');
        b.mapVideo(0, 0);
        b.setVideoCodec('hevc_vaapi');
        b.enableSubtitleBurnIn(3);
        b.build();
        const args = b.build();
        const graph = args[args.indexOf('-filter_complex') + 1];

        expect(graph.split('ceil(iw/64)').length - 1).toBe(1);
    });
});

// The seam real transcodes take: FullTranscodeStrategy decides the hwaccel mode,
// the size cap / even-dimension scale and burn-in, then calls build().
describe('AMD VA-API alignment through FullTranscodeStrategy', () => {
    beforeEach(() => {
        gpu.vendor.mockReset();
        gpu.vendor.mockReturnValue(AMD);
    });

    const strategyConfig = (
        gpuEncoder: string,
        extra: Partial<FullStrategyConfig> = {},
    ): FullStrategyConfig => ({
        localFilePath: '/media/movie.mkv',
        outputDir: '/tmp/transcode/amd-align',
        segmentDuration: 6,
        gpuAcceleration: 'vaapi',
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
        audioTracks: [
            {
                index: asAbsoluteStreamIndex(1),
                displayTitle: 'English',
                language: 'eng',
                channels: 2,
                codec: 'aac',
                isDefault: true,
            },
        ],
        videoInfo: {
            codec: 'h264',
            width: 1920,
            height: 1080,
            outputCodec: gpuEncoder.startsWith('hevc') ? 'hevc' : gpuEncoder.split('_')[0],
            videoRange: 'SDR',
            frameRate: 24,
        },
        decision: {
            mode: 'full',
            reasons: 0,
            videoAction: 'transcode',
            audioAction: 'copy',
            useGpu: true,
            gpuEncoder,
            needsTonemapping: false,
            preserveHdr10: false,
        },
        ...extra,
    });

    const finalVideoChain = (args: string[]): string => {
        const fc = args.indexOf('-filter_complex');
        if (fc !== -1) return args[fc + 1];
        const vf = args.indexOf('-vf');
        return vf === -1 ? '' : args[vf + 1];
    };

    it.each([
        ['hevc_vaapi, size cap', 'hevc_vaapi', { maxWidth: 1920, maxHeight: 1080 }],
        ['hevc_vaapi, even-dimension scale', 'hevc_vaapi', {}],
        ['av1_vaapi, even-dimension scale', 'av1_vaapi', {}],
    ] as const)('%s: the chain ends in the align, exactly once', (_label, encoder, extra) => {
        const { args } = new FullTranscodeStrategy().buildArgs(strategyConfig(encoder, extra));
        const chain = finalVideoChain(args);

        expect(args[args.indexOf('-c:v') + 1]).toBe(encoder);
        expect(chain.endsWith(ALIGN), chain).toBe(true);
        expect(chain.split('ceil(iw/64)').length - 1).toBe(1);
    });

    it('burn-in: the align lands before [vout] in the strategy-built graph', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(
            strategyConfig('hevc_vaapi', { subtitleBurnIn: { absoluteIndex: 3, codec: 'pgs' } }),
        );

        expect(args).not.toContain('-vf');
        expect(finalVideoChain(args).endsWith(`${ALIGN}[vout]`)).toBe(true);
    });

    it('h264_vaapi from the strategy is left alone', () => {
        const { args } = new FullTranscodeStrategy().buildArgs(strategyConfig('h264_vaapi'));

        expect(args.join(' ')).not.toContain('ceil(iw/64)');
    });
});
