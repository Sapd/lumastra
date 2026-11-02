// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The HLS play_methods URLs must carry the caps the start was evaluated against.
 *
 * The plan records the quality cap, but the HLS job only trusts it for the
 * copy-vs-transcode call: the encode geometry, bitrate and audio downmix come
 * from `?maxHeight` / `?maxBitrate` / `?maxAudioChannels` on the URL. Before
 * this, the decision reported "1920x1080 exceeds your quality cap (720p)" while the
 * returned full_transcode URL produced a 4K encode with 5.1 audio for any
 * client that used it as-is (GPU hw-transcode test 2026-10-01).
 *
 * Asserted at the seam: the returned URL is parsed with the SAME parsers the
 * HLS route uses, so a renamed param or a dropped rung fails here, not in a
 * string match. Harness: the real `buildPlaybackStartInfo`, only I/O stubbed
 * (same as playback-start-info.audio-only-gate.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFeatures = vi.hoisted(() => ({ ffmpegAvailable: true }));

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
    config: { ENABLE_HDR10_PRESERVATION: false },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemById: vi.fn(async () => ({ id: 'media-1', media_type: 'movie' })),
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: vi.fn(async () => [
        { id: 'file-1', label: null, edition: null, file_path: '/media/x.mkv', is_default: true },
    ]),
}));

vi.mock('$lib/server/database/queries/external-subtitles.queries.js', () => ({
    getExternalSubtitlesForFile: vi.fn(async () => [
        { id: 'sub-1', language: 'en', format: 'srt', is_forced: false, is_sdh: false },
    ]),
}));

vi.mock('$lib/server/database/queries/episode-search.queries.js', () => ({
    getFileSiblingEpisodes: vi.fn(async () => []),
}));

vi.mock('$lib/server/services/effective-playback.js', () => ({
    resolveEffectiveResume: vi.fn(async () => ({
        positionMs: 0,
        anchorMs: null,
        isWatched: false,
    })),
}));

vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn(async () => ({ isAccessible: true, containerPath: '/media/x.mkv' })),
}));

const mockProbe = vi.hoisted(() => ({ probeMediaFile: vi.fn() }));

vi.mock('$lib/server/utils/ffprobe.js', () => ({
    probeMediaFile: mockProbe.probeMediaFile,
    containerFromExtension: () => 'matroska',
}));

vi.mock('$lib/server/services/transcoding/hardware-detection.js', () => ({
    hardwareDetection: { getBestEncoder: vi.fn(async () => 'libx264') },
}));

vi.mock('$lib/server/services/playback-planner.service.js', () => ({
    playbackPlanner: {
        createPlan: vi.fn(async () => ({
            plan: {
                plan_id: 'plan-1',
                method: 'remux',
                delivery_path: 'mse_hls',
                playback_branch: 'hls',
                hls_audio_mode: 'muxed',
                output_hdr: 'sdr',
                transcode_reasons: [],
                transcode_reason_codes: [],
                target_video_codec: null,
                target_audio_codec: null,
            },
        })),
    },
}));

vi.mock('$lib/server/services/trickplay-storage.service.js', () => ({
    getBestTrickplayInfo: vi.fn(async () => undefined),
}));

import { buildPlaybackStartInfo } from './info.service.js';
import { parseQualityCapParams, parseMaxAudioChannelsParam } from './transcoding/quality-cap.js';
import type { DeviceCapabilities } from '$lib/server/utils/media-compatibility.js';
import type { UserId } from '$lib/shared/user-id.js';

const SURROUND_STREAM = {
    audioRelativeIndex: 0,
    absoluteIndex: 1,
    codec: 'eac3',
    channels: 6,
    language: 'eng',
    title: null,
    isDefault: true,
};

const STEREO_CLIENT: DeviceCapabilities = {
    videoCodecs: new Set(['h264']),
    audioCodecs: new Set(['aac']),
    containers: new Set(['mp4']),
    canSwitchAudioInDirectPlay: false,
    maxAudioChannels: 2,
};

mockProbe.probeMediaFile.mockResolvedValue({
    success: true,
    duration: 600,
    formatBitrate: 40_000_000,
    video: {
        codec: 'h264',
        width: 3840,
        height: 2160,
        bitrate: 40_000_000,
        hdr: 'sdr',
        pixelFormat: 'yuv420p',
        profile: 'High',
        level: 51,
    },
    audioStreams: [SURROUND_STREAM],
    subtitleStreams: [],
});

async function playMethods(params: {
    userSelectedMaxHeight?: number;
    userSelectedMaxBitrate?: number;
    clientCaps?: DeviceCapabilities;
    capsSource?: 'caps_param' | 'device_profile';
}) {
    const result = await buildPlaybackStartInfo({
        sql: {} as never,
        userId: 'user-1' as UserId,
        internalId: 'media-1',
        ...params,
    });
    if (!result.ok) throw new Error(`buildPlaybackStartInfo failed: ${result.message}`);
    return Object.fromEntries(
        Object.entries(result.deliveryPaths).map(([method, url]) => [method, { url }]),
    ) as Record<keyof typeof result.deliveryPaths, { url: string }>;
}

