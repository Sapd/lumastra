// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for FFmpeg Arguments Builder
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The real helper enumerates the local ffmpeg binary; fixed values keep these
// args deterministic across machines (media-format-whitelist.test.ts and its
// integration test cover the enumeration itself).
const formatWhitelist = vi.hoisted(() => ({
    media: vi.fn<() => string | null>(() => 'WL-MEDIA'),
    concatList: vi.fn<() => string | null>(() => 'WL-CONCAT-LIST'),
}));
vi.mock('../../utils/media-format-whitelist.js', () => ({
    getMediaFormatWhitelist: formatWhitelist.media,
    getConcatListFormatWhitelist: formatWhitelist.concatList,
}));
// build() reads the VA-API node's PCI vendor from sysfs to decide the AMD 64x16
// encode alignment. Pin "not AMD" so these args don't depend on the host's GPU;
// the alignment has its own file (ffmpeg-args-builder.amd-vaapi-align.test.ts).
vi.mock('./gpu-identity.js', () => ({ readDeviceNodeVendorId: () => '' }));

import { config } from '$lib/server/config.js';
import { FFmpegArgsBuilder, resolveTonemapMode } from './ffmpeg-args-builder.js';

describe('FFmpegArgsBuilder', () => {
    let builder: FFmpegArgsBuilder;

    beforeEach(() => {
        formatWhitelist.media.mockClear();
        formatWhitelist.concatList.mockClear();
        builder = new FFmpegArgsBuilder();
    });

    describe('constructor', () => {
        it('adds global options by default', () => {
            const args = builder.build();

            expect(args).toContain('-hide_banner');
            expect(args).toContain('-loglevel');
            expect(args).toContain('warning');
            expect(args).toContain('-stats');
        });
    });

    describe('addInputFile', () => {
        it('adds input file', () => {
            builder.addInputFile('/path/to/video.mkv');
            const args = builder.build();

            expect(args).toContain('-i');
            expect(args).toContain('/path/to/video.mkv');
        });

        it('adds seeking before input when specified', () => {
            builder.addInputFile('/path/to/video.mkv', 120);
            const args = builder.build();

            const ssIndex = args.indexOf('-ss');
            const inputIndex = args.indexOf('-i');

            expect(ssIndex).toBeGreaterThan(-1);
            expect(ssIndex).toBeLessThan(inputIndex);
            expect(args[ssIndex + 1]).toBe('120');
        });

        it('does not add seeking when 0', () => {
            builder.addInputFile('/path/to/video.mkv', 0);
            const args = builder.build();

            expect(args).not.toContain('-ss');
        });

        // P1+R2 residual (fix plan 6, Task 7 / S-P1c).
        it('carries -protocol_whitelist file immediately before -i', () => {
            builder.addInputFile('/path/to/video.mkv');
            const args = builder.build();

            const inputIndex = args.indexOf('-i');
            expect(args[inputIndex - 2]).toBe('-protocol_whitelist');
            expect(args[inputIndex - 1]).toBe('file');
        });

        // Control: seeking + the whitelist coexist in the right order.
        it('places the whitelist after -ss but still immediately before -i', () => {
            builder.addInputFile('/path/to/video.mkv', 120);
            const args = builder.build();

            const ssIndex = args.indexOf('-ss');
            const inputIndex = args.indexOf('-i');
            expect(ssIndex).toBeLessThan(inputIndex);
            expect(args[inputIndex - 2]).toBe('-protocol_whitelist');
            expect(args[inputIndex - 1]).toBe('file');
        });

        // F4 (fix plan 6, final wave): the runtime demuxer list, input-scoped.
        it('carries the media -format_whitelist as an input option, before -protocol_whitelist', () => {
            builder.addInputFile('/path/to/video.mkv', 120);
            const args = builder.build();

            const inputIndex = args.indexOf('-i');
            expect(args.slice(args.indexOf('-ss'), inputIndex + 2)).toEqual([
                '-ss',
                '120',
                '-format_whitelist',
                'WL-MEDIA',
                '-protocol_whitelist',
                'file',
                '-i',
                '/path/to/video.mkv',
            ]);
            expect(formatWhitelist.concatList).not.toHaveBeenCalled();
        });

        it('sets no -format_whitelist when the demuxers could not be enumerated', () => {
            formatWhitelist.media.mockReturnValueOnce(null);
            builder.addInputFile('/path/to/video.mkv');
            const args = builder.build();

            expect(args).not.toContain('-format_whitelist');
            expect(args[args.indexOf('-i') - 2]).toBe('-protocol_whitelist');
        });
    });

    describe('seeked copy-video timestamps (native HLS)', () => {
        const segmentOptions = (args: string[]): string | undefined => {
            const i = args.indexOf('-hls_segment_options');
            return i >= 0 ? args[i + 1] : undefined;
        };

        it('leaves a seeked copy generation re-based for hls.js by default', () => {
            const args = builder
                .setVideoCopy()
                .addInputFile('/path/to/video.mkv', 600)
                .addOutputOptions()
                .configureHlsOutput({ segmentType: 'fmp4' })
                .build();
            expect(segmentOptions(args)).toBeUndefined();
        });

        // Prod 2026-10-15: without frag_discont a seeked generation's tfdt
        // started near 0 and AVPlayer drew every WebVTT cue ~10 min late — no
        // subtitles after a resume or a long seek in the iPhone app.
        it('writes absolute tfdt on a seeked generation for a native-HLS client', () => {
            const args = builder
                .setVideoCopy()
                .keepSourceTimestamps()
                .addInputFile('/path/to/video.mkv', 600)
                .addOutputOptions()
                .configureHlsOutput({ segmentType: 'fmp4' })
                .build();
            expect(segmentOptions(args)).toBe('movflags=+frag_discont');
            expect(args).toContain('-copyts');
        });

        it('changes nothing for a native-HLS generation from 0', () => {
            const args = builder
                .setVideoCopy()
                .keepSourceTimestamps()
                .addInputFile('/path/to/video.mkv')
                .addOutputOptions()
                .configureHlsOutput({ segmentType: 'fmp4' })
                .build();
            expect(segmentOptions(args)).toBeUndefined();
            expect(args).not.toContain('-copyts');
        });
    });

    describe('addConcatInputFile', () => {
        it('adds the concat demuxer flags and -protocol_whitelist file immediately before -i', () => {
            builder.addConcatInputFile('/tmp/lumastra-concat-abc.txt');
            const args = builder.build();

            expect(args).toContain('-f');
            expect(args).toContain('concat');
            expect(args).toContain('-safe');
            expect(args).toContain('0');

            const inputIndex = args.indexOf('-i');
            expect(args[inputIndex - 2]).toBe('-protocol_whitelist');
            expect(args[inputIndex - 1]).toBe('file');
            expect(args[inputIndex + 1]).toBe('/tmp/lumastra-concat-abc.txt');
        });

        it('carries the concat-list -format_whitelist (the variant that keeps concat)', () => {
            builder.addConcatInputFile('/tmp/lumastra-concat-abc.txt');
            const args = builder.build();

            const inputIndex = args.indexOf('-i');
            expect(args.slice(inputIndex - 8, inputIndex + 2)).toEqual([
                '-f',
                'concat',
                '-safe',
                '0',
                '-format_whitelist',
                'WL-CONCAT-LIST',
                '-protocol_whitelist',
                'file',
                '-i',
                '/tmp/lumastra-concat-abc.txt',
            ]);
            expect(formatWhitelist.media).not.toHaveBeenCalled();
        });

        it('sets no -format_whitelist on the list when the demuxers could not be enumerated', () => {
            formatWhitelist.concatList.mockReturnValueOnce(null);
            builder.addConcatInputFile('/tmp/lumastra-concat-abc.txt');

            expect(builder.build()).not.toContain('-format_whitelist');
        });
    });

    describe('Video Encoding', () => {
        describe('copyVideo', () => {
            it('sets video codec to copy', () => {
                builder.copyVideo();
                const args = builder.build();

                const codecIndex = args.indexOf('-c:v');
                expect(codecIndex).toBeGreaterThan(-1);
                expect(args[codecIndex + 1]).toBe('copy');
            });
        });

        describe('disableVideo', () => {
            it('emits -vn and no video codec', () => {
                builder.disableVideo();
                const args = builder.build();
                expect(args).toContain('-vn');
                expect(args).not.toContain('-c:v');
            });

            it('is idempotent', () => {
                builder.disableVideo().disableVideo();
                expect(builder.build().filter((a) => a === '-vn')).toHaveLength(1);
            });
        });

        describe('setVideoCodec', () => {
            it('sets video codec', () => {
                builder.setVideoCodec('libx264');
                const args = builder.build();

                expect(args).toContain('-c:v');
                expect(args).toContain('libx264');
            });

            it('sets profile and level', () => {
                builder.setVideoCodec('libx264', {
                    profile: 'high',
                    level: '4.0',
                });
                const args = builder.build();

                expect(args).toContain('-profile:v');
                expect(args).toContain('high');
                expect(args).toContain('-level:v');
                expect(args).toContain('4.0');
            });

            it('sets B-frames', () => {
                builder.setVideoCodec('libx264', { bframes: 3 });
                const args = builder.build();

                expect(args).toContain('-bf');
                const bfIndex = args.indexOf('-bf');
                expect(args[bfIndex + 1]).toBe('3');
            });

            it('sets NVENC preset for nvenc encoders', () => {
                builder.setVideoCodec('hevc_nvenc', { nvencPreset: 'p4' });
                const args = builder.build();

                expect(args).toContain('-preset');
                expect(args).toContain('p4');
            });

            it('sets preset and CRF for software encoders', () => {
                builder.setVideoCodec('libx264', { preset: 'medium', crf: 23 });
                const args = builder.build();

                expect(args).toContain('-preset');
                expect(args).toContain('medium');
                expect(args).toContain('-crf');
                expect(args).toContain('23');
            });

            it.each(['libx264', 'libx265', 'h264_nvenc', 'hevc_qsv', 'hevc_vaapi'])(
                'honors a strict video ceiling for %s',
                (encoder) => {
                    builder.setVideoCodec(encoder, { bitrate: 4, maxBitrate: 4 });
                    const args = builder.build();
                    expect(Number(args[args.indexOf('-maxrate') + 1])).toBe(4_000_000);
                    expect(Number(args[args.indexOf('-b:v') + 1])).toBeLessThanOrEqual(4_000_000);
                },
            );

            it('sets bitrate with maxrate and bufsize', () => {
                builder.setVideoCodec('libx264', { bitrate: 8 }); // 8 Mbps
                const args = builder.build();

                expect(args).toContain('-b:v');
                expect(args).toContain('-maxrate');
                expect(args).toContain('-bufsize');

                const bitrateIndex = args.indexOf('-b:v');
                expect(args[bitrateIndex + 1]).toBe('8000000');
            });
        });

        describe('setVideoBitrate', () => {
            it('sets bitrate, maxrate, and bufsize', () => {
                builder.setVideoBitrate(10); // 10 Mbps
                const args = builder.build();

                expect(args).toContain('-b:v');
                expect(args).toContain('10000000');
                expect(args).toContain('-maxrate');
                expect(args).toContain('15000000'); // 1.5x
                expect(args).toContain('-bufsize');
                expect(args).toContain('20000000'); // 2x
            });
        });

        describe('setVideoTag', () => {
            it('sets video tag for Dolby Vision', () => {
                builder.setVideoTag('dvh1');
                const args = builder.build();

                expect(args).toContain('-vtag');
                expect(args).toContain('dvh1');
            });
        });
    });

    describe('Keyframe Settings', () => {
        describe('setKeyframeInterval', () => {
            it('sets GOP size based on segment duration and frame rate', () => {
                builder.setKeyframeInterval(6, 24); // 6s segments at 24fps
                const args = builder.build();

                expect(args).toContain('-g');
                const gIndex = args.indexOf('-g');
                expect(args[gIndex + 1]).toBe('144'); // 6 * 24 = 144

                expect(args).toContain('-keyint_min');
                expect(args).toContain('-sc_threshold');
                expect(args).toContain('0');
            });

            it('handles different frame rates', () => {
                builder.setKeyframeInterval(4, 30); // 4s segments at 30fps
                const args = builder.build();

                const gIndex = args.indexOf('-g');
                expect(args[gIndex + 1]).toBe('120'); // 4 * 30 = 120
            });
        });

        describe('forceKeyframesAtInterval', () => {
            it('sets force_key_frames expression', () => {
                builder.forceKeyframesAtInterval(6);
                const args = builder.build();

                expect(args).toContain('-force_key_frames');
                const fkfIndex = args.indexOf('-force_key_frames');
                expect(args[fkfIndex + 1]).toContain('expr:gte(t,n_forced*6)');
            });
        });

        it('makes forced QSV HEVC keyframes IDR frames', () => {
            builder.setVideoCodec('hevc_qsv', {});
            const args = builder.build();

            const forcedIdrIndex = args.indexOf('-forced_idr');
            expect(forcedIdrIndex).toBeGreaterThanOrEqual(0);
            expect(args[forcedIdrIndex + 1]).toBe('1');
        });
    });

    describe('Audio Encoding', () => {
        describe('copyAudio', () => {
            it('copies all audio when no stream specified', () => {
                builder.copyAudio();
                const args = builder.build();

                expect(args).toContain('-c:a');
                expect(args).toContain('copy');
            });

            it('copies specific audio stream', () => {
                builder.copyAudio(1);
                const args = builder.build();

                expect(args).toContain('-c:a:1');
                expect(args).toContain('copy');
            });
        });

        describe('setAudioCodec', () => {
            it('sets audio codec for specific stream', () => {
                builder.setAudioCodec('aac', 0, {
                    bitrate: '128k',
                    channels: 2,
                });
                const args = builder.build();

                expect(args).toContain('-c:a:0');
                expect(args).toContain('aac');
                expect(args).toContain('-b:a:0');
                expect(args).toContain('128k');
                expect(args).toContain('-ac:a:0');
                expect(args).toContain('2');
            });

            it('sets VBR for AAC', () => {
                builder.setAudioCodec('aac', 0, { vbr: true });
                const args = builder.build();

                expect(args).toContain('-q:a:0');
                expect(args).toContain('2');
            });
        });

        describe('setAudioBoost', () => {
            it('sets volume filter when not 1.0', () => {
                builder.setAudioBoost(1.5);
                const args = builder.build();

                expect(args).toContain('-af');
                expect(args).toContain('volume=1.5');
            });

            it('does not set filter when 1.0', () => {
                builder.setAudioBoost(1.0);
                const args = builder.build();

                expect(args).not.toContain('-af');
            });
        });
    });

    describe('Stream Mapping', () => {
        describe('mapVideo', () => {
            it('maps video stream from input', () => {
                builder.mapVideo(0, 0);
                const args = builder.build();

                expect(args).toContain('-map');
                expect(args).toContain('0:v:0');
            });
        });

        describe('mapAudio', () => {
            it('maps audio stream from input', () => {
                builder.mapAudio(0, 2);
                const args = builder.build();

                expect(args).toContain('-map');
                expect(args).toContain('0:a:2');
            });

            it('maps audio from different inputs', () => {
                builder.mapAudio(0, 0);
                builder.mapAudio(1, 1);
                const args = builder.build();

                expect(args).toContain('0:a:0');
                expect(args).toContain('1:a:1');
            });
        });

        describe('mapAllAudio', () => {
            it('maps all audio from input', () => {
                builder.mapAllAudio(0);
                const args = builder.build();

                expect(args).toContain('-map');
                expect(args).toContain('0:a');
            });
        });
    });

    describe('HLS Output', () => {
        describe('configureHlsOutput', () => {
            it('sets HLS format and options', () => {
                builder.configureHlsOutput({
                    segmentDuration: 6,
                    playlistType: 'event',
                    segmentType: 'fmp4',
                });
                const args = builder.build();

                expect(args).toContain('-f');
                expect(args).toContain('hls');
                expect(args).toContain('-hls_time');
                expect(args).toContain('6');
                expect(args).toContain('-hls_playlist_type');
                expect(args).toContain('event');
                expect(args).toContain('-hls_segment_type');
                expect(args).toContain('fmp4');
            });

            it('sets init filename for fMP4', () => {
                builder.configureHlsOutput({
                    segmentType: 'fmp4',
                    initFilename: 'init_%v.mp4',
                });
                const args = builder.build();

                expect(args).toContain('-hls_fmp4_init_filename');
                expect(args).toContain('init_%v.mp4');
            });

            it('sets HLS flags', () => {
                builder.configureHlsOutput({
                    flags: ['independent_segments', 'program_date_time'],
                });
                const args = builder.build();

                expect(args).toContain('-hls_flags');
                expect(args).toContain('independent_segments+program_date_time');
            });
        });

        describe('setVarStreamMap', () => {
            it('sets var_stream_map for multi-audio', () => {
                builder.setVarStreamMap('a:0,agroup:audio v:0,agroup:audio');
                const args = builder.build();

                expect(args).toContain('-var_stream_map');
                expect(args).toContain('a:0,agroup:audio v:0,agroup:audio');
            });
        });

        describe('setMasterPlaylist', () => {
            it('sets master playlist name', () => {
                builder.setMasterPlaylist('master.m3u8');
                const args = builder.build();

                expect(args).toContain('-master_pl_name');
                expect(args).toContain('master.m3u8');
            });
        });
    });

    describe('Hardware Acceleration', () => {
        describe('enableHwAccel', () => {
            it('enables NVENC acceleration', () => {
                builder.enableHwAccel('nvenc');
                const args = builder.build();

                expect(args).toContain('-hwaccel');
                expect(args).toContain('cuda');
                expect(args).toContain('-hwaccel_output_format');
                expect(args).toContain('cuda');
            });

            it('enables VAAPI acceleration', () => {
                builder.enableHwAccel('vaapi', '/dev/dri/renderD128');
                const args = builder.build();

                expect(args).toContain('-hwaccel');
                expect(args).toContain('vaapi');
                expect(args).toContain('-vaapi_device');
                expect(args).toContain('/dev/dri/renderD128');
            });

            it('enables QSV acceleration', () => {
                builder.enableHwAccel('qsv');
                const args = builder.build();

                expect(args).toContain('-hwaccel');
                expect(args).toContain('qsv');
            });

            it('enables VideoToolbox acceleration', () => {
                builder.enableHwAccel('videotoolbox');
                const args = builder.build();

                expect(args).toContain('-hwaccel');
                expect(args).toContain('videotoolbox');
            });

            describe('QSV software-decode bridge', () => {
                it('uses init_hw_device + filter device instead of -hwaccel_output_format', () => {
                    builder.enableHwAccel('qsv', undefined, { softwareDecodeBridge: true });
                    const args = builder.build();

                    // No GPU decode forced — frames come from a software decoder
                    expect(args).not.toContain('-hwaccel');
                    expect(args).not.toContain('-hwaccel_output_format');
                    // Explicit QSV filter device derived from VAAPI
                    expect(args).toContain('-init_hw_device');
                    const initDevices = args.filter((a) => a === '-init_hw_device').length;
                    expect(initDevices).toBe(2);
                    expect(args).toContain('qsv=qs@va');
                    expect(args).toContain('-filter_hw_device');
                    expect(args).toContain('qs');
                });

                it('inserts an hwupload bridge ahead of the existing filter chain', () => {
                    builder
                        .enableHwAccel('qsv', undefined, { softwareDecodeBridge: true })
                        .addVideoFilter('scale_qsv=w=trunc(iw/2)*2:h=trunc(ih/2)*2');
                    const args = builder.build();

                    const vfIndex = args.indexOf('-vf');
                    expect(vfIndex).not.toBe(-1);
                    expect(args[vfIndex + 1]).toBe(
                        'format=nv12,hwupload=extra_hw_frames=16,format=qsv,scale_qsv=w=trunc(iw/2)*2:h=trunc(ih/2)*2',
                    );
                });

                it('adds an hwupload bridge even with no other filters', () => {
                    builder.enableHwAccel('qsv', undefined, { softwareDecodeBridge: true });
                    const args = builder.build();

                    const vfIndex = args.indexOf('-vf');
                    expect(vfIndex).not.toBe(-1);
                    expect(args[vfIndex + 1]).toBe(
                        'format=nv12,hwupload=extra_hw_frames=16,format=qsv',
                    );
                });

                it('does not double-insert the bridge on repeated build() calls', () => {
                    builder
                        .enableHwAccel('qsv', undefined, { softwareDecodeBridge: true })
                        .addVideoFilter('scale_qsv=w=1280:h=720');
                    builder.build();
                    const args = builder.build();

                    const vfIndex = args.indexOf('-vf');
                    expect(args[vfIndex + 1]).toBe(
                        'format=nv12,hwupload=extra_hw_frames=16,format=qsv,scale_qsv=w=1280:h=720',
                    );
                });

                it('keeps the zero-copy path when bridge is not requested', () => {
                    builder.enableHwAccel('qsv');
                    const args = builder.build();

                    expect(args).toContain('-hwaccel');
                    expect(args).toContain('-hwaccel_output_format');
                    expect(args).not.toContain('-init_hw_device');
                });
            });

            describe('VA-API software-decode bridge', () => {
                it('drops -hwaccel_output_format and keeps the device for the encoder', () => {
                    builder.enableHwAccel('vaapi', '/dev/dri/renderD128', {
                        softwareDecodeBridge: true,
                    });
                    const args = builder.build();

                    expect(args).not.toContain('-hwaccel');
                    expect(args).not.toContain('-hwaccel_output_format');
                    expect(args).toContain('-vaapi_device');
                    expect(args).toContain('/dev/dri/renderD128');
                });

                it('inserts a plain hwupload bridge ahead of the filter chain', () => {
                    builder
                        .enableHwAccel('vaapi', '/dev/dri/renderD128', {
                            softwareDecodeBridge: true,
                        })
                        .addVideoFilter('scale_vaapi=w=trunc(iw/2)*2:h=trunc(ih/2)*2');
                    const args = builder.build();

                    const vfIndex = args.indexOf('-vf');
                    expect(args[vfIndex + 1]).toBe(
                        'format=nv12,hwupload,scale_vaapi=w=trunc(iw/2)*2:h=trunc(ih/2)*2',
                    );
                });

                it('keeps the zero-copy path when bridge is not requested', () => {
                    builder.enableHwAccel('vaapi', '/dev/dri/renderD128');
                    const args = builder.build();

                    expect(args).toContain('-hwaccel');
                    expect(args).toContain('-hwaccel_output_format');
                });
            });

            describe('VA-API software HDR tone-map (AMD)', () => {
                it('uses software filters + a TAIL hwupload (after tonemap/scale)', () => {
                    builder
                        .enableHwAccel('vaapi', '/dev/dri/renderD128', {
                            vaapiSoftwareTonemap: true,
                        })
                        .addVideoFilter('tonemapx=tonemap=bt2390:format=yuv420p')
                        .addVideoFilter('scale=1280:720');
                    const args = builder.build();

                    // No GPU decode, software filter backend
                    expect(args).not.toContain('-hwaccel');
                    expect(args).not.toContain('-hwaccel_output_format');
                    expect(builder.getActiveFilterHwAccel()).toBe('none');
                    expect(args).toContain('-vaapi_device');
                    // upload goes at the END — after the software tonemap + scale
                    const vfIndex = args.indexOf('-vf');
                    expect(args[vfIndex + 1]).toBe(
                        'tonemapx=tonemap=bt2390:format=yuv420p,scale=1280:720,format=nv12,hwupload',
                    );
                });
            });

            describe('NVENC encoder-only bridge', () => {
                it('drops CUDA decode and inserts NO hwupload (encoder ingests system frames)', () => {
                    builder.enableHwAccel('nvenc', undefined, { softwareDecodeBridge: true });
                    const args = builder.build();

                    expect(args).not.toContain('-hwaccel');
                    expect(args).not.toContain('-hwaccel_output_format');
                    expect(args).not.toContain('-init_hw_device');
                    // No -vf bridge at all — software frames go straight to nvenc
                    expect(args).not.toContain('-vf');
                });

                it('reports software filter backend so scalers go software', () => {
                    builder.enableHwAccel('nvenc', undefined, { softwareDecodeBridge: true });
                    expect(builder.getActiveFilterHwAccel()).toBe('none');
                    // still counts as "hwaccel enabled" so the strategy won't re-enable CUDA
                    expect(builder.hasHwAccelEnabled()).toBe(true);
                });

                it('keeps CUDA zero-copy + scale_cuda when bridge is not requested', () => {
                    builder.enableHwAccel('nvenc');
                    expect(builder.getActiveFilterHwAccel()).toBe('nvenc');
                    const args = builder.build();
                    expect(args).toContain('-hwaccel');
                    expect(args).toContain('cuda');
                });
            });
        });
    });

    describe('Output Options', () => {
        describe('addOutputOptions', () => {
            it('adds common output options', () => {
                builder.addOutputOptions();
                const args = builder.build();

                expect(args).toContain('-avoid_negative_ts');
                expect(args).toContain('make_zero');
                expect(args).toContain('-fflags');
                expect(args).toContain('+genpts');
                expect(args).toContain('-max_muxing_queue_size');
            });
        });

        describe('enableStrict', () => {
            it('enables unofficial strict mode for DV', () => {
                builder.enableStrict();
                const args = builder.build();

                expect(args).toContain('-strict');
                expect(args).toContain('unofficial');
            });
        });

        describe('setOutput', () => {
            it('sets output path as last argument', () => {
                builder.setOutput('/tmp/output.m3u8');
                const args = builder.build();

                expect(args[args.length - 1]).toBe('/tmp/output.m3u8');
            });
        });
    });

    describe('build()', () => {
        it('returns a copy of args array', () => {
            const args1 = builder.build();
            const args2 = builder.build();

            expect(args1).toEqual(args2);
            expect(args1).not.toBe(args2); // Different array instances
        });
    });

    describe('Integration: Complete HLS Pipeline', () => {
        it('builds complete args for local file transcode', () => {
            builder
                .enableHwAccel('nvenc')
                .addInputFile('/media/movie.mkv', 300)
                .mapVideo(0, 0)
                .mapAudio(0, 0)
                .mapAudio(0, 1)
                .setVideoCodec('hevc_nvenc', {
                    nvencPreset: 'p4',
                    profile: 'main10',
                    level: '5.1',
                    bframes: 3,
                })
                .setKeyframeInterval(6, 24)
                .copyAudio(0)
                .setAudioCodec('aac', 1, { bitrate: '256k', channels: 6 })
                .addOutputOptions()
                .enableStrict()
                .configureHlsOutput({
                    segmentDuration: 6,
                    playlistType: 'event',
                    segmentType: 'fmp4',
                })
                .setVarStreamMap('a:0,agroup:audio a:1,agroup:audio v:0,agroup:audio')
                .setMasterPlaylist('master.m3u8')
                .setOutput('/tmp/output/stream_%v/index.m3u8');

            const args = builder.build();

            // Verify key components are present
            expect(args).toContain('-hwaccel');
            expect(args).toContain('-ss');
            expect(args).toContain('-i');
            expect(args).toContain('-c:v');
            expect(args).toContain('hevc_nvenc');
            expect(args).toContain('-profile:v');
            expect(args).toContain('main10');
            expect(args).toContain('-bf');
            expect(args).toContain('-g');
            expect(args).toContain('-c:a:0');
            expect(args).toContain('copy');
            expect(args).toContain('-c:a:1');
            expect(args).toContain('aac');
            expect(args).toContain('-f');
            expect(args).toContain('hls');
            expect(args).toContain('-var_stream_map');
            expect(args).toContain('-master_pl_name');
            expect(args[args.length - 1]).toBe('/tmp/output/stream_%v/index.m3u8');
        });
    });

    describe('enableSubtitleBurnIn', () => {
        it('adds filter_complex with overlay', () => {
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.mapAudio(0, 0);
            builder.setVideoCodec('libx264');
            builder.enableSubtitleBurnIn(3);
            const args = builder.build();

            expect(args).toContain('-filter_complex');
            const fcIdx = args.indexOf('-filter_complex');
            const filterChain = args[fcIdx + 1];
            expect(filterChain).toContain('[0:v]');
            expect(filterChain).toContain('[0:3][0:v]scale2ref=w=rw:h=rw*ih/iw[_sub][_ref]');
            expect(filterChain).toContain('[_ref][_sub]overlay=x=(W-w)/2:y=H-h');
            expect(filterChain).toContain('[vout]');
        });

        it('replaces -map 0:v:0 with -map [vout]', () => {
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('libx264');
            builder.enableSubtitleBurnIn(5);
            const args = builder.build();

            expect(args).toContain('-map');
            const mapIdx = args.indexOf('-map');
            // First -map should be [vout] (was 0:v:0)
            expect(args[mapIdx + 1]).toBe('[vout]');
        });

        it('removes hwaccel flags but keeps device args', () => {
            builder.enableHwAccel('vaapi', '/dev/dri/renderD128');
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('hevc_vaapi');
            builder.enableSubtitleBurnIn(3);
            const args = builder.build();

            expect(args).not.toContain('-hwaccel');
            expect(args).not.toContain('-hwaccel_output_format');
            // Device arg should be preserved for GPU encode
            expect(args).toContain('-vaapi_device');
        });

        it('adds hwupload for VAAPI encode', () => {
            builder.enableHwAccel('vaapi', '/dev/dri/renderD128');
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('hevc_vaapi');
            builder.enableSubtitleBurnIn(3);
            const args = builder.build();

            const fcIdx = args.indexOf('-filter_complex');
            const filterChain = args[fcIdx + 1];
            expect(filterChain).toContain('format=nv12,hwupload');
        });

        // h264 hardware encoders get an 8-bit pin; with burn-in it must live inside
        // the complex graph — a -vf next to -filter_complex makes ffmpeg refuse to
        // start ("Simple and complex filtering cannot be used together").
        it.each([
            ['vaapi', 'h264_vaapi', 'format=nv12,hwupload[vout]'],
            ['qsv', 'h264_qsv', 'format=qsv[vout]'],
            ['nvenc', 'h264_nvenc', 'y=H-h,format=yuv420p[vout]'],
        ] as const)('%s h264 burn-in pins 8-bit inside the graph, no -vf', (hw, enc, tail) => {
            builder.enableHwAccel(hw, hw === 'nvenc' ? undefined : '/dev/dri/renderD128');
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec(enc);
            builder.enableSubtitleBurnIn(3);
            const args = builder.build();

            expect(args).not.toContain('-vf');
            const graph = args[args.indexOf('-filter_complex') + 1];
            expect(graph.endsWith(tail)).toBe(true);
        });

        // The frame is downscaled before the overlay (tonemap + overlay at output
        // size, not 4K), so the subtitle canvas must be fitted to that frame:
        // width-fit keeping its aspect, anchored to the bottom.
        it('fits the subtitle canvas to the downscaled frame, bottom-anchored', () => {
            builder.enableHwAccel('vaapi', '/dev/dri/renderD128');
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('h264_vaapi');
            builder.addVideoFilter('scale_vaapi=w=1280:h=720');
            builder.enableSubtitleBurnIn(2);
            const args = builder.build();

            const graph = args[args.indexOf('-filter_complex') + 1];
            expect(graph).toBe(
                '[0:v]scale=w=1280:h=720[_vf];[0:2][_vf]scale2ref=w=rw:h=rw*ih/iw[_sub][_ref];' +
                    '[_ref][_sub]overlay=x=(W-w)/2:y=H-h,format=nv12,hwupload[vout]',
            );
        });

        // overlay defaults to 8-bit yuv420: an HDR-preserving 10-bit encode with
        // burn-in must keep 10-bit through the overlay; 8-bit encodes are unchanged.
        it.each([
            ['libx265', 'yuv420p10le'],
            ['hevc_nvenc', 'p010le'],
            ['av1_nvenc', 'p010le'],
            ['hevc_amf', 'p010le'],
            ['hevc_videotoolbox', 'p010le'],
        ])('keeps supported 10-bit 4:2:0 frames for %s (%s)', (encoder, format) => {
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec(encoder);
            builder.enableHdr10Output({ outputRange: 'HDR10' });
            builder.enableSubtitleBurnIn(3);
            const tenBit = builder.build();
            expect(tenBit[tenBit.indexOf('-filter_complex') + 1]).toContain(
                `overlay=x=(W-w)/2:y=H-h:format=auto,format=${format}`,
            );

            const sdr = new FFmpegArgsBuilder();
            sdr.addInputFile('/path/to/video.mkv');
            sdr.mapVideo(0, 0);
            sdr.setVideoCodec('libx264');
            sdr.enableSubtitleBurnIn(3);
            const eightBit = sdr.build();
            expect(eightBit[eightBit.indexOf('-filter_complex') + 1]).not.toContain('format=auto');
        });

        // NVENC HDR→SDR + burn-in: `tonemap_cuda,scale_cuda=format=` mapped to
        // `tonemap=hable,scale=format=` was rejected by FFmpeg at parse time.
        it('maps the NVENC HDR tonemap chain to software tonemapx for burn-in', () => {
            builder.enableHwAccel('nvenc');
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('h264_nvenc');
            builder.addVideoFilter(
                'tonemap_cuda=tonemap=bt2390:desat=0.5:peak=100,scale_cuda=format=yuv420p',
            );
            builder.addVideoFilter('scale_cuda=w=1720:h=720');
            builder.enableSubtitleBurnIn(6);
            const args = builder.build();

            const graph = args[args.indexOf('-filter_complex') + 1];
            expect(graph).toMatch(
                /^\[0:v\]tonemapx=[^;]*format=yuv420p,scale=w=1720:h=720\[_vf\];/,
            );
            expect(graph).not.toContain('tonemap=hable');
            expect(graph).not.toContain('scale=format=');
            expect(
                graph.endsWith(
                    'scale=w=1720:h=720[_vf];[0:6][_vf]scale2ref=w=rw:h=rw*ih/iw[_sub][_ref];[_ref][_sub]overlay=x=(W-w)/2:y=H-h,format=yuv420p[vout]',
                ),
            ).toBe(true);
        });

        it('does not add hwupload for NVENC', () => {
            builder.enableHwAccel('nvenc');
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('h264_nvenc');
            builder.enableSubtitleBurnIn(3);
            const args = builder.build();

            const fcIdx = args.indexOf('-filter_complex');
            const filterChain = args[fcIdx + 1];
            expect(filterChain).not.toContain('hwupload');
        });

        it('converts GPU-specific -vf filters to CPU equivalents', () => {
            builder.enableHwAccel('nvenc');
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('h264_nvenc');
            builder.addVideoFilter('scale_cuda=w=1920:h=1080');
            builder.enableSubtitleBurnIn(4);
            const args = builder.build();

            const fcIdx = args.indexOf('-filter_complex');
            const filterChain = args[fcIdx + 1];
            // GPU scale should be replaced with CPU scale
            expect(filterChain).toContain('scale=w=1920:h=1080');
            expect(filterChain).not.toContain('scale_cuda');
            // The resize runs before the overlay (subtitle fitted by scale2ref)
            expect(filterChain).toContain('[0:v]scale=w=1920:h=1080[_vf]');
        });

        it('works without existing -vf filters', () => {
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('libx264');
            builder.enableSubtitleBurnIn(2);
            const args = builder.build();

            const fcIdx = args.indexOf('-filter_complex');
            const filterChain = args[fcIdx + 1];
            // Direct overlay without intermediate filters
            expect(filterChain).toBe(
                '[0:2][0:v]scale2ref=w=rw:h=rw*ih/iw[_sub][_ref];[_ref][_sub]overlay=x=(W-w)/2:y=H-h,format=yuv420p[vout]',
            );
        });

        it('preserves audio maps after video map', () => {
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.mapAudio(0, 0);
            builder.mapAudio(0, 1);
            builder.setVideoCodec('libx264');
            builder.enableSubtitleBurnIn(3);
            const args = builder.build();

            // Find all -map args
            const maps: string[] = [];
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '-map') maps.push(args[i + 1]);
            }

            expect(maps[0]).toBe('[vout]'); // video → filter output
            expect(maps[1]).toBe('0:a:0'); // audio 0
            expect(maps[2]).toBe('0:a:1'); // audio 1
        });

        // Regression: a CPU overlay leaves frames in system memory, so a QSV
        // encoder ALWAYS needs an hwupload — not only when a software-decode bridge
        // is active. Without this, hardware-decodable sources (e.g. AV1) fed the
        // system frames straight to hevc_qsv, which fails to open.
        it('adds a QSV hwupload for QSV encode even without a decode bridge', () => {
            builder.enableHwAccel('qsv'); // zero-copy decode, no bridge
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('hevc_qsv');
            builder.enableSubtitleBurnIn(3);
            const args = builder.build();

            const fcIdx = args.indexOf('-filter_complex');
            const filterChain = args[fcIdx + 1];
            expect(filterChain).toContain('hwupload=extra_hw_frames=16,format=qsv');
        });

        it('tonemaps HDR→SDR before the overlay when tonemapHdrToSdr is set', () => {
            builder.enableHwAccel('qsv');
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('hevc_qsv');
            builder.enableSubtitleBurnIn(7, { tonemapHdrToSdr: true });
            const args = builder.build();

            const fcIdx = args.indexOf('-filter_complex');
            const filterChain = args[fcIdx + 1];
            // tonemapx emits an 8-bit SDR image, applied ahead of the overlay.
            expect(filterChain).toContain('tonemapx=tonemap=');
            expect(filterChain).toContain('format=nv12');
            expect(filterChain.indexOf('tonemapx')).toBeLessThan(filterChain.indexOf('overlay'));
            // Still uploads the composited SDR frames to the QSV surface.
            expect(filterChain).toContain('hwupload=extra_hw_frames=16,format=qsv');
        });

        it('does not tonemap when tonemapHdrToSdr is not set', () => {
            builder.enableHwAccel('qsv');
            builder.addInputFile('/path/to/video.mkv');
            builder.mapVideo(0, 0);
            builder.setVideoCodec('hevc_qsv');
            builder.enableSubtitleBurnIn(7);
            const args = builder.build();

            const fcIdx = args.indexOf('-filter_complex');
            const filterChain = args[fcIdx + 1];
            expect(filterChain).not.toContain('tonemapx');
        });
    });
});

