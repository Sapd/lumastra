// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    MediaInfo,
    DeviceCapabilities,
    ServerEncodeCaps,
} from '$lib/server/utils/media-compatibility.js';
import type {
    CreatePlanParams,
    PlaybackPlannerService as PlaybackPlannerServiceType,
} from './playback-planner.service.js';

// Mock valkey
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

// Mock hardware detection
const mockGetBestEncoder = vi
    .fn<(codec: 'h264' | 'hevc' | 'av1') => Promise<string | null>>()
    .mockResolvedValue(null);
const mockGetBestDecoder = vi
    .fn<(codec: string, is10Bit?: boolean) => Promise<string | null>>()
    .mockResolvedValue(null);

vi.mock('$lib/server/services/transcoding/hardware-detection.js', () => ({
    hardwareDetection: {
        getBestEncoder: (...args: ['h264' | 'hevc' | 'av1']) => mockGetBestEncoder(...args),
        getBestDecoder: (...args: [string, boolean?]) => mockGetBestDecoder(...args),
    },
}));

// Mock crypto for deterministic UUIDs
vi.mock('crypto', async (importOriginal) => ({
    ...(await importOriginal<typeof import('crypto')>()),
    randomUUID: vi.fn(() => 'test-uuid-0000-0000-000000000001'),
}));

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
        videoCodecs: new Set(['h264', 'hevc']),
        audioCodecs: new Set(['aac', 'opus']),
        containers: new Set(['mp4', 'webm']),
        canSwitchAudioInDirectPlay: true,
        ...overrides,
    };
}

function makeServerEncode(overrides: Partial<ServerEncodeCaps> = {}): ServerEncodeCaps {
    return {
        canEncodeCodec: () => true,
        canEfficientlyEncodeCodec: () => false,
        ...overrides,
    };
}

function makeParams(overrides: Partial<CreatePlanParams> = {}): CreatePlanParams {
    return {
        intent: 'play',
        fileId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        mediaInfo: makeMediaInfo(),
        caps: makeCaps(),
        serverEncode: makeServerEncode(),
        deliveryPath: 'native_hls',
        ...overrides,
    };
}

