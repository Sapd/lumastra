// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A play-session start must start a finished item from the beginning.
 *
 * Reverse-proxy e2e 2026-10-06: a movie watched to the end kept
 * `resume_position_ms` 420059 of a 420021 ms file (`is_watched=true`). Handed out
 * as-is it started HLS past the last segment and wedged the player. Asserted on
 * `resume_position_ms` as the endpoint returns it — the field every client
 * starts from. Harness: the real `buildPlaybackStartInfo`, only I/O stubbed (same as
 * playback-start-info.play-method-caps.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getMediaItemById: vi.fn(),
    getFilesForMediaItem: vi.fn(),
    getFileSiblingEpisodes: vi.fn(),
    resolveEffectiveResume: vi.fn(),
    probeMediaFile: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({
    features: { ffmpegAvailable: true },
    config: { ENABLE_HDR10_PRESERVATION: false },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemById: mocks.getMediaItemById,
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: mocks.getFilesForMediaItem,
}));

vi.mock('$lib/server/database/queries/external-subtitles.queries.js', () => ({
    getExternalSubtitlesForFile: vi.fn(async () => []),
}));

vi.mock('$lib/server/database/queries/episode-search.queries.js', () => ({
    getFileSiblingEpisodes: mocks.getFileSiblingEpisodes,
}));

vi.mock('$lib/server/services/effective-playback.js', () => ({
    resolveEffectiveResume: mocks.resolveEffectiveResume,
}));

vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn(async () => ({ isAccessible: true, containerPath: '/media/x.mkv' })),
}));

vi.mock('$lib/server/utils/ffprobe.js', () => ({
    probeMediaFile: mocks.probeMediaFile,
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

function probe(durationSeconds: number | null): unknown {
    return {
        success: true,
        duration: durationSeconds ?? undefined,
        formatBitrate: 5_000_000,
        video: {
            codec: 'h264',
            width: 1280,
            height: 720,
            bitrate: 5_000_000,
            hdr: 'sdr',
            pixelFormat: 'yuv420p',
            profile: 'High',
            level: 41,
        },
        audioStreams: [
            {
                audioRelativeIndex: 0,
                absoluteIndex: 1,
                codec: 'aac',
                channels: 2,
                language: 'eng',
                title: null,
                isDefault: true,
            },
        ],
        subtitleStreams: [],
    };
}

function resume(positionMs: number, isWatched: boolean): unknown {
    return { positionMs, anchorMs: Date.parse('2026-10-06T10:00:00Z'), isWatched };
}

async function resumePositionMs(): Promise<number> {
    const result = await buildPlaybackStartInfo({
        sql: {} as never,
        userId: 'user-1' as UserId,
        internalId: 'media-1',
    });
    if (!result.ok) throw new Error(`buildPlaybackStartInfo failed: ${result.message}`);
    return result.data.resume_position_ms;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMediaItemById.mockResolvedValue({
        id: 'media-1',
        media_type: 'movie',
        runtime_seconds: 420,
    });
    mocks.getFilesForMediaItem.mockResolvedValue([
        {
            id: 'file-1',
            label: null,
            edition: null,
            file_path: '/media/x.mkv',
            is_default: true,
            duration_seconds: 420.021,
        },
    ]);
    mocks.getFileSiblingEpisodes.mockResolvedValue([]);
    mocks.probeMediaFile.mockResolvedValue(probe(420.021));
});

describe('play-session start resume_position_ms for a finished item', () => {
    it('is 0 for a movie watched to the end (the e2e repro row)', async () => {
        mocks.resolveEffectiveResume.mockResolvedValue(resume(420_059, true));
        expect(await resumePositionMs()).toBe(0);
    });

    it('keeps a mid-movie re-watch resume', async () => {
        mocks.resolveEffectiveResume.mockResolvedValue(resume(210_000, true));
        expect(await resumePositionMs()).toBe(210_000);
    });

    // Catalog says 7 min; the probed file is a 10 min extended cut.
    it('judges against the probed file, not the catalog runtime', async () => {
        mocks.probeMediaFile.mockResolvedValue(probe(600));
        mocks.resolveEffectiveResume.mockResolvedValue(resume(450_000, false));
        expect(await resumePositionMs()).toBe(450_000);
    });

    it('falls back to the scanner-stored duration when the probe has none', async () => {
        mocks.probeMediaFile.mockResolvedValue(probe(null));
        mocks.resolveEffectiveResume.mockResolvedValue(resume(420_059, true));
        expect(await resumePositionMs()).toBe(0);
    });

    // Positions are file-absolute: 692 s is half a minute into episode 25 of a
    // combined file, not 105 % of its 660 s runtime.
    it('keeps a file-absolute resume in a combined multi-episode file', async () => {
        mocks.getMediaItemById.mockResolvedValue({
            id: 'media-1',
            media_type: 'episode',
            runtime_seconds: 660,
        });
        mocks.getFilesForMediaItem.mockResolvedValue([
            {
                id: 'file-1',
                label: null,
                edition: null,
                file_path: '/media/x.mkv',
                is_default: true,
                duration_seconds: 1320,
            },
        ]);
        mocks.getFileSiblingEpisodes.mockResolvedValue([
            {
                id: 'ep-24',
                episode_number: 24,
                title: 'A',
                start_offset_ms: '0',
                end_offset_ms: '660000',
            },
            {
                id: 'media-1',
                episode_number: 25,
                title: 'B',
                start_offset_ms: '660000',
                end_offset_ms: '1320000',
            },
        ]);
        mocks.probeMediaFile.mockResolvedValue(probe(1320));
        mocks.resolveEffectiveResume.mockResolvedValue(resume(692_000, false));
        expect(await resumePositionMs()).toBe(692_000);

        // The end-clamp still uses the whole combined file, not the selected
        // episode's 660 s catalog runtime.
        mocks.resolveEffectiveResume.mockResolvedValue(resume(1_319_000, true));
        expect(await resumePositionMs()).toBe(0);
    });
});