/** What the HLS route would read from this URL. */
function routeView(url: string) {
    const search = new URL(url, 'http://x').searchParams;
    return {
        qualityCap: parseQualityCapParams(search),
        maxAudioChannels: parseMaxAudioChannelsParam(search),
        plan: search.get('plan'),
    };
}

describe('Private start paths carry the requested caps', () => {
    beforeEach(() => {
        mockFeatures.ffmpegAvailable = true;
    });

    it.each(['remux', 'audio_transcode', 'full_transcode'] as const)(
        '%s carries maxHeight, maxBitrate and maxAudioChannels',
        async (rung) => {
            const methods = await playMethods({
                userSelectedMaxHeight: 720,
                userSelectedMaxBitrate: 4_000_000,
                clientCaps: STEREO_CLIENT,
            });

            expect(routeView(methods[rung].url)).toEqual({
                qualityCap: { maxHeight: 720, maxBitrate: 4_000_000 },
                maxAudioChannels: 2,
                plan: 'plan-1',
            });
        },
    );

    it('audio_only carries no cap (no video to cap, encode is always stereo)', async () => {
        const methods = await playMethods({
            userSelectedMaxHeight: 720,
            userSelectedMaxBitrate: 4_000_000,
            clientCaps: STEREO_CLIENT,
        });

        expect(routeView(methods.audio_only!.url)).toEqual({
            qualityCap: {},
            maxAudioChannels: undefined,
            plan: 'plan-1',
        });
    });

    it('direct carries no cap — it is the untouched file', async () => {
        const methods = await playMethods({
            userSelectedMaxHeight: 720,
            clientCaps: STEREO_CLIENT,
        });

        expect(methods.direct.url).not.toMatch(/max(Height|Bitrate|AudioChannels)=/);
    });

    it('adds nothing when no cap was requested and the client declared no channel cap', async () => {
        // Comparison for the tests above: the params come from the request,
        // not from something buildPlaybackStartInfo always emits.
        const methods = await playMethods({});

        expect(routeView(methods.full_transcode.url)).toEqual({
            qualityCap: {},
            maxAudioChannels: undefined,
            plan: 'plan-1',
        });
    });

    it('does not bake a channel cap that came from a POSTed DeviceProfile', async () => {
        // A DeviceProfile's AudioChannels is the minimum over ALL its codec
        // profiles — too coarse to force a downmix. Same caps, different source.
        const methods = await playMethods({
            clientCaps: STEREO_CLIENT,
            capsSource: 'device_profile',
        });

        expect(routeView(methods.full_transcode.url).maxAudioChannels).toBeUndefined();
    });

    it('bakes the tighter of the user and device bitrate caps', async () => {
        const methods = await playMethods({
            userSelectedMaxBitrate: 8_000_000,
            clientCaps: { ...STEREO_CLIENT, maxBitrate: 3_000_000 },
        });

        expect(routeView(methods.full_transcode.url).qualityCap).toEqual({
            maxBitrate: 3_000_000,
        });
    });

    it('a client appending the same caps again still resolves to the same caps', async () => {
        const methods = await playMethods({
            userSelectedMaxHeight: 720,
            userSelectedMaxBitrate: 4_000_000,
            clientCaps: STEREO_CLIENT,
        });

        const url = `${methods.full_transcode.url}&maxHeight=720&maxBitrate=4000000&maxAudioChannels=2`;

        expect(routeView(url)).toEqual({
            qualityCap: { maxHeight: 720, maxBitrate: 4_000_000 },
            maxAudioChannels: 2,
            plan: 'plan-1',
        });
    });

    it('a client appending a different cap overrides the baked-in one', async () => {
        const methods = await playMethods({
            userSelectedMaxHeight: 720,
            clientCaps: STEREO_CLIENT,
        });

        expect(routeView(`${methods.full_transcode.url}&maxHeight=1080`).qualityCap).toEqual({
            maxHeight: 1080,
        });
    });
});

describe('playback start decision record', () => {
    it('exposes availability and tracks without private paths or credentials', async () => {
        const result = await buildPlaybackStartInfo({
            sql: {} as never,
            userId: 'user-1' as UserId,
            internalId: 'media-1',
            clientCaps: STEREO_CLIENT,
            capsSource: 'caps_param',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        expect(result.data.versions.length).toBeGreaterThan(0);
        expect(result.data.tracks.audio).toHaveLength(1);
        expect(result.data.externalSubtitles).toEqual([
            { id: 'sub-1', language: 'en', format: 'srt', isForced: false, isSdh: false },
        ]);
        expect(result.data.play_methods.full_transcode).toHaveProperty('available');
        const assertNoDelivery = (value: unknown): void => {
            if (!value || typeof value !== 'object') return;
            for (const [key, child] of Object.entries(value)) {
                expect(key).not.toMatch(
                    /^(url|href|deliveryUrl|deliveryPaths|api_key|stream_token|accessToken)$/,
                );
                assertNoDelivery(child);
            }
        };
        assertNoDelivery(result.data);
    });
});