describe('PlaybackPlannerService', () => {
    let playbackPlanner: InstanceType<typeof PlaybackPlannerServiceType>;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockSetEx.mockResolvedValue(true);
        mockGetValkeyClient.mockReturnValue(null);
        mockGetBestEncoder.mockResolvedValue(null);
        mockGetBestDecoder.mockResolvedValue(null);

        // Re-import to get fresh singleton
        const mod = await import('./playback-planner.service.js');
        playbackPlanner = mod.playbackPlanner;
    });

    describe('createPlan', () => {
        it('should create a direct play plan for compatible h264/mp4/aac', async () => {
            const result = await playbackPlanner.createPlan(makeParams());
            const { plan } = result;

            expect(plan.method).toBe('remux');
            expect(plan.video_action).toBe('copy');
            expect(plan.audio_action).toBe('copy');
            expect(plan.target_video_codec).toBeUndefined();
            expect(plan.target_audio_codec).toBeUndefined();
            expect(plan.transcode_reason_codes).toContainEqual({ code: 'container_incompatible' });
            expect(plan.intent).toBe('play');
            expect(plan.delivery_path).toBe('native_hls');
            expect(plan.playback_branch).toBe('native_hls_multi_audio');
            expect(plan.hls_audio_mode).toBe('muxed');
            expect(plan.needs_tonemapping).toBe(false);
            expect(plan.output_hdr).toBe('sdr');
        });

        it('should create a remux plan for h264/mkv/aac (incompatible container)', async () => {
            const result = await playbackPlanner.createPlan(
                makeParams({
                    deliveryPath: 'mse_hls',
                    mediaInfo: makeMediaInfo({ container: 'matroska,webm' }),
                    caps: makeCaps({ containers: new Set(['mp4']) }),
                }),
            );
            const { plan } = result;

            expect(plan.method).toBe('remux');
            expect(plan.video_action).toBe('copy');
            expect(plan.audio_action).toBe('copy');
            expect(plan.playback_branch).toBe('web_hls_single_audio');
            expect(plan.hls_audio_mode).toBe('muxed');
            expect(plan.target_video_codec).toBeUndefined();
            expect(plan.target_audio_codec).toBeUndefined();
            expect(plan.transcode_reasons.length).toBeGreaterThan(0);
        });

        it('should create an audio transcode plan for h264/mp4/truehd', async () => {
            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({
                        audioCodecs: ['truehd'],
                        audioTrackCount: 1,
                    }),
                }),
            );
            const { plan } = result;

            expect(plan.method).toBe('audio_transcode');
            expect(plan.video_action).toBe('copy');
            expect(plan.audio_action).toBe('transcode');
            expect(plan.playback_branch).toBe('native_hls_multi_audio');
            expect(plan.hls_audio_mode).toBe('muxed');
            expect(plan.target_audio_codec).toBe('aac');
            expect(plan.target_video_codec).toBeUndefined();
        });

        it('should create a full transcode plan for incompatible video codec', async () => {
            mockGetBestEncoder.mockResolvedValue('libx264');

            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({ videoCodec: 'vp9' }),
                    caps: makeCaps({ videoCodecs: new Set(['h264']) }),
                }),
            );
            const { plan } = result;

            expect(plan.method).toBe('full_transcode');
            expect(plan.video_action).toBe('transcode');
            expect(plan.audio_action).toBe('transcode');
            expect(plan.playback_branch).toBe('full_transcode');
            expect(plan.hls_audio_mode).toBe('demux');
            expect(plan.target_video_codec).toBe('h264');
            expect(plan.target_audio_codec).toBe('aac');
        });

        it('should force muxed HLS audio for MSE full transcode plans', async () => {
            mockGetBestEncoder.mockResolvedValue('libx264');

            const result = await playbackPlanner.createPlan(
                makeParams({
                    deliveryPath: 'mse_hls',
                    mediaInfo: makeMediaInfo({ videoCodec: 'vp9' }),
                    caps: makeCaps({ videoCodecs: new Set(['h264']) }),
                }),
            );
            const { plan } = result;

            expect(plan.method).toBe('full_transcode');
            expect(plan.playback_branch).toBe('full_transcode');
            expect(plan.hls_audio_mode).toBe('muxed');
        });

        it('should force full_transcode for preview intent regardless of compatibility', async () => {
            mockGetBestEncoder.mockResolvedValue('libx264');

            const result = await playbackPlanner.createPlan(makeParams({ intent: 'preview' }));
            const { plan } = result;

            expect(plan.method).toBe('full_transcode');
            expect(plan.video_action).toBe('transcode');
            expect(plan.audio_action).toBe('transcode');
            expect(plan.target_video_codec).toBe('h264');
            expect(plan.target_audio_codec).toBe('aac');
            expect(plan.transcode_reasons).toEqual(['Preview mode: forced transcode to H.264']);
        });

        it('should store plan in Valkey via setEx', async () => {
            await playbackPlanner.createPlan(makeParams());

            expect(mockSetEx).toHaveBeenCalledTimes(1);
            const [key, ttl, value] = mockSetEx.mock.calls[0];
            expect(key).toMatch(/^v1:playback-plan:/);
            expect(ttl).toBe(1800);
            const stored = JSON.parse(value);
            expect(stored.plan_id).toBeDefined();
            expect(stored.method).toBe('remux');
            expect(stored.playback_branch).toBe('native_hls_multi_audio');
            expect(stored.hls_audio_mode).toBe('muxed');
        });

        it('should resolve GPU encoder when transcoding', async () => {
            mockGetBestEncoder.mockResolvedValue('h264_nvenc');
            mockGetBestDecoder.mockResolvedValue('h264_cuvid');

            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({ videoCodec: 'vp9' }),
                    caps: makeCaps({ videoCodecs: new Set(['h264']) }),
                }),
            );

            expect(result.plan.gpu_encoder).toBe('h264_nvenc');
            expect(result.plan.gpu_decoder).toBe('h264_cuvid');
            expect(mockGetBestEncoder).toHaveBeenCalledWith('h264');
            expect(mockGetBestDecoder).toHaveBeenCalledWith('vp9');
        });

        // HDR edge cases
        it('should output SDR when source is HDR10 and enableHdrPreservation is false', async () => {
            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({
                        hdr: 'hdr10',
                        videoCodec: 'hevc',
                    }),
                    caps: makeCaps({
                        videoCodecs: new Set(['hevc']),
                        hdrFormats: new Set(['hdr10']),
                    }),
                    enableHdrPreservation: false,
                }),
            );
            // Video is direct-playable (hevc supported) but HDR preservation is off
            // However, method is 'direct' so video is copied — HDR is preserved by nature
            expect(result.plan.output_hdr).toBe('hdr10');
            expect(result.plan.needs_tonemapping).toBe(false);
        });

        it('should preserve HDR10 when enableHdrPreservation is true and device supports it', async () => {
            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({
                        hdr: 'hdr10',
                        videoCodec: 'hevc',
                    }),
                    caps: makeCaps({
                        videoCodecs: new Set(['hevc']),
                        hdrFormats: new Set(['hdr10']),
                    }),
                    enableHdrPreservation: true,
                }),
            );
            expect(result.plan.output_hdr).toBe('hdr10');
            expect(result.plan.needs_tonemapping).toBe(false);
            expect(result.plan.method).toBe('remux');
        });

        it('should tonemap DolbyVision to SDR when device lacks DV support', async () => {
            mockGetBestEncoder.mockResolvedValue('libx264');

            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({
                        hdr: 'dovi',
                        videoCodec: 'hevc',
                    }),
                    caps: makeCaps({
                        videoCodecs: new Set(['h264', 'hevc']),
                        hdrFormats: new Set(['hdr10']), // No 'dovi'
                    }),
                }),
            );
            expect(result.plan.needs_tonemapping).toBe(true);
            expect(result.plan.output_hdr).toBe('sdr');
            expect(result.plan.method).toBe('full_transcode');
            expect(result.plan.video_action).toBe('transcode');
        });

        it('tonemaps HDR10 to SDR when the only transcode target is h264 (h264 cannot carry HDR)', async () => {
            // Regression: an HDR10 HEVC source + an h264-only client forces a full
            // transcode to h264. h264 cannot carry HDR10, so even though the device
            // advertises HDR10 display (compat.needsTonemapping=false), we MUST
            // tonemap — otherwise 10-bit HDR frames hit the 8-bit h264 encoder and
            // it fails to open (VA-API -38). HEVC/AV1 targets still preserve HDR.
            mockGetBestEncoder.mockResolvedValue('h264_vaapi');
            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({ hdr: 'hdr10', videoCodec: 'hevc' }),
                    caps: makeCaps({
                        videoCodecs: new Set(['h264']), // client cannot play HEVC → transcode to h264
                        hdrFormats: new Set(['hdr10']), // client claims it can display HDR10
                    }),
                    enableHdrPreservation: true,
                }),
            );
            expect(result.plan.method).toBe('full_transcode');
            expect(result.plan.target_video_codec).toBe('h264');
            expect(result.plan.needs_tonemapping).toBe(true);
            expect(result.plan.output_hdr).toBe('sdr');
        });

        it('should tonemap DolbyVision Profile 8 (dovi_hdr10) when device lacks DV support', async () => {
            // Chrome/Firefox/Edge reject the DV-tagged HEVC bitstream on MSE
            // (bufferAddCodecError) even when they advertise HDR10, so we must
            // re-encode to a clean HDR10/SDR stream.
            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({
                        hdr: 'dovi_hdr10',
                        videoCodec: 'hevc',
                    }),
                    caps: makeCaps({
                        videoCodecs: new Set(['hevc']),
                        hdrFormats: new Set(['hdr10']), // No 'dovi' but has hdr10
                    }),
                }),
            );
            expect(result.plan.needs_tonemapping).toBe(true);
            expect(result.plan.method).toBe('full_transcode');
        });

        it('should NOT tonemap DolbyVision Profile 8 (dovi_hdr10) when device advertises DV support', async () => {
            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({
                        hdr: 'dovi_hdr10',
                        videoCodec: 'hevc',
                    }),
                    caps: makeCaps({
                        videoCodecs: new Set(['hevc']),
                        hdrFormats: new Set(['hdr10', 'dovi']),
                    }),
                }),
            );
            expect(result.plan.needs_tonemapping).toBe(false);
            expect(result.plan.method).toBe('remux');
        });

        it('should output SDR for full_transcode when HDR preservation is enabled but tonemapping needed', async () => {
            mockGetBestEncoder.mockResolvedValue('libx264');

            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({
                        hdr: 'dovi',
                        videoCodec: 'hevc',
                    }),
                    caps: makeCaps({
                        videoCodecs: new Set(['h264']),
                        hdrFormats: new Set(), // No HDR support at all
                    }),
                    enableHdrPreservation: true, // Enabled but tonemapping overrides
                }),
            );
            expect(result.plan.needs_tonemapping).toBe(true);
            expect(result.plan.output_hdr).toBe('sdr');
            expect(result.plan.method).toBe('full_transcode');
        });

        // Multi-audio track scenarios
        it('should remux for mixed multi-audio (aac + dts + truehd) — aac is compatible', async () => {
            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({
                        audioCodecs: ['aac', 'dts', 'truehd'],
                        audioTrackCount: 3,
                    }),
                    caps: makeCaps({ canSwitchAudioInDirectPlay: false }),
                }),
            );
            // Multi-audio + can't switch → needs HLS. aac is compatible → remux (not audio_transcode)
            expect(result.plan.method).toBe('remux');
            expect(result.plan.video_action).toBe('copy');
            expect(result.plan.audio_action).toBe('copy');
        });

        it('should audio_transcode when ALL audio tracks are incompatible', async () => {
            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({
                        audioCodecs: ['dts', 'truehd'],
                        audioTrackCount: 2,
                    }),
                    caps: makeCaps({ audioCodecs: new Set(['aac']) }),
                }),
            );
            expect(result.plan.method).toBe('audio_transcode');
            expect(result.plan.audio_action).toBe('transcode');
            expect(result.plan.target_audio_codec).toBe('aac');
        });

        it('should force HLS for multi-audio when canSwitchAudioInDirectPlay is false', async () => {
            const result = await playbackPlanner.createPlan(
                makeParams({
                    deliveryPath: 'direct_file',
                    mediaInfo: makeMediaInfo({
                        audioCodecs: ['aac', 'aac'],
                        audioTrackCount: 2,
                    }),
                    caps: makeCaps({ canSwitchAudioInDirectPlay: false }),
                }),
            );
            // Multi-audio + no switching → remux (not direct)
            expect(result.plan.method).toBe('remux');
        });

        // 10-bit H.264
        it('should full_transcode for 10-bit H.264 despite h264 in caps', async () => {
            mockGetBestEncoder.mockResolvedValue('libx264');

            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({
                        videoCodec: 'h264',
                        videoBitDepth: 10,
                    }),
                }),
            );
            expect(result.plan.method).toBe('full_transcode');
            expect(result.plan.video_action).toBe('transcode');
            expect(result.plan.transcode_reasons).toEqual(
                expect.arrayContaining([expect.stringContaining('10-bit H.264')]),
            );
        });

        // GPU fallback chain
        it('should fall back to h264 when server cannot encode selected codec', async () => {
            mockGetBestEncoder.mockResolvedValue('libx264');

            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({ videoCodec: 'mpeg2video' }),
                    caps: makeCaps({
                        videoCodecs: new Set(['av1', 'hevc', 'h264']),
                    }),
                    serverEncode: makeServerEncode({
                        canEncodeCodec: (codec) => codec === 'h264', // Only h264
                        canEfficientlyEncodeCodec: () => false,
                    }),
                }),
            );
            expect(result.plan.target_video_codec).toBe('h264');
            expect(result.plan.method).toBe('full_transcode');
        });

        it('should prefer GPU-efficient codec over CPU-only higher priority codec', async () => {
            mockGetBestEncoder.mockResolvedValue('hevc_nvenc');

            const result = await playbackPlanner.createPlan(
                makeParams({
                    mediaInfo: makeMediaInfo({ videoCodec: 'mpeg2video' }),
                    caps: makeCaps({
                        videoCodecs: new Set(['av1', 'hevc', 'h264']),
                    }),
                    serverEncode: makeServerEncode({
                        canEncodeCodec: () => true,
                        canEfficientlyEncodeCodec: (codec) => codec === 'hevc', // GPU for hevc only
                    }),
                }),
            );
            // Prefers hevc (GPU-efficient) over av1 (CPU-only)
            expect(result.plan.target_video_codec).toBe('hevc');
        });
    });

    describe('getPlan', () => {
        it('should return null when Valkey client is unavailable', async () => {
            mockGetValkeyClient.mockReturnValue(null);
            const result = await playbackPlanner.getPlan('non-existent-id');
            expect(result).toBeNull();
        });

        it('should return null when plan key does not exist', async () => {
            mockGetValkeyClient.mockReturnValue({
                get: vi.fn().mockResolvedValue(null),
            });

            const result = await playbackPlanner.getPlan('non-existent-id');
            expect(result).toBeNull();
        });

        it('should parse and return stored plan', async () => {
            const storedPlan = {
                plan_id: 'a0000000-0000-4000-a000-000000000001',
                intent: 'play',
                delivery_path: 'native_hls',
                method: 'direct',
                video_action: 'copy',
                audio_action: 'copy',
                subtitle_method: 'none',
                transcode_reasons: [],
                needs_tonemapping: false,
                file_id: 'b0000000-0000-4000-a000-000000000001',
                created_at: '2026-01-01T00:00:00.000Z',
                expires_at: '2026-01-01T01:00:00.000Z',
            };
            mockGetValkeyClient.mockReturnValue({
                get: vi.fn().mockResolvedValue(JSON.stringify(storedPlan)),
            });

            const result = await playbackPlanner.getPlan('a0000000-0000-4000-a000-000000000001');
            expect(result).toEqual(storedPlan);
        });
    });

    describe('refreshPlan', () => {
        it('should call expire with the correct key and TTL', async () => {
            mockExpire.mockResolvedValue(true);

            const result = await playbackPlanner.refreshPlan('plan-123');
            expect(result).toBe(true);
            expect(mockExpire).toHaveBeenCalledWith('v1:playback-plan:plan-123', 1800);
        });
    });
});

