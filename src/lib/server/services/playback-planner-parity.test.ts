// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    MediaInfo,
    DeviceCapabilities,
    ServerEncodeCaps,
} from '$lib/server/utils/media-compatibility.js';
import type { MediaSourceInfo } from './transcoding/types.js';
import type { PlaybackPlannerService as PlaybackPlannerServiceType } from './playback-planner.service.js';
import type { TranscodeDecisionEngine as TranscodeDecisionEngineType } from './transcoding/transcode-decision.js';

// ── Mocks ──

const mockSetEx = vi
    .fn<(key: string, seconds: number, value: string) => Promise<boolean>>()
    .mockResolvedValue(true);
const mockGetValkeyClient = vi.fn().mockReturnValue(null);
const mockExpire = vi
    .fn<(key: string, seconds: number) => Promise<boolean>>()
    .mockResolvedValue(true);

vi.mock('$lib/server/cache/valkey.js', () => ({
    setEx: (...args: [string, number, string]) => mockSetEx(...args),
    getValkeyClient: () => mockGetValkeyClient(),
    getCoordinationClient: () => mockGetValkeyClient(),
    expire: (...args: [string, number]) => mockExpire(...args),
}));

const mockGetBestEncoder = vi
    .fn<(codec: 'h264' | 'hevc' | 'av1') => Promise<string | null>>()
    .mockResolvedValue(null);
const mockGetBestDecoder = vi
    .fn<(codec: string, is10Bit?: boolean) => Promise<string | null>>()
    .mockResolvedValue(null);
const mockGetCapabilities = vi.fn().mockResolvedValue({
    encoders: [],
    decoders: [],
    hwaccels: [],
    filters: [],
    ffmpegVersion: '6.0',
    detected: true,
});

vi.mock('./transcoding/hardware-detection.js', () => ({
    hardwareDetection: {
        getBestEncoder: (...args: ['h264' | 'hevc' | 'av1']) => mockGetBestEncoder(...args),
        getBestDecoder: (...args: [string, boolean?]) => mockGetBestDecoder(...args),
        getCapabilities: () => mockGetCapabilities(),
    },
    isGpuEncoder: (encoder: string | undefined | null): boolean =>
        !!encoder && /_nvenc|_qsv|_amf|_vaapi|_videotoolbox/.test(encoder),
    isGpuDecoder: (decoder: string | undefined | null): boolean =>
        !!decoder && /_cuvid|_qsv|_vaapi|_videotoolbox|_d3d11va|_dxva2/.test(decoder),
}));

vi.mock('crypto', () => ({
    randomUUID: vi.fn(() => 'test-uuid-0000-0000-000000000001'),
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        TRANSCODING_MODE: 'full',
        GPU_ACCELERATION: 'none',
        HW_ENCODING_ENABLED: false,
        HW_DECODE_CODECS: '',
        HW_DECODE_10BIT: '',
        VIDEO_CODEC: 'h264',
        VIDEO_CODEC_AUTO: false,
        AUDIO_CODEC: 'aac',
        ALLOW_HEVC_ENCODING: true,
        ALLOW_AV1_ENCODING: true,
        ALLOW_AV1_MSE_HLS: false,
        SOFTWARE_ENCODE_MAX_WIDTH: 1920,
        SOFTWARE_CODEC_PREFERENCE: 'h264,hevc,av1',
        ENCODING_PRESET: 'fast',
        NVENC_PRESET: 'p4',
        ENABLE_TONEMAPPING: true,
        TONEMAPPING_ALGORITHM: 'hable',
        ENABLE_HDR10_PRESERVATION: false,
        MAX_WIDTH: 0,
        MAX_HEIGHT: 0,
    },
}));

vi.mock('./transcoding/device-profiles.js', () => ({
    deviceProfiles: {
        getProfile: vi.fn().mockResolvedValue(null),
        getProfileByUserAgent: vi.fn().mockResolvedValue(null),
    },
}));

// ── Helpers ──

function makeMediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
    return {
        videoCodec: 'h264',
        audioCodecs: ['aac'],
        audioTrackCount: 1,
        container: 'mp4',
        hdr: 'sdr',
        ...overrides,
    };
}

