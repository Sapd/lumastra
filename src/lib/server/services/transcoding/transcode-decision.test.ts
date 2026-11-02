// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Transcode Decision Engine
 *
 * Tests direct-play vs transcode decision matrix with mocked dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscodeDecisionEngine } from './transcode-decision.js';
import type { TranscodeDecision } from './types.js';
import { TranscodeReason, type MediaSourceInfo } from './types.js';
import { hardwareDetection } from './hardware-detection.js';
import { deviceProfiles } from './device-profiles.js';
import { checkCompatibility } from '$lib/server/utils/media-compatibility.js';
import type { PlaybackPlan } from '$lib/schemas/playback-plan.js';

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: {
        TRANSCODING_MODE: 'auto',
        MAX_WIDTH: 0,
        MAX_HEIGHT: 0,
        GPU_ACCELERATION: 'none',
        HW_ENCODING_ENABLED: false,
        HW_DECODE_CODECS: '',
        ENABLE_TONEMAPPING: true,
        TONEMAPPING_ALGORITHM: 'bt2390',
        ENABLE_HDR10_PRESERVATION: true,
        VIDEO_CODEC_AUTO: true,
        VIDEO_CODEC: 'h264',
        AUDIO_CODEC: 'aac',
        ALLOW_HEVC_ENCODING: true,
        ALLOW_AV1_ENCODING: true,
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

vi.mock('$lib/server/utils/media-compatibility.js', () => ({
    checkCompatibility: vi.fn(),
    normalizeVideoCodecToken: (codec: string): string => {
        const c = codec.toLowerCase();
        if (c === 'h265' || c === 'h.265') return 'hevc';
        if (c === 'h.264') return 'h264';
        return c;
    },
}));

vi.mock('./hardware-detection.js', () => ({
    hardwareDetection: {
        getCapabilities: vi.fn(),
        getBestEncoder: vi.fn(),
        supportsEncoder: vi.fn(),
        getBestDecoder: vi.fn(),
    },
    isGpuEncoder: vi.fn(
        (e: string | undefined | null): boolean =>
            !!e && /_nvenc|_qsv|_amf|_vaapi|_videotoolbox/.test(e),
    ),
    isGpuDecoder: vi.fn(
        (d: string | undefined | null): boolean =>
            !!d && /_cuvid|_qsv|_vaapi|_videotoolbox|_d3d11va|_dxva2/.test(d),
    ),
}));

vi.mock('./device-profiles.js', () => ({
    deviceProfiles: {
        getProfile: vi.fn(),
        getProfileByUserAgent: vi.fn(),
    },
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeProfile(overrides: Record<string, unknown> = {}) {
    return {
        id: 'chrome',
        Name: 'Chrome',
        MaxStreamingBitrate: 120000000,
        DirectPlayProfiles: [
            {
                Container: 'mp4,m4v',
                Type: 'Video',
                VideoCodec: 'h264,hevc,vp9,av1',
                AudioCodec: 'aac,mp3,opus,flac',
            },
        ],
        TranscodingProfiles: [
            {
                Container: 'ts',
                Type: 'Video',
                VideoCodec: 'h264',
                AudioCodec: 'aac,mp3',
                Protocol: 'hls',
                Context: 'Streaming',
            },
        ],
        CodecProfiles: [],
        ContainerProfiles: [],
        SubtitleProfiles: [],
        supportsHdr: false,
        supportsDolbyVision: false,
        supportsAtmos: false,
        ...overrides,
    };
}

function makeMediaSource(overrides: Partial<MediaSourceInfo> = {}): MediaSourceInfo {
    return {
        id: 'media-123',
        container: 'mp4',
        bitrate: 5000000,
        streams: [
            {
                index: 0,
                type: 'Video',
                codec: 'h264',
                profile: 'High',
                level: 41,
                width: 1920,
                height: 1080,
                bitDepth: 8,
                videoRange: 'SDR',
                videoRangeType: 'SDR',
            },
            {
                index: 1,
                type: 'Audio',
                codec: 'aac',
                channels: 2,
                isDefault: true,
            },
        ],
        ...overrides,
    };
}

function makePlan(overrides: Partial<PlaybackPlan> = {}): PlaybackPlan {
    return {
        plan_id: '00000000-0000-0000-0000-000000000000',
        intent: 'play',
        delivery_path: 'native_hls',
        method: 'direct',
        video_action: 'copy',
        audio_action: 'copy',
        subtitle_method: 'none',
        transcode_reasons: [],
        needs_tonemapping: false,
        output_hdr: 'sdr',
        source_video_codec: 'h264',
        file_id: '00000000-0000-0000-0000-000000000001',
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T00:30:00.000Z',
        ...overrides,
    };
}

const allCompatible: ReturnType<typeof checkCompatibility> = {
    videoCompatible: true,
    audioCompatible: true,
    audioCompatibleInHls: true,
    audioAllCompatible: true,
    audioAnyCompatible: true,
    audioAllCompatibleInHls: true,
    audioAnyCompatibleInHls: true,
    incompatibleAudioCodecs: [],
    containerCompatible: true,
    needsTonemapping: false,
    needsHlsForAudio: false,
    videoLevelExceeded: false,
    videoProfileExceeded: false,
    videoProfileExcluded: false,
    resolutionExceeded: false,
    resolutionExceededSource: null,
    bitrateExceeded: false,
    bitrateExceededSource: null,
    audioChannelsExceeded: false,
    recommended: 'direct',
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TranscodeDecisionEngine', () => {
    let engine: TranscodeDecisionEngine;

    beforeEach(() => {
        engine = new TranscodeDecisionEngine();
        vi.clearAllMocks();
        vi.mocked(deviceProfiles.getProfile).mockResolvedValue(makeProfile() as never);
        vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(makeProfile() as never);
        vi.mocked(hardwareDetection.getCapabilities).mockResolvedValue({
            encoders: ['libx264', 'libx265', 'aac'],
            decoders: ['h264', 'hevc'],
            hwaccels: [],
            filters: ['tonemap'],
            ffmpegVersion: '6.0',
            detected: true,
        });
        vi.mocked(hardwareDetection.getBestEncoder).mockResolvedValue('libx264');
        vi.mocked(hardwareDetection.supportsEncoder).mockResolvedValue(false);
        vi.mocked(hardwareDetection.getBestDecoder).mockResolvedValue('h264');
        vi.mocked(checkCompatibility).mockReturnValue(allCompatible);
    });

    // ── decide() matrix ─────────────────────────────────────────────────────

    describe('decide()', () => {
        it('returns direct play when everything is compatible', async () => {
            const decision = await engine.decide(makeMediaSource());

            expect(decision.mode).toBe('direct');
            expect(decision.reasons).toBe(TranscodeReason.None);
            expect(decision.videoAction).toBe('copy');
            expect(decision.audioAction).toBe('copy');
            expect(decision.targetCodec).toEqual({});
        });

        it('transcodes video when codec is not supported', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                videoCompatible: false,
            });

            const decision = await engine.decide(makeMediaSource());

            expect(decision.mode).toBe('full');
            expect(decision.reasons & TranscodeReason.VideoCodecNotSupported).not.toBe(0);
            expect(decision.videoAction).toBe('transcode');
            expect(decision.audioAction).toBe('copy');
            expect(decision.targetCodec?.video).toBeDefined();
        });

        it('copies video when only container is unsupported', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                containerCompatible: false,
            });

            const decision = await engine.decide(makeMediaSource({ container: 'mkv' }));

            expect(decision.mode).toBe('full');
            expect(decision.reasons & TranscodeReason.ContainerNotSupported).not.toBe(0);
            expect(decision.videoAction).toBe('copy');
            expect(decision.audioAction).toBe('copy');
        });

        it('transcodes audio when codec is not supported', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                audioCompatible: false,
            });

            const decision = await engine.decide(makeMediaSource());

            expect(decision.mode).toBe('full');
            expect(decision.reasons & TranscodeReason.AudioCodecNotSupported).not.toBe(0);
            expect(decision.videoAction).toBe('copy');
            expect(decision.audioAction).toBe('transcode');
            expect(decision.targetCodec?.audio).toBe('aac');
        });

        it('transcodes video when resolution exceeds limit', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                resolutionExceeded: true,
            });

            const decision = await engine.decide(makeMediaSource());

            expect(decision.mode).toBe('full');
            expect(decision.reasons & TranscodeReason.ResolutionExceedsLimit).not.toBe(0);
            expect(decision.videoAction).toBe('transcode');
        });

        it('transcodes video when bitrate exceeds limit', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                bitrateExceeded: true,
            });

            const decision = await engine.decide(makeMediaSource());

            expect(decision.mode).toBe('full');
            expect(decision.reasons & TranscodeReason.BitrateExceedsLimit).not.toBe(0);
            expect(decision.videoAction).toBe('transcode');
        });

        it('transcodes video when profile is not supported', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                videoProfileExceeded: true,
            });

            const decision = await engine.decide(makeMediaSource());

            expect(decision.reasons & TranscodeReason.VideoProfileNotSupported).not.toBe(0);
            expect(decision.videoAction).toBe('transcode');
        });

        it('transcodes video when level is not supported', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                videoLevelExceeded: true,
            });

            const decision = await engine.decide(makeMediaSource());

            expect(decision.reasons & TranscodeReason.VideoLevelNotSupported).not.toBe(0);
            expect(decision.videoAction).toBe('transcode');
        });

        it('transcodes audio when channels exceed limit', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                audioChannelsExceeded: true,
            });

            const decision = await engine.decide(makeMediaSource());

            expect(decision.reasons & TranscodeReason.AudioChannelsNotSupported).not.toBe(0);
            expect(decision.audioAction).toBe('transcode');
        });

        it('forces full transcode when config mode is full', async () => {
            const { config } = await import('$lib/server/config.js');
            // The mocked config is a plain object; the real `config` type marks
            // TRANSCODING_MODE read-only, so write through a mutable view.
            const mutableConfig = config as { TRANSCODING_MODE: string };
            const originalMode = config.TRANSCODING_MODE;
            mutableConfig.TRANSCODING_MODE = 'full';

            try {
                const decision = await engine.decide(makeMediaSource());

                expect(decision.mode).toBe('full');
                expect(decision.reasons & TranscodeReason.ForcedByConfig).not.toBe(0);
                // ForcedByConfig alone does NOT force video transcoding (Bug 1/2 regression)
                expect(decision.videoAction).toBe('copy');
                expect(decision.audioAction).toBe('copy');
            } finally {
                mutableConfig.TRANSCODING_MODE = originalMode;
            }
        });

        it('forces audio transcode for HLS-incompatible codecs', async () => {
            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'h264',
                            width: 1920,
                            height: 1080,
                        },
                        {
                            index: 1,
                            type: 'Audio',
                            codec: 'dts',
                            channels: 6,
                            isDefault: true,
                        },
                    ],
                }),
            );

            expect(decision.audioAction).toBe('transcode');
        });

        it('handles audio-only content with direct play', async () => {
            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 1,
                            type: 'Audio',
                            codec: 'aac',
                            channels: 2,
                            isDefault: true,
                        },
                    ],
                }),
            );

            expect(decision.mode).toBe('direct');
            expect(decision.videoAction).toBe('copy');
            expect(decision.audioAction).toBe('copy');
        });

        it('handles audio-only content with incompatible codec', async () => {
            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 1,
                            type: 'Audio',
                            codec: 'dts',
                            channels: 6,
                            isDefault: true,
                        },
                    ],
                }),
            );

            expect(decision.mode).toBe('full');
            expect(decision.audioAction).toBe('transcode');
            expect(decision.targetCodec?.audio).toBe('aac');
        });

        it('applies plan hints to override video codec', async () => {
            vi.mocked(hardwareDetection.supportsEncoder).mockResolvedValue(true);

            const decision = await engine.decide(makeMediaSource(), undefined, undefined, {
                targetVideoCodec: 'hevc',
            });

            expect(decision.videoAction).toBe('transcode');
            expect(decision.targetCodec?.video).toBeDefined();
        });

        it('applies plan hints to force copy when engine says transcode', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                videoCompatible: false,
            });

            const decision = await engine.decide(makeMediaSource(), undefined, undefined, {
                targetVideoCodec: 'copy',
            });

            expect(decision.videoAction).toBe('copy');
            expect(decision.targetCodec?.video).toBeUndefined();
        });

        it('clears overruled reason bits on plan-hint copy override so mode agrees with actions', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                videoCompatible: false,
            });

            const decision = await engine.decide(makeMediaSource(), undefined, undefined, {
                targetVideoCodec: 'copy',
            });

            expect(decision.videoAction).toBe('copy');
            expect(decision.audioAction).toBe('copy');
            expect(decision.reasons & TranscodeReason.VideoCodecNotSupported).toBe(0);
            expect(decision.mode).toBe('direct');
        });

        it('ignores an unrecognised video codec hint instead of passing it to ffmpeg argv', async () => {
            // security review 2026-09-12, C17: a hint outside CODEC_ENCODER_MAP /
            // the software fallback map must never reach targetCodec.video raw.
            vi.mocked(hardwareDetection.supportsEncoder).mockResolvedValue(true);

            const decision = await engine.decide(makeMediaSource(), undefined, undefined, {
                targetVideoCodec: 'foo;rm',
            });

            expect(decision.targetCodec?.video).not.toBe('foo;rm');
        });

        it('applies plan hints to override audio codec via the known-encoder table', async () => {
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                audioCompatible: false,
            });

            const decision = await engine.decide(makeMediaSource(), undefined, undefined, {
                targetAudioCodec: 'opus',
            });

            expect(decision.targetCodec?.audio).toBe('libopus');
        });

        it('ignores an unrecognised audio codec hint instead of passing it to ffmpeg argv', async () => {
            // security review 2026-09-12, C17: a hint outside AUDIO_HINT_ENCODER_MAP
            // must never reach targetCodec.audio raw.
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                audioCompatible: false,
            });

            const decision = await engine.decide(makeMediaSource(), undefined, undefined, {
                targetAudioCodec: 'foo;rm',
            });

            expect(decision.targetCodec?.audio).not.toBe('foo;rm');
        });

        it('forces video transcode when tonemapping is needed', async () => {
            const hdrProfile = makeProfile({ supportsHdr: false });
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(hdrProfile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(hdrProfile as never);
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                needsTonemapping: true,
            });

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'hevc',
                            width: 3840,
                            height: 2160,
                            videoRange: 'HDR',
                            videoRangeType: 'HDR10',
                            hdr10Metadata: {},
                        },
                        {
                            index: 1,
                            type: 'Audio',
                            codec: 'aac',
                            channels: 2,
                            isDefault: true,
                        },
                    ],
                }),
            );

            expect(decision.needsTonemapping).toBe(true);
            expect(decision.videoAction).toBe('transcode');
        });

        it('preserves HDR10 when transcoding HDR content on HDR device', async () => {
            const hdrProfile = makeProfile({ supportsHdr: true });
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(hdrProfile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(hdrProfile as never);
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                videoCompatible: false,
            });

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'hevc',
                            width: 3840,
                            height: 2160,
                            videoRange: 'HDR',
                            videoRangeType: 'HDR10',
                            hdr10Metadata: {
                                maxCll: '1000,400',
                            },
                        },
                        {
                            index: 1,
                            type: 'Audio',
                            codec: 'aac',
                            channels: 2,
                            isDefault: true,
                        },
                    ],
                }),
            );

            expect(decision.preserveHdr10).toBe(true);
            expect(decision.outputVideoRange).toBe('HDR10');
        });

        it('falls back DV Profile 8 to HDR10 when device lacks DV support', async () => {
            const hdrProfile = makeProfile({
                supportsHdr: true,
                supportsDolbyVision: false,
            });
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(hdrProfile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(hdrProfile as never);
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                videoCompatible: false,
            });

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'hevc',
                            width: 1920,
                            height: 1080,
                            videoRange: 'DolbyVision',
                            videoRangeType: 'DOVI',
                            hdr10Metadata: {
                                dvProfile: 8,
                                dvBlCompatId: 1,
                            },
                        },
                        {
                            index: 1,
                            type: 'Audio',
                            codec: 'aac',
                            channels: 2,
                            isDefault: true,
                        },
                    ],
                }),
            );

            expect(decision.preserveHdr10).toBe(true);
        });

        it('falls back DV Profile 8 with HLG base layer to HLG output', async () => {
            const hdrProfile = makeProfile({
                supportsHdr: true,
                supportsDolbyVision: false,
            });
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(hdrProfile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(hdrProfile as never);
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                videoCompatible: false,
            });

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'hevc',
                            width: 1920,
                            height: 1080,
                            videoRange: 'DolbyVision',
                            videoRangeType: 'DOVI',
                            hdr10Metadata: {
                                dvProfile: 8,
                                dvBlCompatId: 4,
                            },
                        },
                        {
                            index: 1,
                            type: 'Audio',
                            codec: 'aac',
                            channels: 2,
                            isDefault: true,
                        },
                    ],
                }),
            );

            expect(decision.preserveHdr10).toBe(true);
            expect(decision.outputVideoRange).toBe('HLG');
        });
    });

    // ── decide() regression fixes ───────────────────────────────────────────

    describe('decide() — profileToDeviceCaps audio-scope regressions', () => {
        it('bare audio-file DirectPlayProfile entry does not disable the audio codec check for video playback', async () => {
            // {Container:'mp3',Type:'Audio'} has no AudioCodec — it must only
            // relax the check for AUDIO-ONLY playback, not for a Video entry
            // that itself restricts AudioCodec.
            const restrictedProfile = makeProfile({
                DirectPlayProfiles: [
                    {
                        Container: 'mp4,m4v',
                        Type: 'Video',
                        VideoCodec: 'h264,hevc,vp9,av1',
                        AudioCodec: 'aac,mp3',
                    },
                    { Container: 'mp3', Type: 'Audio' },
                ],
            });
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(restrictedProfile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(
                restrictedProfile as never,
            );
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                audioCompatible: false,
                audioAllCompatible: false,
            });

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        { index: 0, type: 'Video', codec: 'h264', width: 1920, height: 1080 },
                        { index: 1, type: 'Audio', codec: 'ac3', channels: 6, isDefault: true },
                    ],
                }),
            );

            expect(decision.audioAction).toBe('transcode');
        });

        it('a Video-type DirectPlayProfile with no AudioCodec restriction still bypasses the audio check', async () => {
            const unrestrictedProfile = makeProfile({
                DirectPlayProfiles: [
                    { Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264,hevc,vp9,av1' },
                ],
            });
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(unrestrictedProfile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(
                unrestrictedProfile as never,
            );
            vi.mocked(checkCompatibility).mockReturnValue({
                ...allCompatible,
                audioCompatible: false,
                audioAllCompatible: false,
            });

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        { index: 0, type: 'Video', codec: 'h264', width: 1920, height: 1080 },
                        { index: 1, type: 'Audio', codec: 'ac3', channels: 6, isDefault: true },
                    ],
                }),
            );

            expect(decision.audioAction).toBe('copy');
        });
    });

    describe('decide() — comma-list CodecProfile.Codec resolution', () => {
        it('resolves maxAudioChannels from a comma-list CodecProfile.Codec matching the media audio codec', async () => {
            const profile = makeProfile({
                CodecProfiles: [
                    {
                        Type: 'VideoAudio',
                        Codec: 'ac3,eac3',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'AudioChannels',
                                Value: '6',
                                IsRequired: false,
                            },
                        ],
                    },
                ],
            });
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(profile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(profile as never);

            await engine.decide(
                makeMediaSource({
                    streams: [
                        { index: 0, type: 'Video', codec: 'h264', width: 1920, height: 1080 },
                        { index: 1, type: 'Audio', codec: 'eac3', channels: 6, isDefault: true },
                    ],
                }),
            );

            expect(checkCompatibility).toHaveBeenCalled();
            const [, deviceCaps] = vi.mocked(checkCompatibility).mock.calls[0];
            expect(deviceCaps.maxAudioChannels).toBe(6);
        });
    });

    describe('decide() — unidentified video codec', () => {
        it('forces video transcode when the codec is undefined, even when compat says all-compatible', async () => {
            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        { index: 0, type: 'Video', codec: undefined, width: 1920, height: 1080 },
                        { index: 1, type: 'Audio', codec: 'aac', channels: 2, isDefault: true },
                    ],
                }),
            );
            expect(decision.videoAction).toBe('transcode');
        });

        it('forces video transcode when the codec is an empty string, even when compat says all-compatible', async () => {
            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        { index: 0, type: 'Video', codec: '', width: 1920, height: 1080 },
                        { index: 1, type: 'Audio', codec: 'aac', channels: 2, isDefault: true },
                    ],
                }),
            );
            expect(decision.videoAction).toBe('transcode');
        });
    });

    describe('decide() — interlaced enforcement', () => {
        const interlacedProfile = () =>
            makeProfile({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Codec: 'h264',
                        Conditions: [
                            {
                                Condition: 'NotEquals',
                                Property: 'IsInterlaced',
                                Value: 'true',
                                IsRequired: false,
                            },
                        ],
                    },
                ],
            });

        it('transcodes interlaced video when the profile disallows it', async () => {
            const profile = interlacedProfile();
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(profile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(profile as never);

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'h264',
                            width: 1920,
                            height: 1080,
                            isInterlaced: true,
                        },
                        { index: 1, type: 'Audio', codec: 'aac', channels: 2, isDefault: true },
                    ],
                }),
            );
            expect(decision.videoAction).toBe('transcode');
            expect(decision.reasons & TranscodeReason.InterlacedNotSupported).not.toBe(0);
        });

        it('copies progressive video (isInterlaced: false) under the same profile', async () => {
            const profile = interlacedProfile();
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(profile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(profile as never);

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'h264',
                            width: 1920,
                            height: 1080,
                            isInterlaced: false,
                        },
                        { index: 1, type: 'Audio', codec: 'aac', channels: 2, isDefault: true },
                    ],
                }),
            );
            expect(decision.videoAction).toBe('copy');
        });

        it('copies video with isInterlaced undefined under the same profile', async () => {
            const profile = interlacedProfile();
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(profile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(profile as never);

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        { index: 0, type: 'Video', codec: 'h264', width: 1920, height: 1080 },
                        { index: 1, type: 'Audio', codec: 'aac', channels: 2, isDefault: true },
                    ],
                }),
            );
            expect(decision.videoAction).toBe('copy');
        });
    });

    describe('decide() — RefFrames with ApplyConditions', () => {
        const refFramesProfile = () =>
            makeProfile({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Codec: 'h264',
                        Conditions: [
                            {
                                Condition: 'LessThanEqual',
                                Property: 'RefFrames',
                                Value: '4',
                                IsRequired: false,
                            },
                        ],
                        ApplyConditions: [
                            {
                                Condition: 'GreaterThanEqual',
                                Property: 'Width',
                                Value: '1900',
                                IsRequired: false,
                            },
                        ],
                    },
                ],
            });

        it('transcodes when ApplyConditions gate passes (wide source) and RefFrames exceeds the limit', async () => {
            const profile = refFramesProfile();
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(profile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(profile as never);

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'h264',
                            width: 1920,
                            height: 1080,
                            refFrames: 16,
                        },
                        { index: 1, type: 'Audio', codec: 'aac', channels: 2, isDefault: true },
                    ],
                }),
            );
            expect(decision.videoAction).toBe('transcode');
            expect(decision.reasons & TranscodeReason.RefFramesExceedsLimit).not.toBe(0);
        });

        it('copies when ApplyConditions gate fails (narrow source) even though RefFrames exceeds the limit', async () => {
            const profile = refFramesProfile();
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(profile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(profile as never);

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'h264',
                            width: 1280,
                            height: 720,
                            refFrames: 16,
                        },
                        { index: 1, type: 'Audio', codec: 'aac', channels: 2, isDefault: true },
                    ],
                }),
            );
            expect(decision.videoAction).toBe('copy');
        });

        it('copies when width is unknown — an unknown width must not satisfy the width gate', async () => {
            const profile = refFramesProfile();
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(profile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(profile as never);

            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'h264',
                            refFrames: 16,
                        },
                        { index: 1, type: 'Audio', codec: 'aac', channels: 2, isDefault: true },
                    ],
                }),
            );
            expect(decision.videoAction).toBe('copy');
            expect(decision.reasons & TranscodeReason.RefFramesExceedsLimit).toBe(0);
        });
    });

    describe('decide() — container-scoped CodecProfile', () => {
        const containerScopedProfile = () =>
            makeProfile({
                CodecProfiles: [
                    {
                        Type: 'Video',
                        Codec: 'h264',
                        Container: '-mp4,ts',
                        Conditions: [
                            {
                                Condition: 'NotEquals',
                                Property: 'IsInterlaced',
                                Value: 'true',
                                IsRequired: false,
                            },
                        ],
                    },
                ],
            });

        it('does not apply the profile to an excluded container (mp4) — interlaced source copies', async () => {
            const profile = containerScopedProfile();
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(profile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(profile as never);

            const decision = await engine.decide(
                makeMediaSource({
                    container: 'mp4',
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'h264',
                            width: 1920,
                            height: 1080,
                            isInterlaced: true,
                        },
                        { index: 1, type: 'Audio', codec: 'aac', channels: 2, isDefault: true },
                    ],
                }),
            );
            expect(decision.videoAction).toBe('copy');
        });

        it('applies the profile to a non-excluded container (mkv) — interlaced source transcodes', async () => {
            const profile = containerScopedProfile();
            vi.mocked(deviceProfiles.getProfile).mockResolvedValue(profile as never);
            vi.mocked(deviceProfiles.getProfileByUserAgent).mockResolvedValue(profile as never);

            const decision = await engine.decide(
                makeMediaSource({
                    container: 'mkv',
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'h264',
                            width: 1920,
                            height: 1080,
                            isInterlaced: true,
                        },
                        { index: 1, type: 'Audio', codec: 'aac', channels: 2, isDefault: true },
                    ],
                }),
            );
            expect(decision.videoAction).toBe('transcode');
        });
    });

    describe('decide() — mode consistency with HLS-forced audio transcode', () => {
        it('reports mode "full" (not "direct") when the only reason is the HLS-incompatible-audio force', async () => {
            const decision = await engine.decide(
                makeMediaSource({
                    streams: [
                        { index: 0, type: 'Video', codec: 'h264', width: 1920, height: 1080 },
                        { index: 1, type: 'Audio', codec: 'dts', channels: 6, isDefault: true },
                    ],
                }),
            );
            expect(decision.audioAction).toBe('transcode');
            expect(decision.mode).toBe('full');
        });
    });

    // ── consumePlan() ───────────────────────────────────────────────────────

    describe('consumePlan()', () => {
        it('returns copy decision for a direct-play plan', async () => {
            const plan = makePlan();

            const decision = await engine.consumePlan(plan, makeMediaSource());

            expect(decision.mode).toBe('direct');
            expect(decision.videoAction).toBe('copy');
            expect(decision.audioAction).toBe('copy');
            expect(decision.reasons).toBe(0);
        });

        it('returns transcode decision for a full-transcode plan', async () => {
            const plan = makePlan({
                method: 'full_transcode',
                video_action: 'transcode',
                audio_action: 'transcode',
                target_video_codec: 'h264',
                target_audio_codec: 'aac',
                gpu_encoder: 'libx264',
            });

            const decision = await engine.consumePlan(plan, makeMediaSource());

            expect(decision.mode).toBe('full');
            expect(decision.videoAction).toBe('transcode');
            expect(decision.audioAction).toBe('transcode');
            expect(decision.targetCodec?.video).toBe('libx264');
            expect(decision.targetCodec?.audio).toBe('aac');
        });

        it('still returns valid decision when plan source codec differs from actual media', async () => {
            const plan = makePlan({
                source_video_codec: 'hevc',
            });

            const decision = await engine.consumePlan(plan, makeMediaSource());

            // Despite the drift warning, the plan's decisions are still honored
            expect(decision.mode).toBe('direct');
            expect(decision.videoAction).toBe('copy');
            expect(decision.audioAction).toBe('copy');
        });

        it('preserves HDR from plan when output_hdr is HDR10', async () => {
            const plan = makePlan({
                method: 'full_transcode',
                video_action: 'transcode',
                output_hdr: 'hdr10',
                source_video_codec: 'hevc',
                target_video_codec: 'hevc',
            });

            const decision = await engine.consumePlan(
                plan,
                makeMediaSource({
                    streams: [
                        {
                            index: 0,
                            type: 'Video',
                            codec: 'hevc',
                            width: 3840,
                            height: 2160,
                            videoRange: 'HDR',
                            videoRangeType: 'HDR10',
                            hdr10Metadata: { maxCll: '1000,400' },
                        },
                        {
                            index: 1,
                            type: 'Audio',
                            codec: 'aac',
                            channels: 2,
                            isDefault: true,
                        },
                    ],
                }),
            );

            expect(decision.preserveHdr10).toBe(true);
            expect(decision.outputVideoRange).toBe('HDR10');
        });

        it('outputs SDR when plan needs tonemapping', async () => {
            const plan = makePlan({
                method: 'full_transcode',
                video_action: 'transcode',
                needs_tonemapping: true,
                output_hdr: 'hdr10',
                source_video_codec: 'hevc',
                target_video_codec: 'hevc',
            });

            const decision = await engine.consumePlan(plan, makeMediaSource());

            expect(decision.preserveHdr10).toBe(false);
            expect(decision.outputVideoRange).toBe('SDR');
        });

        it('falls back to software encoder when stored encoder is unavailable', async () => {
            vi.mocked(hardwareDetection.supportsEncoder).mockResolvedValue(false);

            const plan = makePlan({
                method: 'full_transcode',
                video_action: 'transcode',
                target_video_codec: 'h264',
                gpu_encoder: 'h264_nvenc',
            });

            const decision = await engine.consumePlan(plan, makeMediaSource());

            // gpuEncoder should be undefined when stored encoder is not available
            expect(decision.gpuEncoder).toBeUndefined();
            // useGpu should be false since no GPU encoder/decoder resolved
            expect(decision.useGpu).toBe(false);
        });

        // ── mode consistency with playback_branch ───────────────────────────

        it('mode is "full" for a direct-method plan riding a non-direct playback_branch (web_hls_single_audio)', async () => {
            // method:'direct' can still ride an HLS remux branch (multi-audio /
            // container normalization) — that is not "direct" for reporting.
            const plan = makePlan({
                method: 'direct',
                playback_branch: 'web_hls_single_audio',
                video_action: 'copy',
                audio_action: 'copy',
            });

            const decision = await engine.consumePlan(plan, makeMediaSource());

            expect(decision.mode).toBe('full');
        });

        it('mode is "direct" for a direct-method plan with playback_branch "direct"', async () => {
            const plan = makePlan({ method: 'direct', playback_branch: 'direct' });

            const decision = await engine.consumePlan(plan, makeMediaSource());

            expect(decision.mode).toBe('direct');
        });

        it('mode is "direct" for a legacy direct-method plan with no playback_branch (fallback)', async () => {
            // Legacy plans predate the playback_branch field entirely —
            // ?? 'direct' fallback must still resolve to mode 'direct'.
            const plan = makePlan({ method: 'direct' });
            expect(plan.playback_branch).toBeUndefined();

            const decision = await engine.consumePlan(plan, makeMediaSource());

            expect(decision.mode).toBe('direct');
        });
    });
});