describe('PlaybackPlannerService — records the quality cap it evaluated', () => {
    // The HLS job trusts the plan for any cap the plan was built against
    // (qualityCapForcesTranscode: the planner is authoritative), so the plan
    // must say which cap that was.
    let playbackPlanner: InstanceType<typeof PlaybackPlannerServiceType>;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockSetEx.mockResolvedValue(true);
        mockGetValkeyClient.mockReturnValue(null);
        mockGetBestEncoder.mockResolvedValue(null);
        mockGetBestDecoder.mockResolvedValue(null);
        playbackPlanner = (await import('./playback-planner.service.js')).playbackPlanner;
    });

    it('stores the user-selected cap on the plan', async () => {
        const { plan } = await playbackPlanner.createPlan(
            makeParams({
                caps: makeCaps({ userSelectedMaxBitrate: 10_000_000, userSelectedMaxHeight: 1080 }),
            }),
        );
        expect(plan.quality_cap).toEqual({ max_bitrate: 10_000_000, max_height: 1080 });
    });

    it('stores a bitrate-only cap without inventing a height', async () => {
        const { plan } = await playbackPlanner.createPlan(
            makeParams({ caps: makeCaps({ userSelectedMaxBitrate: 4_000_000 }) }),
        );
        expect(plan.quality_cap).toEqual({ max_bitrate: 4_000_000 });
    });

    it('omits quality_cap for a plan built without one', async () => {
        const { plan } = await playbackPlanner.createPlan(makeParams());
        expect(plan.quality_cap).toBeUndefined();
    });
});

describe('PlaybackPlannerService — records the client HDR formats', () => {
    let playbackPlanner: InstanceType<typeof PlaybackPlannerServiceType>;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockSetEx.mockResolvedValue(true);
        mockGetValkeyClient.mockReturnValue(null);
        mockGetBestEncoder.mockResolvedValue(null);
        mockGetBestDecoder.mockResolvedValue(null);
        playbackPlanner = (await import('./playback-planner.service.js')).playbackPlanner;
    });

    it('stores the formats the client advertised (including an SDR-only empty set)', async () => {
        const hdr = await playbackPlanner.createPlan(
            makeParams({ caps: makeCaps({ hdrFormats: new Set(['hdr10', 'hlg']) }) }),
        );
        expect(hdr.plan.client_hdr_formats).toEqual(['hdr10', 'hlg']);

        const sdr = await playbackPlanner.createPlan(
            makeParams({ caps: makeCaps({ hdrFormats: new Set() }) }),
        );
        expect(sdr.plan.client_hdr_formats).toEqual([]);
    });

    it('omits it when the client sent no HDR capabilities', async () => {
        const { plan } = await playbackPlanner.createPlan(makeParams());
        expect(plan.client_hdr_formats).toBeUndefined();
    });
});
