// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `recommended_tracks` wiring inside `buildPlaybackStartInfo`.
 *
 * `info.service.recommendation.test.ts` covers `buildTrackRecommendation` in
 * isolation — a pure function, given inputs, producing the right reason
 * codes. It never touches the DB-backed guard around it: the
 * `getPlaybackPreferences.one` / `getMediaItemForWatch` calls, the
 * `if (prefsRow)` gate, and the try/catch that must turn ANY failure there
 * into an absent `recommended_tracks` rather than a broken response or a
 * wrong opinion (see the schema note on why absence, not a guess, is the
 * safe failure mode).
 *
 * These tests drive the real `buildPlaybackStartInfo`, mocking only I/O
 * boundaries, so a narrowed try/catch, a call moved outside it, or a broken
 * `if (prefsRow)` guard shows up here even though it would compile clean and
 * pass `info.service.recommendation.test.ts` unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFeatures = vi.hoisted(() => ({ ffmpegAvailable: true }));

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
    config: { ENABLE_HDR10_PRESERVATION: false },
}));

const mockLogger = vi.hoisted(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => mockLogger },
}));

const mockCatalog = vi.hoisted(() => ({
    getMediaItemById: vi.fn(async () => ({ id: 'media-1', media_type: 'movie' })),
    getMediaItemForWatch: vi.fn(async () => ({ id: 'media-1', original_language: null })),
}));

vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => mockCatalog);

const mockFiles = vi.hoisted(() => ({ getFilesForMediaItem: vi.fn() }));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => mockFiles);

const mockExternalSubtitles = vi.hoisted(() => ({ getExternalSubtitlesForFile: vi.fn() }));
vi.mock('$lib/server/database/queries/external-subtitles.queries.js', () => mockExternalSubtitles);

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