// Regression tests for the GPU HDR10 transcode breakages found on an RTX 3090:
//   1. `-master_display`/`-max_cll` are libx265-only — pushing them to a hardware
//      encoder aborts FFmpeg ("Unrecognized option 'master_display'").
//   2. Forcing `-pix_fmt` while a hardware decode is active makes FFmpeg insert an
//      auto_scale that can't bridge GPU↔system formats → code -38.
describe('FFmpegArgsBuilder — enableHdr10Output', () => {
    const hdrMeta = {
        masteringDisplayMetadata:
            'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50)',
        maxCll: '1000,400',
    };

    it('hardware encoder + hw decode: no -master_display/-max_cll/-pix_fmt, but keeps HDR10 color VUI', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('nvenc');
        builder.setVideoCodec('hevc_nvenc');
        builder.enableHdr10Output({ outputRange: 'HDR10', metadata: hdrMeta });
        const args = builder.build();

        // The invalid-for-hardware options must NOT be present.
        expect(args).not.toContain('-master_display');
        expect(args).not.toContain('-max_cll');
        // No software -pix_fmt forced onto GPU-resident frames.
        expect(args).not.toContain('-pix_fmt');
        // HDR10 is still signaled via the BT.2020 + PQ color VUI.
        expect(args).toContain('-color_trc');
        expect(args).toContain('smpte2084');
        expect(args).toContain('-color_primaries');
        expect(args).toContain('bt2020');
    });

    it('software libx265: carries HDR10 mastering metadata via -x265-params and sets -pix_fmt', () => {
        const builder = new FFmpegArgsBuilder();
        builder.setVideoCodec('libx265');
        builder.enableHdr10Output({ outputRange: 'HDR10', metadata: hdrMeta });
        const args = builder.build();

        const x265Idx = args.indexOf('-x265-params');
        expect(x265Idx).toBeGreaterThanOrEqual(0);
        expect(args[x265Idx + 1]).toContain('master-display=');
        expect(args[x265Idx + 1]).toContain('max-cll=1000,400');
        // Software path needs an explicit 10-bit pixel format.
        const pixIdx = args.indexOf('-pix_fmt');
        expect(pixIdx).toBeGreaterThanOrEqual(0);
        expect(args[pixIdx + 1]).toBe('yuv420p10le');
        // x265 standalone options must never leak as CLI flags.
        expect(args).not.toContain('-master_display');
    });

    it('GPU VA-API tonemap uses tonemap_vaapi (NOT the software tonemap, which cannot feed a HW encoder)', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('vaapi');
        builder.setVideoCodec('h264_vaapi');
        builder.enableTonemapping({ useGpu: true });
        const args = builder.build().join(' ');
        // Must GPU-tonemap regardless of VPP_TONEMAPPING — feeding software frames
        // to h264_vaapi fails to open the encoder (VA-API -38).
        expect(args).toContain('tonemap_vaapi');
        expect(args).not.toContain('tonemapx');
    });

    it('software (libx264) tonemap uses the tonemapx SIMD path', () => {
        const builder = new FFmpegArgsBuilder();
        builder.setVideoCodec('libx264');
        builder.enableTonemapping({ useGpu: false });
        const args = builder.build().join(' ');
        expect(args).toContain('tonemapx');
        expect(args).not.toContain('tonemap_vaapi');
    });

    // `-color_range` is a CONVERSION request, not a tag: when it differs from the
    // range the decoded frames already carry, FFmpeg inserts an auto_scale to do
    // the conversion — and auto_scale cannot touch QSV/VA-API surfaces:
    //   "Impossible to convert between the formats supported by the filter
    //    'Parsed_scale_qsv_0' and the filter 'auto_scale_0'"  → vf -38
    //   → "[vost#0:0/hevc_qsv] Task finished with error code: -22"
    // Reproduced on the prod Arc A380 against a real DV P10/AV1 source: dropping
    // ONLY `-color_range tv` from an otherwise identical command turns the failure
    // into a clean encode, and the same command crashes hevc_vaapi identically.
    // -colorspace/-color_primaries/-color_trc are pure VUI metadata and stay.
    it.each([
        ['qsv', 'hevc_qsv'],
        ['vaapi', 'hevc_vaapi'],
    ] as const)(
        'VA-API-family pipeline (%s): omits -color_range so no auto_scale is forced onto the surface',
        (hwaccel, encoder) => {
            const builder = new FFmpegArgsBuilder();
            builder.enableHwAccel(hwaccel);
            builder.setVideoCodec(encoder);
            builder.enableHdr10Output({ outputRange: 'HDR10' });
            const args = builder.build();

            expect(args).not.toContain('-color_range');
            // The HDR10 VUI must still be signalled — only the range is dropped.
            expect(args).toContain('-color_trc');
            expect(args).toContain('smpte2084');
        },
    );

    // Verified on an RTX 3090 with a genuinely full-range (pc) 10-bit HDR source:
    // `-color_range tv` encodes cleanly on CUDA because scale_cuda absorbs the range
    // conversion. Dropping it there would needlessly mis-tag NVENC HDR output as full
    // range, so the guard must stay VA-API-family-specific rather than "any hwaccel".
    it('CUDA keeps -color_range tv (scale_cuda absorbs the conversion; verified on an RTX 3090)', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('nvenc');
        builder.setVideoCodec('hevc_nvenc');
        builder.enableHdr10Output({ outputRange: 'HDR10' });
        const args = builder.build();

        const idx = args.indexOf('-color_range');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(args[idx + 1]).toBe('tv');
    });

    // The VA-API software-HDR bridge leaves hwAccelType 'none' but uploads to a VA-API
    // surface at the tail, so the graph output is still a surface auto_scale can't touch.
    it('VA-API software-HDR bridge omits -color_range (output is still a VA-API surface)', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('vaapi', '/dev/dri/renderD128', { vaapiSoftwareTonemap: true });
        builder.setVideoCodec('hevc_vaapi');
        builder.enableHdr10Output({ outputRange: 'HDR10' });
        const args = builder.build();

        expect(args).not.toContain('-color_range');
    });

    it('software pipeline: still tags limited range (auto_scale can convert system frames)', () => {
        const builder = new FFmpegArgsBuilder();
        builder.setVideoCodec('libx265');
        builder.enableHdr10Output({ outputRange: 'HDR10' });
        const args = builder.build();

        const idx = args.indexOf('-color_range');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(args[idx + 1]).toBe('tv');
    });

    // vpp_qsv's tonemap keeps the surface at its input depth unless told otherwise,
    // so an HDR (10-bit) source tone-mapped for h264_qsv still arrives as p010 and
    // the encoder refuses to open: "Current pixel format is unsupported" → -22.
    // Verified on the prod Arc A380: adding `:format=nv12` is the whole difference
    // between a failing and a succeeding command.
    // A 10-bit SDR source (anime remuxes, typically) is not HDR, so no tone-map is
    // added and nothing else converted the p010 surface — h264_qsv then failed to
    // open with "Current pixel format is unsupported" → -22. Reproduced on prod
    // against a real 10-bit SDR HEVC file; appending vpp_qsv=format=nv12 fixes it.
    it.each([
        ['qsv', 'h264_qsv', 'vpp_qsv=format=nv12'],
        ['vaapi', 'h264_vaapi', 'scale_vaapi=format=nv12'],
    ] as const)(
        '%s: pins an 8-bit surface for %s even with no tonemap (10-bit SDR source)',
        (hwaccel, encoder, expectedFilter) => {
            const builder = new FFmpegArgsBuilder();
            builder.enableHwAccel(hwaccel);
            builder.setVideoCodec(encoder);
            builder.addVideoFilter(`scale_${hwaccel}=w=trunc(iw/2)*2:h=trunc(ih/2)*2`);
            const args = builder.build().join(' ');

            expect(args).toContain(expectedFilter);
        },
    );

    // h264_nvenc has no high10 profile (baseline/main/high/high444p) but nvenc's shared
    // pix_fmt list still advertises p010le — so FFmpeg negotiates a 10-bit surface
    // without complaint (scale_cuda logs "fmt:p010le -> p010le (passthrough)") and
    // NVENC only fails at encoder init. Verified on an RTX 3090:
    //   "[h264_nvenc] 10 bit encode not supported" → vf -40 → vost -22
    // for BOTH a tv-range 10-bit SDR source and a pc-range 10-bit HDR one; adding
    // scale_cuda=format=yuv420p fixes both, and an 8-bit source is unaffected.
    it('nvenc: pins 8-bit for h264_nvenc on a CUDA surface', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('nvenc');
        builder.setVideoCodec('h264_nvenc');
        builder.addVideoFilter('scale_cuda=w=trunc(iw/2)*2:h=trunc(ih/2)*2');
        const args = builder.build().join(' ');

        expect(args).toContain('scale_cuda=format=yuv420p');
    });

    it('nvenc encoder-only bridge: pins 8-bit in software (frames are in system memory)', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('nvenc', undefined, { softwareDecodeBridge: true });
        builder.setVideoCodec('h264_nvenc');
        const args = builder.build().join(' ');

        // The bridge leaves hwAccelType 'none', so a hardware scaler would be wrong.
        expect(args).toContain('format=yuv420p');
        expect(args).not.toContain('scale_cuda');
    });

    it('hevc_nvenc keeps its 10-bit surface (main10 profile exists — do not force 8-bit)', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('nvenc');
        builder.setVideoCodec('hevc_nvenc');
        builder.addVideoFilter('scale_cuda=w=trunc(iw/2)*2:h=trunc(ih/2)*2');
        const args = builder.build().join(' ');

        expect(args).not.toContain('format=yuv420p');
    });

    it('HEVC QSV keeps its 10-bit surface (Main10 encodes it natively — do not force nv12)', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('qsv');
        builder.setVideoCodec('hevc_qsv');
        builder.addVideoFilter('scale_qsv=w=trunc(iw/2)*2:h=trunc(ih/2)*2');
        const args = builder.build().join(' ');

        expect(args).not.toContain('format=nv12');
    });

    it('does not stack a second nv12 pass when the tonemap already emits nv12', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('qsv');
        builder.setVideoCodec('h264_qsv');
        builder.enableTonemapping({ useGpu: true });
        const args = builder.build().join(' ');

        expect(args).not.toContain('vpp_qsv=format=nv12');
        expect(args.match(/format=nv12/g)).toHaveLength(1);
    });

    it('QSV tonemap emits 8-bit nv12 (h264_qsv cannot encode 10-bit)', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('qsv');
        builder.setVideoCodec('h264_qsv');
        builder.enableTonemapping({ useGpu: true });
        const args = builder.build().join(' ');

        expect(args).toMatch(/vpp_qsv=tonemap=1[^,\s]*:format=nv12/);
    });
});