describe('TranscodeDecisionEngine.assignEncoderForFlippedTranscode (quality-cap safety net)', () => {
    // A copy plan carries no encoder (consumePlan: useGpu false, no gpuEncoder),
    // so a copy→transcode flip that only changed videoAction fell through to a
    // software encode on an NVENC host (Windows e2e 2026-09-27). The flip must
    // pick the encoder exactly like a planned transcode does.
    let engine: TranscodeDecisionEngine;

    function flippedCopyDecision(): TranscodeDecision {
        return {
            mode: 'full',
            reasons: 0,
            videoAction: 'transcode',
            audioAction: 'transcode',
            targetCodec: { audio: 'aac' },
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
        };
    }

    beforeEach(() => {
        engine = new TranscodeDecisionEngine();
        vi.clearAllMocks();
    });

    it('uses the GPU encoder when one is configured (hevc source → hevc_nvenc)', async () => {
        vi.mocked(hardwareDetection.getBestEncoder).mockResolvedValue('hevc_nvenc');
        vi.mocked(hardwareDetection.getBestDecoder).mockResolvedValue('hevc_cuvid');
        const decision = flippedCopyDecision();

        await engine.assignEncoderForFlippedTranscode(decision, { codec: 'hevc', is10Bit: true });

        expect(hardwareDetection.getBestEncoder).toHaveBeenCalledWith('hevc');
        expect(hardwareDetection.getBestDecoder).toHaveBeenCalledWith('hevc', true);
        expect(decision).toMatchObject({
            useGpu: true,
            gpuEncoder: 'hevc_nvenc',
            gpuDecoder: 'hevc_cuvid',
            targetCodec: { video: 'hevc_nvenc', audio: 'aac' },
        });
    });

    it('encodes the REQUESTED codec when the request asks for another one (hevc source → h264)', async () => {
        vi.mocked(hardwareDetection.getBestEncoder).mockResolvedValue('libx264');
        vi.mocked(hardwareDetection.getBestDecoder).mockResolvedValue('hevc');
        const decision = flippedCopyDecision();

        await engine.assignEncoderForFlippedTranscode(
            decision,
            { codec: 'hevc', is10Bit: true },
            'h264',
        );

        expect(hardwareDetection.getBestEncoder).toHaveBeenCalledWith('h264');
        expect(decision.targetCodec).toMatchObject({ video: 'libx264' });
    });

    it('targets h264 for a source outside h264/hevc/av1', async () => {
        vi.mocked(hardwareDetection.getBestEncoder).mockResolvedValue('h264_nvenc');
        vi.mocked(hardwareDetection.getBestDecoder).mockResolvedValue('mpeg2video');
        const decision = flippedCopyDecision();

        await engine.assignEncoderForFlippedTranscode(decision, { codec: 'mpeg2video' });

        expect(hardwareDetection.getBestEncoder).toHaveBeenCalledWith('h264');
        expect(decision.gpuEncoder).toBe('h264_nvenc');
        expect(decision.useGpu).toBe(true);
    });

    it('falls back to software only when no GPU encoder exists', async () => {
        // getBestEncoder returns the software id on a GPU-less host.
        vi.mocked(hardwareDetection.getBestEncoder).mockResolvedValue('libx265');
        vi.mocked(hardwareDetection.getBestDecoder).mockResolvedValue('hevc');
        const decision = flippedCopyDecision();

        await engine.assignEncoderForFlippedTranscode(decision, { codec: 'hevc' });

        expect(decision.useGpu).toBe(false);
        expect(decision.gpuEncoder).toBeUndefined();
        expect(decision.targetCodec).toMatchObject({ video: 'libx265' });
    });
});

