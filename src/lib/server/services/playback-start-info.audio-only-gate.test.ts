// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `play_methods.audio_only.available` must reflect whether the SOURCE actually
 * has an audio stream.
 *
 * The audio-only rung runs FFmpeg with `-vn`. On a source with zero audio
 * streams that maps nothing at all: no rendition is written, no playlist ever
 * appears, and every segment request 503s until the client gives up. Unlike
 * every other rung there is nothing to degrade to — so the rung must not be
 * offered in the first place.
 *
 * These tests drive the real `buildPlaybackStartInfo` with only its I/O boundaries
 * (DB, ffprobe, planner, hardware detection) stubbed, so they exercise the
 * actual `play_methods` construction.
 *
 * What they prove:
 *  - the gate is attached to `audio_only` specifically, not to `hlsAvailable`
 *    globally — `remux`/`audio_transcode`/`full_transcode` stay available on
 *    the very same video-only source (a blanket gate would fail this).
 *  - the gate is not vacuous — the SAME fixture with one audio stream added
 *    flips `audio_only.available` back to true, so a hardcoded `false` fails.
 *  - the gate composes with `hlsAvailable` — with ffmpeg absent, audio streams
 *    present or not, the rung is unavailable.
 *
 * What they do NOT prove: that the client honours `available: false` (that is
 * `audio-only-selection.test.ts`), or that FFmpeg really writes nothing for a
 * silent source (that is the ffmpeg smoke test).
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
    getExternalSubtitlesForFile: vi.fn(async () => []),
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
import type { UserId } from '$lib/shared/user-id.js';

const AUDIO_STREAM = {
    audioRelativeIndex: 0,
    absoluteIndex: 1,
    codec: 'aac',
    channels: 2,
    language: 'eng',
    title: null,
    isDefault: true,
};

// One fixture, one knob. Everything except the audio stream list is identical
// between the two runs, so a difference in the result can only come from the
// audio stream count.
function probeResult(audioStreams: unknown[]) {
    return {
        success: true,
        duration: 600,
        formatBitrate: 4_000_000,
        video: {
            codec: 'h264',
            width: 1920,
            height: 1080,
            bitrate: 4_000_000,
            hdr: 'sdr',
            pixelFormat: 'yuv420p',
            profile: 'High',
            level: 40,
        },
        audioStreams,
        subtitleStreams: [],
    };
}

async function playMethodsFor(audioStreams: unknown[]) {
    mockProbe.probeMediaFile.mockResolvedValue(probeResult(audioStreams));
    const result = await buildPlaybackStartInfo({
        sql: {} as never,
        userId: 'user-1' as UserId,
        internalId: 'media-1',
    });
    if (!result.ok) throw new Error(`buildPlaybackStartInfo failed: ${result.message}`);
    return result.data.play_methods;
}

describe('play_methods.audio_only availability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFeatures.ffmpegAvailable = true;
    });

    it('is unavailable when the source has no audio stream at all', async () => {
        const methods = await playMethodsFor([]);

        expect(methods.audio_only?.available).toBe(false);
    });

    it('leaves the other HLS rungs available on that same video-only source', async () => {
        // Guards against "fix" the gate by turning hlsAvailable off wholesale:
        // a video-only file is still perfectly remuxable/transcodable.
        const methods = await playMethodsFor([]);

        expect(methods.remux.available).toBe(true);
        expect(methods.audio_transcode.available).toBe(true);
        expect(methods.full_transcode.available).toBe(true);
    });

    it('is available again once the same source has one audio stream', async () => {
        // Guards against a hardcoded `available: false`.
        const methods = await playMethodsFor([AUDIO_STREAM]);

        expect(methods.audio_only?.available).toBe(true);
    });

    it('stays unavailable when ffmpeg is missing, even with audio streams present', async () => {
        mockFeatures.ffmpegAvailable = false;

        const methods = await playMethodsFor([AUDIO_STREAM]);

        expect(methods.audio_only?.available).toBe(false);
    });
});