vi.mock('$lib/server/utils/ffprobe.js', () => ({
    probeMediaFile: vi.fn(async () => ({
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
        subtitleStreams: [
            {
                index: 4,
                codec: 'subrip',
                language: 'eng',
                title: null,
                isDefault: false,
                isForced: false,
            },
        ],
    })),
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

const mockPrefs = vi.hoisted(() => ({
    getPlaybackPreferences: { one: vi.fn() },
}));

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => mockPrefs);

import { buildPlaybackStartInfo } from './info.service.js';
import { probeMediaFile } from '$lib/server/utils/ffprobe.js';
import { playbackPlanner } from './playback-planner.service.js';
import type { UserId } from '$lib/shared/user-id.js';

// Only the fields `parseLanguagePreferences` actually reads (info.service.ts)
// need to be present — the row type is not enforced across the mock boundary.
const PREFS_ROW = {
    prefer_original_audio: false,
    audio_language: null,
    last_audio_language: null,
    subtitle_language: null,
    subtitles_enabled: true,
    forced_subtitles_enabled: false,
    subtitle_track_hint: JSON.stringify({ language: 'eng', isForced: false, codec: 'subrip' }),
};

async function callBuildPlaybackStartInfo(fileId?: string) {
    const result = await buildPlaybackStartInfo({
        sql: {} as never,
        userId: 'user-1' as UserId,
        internalId: 'media-1',
        fileId,
    });
    if (!result.ok) throw new Error(`buildPlaybackStartInfo failed: ${result.message}`);
    return result.data;
}

describe('recommended_tracks wiring in buildPlaybackStartInfo', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFiles.getFilesForMediaItem.mockResolvedValue([
            {
                id: 'file-1',
                label: null,
                edition: null,
                file_path: '/media/x.mkv',
                is_default: true,
            },
        ]);
        mockExternalSubtitles.getExternalSubtitlesForFile.mockResolvedValue([]);
        mockFeatures.ffmpegAvailable = true;
        mockCatalog.getMediaItemById.mockResolvedValue({ id: 'media-1', media_type: 'movie' });
        mockCatalog.getMediaItemForWatch.mockResolvedValue({
            id: 'media-1',
            original_language: null,
        });
    });

    it('loads sidecars for the selected file and emits ready descriptors', async () => {
        mockFiles.getFilesForMediaItem.mockResolvedValue([
            {
                id: 'file-1',
                label: null,
                edition: null,
                file_path: '/media/x.mkv',
                is_default: true,
            },
            {
                id: 'file-2',
                label: null,
                edition: null,
                file_path: '/media/y.mkv',
                is_default: false,
            },
        ]);
        const sidecars = [
            {
                id: 'subtitle-1',
                file_id: 'file-1',
                language: 'en',
                format: 'srt',
                is_forced: false,
                is_sdh: false,
            },
            {
                id: 'subtitle-2',
                file_id: 'file-2',
                language: 'de',
                format: 'vtt',
                is_forced: false,
                is_sdh: false,
            },
        ];
        mockExternalSubtitles.getExternalSubtitlesForFile.mockImplementation(async (_sql, fileId) =>
            sidecars.filter((row) => row.file_id === fileId),
        );
        const data = await callBuildPlaybackStartInfo('file-2');
        expect(mockExternalSubtitles.getExternalSubtitlesForFile).toHaveBeenCalledWith(
            expect.anything(),
            'file-2',
        );
        expect(data.externalSubtitles?.map((row) => row.id)).toEqual(['subtitle-2']);
        expect(data.subtitles).toContainEqual(
            expect.objectContaining({
                id: 'subtitle-2',
                index: 1000,
                kind: 'external',
                hrefs: {
                    text: '/api/playback/media-1/subtitles/external/subtitle-2?fileId=file-2&format=vtt',
                    raw: '/api/playback/media-1/subtitles/external/subtitle-2?fileId=file-2&format=vtt',
                },
            }),
        );
        expect(data.subtitles.some((track) => track.id === 'subtitle-1')).toBe(false);
    });

    it('omits recommended_tracks when there is no preferences row', async () => {
        mockPrefs.getPlaybackPreferences.one.mockResolvedValue(null);

        const data = await callBuildPlaybackStartInfo();

        expect(data.recommended_tracks).toBeUndefined();
        // The guard is `if (prefsRow)` — a real row-dependent lookup must not
        // fire when there is no row to resolve against.
        expect(mockCatalog.getMediaItemForWatch).not.toHaveBeenCalled();
    });

    it('omits recommended_tracks and logs when a downstream lookup throws', async () => {
        mockPrefs.getPlaybackPreferences.one.mockResolvedValue(PREFS_ROW);
        mockCatalog.getMediaItemForWatch.mockRejectedValue(new Error('db unavailable'));

        const data = await callBuildPlaybackStartInfo();

        expect(data.recommended_tracks).toBeUndefined();
        expect(mockLogger.warn).toHaveBeenCalled();
        // The response as a whole must still succeed — a recommendation
        // failure must never break playback info entirely.
        expect(data.tracks.audio.length).toBeGreaterThan(0);
    });

    it('resolves recommended_tracks on the happy path, parsing the JSONB hint', async () => {
        mockPrefs.getPlaybackPreferences.one.mockResolvedValue(PREFS_ROW);

        const data = await callBuildPlaybackStartInfo();

        // No audio preference expressed -> file default (index 0, the only/
        // default track). Subtitle hint names the eng/non-forced/subrip
        // track exactly -> hint-exact match on subtitle index 4.
        expect(data.recommended_tracks).toEqual({
            audio_track_index: 0,
            subtitle_track_index: 4,
            reason: { audio: 'file-default', subtitle: 'hint-exact' },
        });
    });

    it.each(['subrip', 'dvbsub'])(
        'passes scoped subtitle identity through planning and recommendations with an earlier %s candidate',
        async (firstCodec) => {
            mockPrefs.getPlaybackPreferences.one.mockResolvedValue({
                ...PREFS_ROW,
                subtitle_track_hint: JSON.stringify({
                    language: 'eng',
                    isForced: false,
                    codec: null,
                    fileId: 'file-1',
                    trackId: 'file-1:5',
                }),
            });
            const probe = await probeMediaFile('/media/x.mkv');
            vi.mocked(probeMediaFile).mockResolvedValueOnce({
                ...probe,
                subtitleStreams: [
                    {
                        index: 4,
                        codec: firstCodec,
                        language: 'eng',
                        title: null,
                        isDefault: false,
                        isForced: false,
                        isHearingImpaired: false,
                    },
                    {
                        index: 5,
                        codec: 'subrip',
                        language: 'eng',
                        title: null,
                        isDefault: false,
                        isForced: false,
                        isHearingImpaired: false,
                    },
                ],
            });
            const data = await callBuildPlaybackStartInfo();
            expect(data.recommended_tracks?.subtitle_track_index).toBe(5);
            expect(playbackPlanner.createPlan).toHaveBeenLastCalledWith(
                expect.objectContaining({ subtitleMethod: 'none' }),
            );
        },
    );
});