describe('TranscodeDecisionEngine.assignHdrForFlippedTranscode (quality-cap safety net)', () => {
    // A copy plan's HDR fields describe a copy (no tone-map, no HDR10
    // signalling). A flip must set the HDR handling a planned transcode would
    // give this client: tone-map when it cannot display the source HDR,
    // preserve when it can and the encoder can carry HDR.
    let engine: TranscodeDecisionEngine;

    const hdr10Stream = {
        type: 'Video' as const,
        index: 0,
        codec: 'hevc',
        width: 3840,
        height: 2160,
        videoRange: 'HDR',
        videoRangeType: 'HDR10',
        bitDepth: 10,
        hdr10Metadata: { maxCll: '1000,400' },
    };

    function flipped(encoder: string) {
        return {
            mode: 'full' as const,
            reasons: 0,
            videoAction: 'transcode' as const,
            audioAction: 'copy' as const,
            targetCodec: { video: encoder },
            useGpu: encoder.includes('nvenc'),
            gpuEncoder: encoder.includes('nvenc') ? encoder : undefined,
            // As consumePlan leaves them for a copy plan:
            needsTonemapping: false,
            preserveHdr10: false,
        };
    }

    beforeEach(() => {
        engine = new TranscodeDecisionEngine();
    });

    it('HDR10 source + SDR-only client → tone-map to SDR', () => {
        const decision = flipped('hevc_nvenc');
        engine.assignHdrForFlippedTranscode(decision, hdr10Stream, []);
        expect(decision).toMatchObject({
            needsTonemapping: true,
            tonemappingAlgorithm: 'bt2390',
            preserveHdr10: false,
            outputVideoRange: 'SDR',
        });
    });

    it('HDR10 source + HDR10-capable client + HEVC encoder → preserve HDR10', () => {
        const decision = flipped('hevc_nvenc');
        engine.assignHdrForFlippedTranscode(decision, hdr10Stream, ['hdr10', 'hlg']);
        expect(decision).toMatchObject({
            needsTonemapping: false,
            preserveHdr10: true,
            outputVideoRange: 'HDR10',
            hdr10Metadata: { maxCll: '1000,400' },
        });
    });

    it('an HDR-capable client still gets a tone-map when the encoder is H.264 (no HDR)', () => {
        const decision = flipped('h264_nvenc');
        engine.assignHdrForFlippedTranscode(decision, hdr10Stream, ['hdr10']);
        expect(decision.needsTonemapping).toBe(true);
        expect(decision.preserveHdr10).toBe(false);
    });

    it('HLG source is preserved as HLG only for an HLG-capable client', () => {
        const hlg = { ...hdr10Stream, videoRange: 'HLG', videoRangeType: 'HLG' };
        const hdr10Only = flipped('hevc_nvenc');
        engine.assignHdrForFlippedTranscode(hdr10Only, hlg, ['hdr10']);
        expect(hdr10Only.needsTonemapping).toBe(true);

        const hlgClient = flipped('hevc_nvenc');
        engine.assignHdrForFlippedTranscode(hlgClient, hlg, ['hlg']);
        expect(hlgClient).toMatchObject({ preserveHdr10: true, outputVideoRange: 'HLG' });
    });

    it('an SDR source needs neither', () => {
        const decision = flipped('hevc_nvenc');
        engine.assignHdrForFlippedTranscode(
            decision,
            { ...hdr10Stream, videoRange: 'SDR', videoRangeType: 'SDR', hdr10Metadata: undefined },
            [],
        );
        expect(decision.needsTonemapping).toBe(false);
        expect(decision.preserveHdr10).toBe(false);
    });
});