// The software-decode bridge uploads system-memory frames onto a GPU surface. That
// surface's depth must match the depth the ENCODER was told to emit, or the QSV
// runtime rejects the encoder at init:
//   "[hevc_qsv] Current profile is unsupported"
//   → "Could not open encoder before EOF" → vost -22 (Invalid argument)
// and not a single frame is produced — the client just sees a dead stream.
//
// This shipped broken: the bridge hardcoded 8-bit `format=nv12` while HDR10
// preservation set `-profile:v main10`. Reproduced on the prod Arc A380 against a
// real 10-bit DV-P10/AV1 4K remux — changing ONLY nv12→p010le turns the identical
// command from "encoder never opens" into a clean encode producing real segments.
describe('software-decode bridge: upload depth must match the encoder profile', () => {
    it.each([
        ['qsv', 'hevc_qsv'],
        ['vaapi', 'hevc_vaapi'],
    ] as const)(
        '%s bridge uploads a 10-bit (p010le) surface when the encoder emits Main 10',
        (hwaccel, encoder) => {
            const builder = new FFmpegArgsBuilder();
            builder.enableHwAccel(hwaccel, '/dev/dri/renderD128', {
                softwareDecodeBridge: true,
            });
            builder.setVideoCodec(encoder);
            builder.enableHdr10Output({ outputRange: 'HDR10' });
            const args = builder.build();

            // Guard the premise: HDR10 preservation really did request Main 10.
            const profileIdx = args.indexOf('-profile:v');
            expect(args[profileIdx + 1]).toBe('main10');

            const vf = args[args.indexOf('-vf') + 1];
            expect(vf).toContain('format=p010le');
            expect(vf).not.toContain('format=nv12');
        },
    );

    // An HDR transfer function is the ONLY 10-bit signal an AV1 encode carries:
    // `main10` is HEVC-keyed and AV1 is given no -profile:v at all. Missing it fails
    // SILENTLY — av1_qsv accepts nv12, so there is no error and no failure event,
    // just a crushed 8-bit image tagged BT.2020/PQ. Banding, and nothing to correlate.
    it('treats an HDR transfer as 10-bit even when the encoder carries no profile', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('qsv', '/dev/dri/renderD128', { softwareDecodeBridge: true });
        builder.setVideoCodec('av1_qsv');
        builder.enableHdr10Output({ outputRange: 'HDR10' });
        const args = builder.build();

        // Guard the premise: AV1 really does reach here with no -profile:v.
        expect(args).not.toContain('-profile:v');
        expect(args[args.indexOf('-vf') + 1]).toContain('format=p010le');
    });

    // No hardware H.264 encoder can emit >8-bit, so a 10-bit signal must NOT widen
    // the surface for one — that would upload p010 only to convert it back down, or
    // hand a vendor without that pin a surface it rejects outright.
    it('never widens the surface for a hardware H.264 encoder', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('qsv', '/dev/dri/renderD128', { softwareDecodeBridge: true });
        builder.setVideoCodec('h264_qsv');
        builder.enableHdr10Output({ outputRange: 'HDR10' });
        const args = builder.build();

        expect(args[args.indexOf('-vf') + 1]).toContain('format=nv12');
        expect(args.join(' ')).not.toContain('p010');
    });

    // `nv12` ends in "12" — a bare trailing-digits test matches it and flips an
    // explicitly 8-bit pipeline to a p010 upload, re-arming the auto_scale -38 →
    // vost -22 chain this whole mechanism exists to prevent.
    it('does not mistake an 8-bit nv12 pix_fmt for a 10-bit output', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('qsv', '/dev/dri/renderD128', { softwareDecodeBridge: true });
        builder.setVideoCodec('hevc_qsv');
        builder.setPixelFormat('nv12');
        const args = builder.build();

        const vf = args[args.indexOf('-vf') + 1];
        expect(vf).toContain('format=nv12');
        expect(vf).not.toContain('p010');
    });

    // Same bug, one vendor over: the VA-API burn-in suffix used to hardcode nv12.
    // Burn-in over 10-bit HDR reaches here with -profile:v main10 (VA-API is excluded
    // from setVideoCodec's profile handling, so enableHdr10Output pushes it).
    it('VA-API subtitle burn-in uploads a 10-bit surface under a Main 10 profile', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('vaapi', '/dev/dri/renderD128');
        builder.setVideoCodec('hevc_vaapi');
        builder.enableHdr10Output({ outputRange: 'HDR10' });
        builder.enableSubtitleBurnIn(3);
        const args = builder.build();

        const chain = args[args.indexOf('-filter_complex') + 1];
        expect(chain).toContain('format=auto,format=p010le,hwupload');
        expect(chain).not.toContain('format=nv12');
    });

    // The mirror case: a tone-mapped HDR→SDR pipeline genuinely produces an 8-bit
    // image, so widening the surface to p010 would be pointless. nv12 must stay.
    it('keeps the 8-bit nv12 surface when the output is not 10-bit', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('qsv', '/dev/dri/renderD128', { softwareDecodeBridge: true });
        builder.setVideoCodec('hevc_qsv');
        const args = builder.build();

        expect(args).not.toContain('-profile:v');
        const vf = args[args.indexOf('-vf') + 1];
        expect(vf).toContain('format=nv12');
        expect(vf).not.toContain('p010');
    });
});

