// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Transcode Strategies
 *
 * Tests the complete buildArgs() flow for FullTranscodeStrategy,
 * verifying FFmpeg argument generation for various scenarios.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The real helper enumerates the local ffmpeg binary; a fixed value keeps the
// characterisation snapshots below identical on every machine.
vi.mock('../../utils/media-format-whitelist.js', () => ({
    getMediaFormatWhitelist: () => 'WL-MEDIA',
    getConcatListFormatWhitelist: () => 'WL-CONCAT-LIST',
}));

import { planStandaloneTranscode } from './effective-transcode-plan.js';
import { FullTranscodeStrategy } from './full-transcode-strategy.js';
import { toSoftwareDecision } from './slow-transcode.js';
import type { FullStrategyConfig } from './transcode-strategy.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import { config as serverConfig } from '$lib/server/config.js';

describe('FullTranscodeStrategy', () => {
    let strategy: FullTranscodeStrategy;

    const baseConfig: Omit<FullStrategyConfig, 'audioTracks' | 'decision'> = {
        localFilePath: '/media/movie.mkv',
        outputDir: '/tmp/transcode/test123',
        segmentDuration: 6,
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
    };

    beforeEach(() => {
        strategy = new FullTranscodeStrategy();
    });

    it.each(['h264', 'hevc', 'av1'] as const)(
        'burn-in resolves an unassigned %s encoder and constrains overlay chroma',
        (codec) => {
            const cfg: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [],
                videoInfo: { codec, outputCodec: codec, width: 320, height: 180, bitDepth: 8 },
                subtitleBurnIn: { absoluteIndex: 1, codec: 'hdmv_pgs_subtitle' },
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };
            const plan = planStandaloneTranscode(cfg);
            const encoder = { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1' }[codec];
            expect(plan.video).toMatchObject({ action: 'transcode', encoder });
            const { args } = strategy.buildArgs({ ...cfg, effectivePlan: plan });
            expect(args[args.indexOf('-c:v') + 1]).toBe(encoder);
            const graph = args[args.indexOf('-filter_complex') + 1]!;
            expect(graph).toContain(
                codec === 'hevc' ? ',format=yuv420p10le[vout]' : ',format=yuv420p[vout]',
            );
            if (codec === 'h264') expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
        },
    );

    describe('buildArgs - software twin of a GPU decision (NVENC session fallback, tail cache)', () => {
        // The decision engine puts the GPU encoder's NAME in targetCodec.video too.
        // Clearing gpuEncoder alone fell through to it and still built hevc_nvenc
        // (Windows tower 2026-10-14: the fallback respawn failed on NVENC again).
        it.each([
            ['hevc_nvenc', 'libx265'],
            ['h264_nvenc', 'libx264'],
            ['hevc_qsv', 'libx265'],
        ])('a %s decision builds %s, with no hardware acceleration', (gpu, software) => {
            const result = strategy.buildArgs({
                ...baseConfig,
                gpuAcceleration: 'none',
                audioTracks: [],
                decision: toSoftwareDecision({
                    mode: 'full',
                    reasons: 1,
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: true,
                    gpuEncoder: gpu,
                    gpuDecoder: 'hevc_cuvid',
                    targetCodec: { video: gpu, audio: 'aac' },
                    needsTonemapping: false,
                    preserveHdr10: false,
                }),
            });
            const joined = result.args.join(' ');
            expect(result.args).toContain(software);
            expect(joined).not.toMatch(/nvenc|_qsv|cuvid|-hwaccel/);
        });
    });

    it('keeps HDR tonemapping when a legacy CPU tail probe reuses the effective decision', () => {
        const config: FullStrategyConfig = {
            ...baseConfig,
            audioTracks: [],
            videoInfo: {
                codec: 'hevc',
                outputCodec: 'h264',
                width: 1920,
                height: 1080,
                videoRange: 'HDR',
                bitDepth: 10,
            },
            decision: {
                mode: 'full',
                reasons: 0,
                videoAction: 'transcode',
                audioAction: 'copy',
                useGpu: false,
                needsTonemapping: false,
                preserveHdr10: false,
            },
            subtitleBurnIn: { absoluteIndex: 2, codec: 'hdmv_pgs_subtitle' },
        };
        // Burn-in was the copy→transcode trigger. The requested H.264 codec
        // supplies the CPU encoder and HDR→SDR handling at effective planning.
        const mainPlan = planStandaloneTranscode(config);
        expect(mainPlan.video).toMatchObject({ action: 'transcode', encoder: 'libx264' });
        const tail = strategy.buildArgs({
            ...config,
            decision: mainPlan.decision,
            subtitleBurnIn: undefined,
            startTimeSeconds: 90,
        });
        expect(tail.args.join(' ')).toContain('tonemapx=');
    });

    describe('buildArgs - Preview duration cap', () => {
        const previewBase = (extra: Partial<FullStrategyConfig>): FullStrategyConfig => ({
            ...baseConfig,
            startTimeSeconds: 100,
            audioTracks: [
                {
                    index: asAbsoluteStreamIndex(0),
                    displayTitle: 'English',
                    language: 'eng',
                    channels: 2,
                    codec: 'aac',
                    isDefault: true,
                },
            ],
            decision: {
                mode: 'full',
                reasons: 0,
                videoAction: 'transcode',
                audioAction: 'copy',
                useGpu: false,
                needsTonemapping: false,
                preserveHdr10: false,
            },
            ...extra,
        });

        it('emits -t <seconds> as an INPUT option (before -i) when maxDurationSeconds is set', () => {
            const result = strategy.buildArgs(previewBase({ maxDurationSeconds: 30 }));
            const tIndex = result.args.indexOf('-t');
            const iIndex = result.args.indexOf('-i');
            expect(tIndex).toBeGreaterThanOrEqual(0);
            expect(result.args[tIndex + 1]).toBe('30');
            // Must be an input option: -t precedes the -i it applies to.
            expect(tIndex).toBeLessThan(iIndex);
        });

        it('emits no -t when maxDurationSeconds is absent (unbounded, legacy behavior)', () => {
            const result = strategy.buildArgs(previewBase({}));
            expect(result.args).not.toContain('-t');
        });
    });

    describe('buildArgs - subtitle burn-in audio handling', () => {
        // Burn-in transcodes the VIDEO (the overlay is a video filter), which used
        // to drag audio into a re-encode too, because audio copy was gated on
        // "is the video being copied". The master playlist still advertised the
        // SOURCE audio codec, so E-AC3 was silently delivered as AAC under an
        // advertised `ec-3` and AVFoundation rejected the stream at playback start
        // with 'fmt?' (CoreMediaErrorDomain 1718449215). Verified on prod:
        // without burn-in advertised ec-3 / actual eac3; with burn-in advertised
        // ec-3 / actual aac.
        function burnInConfig(forceAudioTranscode: boolean): FullStrategyConfig {
            return {
                ...baseConfig,
                forceAudioTranscode,
                subtitleBurnIn: { absoluteIndex: 3, codec: 'hdmv_pgs_subtitle' },
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'German',
                        language: 'ger',
                        channels: 6,
                        codec: 'eac3',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 0,
                    // Burn-in reconciles the decision to 'transcode' at job start.
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };
        }

        it('keeps copying HLS-compatible audio while burning in a subtitle', () => {
            const result = strategy.buildArgs(burnInConfig(false));

            const audioCodecIndex = result.args.indexOf('-c:a:0');
            expect(audioCodecIndex).toBeGreaterThan(-1);
            expect(result.args[audioCodecIndex + 1]).toBe('copy');
        });

        it('still transcodes audio when the client explicitly asked for AAC', () => {
            // forceAudioTranscode is the browser/AAC request path — the manifest
            // advertises mp4a there, so re-encoding is correct and stays correct.
            const result = strategy.buildArgs(burnInConfig(true));

            const audioCodecIndex = result.args.indexOf('-c:a:0');
            expect(result.args[audioCodecIndex + 1]).not.toBe('copy');
        });
    });

    describe('buildArgs - Video Copy', () => {
        it('copies video when decision.videoAction is copy', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            const videoCodecIndex = result.args.indexOf('-c:v');
            expect(result.args[videoCodecIndex + 1]).toBe('copy');
        });

        // Cross-compatible DV (profile 8) is tagged `hvc1`, matching the base-layer
        // codec the manifest puts in CODECS; DV rides along in SUPPLEMENTAL-CODECS,
        // backed by the dvvC box. Tagging it `dvh1` contradicted CODECS and left
        // AVPlayer unable to build a decoder — audio played over a black screen.
        it('tags copied cross-compatible DV (profile 8) as hvc1 to match CODECS', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                videoInfo: {
                    codec: 'hevc',
                    width: 3840,
                    height: 2160,
                    dvProfile: 8,
                },
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('-vtag');
            expect(result.args).toContain('hvc1');
            expect(result.args).not.toContain('dvh1');
            expect(result.args).not.toContain('dvhe');
        });

        // An hvc1/dvh1 sample entry needs parameter sets out-of-band in hvcC. MKVs
        // with a 23-byte CodecPrivate stub keep them in-band only, so a forced hvc1
        // copy produced a track with no VPS/SPS/PPS — AVPlayer rejected it with
        // CoreMediaErrorDomain -19601 (audio over a black screen). hevc_metadata
        // rebuilds the extradata without re-encoding.
        it('applies hevc_metadata on HEVC fMP4 copies to rebuild hvcC parameter sets', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                videoInfo: { codec: 'hevc', width: 1920, height: 1080 },
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            const i = result.args.indexOf('-bsf:v');
            expect(i).toBeGreaterThan(-1);
            expect(result.args[i + 1]).toBe('hevc_metadata');
        });

        // MPEG-TS carries parameter sets in-band by design and has no sample entry,
        // so there is nothing to reconstruct.
        it('does not apply hevc_metadata for MPEG-TS output', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                videoInfo: { codec: 'hevc', width: 1920, height: 1080 },
                hlsOutput: { hlsContainer: 'mpegts' },
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);
            expect(result.args).not.toContain('hevc_metadata');
        });

        // Profiles 5/7 have no base layer, so the DV codec is the PRIMARY CODECS entry
        // and the sample entry must match it rather than being forced to hvc1.
        it('tags copied non-cross-compatible DV (profile 5) as dvh1 to match CODECS', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                videoInfo: {
                    codec: 'hevc',
                    width: 3840,
                    height: 2160,
                    dvProfile: 5,
                    dvBlSignalCompatibilityId: 0,
                },
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('-vtag');
            expect(result.args).toContain('dvh1');
            expect(result.args).not.toContain('hvc1');
        });

        it('tags copied HEVC as hvc1 into fMP4 (manifest advertises hvc1, not hev1)', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                videoInfo: { codec: 'hevc', width: 1920, height: 1080 },
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            const vtagIndex = result.args.indexOf('-vtag');
            expect(vtagIndex).toBeGreaterThanOrEqual(0);
            expect(result.args[vtagIndex + 1]).toBe('hvc1');
        });

        it('does NOT tag copied H.264 (avc1 is the natural mp4 sample entry)', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                videoInfo: { codec: 'h264', width: 1920, height: 1080 },
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            expect(result.args).not.toContain('-vtag');
            expect(result.args).not.toContain('hvc1');
        });

        it('does NOT tag copied HEVC when the container is MPEG-TS (no ISO-BMFF 4CC)', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                videoInfo: { codec: 'hevc', width: 1920, height: 1080 },
                hlsOutput: { hlsContainer: 'mpegts' },
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            expect(result.args).not.toContain('hvc1');
        });
    });

    describe('buildArgs - GPU Encoding', () => {
        it('uses GPU encoder when available', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                gpuAcceleration: 'nvenc',
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 1,
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: true,
                    gpuEncoder: 'hevc_nvenc',
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('-c:v');
            expect(result.args).toContain('hevc_nvenc');
            expect(result.description).toContain('GPU-accelerated');
        });

        it('tags encoded HEVC as hvc1 into fMP4 (encoders default to hev1)', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                gpuAcceleration: 'nvenc',
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 1,
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: true,
                    gpuEncoder: 'hevc_nvenc',
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            const vtagIndex = result.args.indexOf('-vtag');
            expect(vtagIndex).toBeGreaterThanOrEqual(0);
            expect(result.args[vtagIndex + 1]).toBe('hvc1');
        });

        it('sets HEVC profile/level for Apple TV compatibility', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                gpuAcceleration: 'nvenc',
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 1,
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: true,
                    gpuEncoder: 'hevc_nvenc',
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            // HEVC should have main profile and level 5.1
            expect(result.args).toContain('-profile:v');
            expect(result.args).toContain('-level:v');

            const profileIndex = result.args.indexOf('-profile:v');
            const levelIndex = result.args.indexOf('-level:v');
            expect(result.args[profileIndex + 1]).toBe('main');
            expect(result.args[levelIndex + 1]).toBe('5.1');
        });

        it('sets B-frames for better compression', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                gpuAcceleration: 'nvenc',
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 1,
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: true,
                    gpuEncoder: 'h264_nvenc',
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('-bf');
            const bfIndex = result.args.indexOf('-bf');
            expect(result.args[bfIndex + 1]).toBe('3');
        });
    });

    describe('buildArgs - Audio Handling', () => {
        it('copies audio when decision.audioAction is copy', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                    {
                        index: asAbsoluteStreamIndex(1),
                        displayTitle: 'German',
                        language: 'ger',
                        channels: 6,
                        codec: 'ac3',
                        isDefault: false,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('-c:a:0');
            expect(result.args).toContain('-c:a:1');

            const audio0Index = result.args.indexOf('-c:a:0');
            const audio1Index = result.args.indexOf('-c:a:1');
            expect(result.args[audio0Index + 1]).toBe('copy');
            expect(result.args[audio1Index + 1]).toBe('copy');
        });

        it('transcodes audio with correct channel count', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'Surround',
                        language: 'eng',
                        channels: 8,
                        codec: 'dts',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'transcode',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            // Should transcode to AAC
            const audioCodecIndex = result.args.indexOf('-c:a:0');
            expect(result.args[audioCodecIndex + 1]).toBe('aac');
        });

        it('handles undefined channel count (defaults to stereo)', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'Unknown',
                        language: 'und',
                        channels: 0,
                        codec: 'dts',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'transcode',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            // Channel count should be set and not NaN
            // The args are built via FFmpegArgsBuilder, so check for valid output
            expect(result.args).toBeDefined();
            expect(result.args.length).toBeGreaterThan(0);
        });
    });

    describe('buildArgs - Audio Stream Mapping', () => {
        it('maps audio streams sequentially by array position, not Jellyfin global index', () => {
            // Jellyfin's track.index is a GLOBAL stream index (includes video)
            // Example: Video=0, Audio=1, Audio=2 → Jellyfin reports audio indices [1, 2]
            // But FFmpeg -map 0:a:N uses audio-RELATIVE indices: 0:a:0 (first audio), 0:a:1 (second audio)
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(1),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                    {
                        index: asAbsoluteStreamIndex(2),
                        displayTitle: 'German',
                        language: 'ger',
                        channels: 6,
                        codec: 'ac3',
                        isDefault: false,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            // Should map 0:a:0 and 0:a:1 (sequential), NOT 0:a:1 and 0:a:2 (Jellyfin indices)
            expect(result.args).toContain('0:a:0');
            expect(result.args).toContain('0:a:1');
            expect(result.args).not.toContain('0:a:2'); // This would be non-existent third audio
        });
    });

    describe('buildArgs - Muxed Audio Selection (regression: always wrong language)', () => {
        // Real bug (Rick & Morty S09E01): file is video@abs0, German@abs1 (default),
        // English@abs2. In muxed mode the client sends the ABSOLUTE stream index as
        // hlsAudioTrackIndex; the strategy must resolve it to the right -map 0:a:N
        // ARRAY POSITION. Sending/resolving the wrong index made every selection
        // collapse to the first (German) track.
        const rickAndMorty = [
            {
                index: asAbsoluteStreamIndex(1), // absolute stream index
                displayTitle: 'German',
                language: 'ger',
                channels: 6,
                codec: 'eac3',
                isDefault: true,
            },
            {
                index: asAbsoluteStreamIndex(2), // absolute stream index
                displayTitle: 'English',
                language: 'eng',
                channels: 6,
                codec: 'eac3',
                isDefault: false,
            },
        ];

        const muxedDecision = {
            mode: 'full' as const,
            reasons: 0,
            videoAction: 'copy' as const,
            audioAction: 'transcode' as const,
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
        };

        it('selecting English (absolute 2) maps the SECOND audio track (0:a:1), not German', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: rickAndMorty,
                hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 2 },
                decision: muxedDecision,
            };

            const result = strategy.buildArgs(config);

            // Muxed = exactly one audio stream mapped, and it must be position 1 (English).
            expect(result.args).toContain('0:a:1');
            expect(result.args).not.toContain('0:a:0');
        });

        it('selecting German (absolute 1) maps the FIRST audio track (0:a:0)', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: rickAndMorty,
                hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 1 },
                decision: muxedDecision,
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('0:a:0');
            expect(result.args).not.toContain('0:a:1');
        });

        it('resolves correctly when audio does NOT start at absolute index 1 (subtitle before audio)', () => {
            // video@0, subtitle@1, German@abs2, English@abs3
            const subsFirst = [
                { ...rickAndMorty[0], index: asAbsoluteStreamIndex(2) }, // German @ abs 2
                { ...rickAndMorty[1], index: asAbsoluteStreamIndex(3) }, // English @ abs 3
            ];
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: subsFirst,
                hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 3 }, // English
                decision: muxedDecision,
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('0:a:1'); // English is the 2nd audio → position 1
            expect(result.args).not.toContain('0:a:0');
        });

        it('falls back to the first track when the absolute index does not match any stream', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: rickAndMorty,
                hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 99 },
                decision: muxedDecision,
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('0:a:0');
            expect(result.args).not.toContain('0:a:1');
        });

        it('maps no audio (no 0:a:N) when there are zero audio tracks', () => {
            // Mapping step and audio-encode step must agree: with no audio tracks,
            // neither maps a stream (mapping a nonexistent 0:a:0 would fail ffmpeg).
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [],
                hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 1 },
                decision: muxedDecision,
            };

            const result = strategy.buildArgs(config);

            expect(result.args).not.toContain('0:a:0');
        });
    });

    describe('buildArgs - Muxed default audio track (D12)', () => {
        // When the request names no audio track — the Jellyfin master.m3u8 path,
        // and any client that omits AudioStreamIndex — the strategy used to ask
        // for `hlsAudioTrackIndex ?? 0`. Absolute 0 is the VIDEO stream on
        // essentially every file, so it matched nothing and fell through to
        // container order, giving Jellyfin clients a different default track
        // than the web player's isDefault-aware resolver.
        //
        // English is FIRST in the container here but German is the file default,
        // so container order and the correct answer differ.
        const englishFirstGermanDefault = [
            {
                index: asAbsoluteStreamIndex(1),
                displayTitle: 'English',
                language: 'eng',
                channels: 6,
                codec: 'eac3',
                isDefault: false,
            },
            {
                index: asAbsoluteStreamIndex(2),
                displayTitle: 'German',
                language: 'ger',
                channels: 6,
                codec: 'eac3',
                isDefault: true,
            },
        ];

        const muxedDecision = {
            mode: 'full' as const,
            reasons: 0,
            videoAction: 'copy' as const,
            audioAction: 'transcode' as const,
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
        };

        it('defaults to the isDefault track, not the first in the container', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: englishFirstGermanDefault,
                // No hlsAudioTrackIndex — this is the case D12 fixes.
                hlsOutput: { hlsAudioMode: 'muxed' },
                decision: muxedDecision,
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('0:a:1'); // German, array position 1
            expect(result.args).not.toContain('0:a:0');
        });

        it('still honours an explicit hlsAudioTrackIndex over the file default', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: englishFirstGermanDefault,
                hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 1 }, // English
                decision: muxedDecision,
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('0:a:0');
            expect(result.args).not.toContain('0:a:1');
        });

        it('falls back to the first track when no track is flagged default', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: englishFirstGermanDefault.map((t) => ({ ...t, isDefault: false })),
                hlsOutput: { hlsAudioMode: 'muxed' },
                decision: muxedDecision,
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('0:a:0');
            expect(result.args).not.toContain('0:a:1');
        });

        it('maps no audio when there are no audio tracks and no requested index', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [],
                hlsOutput: { hlsAudioMode: 'muxed' },
                decision: muxedDecision,
            };

            expect(strategy.buildArgs(config).args).not.toContain('0:a:0');
        });

        // The mapping step and the audio-ENCODING step resolve the track
        // independently. If only one learned the new default they would select
        // DIFFERENT tracks — muxing one track's audio while configuring the
        // encoder from another's codec. That is worse than the bug D12 fixes,
        // so pin the two together with a case where the choice is observable in
        // the encoder args: the default track is copyable, the first is not.
        it('the encoding step selects the same track as the mapping step', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    { ...englishFirstGermanDefault[0], codec: 'dts' }, // not HLS-compatible
                    { ...englishFirstGermanDefault[1], codec: 'aac' }, // HLS-compatible, default
                ],
                // videoAction 'copy' => remux => audio MAY be copied, so whether
                // it is copied depends purely on WHICH track got selected.
                hlsOutput: { hlsAudioMode: 'muxed' },
                decision: muxedDecision,
            };

            const result = strategy.buildArgs(config);
            const joined = result.args.join(' ');

            // Mapping step picked German (position 1)...
            expect(result.args).toContain('0:a:1');
            // ...and the encoding step saw German's aac, so it copies rather
            // than re-encoding. Reading the first track's dts would transcode.
            expect(joined).toContain('-c:a:0 copy');
            expect(joined).not.toContain('-c:a:0 aac');
        });

        it('applies the default to the audio-only rung too', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: englishFirstGermanDefault,
                videoDisabled: true,
                hlsOutput: { hlsAudioMode: 'muxed' },
                decision: muxedDecision,
            };

            const result = strategy.buildArgs(config);

            expect(result.args).toContain('0:a:1');
            expect(result.args).not.toContain('0:a:0');
        });
    });

    describe('buildArgs - Seeking', () => {
        it('adds -ss before input for seeking', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                startTimeSeconds: 300,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            const ssIndex = result.args.indexOf('-ss');
            const inputIndex = result.args.indexOf('-i');

            expect(ssIndex).toBeGreaterThan(-1);
            expect(ssIndex).toBeLessThan(inputIndex); // -ss should come before -i
            expect(result.args[ssIndex + 1]).toBe('300');
        });
    });

    describe('buildArgs - HLS Output', () => {
        it('generates correct HLS output configuration', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            };

            const result = strategy.buildArgs(config);

            // HLS format
            expect(result.args).toContain('-f');
            expect(result.args).toContain('hls');

            // fMP4 segments
            expect(result.args).toContain('-hls_segment_type');
            expect(result.args).toContain('fmp4');

            // Segment duration
            expect(result.args).toContain('-hls_time');
            expect(result.args).toContain('6');

            // var_stream_map
            expect(result.args).toContain('-var_stream_map');

            // Master playlist
            expect(result.args).toContain('-master_pl_name');
            expect(result.args).toContain('master.m3u8');

            // Output pattern
            const lastArg = result.args[result.args.length - 1];
            expect(lastArg).toContain('index.m3u8');
        });
    });

    // Regression: burning subtitles into an HDR source on a GPU HEVC encoder
    // fed 8-bit CPU-composited frames into a Main10 (10-bit) encoder, which fails
    // to open ("Current profile is unsupported") and killed playback. Reconcile
    // per HLS_BURN_IN_HDR_STRATEGY.
    describe('buildArgs - HDR subtitle burn-in', () => {
        const hdrBurnInConfig = (extra: Partial<FullStrategyConfig>): FullStrategyConfig => ({
            ...baseConfig,
            gpuAcceleration: 'qsv',
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
                codec: 'av1',
                width: 1920,
                height: 1080,
                outputCodec: 'hevc',
                videoRange: 'HDR10',
            },
            subtitleBurnIn: { absoluteIndex: 7, codec: 'hdmv_pgs_subtitle' },
            decision: {
                mode: 'full',
                reasons: 1,
                videoAction: 'transcode',
                audioAction: 'transcode',
                useGpu: true,
                gpuEncoder: 'hevc_qsv',
                needsTonemapping: false,
                preserveHdr10: true,
                outputVideoRange: 'HDR10',
            },
            ...extra,
        });

        it('default (tonemap): keeps GPU, tonemaps to SDR, encodes Main (not Main10)', () => {
            const config = hdrBurnInConfig({ burnInHdrStrategy: 'tonemap' });
            config.effectivePlan = planStandaloneTranscode(config);
            const result = strategy.buildArgs(config);

            // Still the GPU encoder…
            expect(result.args).toContain('hevc_qsv');
            // …but tonemapped ahead of the overlay, and NOT Main10.
            const fcIdx = result.args.indexOf('-filter_complex');
            expect(fcIdx).toBeGreaterThanOrEqual(0);
            expect(result.args[fcIdx + 1]).toContain('tonemapx=tonemap=');
            const profIdx = result.args.indexOf('-profile:v');
            expect(profIdx).toBeGreaterThanOrEqual(0);
            expect(result.args[profIdx + 1]).toBe('main');
            // The CPU→QSV hwupload needs a filter device — burn-in must force the
            // QSV software-decode-bridge device setup (else "a hardware device
            // reference is required to upload frames to").
            expect(result.args).toContain('-filter_hw_device');
            expect(result.args).toContain('qsv=qs@va');
            // Decision reconciled to SDR so the manifest advertises SDR too.
            expect(config.effectivePlan.decision?.preserveHdr10).toBe(false);
            expect(config.effectivePlan.decision?.outputVideoRange).toBe('SDR');
        });

        it('software: preserves HDR by encoding in software (no GPU encoder)', () => {
            const config = hdrBurnInConfig({ burnInHdrStrategy: 'software' });
            // A GPU encoder pre-baked into targetCodec must NOT keep it on the GPU.
            config.decision!.targetCodec = { video: 'hevc_qsv' };
            config.effectivePlan = planStandaloneTranscode(config);
            const result = strategy.buildArgs(config);

            expect(result.args).not.toContain('hevc_qsv');
            expect(result.args).toContain('libx265');
            expect(result.description).toContain('CPU');
            // HDR is preserved (no forced tonemap).
            expect(config.effectivePlan.decision?.useGpu).toBe(false);
            expect(config.effectivePlan.decision?.preserveHdr10).toBe(true);
        });

        it('SDR source is untouched (no tonemap, GPU encode as before)', () => {
            const config = hdrBurnInConfig({
                videoInfo: {
                    codec: 'h264',
                    width: 1920,
                    height: 1080,
                    outputCodec: 'hevc',
                    videoRange: 'SDR',
                },
                decision: {
                    mode: 'full',
                    reasons: 1,
                    videoAction: 'transcode',
                    audioAction: 'transcode',
                    useGpu: true,
                    gpuEncoder: 'hevc_qsv',
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
            });
            const result = strategy.buildArgs(config);

            expect(result.args).toContain('hevc_qsv');
            const fcIdx = result.args.indexOf('-filter_complex');
            expect(result.args[fcIdx + 1]).not.toContain('tonemapx');
        });
    });

    // A DVD rip / TV recording in a native library (MPEG-2 720x576 25i TFF) was
    // transcoded with NO deinterlacer on any backend: the only signals the
    // strategy read were a videoRangeType that never contains 'Interlaced' and
    // Jellyfin's media-source flag. Output was flagged progressive while idet
    // still found 56/100 frames TFF → combing on every motion (NVENC + VA-API,
    // 2026-10-02). isInterlaced now comes from ffprobe's field_order.
    describe('buildArgs - deinterlacing', () => {
        type Backend = 'none' | 'nvenc' | 'vaapi' | 'qsv';
        const ENCODER: Record<Exclude<Backend, 'none'>, string> = {
            nvenc: 'h264_nvenc',
            vaapi: 'h264_vaapi',
            qsv: 'h264_qsv',
        };
        const interlacedConfig = (
            backend: Backend,
            extra: Partial<FullStrategyConfig> = {},
            isInterlaced: { value: boolean | undefined } = { value: true },
        ): FullStrategyConfig => ({
            ...baseConfig,
            gpuAcceleration: backend,
            // A size cap forces a scale filter, so the ORDER can be asserted.
            maxWidth: 640,
            maxHeight: 480,
            audioTracks: [
                {
                    index: asAbsoluteStreamIndex(1),
                    displayTitle: 'German',
                    language: 'ger',
                    channels: 2,
                    codec: 'ac3',
                    isDefault: true,
                },
            ],
            videoInfo: {
                codec: 'mpeg2video',
                width: 720,
                height: 576,
                outputCodec: 'h264',
                videoRange: 'SDR',
                frameRate: 25,
            },
            mediaSourceInfo: {
                streams: [{ type: 'Video', isInterlaced: isInterlaced.value }, { type: 'Audio' }],
            },
            decision: {
                mode: 'full',
                reasons: 0,
                videoAction: 'transcode',
                audioAction: 'transcode',
                useGpu: backend !== 'none',
                ...(backend !== 'none' ? { gpuEncoder: ENCODER[backend] } : {}),
                needsTonemapping: false,
                preserveHdr10: false,
            },
            ...extra,
        });
        const vfOf = (args: string[]): string => {
            const i = args.indexOf('-vf');
            return i === -1 ? '' : args[i + 1]!;
        };
        /** Position of the first filter in the chain matching `re` (-1 if absent). */
        const posOf = (chain: string, re: RegExp): number =>
            chain.split(',').findIndex((f) => re.test(f));

        it.each([
            ['none', /^yadif=mode=0$/],
            ['nvenc', /^yadif_cuda=mode=send_frame$/],
            ['vaapi', /^deinterlace_vaapi=rate=frame$/],
            // deinterlace_qsv always doubles the rate; vpp_qsv keeps it.
            ['qsv', /^vpp_qsv=deinterlace=2$/],
        ] as const)('%s: deinterlaces BEFORE scaling an interlaced source', (backend, filter) => {
            const result = strategy.buildArgs(interlacedConfig(backend));
            const chain = vfOf(result.args);
            const deint = posOf(chain, filter);
            const scale = posOf(chain, /^scale(_cuda|_vaapi|_qsv)?=/);
            expect(deint, chain).toBeGreaterThanOrEqual(0);
            expect(scale, chain).toBeGreaterThan(deint);
            // Only a decode-bridge upload may precede it — never a resize.
            expect(chain.split(',').slice(0, deint).join(','), chain).not.toMatch(/scale/);
        });

        it.each(['none', 'nvenc', 'vaapi', 'qsv'] as const)(
            '%s: a progressive (or unknown) source gets no deinterlacer',
            (backend) => {
                for (const value of [false, undefined]) {
                    const result = strategy.buildArgs(interlacedConfig(backend, {}, { value }));
                    expect(result.args.join(' ')).not.toMatch(/yadif|bwdif|w3fdif|deinterlace/);
                }
            },
        );

        it('a source-range type is no longer read as an interlace signal', () => {
            const config = interlacedConfig('none', {}, { value: false });
            config.videoInfo!.videoRangeType = 'SDR';
            expect(strategy.buildArgs(config).args.join(' ')).not.toMatch(/yadif/);
        });

        it("deinterlaceMethod 'none' disables it", () => {
            const result = strategy.buildArgs(
                interlacedConfig('nvenc', { deinterlaceMethod: 'none' }),
            );
            expect(result.args.join(' ')).not.toMatch(/yadif|deinterlace/);
        });

        it('a video COPY is never given a deinterlacer (ffmpeg refuses -vf with -c:v copy)', () => {
            const config = interlacedConfig('nvenc', { maxWidth: 0, maxHeight: 0 });
            config.decision = {
                ...config.decision!,
                videoAction: 'copy',
                useGpu: false,
                gpuEncoder: undefined,
            };
            config.videoInfo = { ...config.videoInfo!, codec: 'h264', outputCodec: undefined };
            const args = strategy.buildArgs(config).args;
            expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
            expect(args.join(' ')).not.toMatch(/yadif|deinterlace|-vf/);
        });

        it.each([
            ['vaapi', /^format=nv12,hwupload,deinterlace_vaapi=rate=frame,/],
            ['qsv', /hwupload=extra_hw_frames=16,format=qsv,vpp_qsv=deinterlace=2,/],
            // NVENC's bridge is encoder-only: system frames, CPU filters.
            ['nvenc', /^yadif=mode=0,scale=/],
        ] as const)(
            '%s software-decode bridge: the GPU deinterlacer runs AFTER the upload',
            (backend, order) => {
                const chain = vfOf(
                    strategy.buildArgs(
                        interlacedConfig(backend, { forceSoftwareDecodeBridge: true }),
                    ).args,
                );
                expect(chain).toMatch(order);
            },
        );

        it('VideoToolbox (hardware surfaces, no verified deinterlacer) skips rather than break the graph', () => {
            const config = interlacedConfig('none', { gpuAcceleration: 'videotoolbox' });
            config.decision = {
                ...config.decision!,
                useGpu: true,
                gpuEncoder: 'h264_videotoolbox',
            };
            const args = strategy.buildArgs(config).args;
            expect(args).toContain('h264_videotoolbox');
            expect(args.join(' ')).not.toMatch(/yadif|bwdif|deinterlace/);
            expect(args[args.indexOf('-g') + 1]).toBe('150');
        });

        it('an unknown DEINTERLACE_METHOD falls back to yadif instead of breaking the graph', () => {
            const spy = vi
                .spyOn(serverConfig, 'DEINTERLACE_METHOD', 'get')
                .mockReturnValue('nnedi');
            try {
                const chain = vfOf(strategy.buildArgs(interlacedConfig('none')).args);
                expect(chain.split(',')[0]).toBe('yadif=mode=0');
            } finally {
                spy.mockRestore();
            }
        });

        it('GOP is sized for the source rate at single rate (25 fps × 6 s)', () => {
            const args = strategy.buildArgs(interlacedConfig('vaapi')).args;
            expect(args[args.indexOf('-g') + 1]).toBe('150');
        });

        describe('DEINTERLACE_DOUBLE_RATE', () => {
            const spies: Array<{ mockRestore: () => void }> = [];
            beforeEach(() => {
                spies.push(
                    vi.spyOn(serverConfig, 'DEINTERLACE_DOUBLE_RATE', 'get').mockReturnValue(true),
                    vi.spyOn(serverConfig, 'DEINTERLACE_METHOD', 'get').mockReturnValue('bwdif'),
                );
            });
            afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

            it.each(['none', 'nvenc', 'vaapi', 'qsv'] as const)(
                '%s: GOP is sized for the doubled (field) output rate',
                (backend) => {
                    const args = strategy.buildArgs(interlacedConfig(backend)).args;
                    expect(args[args.indexOf('-g') + 1]).toBe('300');
                    expect(args[args.indexOf('-keyint_min') + 1]).toBe('300');
                },
            );

            it.each([
                ['none', 'bwdif=mode=1'],
                ['nvenc', 'yadif_cuda=mode=send_field'],
                ['vaapi', 'deinterlace_vaapi=rate=field'],
                ['qsv', 'deinterlace_qsv=mode=2'],
            ] as const)('%s → %s', (backend, filter) => {
                const chain = vfOf(strategy.buildArgs(interlacedConfig(backend)).args);
                expect(chain.split(',')).toContain(filter);
            });

            it.each(['nvenc', 'vaapi', 'qsv'] as const)(
                '%s + subtitle burn-in: the GPU deinterlacer becomes the CONFIGURED CPU one at field rate',
                (backend) => {
                    // A bare `yadif` here silently halved 50i to 25p.
                    const result = strategy.buildArgs(
                        interlacedConfig(backend, {
                            subtitleBurnIn: { absoluteIndex: 3, codec: 'dvd_subtitle' },
                        }),
                    );
                    const fc = result.args[result.args.indexOf('-filter_complex') + 1]!;
                    expect(fc).toMatch(/^\[0:v\]bwdif=mode=1[,[]/);
                    expect(fc).not.toMatch(/yadif|deinterlace/);
                },
            );
        });

        it.each(['nvenc', 'vaapi', 'qsv'] as const)(
            '%s + burn-in at frame rate keeps a CPU deinterlacer ahead of the overlay',
            (backend) => {
                const result = strategy.buildArgs(
                    interlacedConfig(backend, {
                        subtitleBurnIn: { absoluteIndex: 3, codec: 'dvd_subtitle' },
                    }),
                );
                const fc = result.args[result.args.indexOf('-filter_complex') + 1]!;
                expect(fc).toMatch(/^\[0:v\]yadif=mode=0,scale=/);
                expect(fc).not.toMatch(/deinterlace|yadif=mode=0.*yadif/);
                expect(fc.indexOf('yadif')).toBeLessThan(fc.indexOf('overlay'));
            },
        );
    });

    describe('appendHlsOutputArgs extraction (characterisation)', () => {
        it('produces byte-identical args for a standard video transcode', () => {
            const audioTracks: FullStrategyConfig['audioTracks'] = [
                {
                    index: asAbsoluteStreamIndex(0),
                    displayTitle: 'English',
                    language: 'eng',
                    channels: 2,
                    codec: 'aac',
                    isDefault: true,
                },
            ];
            const decision: FullStrategyConfig['decision'] = {
                mode: 'full',
                reasons: 0,
                videoAction: 'transcode',
                audioAction: 'copy',
                useGpu: false,
                needsTonemapping: false,
                preserveHdr10: false,
            };
            const config: FullStrategyConfig = { ...baseConfig, audioTracks, decision };
            const result = new FullTranscodeStrategy().buildArgs(config);
            expect(result.args).toMatchSnapshot();
        });

        it('produces byte-identical args for a muxed HLS audio transcode', () => {
            const audioTracks: FullStrategyConfig['audioTracks'] = [
                {
                    index: asAbsoluteStreamIndex(0),
                    displayTitle: 'English',
                    language: 'eng',
                    channels: 2,
                    codec: 'aac',
                    isDefault: true,
                },
            ];
            const decision: FullStrategyConfig['decision'] = {
                mode: 'full',
                reasons: 0,
                videoAction: 'transcode',
                audioAction: 'copy',
                useGpu: false,
                needsTonemapping: false,
                preserveHdr10: false,
            };
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks,
                decision,
                hlsOutput: { hlsAudioMode: 'muxed' },
            };
            const result = new FullTranscodeStrategy().buildArgs(config);
            expect(result.args).toMatchSnapshot();
        });
    });

    describe('videoDisabled', () => {
        const audioTracks: FullStrategyConfig['audioTracks'] = [
            {
                index: asAbsoluteStreamIndex(0),
                displayTitle: 'English',
                language: 'eng',
                channels: 2,
                codec: 'aac',
                isDefault: true,
            },
        ];
        const decision: FullStrategyConfig['decision'] = {
            mode: 'full',
            reasons: 0,
            videoAction: 'transcode',
            audioAction: 'transcode',
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
        };
        const cfg = (): FullStrategyConfig => ({
            ...baseConfig,
            audioTracks,
            decision,
            videoDisabled: true,
        });

        it('emits -vn and no video encoder', () => {
            const { args } = strategy.buildArgs(cfg());
            expect(args).toContain('-vn');
            expect(args).not.toContain('-c:v');
        });

        it('emits no scale, tonemap, or hwaccel', () => {
            const joined = strategy.buildArgs(cfg()).args.join(' ');
            expect(joined).not.toMatch(/scale|tonemap|zscale|-hwaccel/);
        });

        it('emits no scale, tonemap, or hwaccel even when the decision calls for GPU + tonemapping', () => {
            // The fixture above (gpuAcceleration: 'none', needsTonemapping: false)
            // proves nothing about the hwaccel/tonemap branches below the
            // videoDisabled guard — they're simply never reached because there's
            // nothing in that fixture to reach. This one makes all four
            // alternatives in the regex load-bearing: with GPU acceleration, a GPU
            // encoder, and needsTonemapping all switched on, buildArgs must still
            // return via buildAudioOnlyArgs before any of scale/tonemap/zscale/
            // -hwaccel setup runs.
            const gpuConfig: FullStrategyConfig = {
                ...baseConfig,
                gpuAcceleration: 'nvenc',
                audioTracks,
                decision: {
                    mode: 'full',
                    reasons: 1,
                    videoAction: 'transcode',
                    audioAction: 'transcode',
                    useGpu: true,
                    gpuEncoder: 'hevc_nvenc',
                    needsTonemapping: true,
                    preserveHdr10: false,
                },
                videoDisabled: true,
            };
            const joined = strategy.buildArgs(gpuConfig).args.join(' ');
            expect(joined).not.toMatch(/scale|tonemap|zscale|-hwaccel/);
        });

        it('encodes audio to fixed AAC stereo at 128k regardless of source codec/channels/bitrate', () => {
            // A discriminating fixture: 6-channel EAC3 at 640kbps would drive
            // config.audioCodec / calculateAdaptiveAudioBitrate / the source
            // channel count to something other than 128k/2ch on the normal
            // path. audio-only must ignore all of that and always emit the
            // fixed constants.
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioBitrateSurround: '256k',
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'German',
                        language: 'ger',
                        channels: 6,
                        codec: 'eac3',
                        bitrate: 640_000,
                        isDefault: true,
                    },
                ],
                decision,
                videoDisabled: true,
            };
            const { args } = strategy.buildArgs(config);
            expect(args[args.indexOf('-c:a:0') + 1]).toBe('aac');
            expect(args[args.indexOf('-b:a:0') + 1]).toBe('128k');
            expect(args[args.indexOf('-ac:a:0') + 1]).toBe('2');
        });

        it('never copies audio, even when video is copied and the source codec is HLS-compatible', () => {
            // On the normal path, videoAction: 'copy' + an HLS-compatible
            // source codec (eac3) would copy audio (canCopyAudio). Audio-only
            // has no copy fast-path at all — it must still transcode to AAC.
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'eac3',
                        isDefault: true,
                    },
                ],
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
                videoDisabled: true,
            };
            const { args } = strategy.buildArgs(config);
            expect(args).not.toContain('copy');
            expect(args[args.indexOf('-c:a:0') + 1]).toBe('aac');
        });

        it('numbers segments ABSOLUTELY from the job offset, even when the decision says the video is copied', () => {
            // The other half of the "audio-only mid-playback switch never
            // starts" invariant (see the effective plan’s drop action). The
            // audio-only rung reuses the plan built for direct play, so the
            // decision can say `videoAction: 'copy'` — but this path appends
            // the HLS tail as a transcode, so FFmpeg gets `-start_number
            // <offset>` and its first file is segment_0000<offset>. The
            // segment handler must therefore NOT subtract the offset again;
            // if this arg ever disappears, the mapping flips to 0-based and
            // the service-side geometry test has to flip with it.
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks,
                startTimeSeconds: 12,
                startNumber: 2,
                decision: {
                    mode: 'direct',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'transcode',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
                videoDisabled: true,
            };
            const { args } = strategy.buildArgs(config);
            expect(args[args.indexOf('-start_number') + 1]).toBe('2');
        });

        it('forces the muxed HLS output shape: no v:0, no var_stream_map, no master playlist', () => {
            const { args } = strategy.buildArgs(cfg());
            expect(args.join(' ')).not.toContain('v:0');
            expect(args).not.toContain('-var_stream_map');
            expect(args).not.toContain('-master_pl_name');
        });

        it('forces the muxed shape even when the source config explicitly requests demux, and maps only one track', () => {
            // buildVarStreamMap() unconditionally appends a `v:0` video
            // variant entry for demux var_stream_map, which hlsenc cannot
            // resolve once -vn has dropped the video stream (EINVAL before
            // writing a byte). Two tracks prove only ONE gets mapped/encoded
            // — an audio-only rung is a single flat rendition, not a
            // multi-track demux structure.
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(0),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                    {
                        index: asAbsoluteStreamIndex(1),
                        displayTitle: 'German',
                        language: 'ger',
                        channels: 2,
                        codec: 'aac',
                        isDefault: false,
                    },
                ],
                decision,
                hlsOutput: { hlsAudioMode: 'demux' },
                videoDisabled: true,
            };
            const { args } = strategy.buildArgs(config);
            expect(args.join(' ')).not.toContain('v:0');
            expect(args).not.toContain('-var_stream_map');
            expect(args).not.toContain('-c:a:1');
        });

        it('maps exactly the requested non-default absolute audio stream, not the first/default track', () => {
            // Two tracks whose absolute index does NOT equal their array
            // position, and the requested track is the non-default one —
            // this fails if the code ignores hlsAudioTrackIndex and maps
            // position 0 (the default English track), and fails if it maps
            // every track instead of exactly one.
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(1),
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                    {
                        index: asAbsoluteStreamIndex(3),
                        displayTitle: 'German',
                        language: 'ger',
                        channels: 2,
                        codec: 'aac',
                        isDefault: false,
                    },
                ],
                decision,
                hlsOutput: { hlsAudioTrackIndex: 3 },
                videoDisabled: true,
            };
            const { args } = strategy.buildArgs(config);
            expect(args.filter((a) => a === '-map')).toHaveLength(1);
            expect(args[args.indexOf('-map') + 1]).toBe('0:a:1');
        });

        it('maps and encodes nothing when audioTracks is empty', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioTracks: [],
                decision,
                videoDisabled: true,
            };
            const { args } = strategy.buildArgs(config);
            expect(args).not.toContain('-map');
            expect(args).not.toContain('-c:a:0');
        });

        it('applies AUDIO_BOOST when downmixing to the fixed stereo target', () => {
            const config: FullStrategyConfig = {
                ...baseConfig,
                audioBoost: 1.5,
                audioTracks,
                decision,
                videoDisabled: true,
            };
            const { args } = strategy.buildArgs(config);
            expect(args[args.indexOf('-af') + 1]).toBe('volume=1.5');
        });

        it('still emits the HLS output tail as a single flat rendition', () => {
            const { args } = strategy.buildArgs(cfg());
            expect(args[args.indexOf('-f') + 1]).toBe('hls');
            expect(args).toContain('-hls_time');
            expect(args).toContain('-hls_segment_filename');
            expect(args[args.length - 1]).toMatch(/index\.m3u8$/);
            expect(args.join(' ')).not.toContain('stream_%v');
        });
    });
    /**
     * Audio-less sources are a SUPPORTED input, not an edge case: silent films
     * and the video-only renditions this app ships deliberately both arrive
     * here with nothing to map. Every audio step in the strategy trusts
     * `audioTracks` as the description of the source, and each guard tests the
     * ARRAY rather than the file — so a list carrying an entry the file does
     * not have sails through and ffmpeg dies with
     *
     *   Stream map '' matches no streams.
     *   Failed to set value '0:a:0' for option 'map': Invalid argument
     *
     * (exit 234, zero segments written) — which is exactly how every hover
     * preview of an audio-less file failed.
     *
     * These fixtures are genuinely audio-less. A fixture that has audio passes
     * every one of these assertions while the bug is fully present.
     */
    describe('buildArgs - sources with no audio stream', () => {
        const silentDecision = {
            mode: 'full' as const,
            reasons: 0,
            videoAction: 'transcode' as const,
            audioAction: 'transcode' as const,
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
        };

        /**
         * A probe of a file holding exactly one video stream and nothing else.
         * The strategy only reads `type` off these, so that is all they carry.
         */
        const videoOnlyProbe = { streams: [{ type: 'Video' }] };

        const realTrack = {
            index: asAbsoluteStreamIndex(1),
            displayTitle: 'English',
            language: 'eng',
            channels: 2,
            codec: 'aac',
            isDefault: true,
        };

        /** The placeholder the preview path used to invent for an audio-less file. */
        const phantomTrack = {
            index: asAbsoluteStreamIndex(0),
            displayTitle: 'Default',
            language: 'und',
            channels: 2,
            codec: 'aac',
            isDefault: true,
        };

        const audioMaps = (args: string[]): string[] =>
            args.filter((arg, i) => args[i - 1] === '-map' && arg.includes(':a'));

        it('maps no audio in MUXED mode when the track list is empty', () => {
            const { args } = strategy.buildArgs({
                ...baseConfig,
                audioTracks: [],
                decision: silentDecision,
                hlsOutput: { hlsAudioMode: 'muxed' },
            });

            expect(audioMaps(args)).toEqual([]);
            // The video must still be mapped — a silent preview, not no preview.
            expect(args.filter((a, i) => args[i - 1] === '-map')).toEqual(['0:v:0']);
        });

        it('maps no audio in DEMUX mode, and var_stream_map describes video alone', () => {
            const { args } = strategy.buildArgs({
                ...baseConfig,
                audioTracks: [],
                decision: silentDecision,
                hlsOutput: { hlsAudioMode: 'demux' },
            });

            expect(audioMaps(args)).toEqual([]);
            // The mapping and the var_stream_map must agree. If the map named an
            // audio rendition that was never mapped, ffmpeg would abort with
            // "Nothing was written into output file" rather than degrade.
            const varStreamMap = args[args.indexOf('-var_stream_map') + 1];
            expect(varStreamMap).not.toMatch(/\ba:\d/);
            expect(varStreamMap).toMatch(/\bv:0\b/);
        });

        it.each([['muxed'], ['demux']] as const)(
            'drops a phantom track the probe contradicts (%s mode)',
            (hlsAudioMode) => {
                const { args } = strategy.buildArgs({
                    ...baseConfig,
                    audioTracks: [phantomTrack],
                    decision: silentDecision,
                    mediaSourceInfo: videoOnlyProbe,
                    hlsOutput: { hlsAudioMode },
                });

                // The exact argument that killed the job.
                expect(args.join(' ')).not.toContain('0:a:0');
                expect(audioMaps(args)).toEqual([]);
                // ...and no encoder was configured for a track that isn't there.
                expect(args).not.toContain('-c:a:0');
            },
        );

        it('leaves real tracks alone when the probe confirms audio exists', () => {
            const { args } = strategy.buildArgs({
                ...baseConfig,
                audioTracks: [realTrack],
                decision: silentDecision,
                mediaSourceInfo: {
                    streams: [{ type: 'Video' }, { type: 'Audio' }],
                },
                hlsOutput: { hlsAudioMode: 'muxed' },
            });

            expect(audioMaps(args)).toEqual(['0:a:0']);
        });

        it('stays inert when there is no probe to contradict the list', () => {
            // Without mediaSourceInfo the strategy has no ground truth, so it
            // must not start second-guessing its caller.
            const { args } = strategy.buildArgs({
                ...baseConfig,
                audioTracks: [realTrack],
                decision: silentDecision,
                hlsOutput: { hlsAudioMode: 'muxed' },
            });

            expect(audioMaps(args)).toEqual(['0:a:0']);
        });
    });
});