function makeCaps(overrides: Partial<DeviceCapabilities> = {}): DeviceCapabilities {
    return {
        videoCodecs: new Set(['h264', 'hevc', 'vp9']),
        audioCodecs: new Set(['aac', 'opus']),
        containers: new Set(['mp4', 'webm']),
        canSwitchAudioInDirectPlay: false,
        ...overrides,
    };
}

function makeServerEncode(): ServerEncodeCaps {
    return {
        canEncodeCodec: (c: string) => ['h264', 'hevc'].includes(c),
        canEfficientlyEncodeCodec: () => false,
    };
}

function makeMediaSource(info: MediaInfo): MediaSourceInfo {
    return {
        id: 'test-source',
        bitrate: info.bitrate,
        streams: [
            {
                type: 'Video',
                index: 0,
                codec: info.videoCodec,
                width: info.width ?? 1920,
                height: info.height ?? 1080,
                bitDepth: info.videoBitDepth,
            },
            ...info.audioCodecs.map((codec, i) => ({
                type: 'Audio' as const,
                index: i + 1,
                codec,
                channels: 2,
                isDefault: i === 0,
            })),
        ],
    };
}

// ── Tests ──

type MakeParamsOptions = {
    mediaInfo: MediaInfo;
    caps?: DeviceCapabilities;
    intent?: 'play' | 'preview';
    deliveryPath?: 'direct_file' | 'mse_hls';
    enableHdrPreservation?: boolean;
};

function makeParams(opts: MakeParamsOptions): {
    intent: 'play' | 'preview';
    fileId: string;
    mediaInfo: MediaInfo;
    caps: DeviceCapabilities;
    serverEncode: ServerEncodeCaps;
    deliveryPath: 'direct_file' | 'mse_hls';
    enableHdrPreservation?: boolean;
} {
    return {
        intent: opts.intent ?? 'play',
        fileId: 'test-uuid-0000-0000-000000000001',
        mediaInfo: opts.mediaInfo,
        caps: opts.caps ?? makeCaps(),
        serverEncode: makeServerEncode(),
        deliveryPath: opts.deliveryPath ?? 'mse_hls',
        ...(opts.enableHdrPreservation !== undefined
            ? { enableHdrPreservation: opts.enableHdrPreservation }
            : {}),
    };
}