describe('resolveTonemapMode', () => {
    it('reports hardware when the GPU VA-API VPP tonemap filter is present', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('vaapi');
        builder.setVideoCodec('h264_vaapi');
        builder.enableTonemapping({ useGpu: true });
        const args = builder.build();

        expect(resolveTonemapMode(args)).toBe('hardware');
    });

    it('reports software when the CPU tonemapx filter is present', () => {
        const builder = new FFmpegArgsBuilder();
        builder.setVideoCodec('libx264');
        builder.enableTonemapping({ useGpu: false });
        const args = builder.build();

        expect(resolveTonemapMode(args)).toBe('software');
    });

    it('reports n/a when no tonemap filter is present', () => {
        const builder = new FFmpegArgsBuilder();
        builder.setVideoCodec('libx264');
        const args = builder.build();

        expect(resolveTonemapMode(args)).toBe('n/a');
    });

    it('reports software when burn-in rewrites a hardware VA-API tonemap filter (the bug this exists to catch)', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('vaapi', '/dev/dri/renderD128');
        builder.addInputFile('/path/to/video.mkv');
        builder.mapVideo(0, 0);
        builder.setVideoCodec('hevc_vaapi');
        builder.enableTonemapping({ useGpu: true });
        builder.enableSubtitleBurnIn(3);
        const args = builder.build();

        // Recording the mode at enableTonemapping()'s return point would say
        // 'hardware' here — applySubtitleBurnIn() rewrites tonemap_vaapi= into
        // software tonemapx= AFTER that point, so only a post-build() scan is
        // correct.
        expect(resolveTonemapMode(args)).toBe('software');
    });

    it('reports software when burn-in rewrites an NVENC CUDA tonemap filter to the bare CPU filter', () => {
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('nvenc');
        builder.addInputFile('/path/to/video.mkv');
        builder.mapVideo(0, 0);
        builder.setVideoCodec('hevc_nvenc');
        builder.enableTonemapping({ useGpu: true });
        builder.enableSubtitleBurnIn(3);
        const args = builder.build();

        expect(resolveTonemapMode(args)).toBe('software');
    });

    it('reports software when burn-in tonemaps directly via tonemapHdrToSdr (no enableTonemapping call at all)', () => {
        const builder = new FFmpegArgsBuilder();
        builder.addInputFile('/path/to/video.mkv');
        builder.mapVideo(0, 0);
        builder.setVideoCodec('libx264');
        builder.enableSubtitleBurnIn(3, { tonemapHdrToSdr: true });
        const args = builder.build();

        expect(resolveTonemapMode(args)).toBe('software');
    });
});