describe('PlaybackPlan planner→executor parity', () => {
    let PlaybackPlannerService: typeof PlaybackPlannerServiceType;
    let TranscodeDecisionEngine: typeof TranscodeDecisionEngineType;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockGetBestEncoder.mockResolvedValue(null);
        mockGetBestDecoder.mockResolvedValue(null);

        const plannerMod = await import('./playback-planner.service.js');
        PlaybackPlannerService = plannerMod.PlaybackPlannerService;
        const decisionMod = await import('./transcoding/transcode-decision.js');
        TranscodeDecisionEngine = decisionMod.TranscodeDecisionEngine;
    });

    it('direct play parity: h264/mp4/aac → copy/copy', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo();
        const caps = makeCaps();

        const { plan } = await planner.createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo,
            caps,
            serverEncode: makeServerEncode(),
            deliveryPath: 'direct_file',
        });

        expect(plan.method).toBe('direct');
        expect(plan.video_action).toBe('copy');
        expect(plan.audio_action).toBe('copy');
        expect(plan.playback_branch).toBe('direct');
        expect(plan.hls_audio_mode).toBeUndefined();

        const engine = new TranscodeDecisionEngine();
        const decision = await engine.consumePlan(plan, makeMediaSource(mediaInfo));

        expect(decision.videoAction).toBe('copy');
        expect(decision.audioAction).toBe('copy');
        expect(decision.mode).toBe('direct');
    });

    it('remux parity: h264/mkv/aac → copy video, remux container', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({ container: 'matroska' });
        const caps = makeCaps({ containers: new Set(['mp4']) });

        const { plan } = await planner.createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo,
            caps,
            serverEncode: makeServerEncode(),
            deliveryPath: 'mse_hls',
        });

        expect(plan.method).toBe('remux');
        expect(plan.video_action).toBe('copy');
        expect(plan.playback_branch).toBe('web_hls_single_audio');
        expect(plan.hls_audio_mode).toBe('muxed');

        const engine = new TranscodeDecisionEngine();
        const decision = await engine.consumePlan(plan, makeMediaSource(mediaInfo));

        expect(decision.videoAction).toBe('copy');
        expect(decision.mode).toBe('full');
    });

    // Native clients must explicitly support source reloads before they lose
    // the demux audio group. Older app releases only offer AVPlayer's picker.

    it('native_hls + copy video + native client → demux (tvOS keeps its language picker)', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({ container: 'matroska', audioTrackCount: 2 });
        const caps = makeCaps({ containers: new Set(['mp4']) });

        const { plan } = await planner.createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo,
            caps,
            serverEncode: makeServerEncode(),
            deliveryPath: 'native_hls',
            clientType: 'native',
        });

        expect(plan.video_action).toBe('copy');
        expect(plan.hls_audio_mode).toBe('demux');
    });

    it.each(['ac3', 'truehd'])(
        'reload-capable AVPlayer uses the complete muxed timeline for %s audio',
        async (audioCodec) => {
            const { plan } = await new PlaybackPlannerService().createPlan({
                intent: 'play',
                fileId: 'test-uuid-0000-0000-000000000001',
                mediaInfo: makeMediaInfo({
                    container: 'matroska',
                    audioTrackCount: 2,
                    audioCodecs: [audioCodec],
                }),
                caps: makeCaps({
                    containers: new Set(['mp4']),
                    audioCodecs: new Set(['aac', 'ac3']),
                    supportsHlsCopyReload: true,
                }),
                serverEncode: makeServerEncode(),
                deliveryPath: 'native_hls',
                clientType: 'native',
            });
            expect(plan.video_action).toBe('copy');
            expect(plan.method).toBe(audioCodec === 'ac3' ? 'remux' : 'audio_transcode');
            expect(plan.hls_audio_mode).toBe('muxed');
        },
    );

    it('keeps full-transcode native multi-audio when the client supports copy reloads', async () => {
        const { plan } = await new PlaybackPlannerService().createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo: makeMediaInfo({
                videoCodec: 'vp9',
                container: 'matroska',
                audioTrackCount: 2,
            }),
            caps: makeCaps({ videoCodecs: new Set(['h264']), supportsHlsCopyReload: true }),
            serverEncode: makeServerEncode(),
            deliveryPath: 'native_hls',
            clientType: 'native',
        });
        expect(plan.video_action).toBe('transcode');
        expect(plan.hls_audio_mode).toBe('demux');
    });

    it('native_hls + copy video + browser client → muxed (Safari subtitle sync preserved)', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({ container: 'matroska', audioTrackCount: 2 });
        const caps = makeCaps({ containers: new Set(['mp4']) });

        const { plan } = await planner.createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo,
            caps,
            serverEncode: makeServerEncode(),
            deliveryPath: 'native_hls',
            clientType: 'browser',
        });

        expect(plan.video_action).toBe('copy');
        expect(plan.hls_audio_mode).toBe('muxed');
    });

    it.each(['ac3', 'aac'])(
        'native_hls + copy video + browser that prefers separate audio (iOS) → demux for %s',
        async (audioCodec) => {
            const { plan } = await new PlaybackPlannerService().createPlan({
                intent: 'play',
                fileId: 'test-uuid-0000-0000-000000000001',
                mediaInfo: makeMediaInfo({
                    container: 'matroska',
                    audioTrackCount: 1,
                    audioCodecs: [audioCodec],
                }),
                caps: makeCaps({
                    containers: new Set(['mp4']),
                    audioCodecs: new Set(['aac', 'ac3']),
                    prefersHlsDemuxAudio: true,
                }),
                serverEncode: makeServerEncode(),
                deliveryPath: 'native_hls',
                clientType: 'browser',
            });

            expect(plan.video_action).toBe('copy');
            expect(plan.hls_audio_mode).toBe('demux');
        },
    );

    it('mse_hls ignores the separate-audio preference (hls.js keeps muxed)', async () => {
        const { plan } = await new PlaybackPlannerService().createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo: makeMediaInfo({ container: 'matroska', audioTrackCount: 1 }),
            caps: makeCaps({ containers: new Set(['mp4']), prefersHlsDemuxAudio: true }),
            serverEncode: makeServerEncode(),
            deliveryPath: 'mse_hls',
            clientType: 'browser',
        });

        expect(plan.hls_audio_mode).toBe('muxed');
    });

    it('native_hls + copy video + unspecified client → muxed (safe default)', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({ container: 'matroska', audioTrackCount: 2 });
        const caps = makeCaps({ containers: new Set(['mp4']) });

        const { plan } = await planner.createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo,
            caps,
            serverEncode: makeServerEncode(),
            deliveryPath: 'native_hls',
        });

        expect(plan.hls_audio_mode).toBe('muxed');
    });

    it('native_hls + transcode video → demux regardless of client', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({ videoCodec: 'vp9', audioTrackCount: 2 });
        const caps = makeCaps({ videoCodecs: new Set(['h264']) });

        for (const clientType of ['native', 'browser'] as const) {
            const { plan } = await planner.createPlan({
                intent: 'play',
                fileId: 'test-uuid-0000-0000-000000000001',
                mediaInfo,
                caps,
                serverEncode: makeServerEncode(),
                deliveryPath: 'native_hls',
                clientType,
            });

            expect(plan.video_action).toBe('transcode');
            expect(plan.hls_audio_mode).toBe('demux');
        }
    });

    it('audio transcode parity: h264/mp4/truehd → video copy, audio transcode to aac', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({ audioCodecs: ['truehd'] });
        const caps = makeCaps();

        const { plan } = await planner.createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo,
            caps,
            serverEncode: makeServerEncode(),
            deliveryPath: 'mse_hls',
        });

        expect(plan.method).toBe('audio_transcode');
        expect(plan.audio_action).toBe('transcode');
        expect(plan.target_audio_codec).toBe('aac');
        expect(plan.playback_branch).toBe('web_hls_single_audio');
        expect(plan.hls_audio_mode).toBe('muxed');

        const engine = new TranscodeDecisionEngine();
        const decision = await engine.consumePlan(plan, makeMediaSource(mediaInfo));

        expect(decision.audioAction).toBe('transcode');
        expect(decision.targetCodec?.audio).toBe('aac');
    });

    it('full transcode parity: vp9 with h264-only browser → transcode video', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({ videoCodec: 'vp9' });
        const caps = makeCaps({ videoCodecs: new Set(['h264']) });

        const { plan } = await planner.createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo,
            caps,
            serverEncode: makeServerEncode(),
            deliveryPath: 'mse_hls',
        });

        expect(plan.method).toBe('full_transcode');
        expect(plan.video_action).toBe('transcode');
        expect(plan.target_video_codec).toBe('h264');
        expect(plan.playback_branch).toBe('full_transcode');
        expect(plan.hls_audio_mode).toBe('muxed');

        const engine = new TranscodeDecisionEngine();
        const decision = await engine.consumePlan(plan, makeMediaSource(mediaInfo));

        expect(decision.videoAction).toBe('transcode');
        expect(decision.targetCodec?.video).toBeDefined();
        expect(decision.mode).toBe('full');
    });

    it('HDR10 with tonemapping: DV source, no DV support → needs_tonemapping', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({ videoCodec: 'hevc', hdr: 'dovi' });
        const caps = makeCaps({ videoCodecs: new Set(['h264', 'hevc']) });

        const { plan } = await planner.createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo,
            caps,
            serverEncode: makeServerEncode(),
            deliveryPath: 'mse_hls',
        });

        expect(plan.needs_tonemapping).toBe(true);
        expect(plan.method).toBe('full_transcode');

        const engine = new TranscodeDecisionEngine();
        const decision = await engine.consumePlan(plan, makeMediaSource(mediaInfo));

        expect(decision.needsTonemapping).toBe(true);
        expect(decision.outputVideoRange).toBe('SDR');
    });

    it('preview constraints: intent=preview → forced full_transcode/h264', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo();
        const caps = makeCaps();

        const { plan } = await planner.createPlan({
            intent: 'preview',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo,
            caps,
            serverEncode: makeServerEncode(),
            deliveryPath: 'mse_hls',
        });

        expect(plan.method).toBe('full_transcode');
        expect(plan.video_action).toBe('transcode');
        expect(plan.audio_action).toBe('transcode');
        expect(plan.target_video_codec).toBe('h264');

        const engine = new TranscodeDecisionEngine();
        const decision = await engine.consumePlan(plan, makeMediaSource(mediaInfo));

        expect(decision.videoAction).toBe('transcode');
        expect(decision.audioAction).toBe('transcode');
        expect(decision.targetCodec?.video).toBeDefined();
    });

    it.each(['direct', 'remux', 'audio_transcode'] as const)(
        'requested %s cannot downgrade required video conversion',
        async (requestedMethod) => {
            const { plan } = await new PlaybackPlannerService().createPlan({
                ...makeParams({
                    mediaInfo: makeMediaInfo({ videoCodec: 'vp9' }),
                    caps: makeCaps({ videoCodecs: new Set(['h264']) }),
                }),
                requestedMethod,
            });
            expect(plan.method).toBe('full_transcode');
            expect(plan.video_action).toBe('transcode');
        },
    );
    it('an override is planned with the client-supported target codec', async () => {
        const { plan } = await new PlaybackPlannerService().createPlan({
            ...makeParams({
                mediaInfo: makeMediaInfo({ videoCodec: 'hevc', width: 1920 }),
                caps: makeCaps({ videoCodecs: new Set(['hevc']) }),
            }),
            requestedMethod: 'full_transcode',
        });
        expect(plan.method).toBe('full_transcode');
        expect(plan.target_video_codec).toBe('hevc');
        expect(plan.transcode_reason_codes).toContainEqual({ code: 'client_requested' });
    });

    it('audio_only remains an explicit conversion choice even when video would need encoding', async () => {
        const { plan } = await new PlaybackPlannerService().createPlan({
            ...makeParams({
                mediaInfo: makeMediaInfo({ videoCodec: 'vp9' }),
                caps: makeCaps({ videoCodecs: new Set(['h264']) }),
            }),
            requestedMethod: 'audio_only',
        });
        expect(plan.method).toBe('audio_only');
        expect(plan.audio_action).toBe('transcode');
        expect(plan.hls_audio_mode).toBe('muxed');
        expect(plan.transcode_reason_codes).toContainEqual({ code: 'client_requested' });
    });

    it('an upgrade changes the stored plan consumed by the executor, including burn-in', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo();
        const { plan } = await planner.createPlan({
            ...makeParams({ mediaInfo }),
            deliveryPath: 'direct_file',
        });
        vi.spyOn(planner, 'getPlan').mockResolvedValue(plan);
        await planner.upgradePlan('plan-id', 'full_transcode', true);
        expect(plan).toMatchObject({
            method: 'full_transcode',
            video_action: 'transcode',
            audio_action: 'transcode',
            subtitle_method: 'burn_in',
            delivery_path: 'native_hls',
            playback_branch: 'full_transcode',
        });
        const decision = await new TranscodeDecisionEngine().consumePlan(
            plan,
            makeMediaSource(mediaInfo),
        );
        expect(decision.videoAction).toBe('transcode');
        expect(decision.audioAction).toBe('transcode');
    });

    it('plan expiration: getPlan returns null when plan is gone → fallback', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo();
        const caps = makeCaps();

        await planner.createPlan({
            intent: 'play',
            fileId: 'test-uuid-0000-0000-000000000001',
            mediaInfo,
            caps,
            serverEncode: makeServerEncode(),
            deliveryPath: 'direct_file',
        });

        // Simulate Valkey returning null (expired)
        mockGetValkeyClient.mockReturnValue({
            get: vi.fn().mockResolvedValue(null),
        });

        const retrieved = await planner.getPlan('test-uuid-0000-0000-000000000001');
        expect(retrieved).toBeNull();
    });

    it('10-bit H.264 → full_transcode (Hi10P never decodable)', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({
            videoCodec: 'h264',
            videoBitDepth: 10,
            container: 'mkv',
            audioCodecs: ['aac'],
            audioTrackCount: 1,
        });

        const { plan } = await planner.createPlan(makeParams({ mediaInfo }));

        expect(plan.method).toBe('full_transcode');
        expect(plan.video_action).toBe('transcode');
        expect(plan.transcode_reasons).toEqual(
            expect.arrayContaining([expect.stringContaining('10-bit H.264')]),
        );
    });

    it('multi-audio aac+dts → remux (aac compatible, dts not)', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({
            videoCodec: 'h264',
            container: 'mkv',
            audioCodecs: ['aac', 'dts'],
            audioTrackCount: 2,
        });

        const { plan } = await planner.createPlan(
            makeParams({
                mediaInfo,
                caps: makeCaps({
                    audioCodecs: new Set(['aac', 'opus']),
                    hlsAudioCodecs: new Set(['aac']),
                    canSwitchAudioInDirectPlay: false,
                }),
            }),
        );

        // dts incompatible but aac works via HLS → remux
        expect(plan.method).toBe('remux');
        expect(plan.video_action).toBe('copy');
        expect(plan.audio_action).toBe('copy');
    });

    it('all audio incompatible (dts + truehd) → audio_transcode', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({
            videoCodec: 'h264',
            container: 'mp4',
            audioCodecs: ['dts', 'truehd'],
            audioTrackCount: 2,
        });

        const { plan } = await planner.createPlan(
            makeParams({
                mediaInfo,
                caps: makeCaps({ audioCodecs: new Set(['aac', 'opus']) }),
            }),
        );

        expect(plan.method).toBe('audio_transcode');
        expect(plan.audio_action).toBe('transcode');
        expect(plan.target_audio_codec).toBe('aac');
    });

    it('HDR10 preservation: video copy preserves HDR metadata', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({
            videoCodec: 'hevc',
            hdr: 'hdr10',
            container: 'mkv',
            audioCodecs: ['eac3'],
            audioTrackCount: 1,
        });

        const { plan } = await planner.createPlan(
            makeParams({
                mediaInfo,
                caps: makeCaps({
                    videoCodecs: new Set(['hevc', 'h264']),
                    hdrFormats: new Set(['hdr10']),
                }),
                enableHdrPreservation: true,
            }),
        );

        // Video compatible → copy (not transcode), HDR preserved by nature
        expect(plan.video_action).toBe('copy');
        expect(plan.output_hdr).toBe('hdr10');
        expect(plan.needs_tonemapping).toBe(false);
    });

    it('DolbyVision Profile 8 (dovi_hdr10) → tonemap when caps lack dovi even with hdr10', async () => {
        // MSE decoders choke on DV-tagged HEVC; devices must advertise `dovi` to
        // avoid re-encode.
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({
            videoCodec: 'hevc',
            hdr: 'dovi_hdr10',
            container: 'mp4',
            audioCodecs: ['eac3'],
            audioTrackCount: 1,
        });

        const { plan } = await planner.createPlan(
            makeParams({
                mediaInfo,
                caps: makeCaps({
                    videoCodecs: new Set(['hevc']),
                    audioCodecs: new Set(['aac', 'opus', 'eac3']),
                    containers: new Set(['mp4']),
                    hdrFormats: new Set(['hdr10']),
                }),
                deliveryPath: 'direct_file',
            }),
        );

        expect(plan.needs_tonemapping).toBe(true);
        expect(plan.method).toBe('full_transcode');
    });

    it('DolbyVision Profile 8 (dovi_hdr10) → direct when caps advertise dovi', async () => {
        const planner = new PlaybackPlannerService();
        const mediaInfo = makeMediaInfo({
            videoCodec: 'hevc',
            hdr: 'dovi_hdr10',
            container: 'mp4',
            audioCodecs: ['eac3'],
            audioTrackCount: 1,
        });

        const { plan } = await planner.createPlan(
            makeParams({
                mediaInfo,
                caps: makeCaps({
                    videoCodecs: new Set(['hevc']),
                    audioCodecs: new Set(['aac', 'opus', 'eac3']),
                    containers: new Set(['mp4']),
                    hdrFormats: new Set(['hdr10', 'dovi']),
                }),
                deliveryPath: 'direct_file',
            }),
        );

        expect(plan.needs_tonemapping).toBe(false);
        expect(plan.method).toBe('direct');
        expect(plan.video_action).toBe('copy');
    });

    it('video level exceeded triggers full_transcode despite codec support', async () => {
        mockGetBestEncoder.mockResolvedValue('libx264');
        const planner = new PlaybackPlannerService();

        const mediaInfo = makeMediaInfo({
            videoCodec: 'h264',
            videoLevel: 52,
            container: 'mp4',
            audioCodecs: ['aac'],
            audioTrackCount: 1,
        });

        const { plan } = await planner.createPlan(
            makeParams({
                mediaInfo,
                caps: makeCaps({
                    codecConstraints: { h264: { maxLevel: 51 } },
                }),
            }),
        );

        expect(plan.method).toBe('full_transcode');
        expect(plan.video_action).toBe('transcode');
        expect(plan.transcode_reasons).toEqual(
            expect.arrayContaining([expect.stringContaining('level')]),
        );
    });
});