/**
 * TONEMAPPING_PARAM is the tone-map curve's tuning value (0 = the algorithm's
 * own default). Until 2026-10-06 nothing read it; it now reaches the CPU
 * tonemapx filter, the burn-in tonemapx and NVENC's tonemap_cuda.
 */
describe('FFmpegArgsBuilder: TONEMAPPING_PARAM', () => {
    afterEach(() => vi.restoreAllMocks());

    function withParam(value: number): void {
        vi.spyOn(config, 'TONEMAPPING_PARAM', 'get').mockReturnValue(value);
    }

    it('leaves param out at the default 0', () => {
        withParam(0);
        const builder = new FFmpegArgsBuilder();
        builder.setVideoCodec('libx264');
        builder.enableTonemapping({ useGpu: false });
        expect(builder.build().join(' ')).not.toContain('param=');
    });

    it('passes it to the software tonemapx filter', () => {
        withParam(0.5);
        const builder = new FFmpegArgsBuilder();
        builder.setVideoCodec('libx264');
        builder.enableTonemapping({ useGpu: false });
        expect(builder.build().join(' ')).toMatch(/tonemapx=tonemap=\w+:param=0\.5:/);
    });

    it('passes it to NVENC tonemap_cuda', () => {
        withParam(1.2);
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('nvenc');
        builder.setVideoCodec('h264_nvenc');
        builder.enableTonemapping({ useGpu: true });
        expect(builder.build().join(' ')).toMatch(/tonemap_cuda=tonemap=\w+:param=1\.2:/);
    });

    it('passes it to the tonemapx that replaces a GPU tonemap for subtitle burn-in', () => {
        withParam(0.5);
        const builder = new FFmpegArgsBuilder();
        builder.enableHwAccel('nvenc');
        builder.addInputFile('/path/to/video.mkv');
        builder.mapVideo(0, 0);
        builder.setVideoCodec('h264_nvenc');
        builder.enableTonemapping({ useGpu: true });
        builder.enableSubtitleBurnIn(6);
        const args = builder.build();
        const graph = args[args.indexOf('-filter_complex') + 1];
        expect(graph).toMatch(/tonemapx=tonemap=\w+:param=0\.5:/);
        expect(graph).not.toContain('tonemap_cuda');
    });
});
