// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, it, expect, vi } from 'vitest';

const savedPreferences = vi.hoisted(() => ({
    value: undefined as Record<string, unknown> | undefined,
    error: false,
}));
vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: {
        one: vi.fn(async () => {
            if (savedPreferences.error) throw new Error('Unavailable');
            return savedPreferences.value;
        }),
    },
}));

const mockFeatures = vi.hoisted(() => ({ ffmpegAvailable: true }));
const mockPlaybackFixture = vi.hoisted(() => ({
    mediaType: 'movie',
    files: [] as Array<{
        id: string;
        label: string | null;
        edition: string | null;
        file_path: string;
        is_default: boolean;
    }>,
}));

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
    getMediaItemById: vi.fn(async () => ({
        id: 'media-1',
        media_type: mockPlaybackFixture.mediaType,
    })),
    getMediaItemForWatch: vi.fn(async () => ({ original_language: 'en' })),
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: vi.fn(async () => mockPlaybackFixture.files),
}));

const externalRows = vi.hoisted(() => ({
    value: [] as Array<{
        id: string;
        file_id: string;
        language: string;
        format: string;
        is_forced: boolean;
        is_sdh: boolean;
    }>,
}));
vi.mock('$lib/server/database/queries/external-subtitles.queries.js', () => ({
    getExternalSubtitlesForFile: vi.fn(async () => externalRows.value),
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
    hardwareDetection: {
        getBestEncoder: vi.fn(async () => 'libx264'),
        getBestDecoder: vi.fn(async () => null),
    },
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    setEx: vi.fn(async () => true),
    getCoordinationClient: vi.fn(() => null),
    expire: vi.fn(async () => true),
}));

vi.mock('$lib/server/services/trickplay-storage.service.js', () => ({
    getBestTrickplayInfo: vi.fn(async () => undefined),
}));

import { startDecisionInputs } from './playback-start-inputs';
import { buildPlaybackStartInfo } from './info.service.js';
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
    formatBitrate: 2_000_000,
    video: {
        codec: 'h264',
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        hdr: 'sdr',
        pixelFormat: 'yuv420p',
        profile: 'High',
        level: 51,
    },
    audioStreams: [
        { ...SURROUND_STREAM, codec: 'aac', channels: 2, absoluteIndex: 1 },
        { ...SURROUND_STREAM, audioRelativeIndex: 1, absoluteIndex: 4 },
    ],
    subtitleStreams: [],
});

beforeEach(() => {
    mockPlaybackFixture.mediaType = 'movie';
    mockPlaybackFixture.files = [
        { id: 'file-1', label: null, edition: null, file_path: '/media/x.mkv', is_default: true },
    ];
});

describe('selected audio start planning with the real planner', () => {
    it.each([false, true])(
        'ignores the deprecated multipartVideo=%s capability in planning',
        (multipartVideo) => {
            expect(startDecisionInputs({ multipartVideo })).toEqual(startDecisionInputs({}));
        },
    );

    it.each(['Chromium', 'Firefox', 'Safari'])(
        'plans the selected EAC3 track for %s instead of accepting the other AAC track',
        async (browser) => {
            const safari = browser === 'Safari';
            const result = await buildPlaybackStartInfo({
                sql: {} as never,
                userId: 'user-1' as UserId,
                internalId: 'media-1',
                fileId: 'file-1',
                audioStreamIndex: 4,
                clientCaps: {
                    ...STEREO_CLIENT,
                    audioCodecs: new Set(safari ? ['aac', 'eac3'] : ['aac']),
                    maxAudioChannels: 6,
                },
                pathScopedCaps: {
                    directFile: {
                        videoCodecs: ['h264'],
                        audioCodecs: ['aac', 'eac3'],
                        containers: ['mp4'],
                    },
                    nativeHls: {
                        videoCodecs: safari ? ['h264'] : [],
                        audioCodecs: safari ? ['aac', 'eac3'] : [],
                    },
                    mseHls: { videoCodecs: ['h264'], audioCodecs: ['aac'] },
                    subtitleRendering: {
                        vtt: true,
                        ass: false,
                        pgs: false,
                        vobsub: false,
                        burnInRequired: [],
                    },
                    hdr: { decode: [], display: false },
                    audioSwitching: false,
                    maxChannels: 6,
                    codecConstraints: {},
                },
            });
            if (!result.ok) throw new Error(result.message);
            expect(result.data.recommended).toBe(safari ? 'remux' : 'audio_transcode');
            expect(result.data.delivery_path).toBe(safari ? 'native_hls' : 'mse_hls');
            const method = result.data.recommended;
            const url = new URL(result.deliveryPaths[method], 'https://test.invalid');
            expect(url.searchParams.get('audioCodec')).toBe(safari ? 'copy' : 'aac');
            expect(result.data.tracks.audio).toHaveLength(2);
        },
    );

    it('ignores silent-file audio indices and plans the default audio for a stale index', async () => {
        const base = await mockProbe.probeMediaFile();
        const caps = {
            sql: {} as never,
            userId: 'user-1' as UserId,
            internalId: 'media-1',
            fileId: 'file-1',
            clientCaps: STEREO_CLIENT,
        };
        mockProbe.probeMediaFile.mockResolvedValueOnce({ ...base, audioStreams: [] });
        const silent = await buildPlaybackStartInfo({ ...caps, audioStreamIndex: 0 });
        expect(silent.ok).toBe(true);

        const unknown = await buildPlaybackStartInfo({ ...caps, audioStreamIndex: 99 });
        expect(unknown.ok).toBe(true);
        if (!unknown.ok) throw new Error(unknown.message);
        expect(unknown.data.recommended).toBe('remux');
        expect(
            new URL(unknown.deliveryPaths.remux, 'https://test.invalid').searchParams.get(
                'audioCodec',
            ),
        ).toBe('copy');
    });
});

it('explicit audio without subtitle ID plans and recommends forced subtitles for the effective dub R14', async () => {
    const base = await mockProbe.probeMediaFile();
    savedPreferences.value = {
        prefer_original_audio: false,
        audio_language: 'en',
        last_audio_language: null,
        subtitle_language: null,
        subtitles_enabled: false,
        forced_subtitles_enabled: true,
        subtitle_track_hint: null,
    };
    mockProbe.probeMediaFile.mockResolvedValueOnce({
        ...base,
        audioStreams: [
            { ...SURROUND_STREAM, codec: 'aac', channels: 2, language: 'eng', absoluteIndex: 1 },
            {
                ...SURROUND_STREAM,
                codec: 'aac',
                channels: 2,
                language: 'deu',
                audioRelativeIndex: 1,
                absoluteIndex: 4,
                isDefault: false,
            },
        ],
        subtitleStreams: [
            { index: 7, codec: 'dvb_subtitle', language: 'eng', isForced: true, isDefault: false },
            { index: 8, codec: 'dvb_subtitle', language: 'deu', isForced: true, isDefault: false },
        ],
    });
    try {
        const result = await buildPlaybackStartInfo({
            sql: {} as never,
            userId: 'user-1' as UserId,
            internalId: 'media-1',
            fileId: 'file-1',
            audioStreamIndex: 4,
            clientCaps: STEREO_CLIENT,
        });
        if (!result.ok) throw new Error(result.message);
        expect(result.data.recommended_tracks).toMatchObject({
            audio_track_index: 1,
            subtitle_track_index: 8,
        });
        expect(result.data.recommended).toBe('full_transcode');
        expect(result.data.tracks.subtitles.map((sub) => sub.method)).toEqual([
            'burn_in',
            'burn_in',
        ]);
    } finally {
        savedPreferences.value = undefined;
    }
});

it.each([4, 1])(
    'explicit audio %s preserves inference only for the identity it explains when defaulting subtitles',
    async (absoluteIndex) => {
        const base = await mockProbe.probeMediaFile();
        savedPreferences.value = {
            prefer_original_audio: false,
            audio_language: 'en',
            last_audio_language: null,
            subtitle_language: null,
            subtitles_enabled: false,
            forced_subtitles_enabled: true,
            subtitle_track_hint: null,
        };
        mockProbe.probeMediaFile.mockResolvedValueOnce({
            ...base,
            audioStreams: [
                {
                    ...SURROUND_STREAM,
                    codec: 'aac',
                    channels: 2,
                    language: 'deu',
                    absoluteIndex: 1,
                },
                {
                    ...SURROUND_STREAM,
                    codec: 'aac',
                    channels: 2,
                    language: undefined,
                    audioRelativeIndex: 1,
                    absoluteIndex: 4,
                    isDefault: false,
                },
            ],
            subtitleStreams: [
                { index: 7, codec: 'subrip', language: 'eng', isForced: true, isDefault: false },
                { index: 8, codec: 'subrip', language: 'deu', isForced: true, isDefault: false },
            ],
        });
        try {
            const result = await buildPlaybackStartInfo({
                sql: {} as never,
                userId: 'user-1' as UserId,
                internalId: 'media-1',
                fileId: 'file-1',
                audioStreamIndex: absoluteIndex,
                clientCaps: STEREO_CLIENT,
            });
            if (!result.ok) throw new Error(result.message);
            expect(result.data.recommended_tracks).toMatchObject({
                audio_track_index: absoluteIndex === 4 ? 1 : 0,
                subtitle_track_index: absoluteIndex === 4 ? 7 : 8,
            });
            expect(result.data.recommended_tracks?.reason.audio).toBe(
                absoluteIndex === 4 ? 'explicit-default-untagged' : 'file-default',
            );
        } finally {
            savedPreferences.value = undefined;
        }
    },
);

it.each(['missing', 'failed'] as const)(
    'plans safe ordinary audio and matching forced subtitles after a %s preference read without publishing a recommendation',
    async (read) => {
        const base = await mockProbe.probeMediaFile();
        savedPreferences.value = undefined;
        savedPreferences.error = read === 'failed';
        mockProbe.probeMediaFile.mockResolvedValueOnce({
            ...base,
            audioStreams: [
                {
                    ...SURROUND_STREAM,
                    codec: 'aac',
                    channels: 2,
                    language: 'eng',
                    title: 'Director Commentary',
                    isDefault: true,
                    absoluteIndex: 1,
                },
                {
                    ...SURROUND_STREAM,
                    codec: 'aac',
                    channels: 2,
                    language: 'deu',
                    title: 'Main',
                    isDefault: false,
                    audioRelativeIndex: 1,
                    absoluteIndex: 4,
                },
            ],
            subtitleStreams: [
                { index: 8, codec: 'pgs', language: 'deu', isForced: true, isDefault: false },
            ],
        });
        try {
            const result = await buildPlaybackStartInfo({
                sql: {} as never,
                userId: 'user-1' as UserId,
                internalId: 'media-1',
                fileId: 'file-1',
                clientCaps: STEREO_CLIENT,
                pathScopedCaps: startDecisionInputs({
                    videoCodecs: ['h264'],
                    audioCodecs: ['aac'],
                    subtitleFormats: ['vtt'],
                }).pathScopedCaps,
                clientType: 'native',
            });
            if (!result.ok) throw new Error(result.message);
            expect(result.data.recommended_tracks).toBeUndefined();
            // Only ordinary German audio has a forced PGS subtitle, so burn-in
            // proves the planner resolved both defaults despite the absent row.
            expect(result.data.recommended).toBe('full_transcode');
        } finally {
            savedPreferences.error = false;
        }
    },
);

it.each(['language', 'stable-hint'] as const)(
    'recommends the supported sidecar by stable ID for a saved %s and omits unsupported sidecars',
    async (preference) => {
        const base = await mockProbe.probeMediaFile();
        savedPreferences.value = {
            prefer_original_audio: false,
            audio_language: 'en',
            last_audio_language: null,
            subtitle_language: preference === 'language' ? 'fr' : null,
            subtitles_enabled: true,
            forced_subtitles_enabled: true,
            subtitle_track_hint:
                preference === 'stable-hint'
                    ? {
                          language: 'fr',
                          isForced: false,
                          codec: 'srt',
                          fileId: 'file-1',
                          trackId: 'sidecar-fr',
                      }
                    : null,
        };
        externalRows.value = [
            {
                id: 'unsupported',
                file_id: 'file-1',
                language: 'fr',
                format: 'pgs',
                is_forced: false,
                is_sdh: false,
            },
            {
                id: 'sidecar-fr',
                file_id: 'file-1',
                language: 'fr',
                format: 'srt',
                is_forced: false,
                is_sdh: false,
            },
        ];
        mockProbe.probeMediaFile.mockResolvedValueOnce({
            ...base,
            subtitleStreams: [
                {
                    index: 7,
                    codec: 'unsupported_codec',
                    language: 'fr',
                    isForced: false,
                    isDefault: true,
                },
            ],
        });
        try {
            const result = await buildPlaybackStartInfo({
                sql: {} as never,
                userId: 'user-1' as UserId,
                internalId: 'media-1',
                fileId: 'file-1',
                clientCaps: STEREO_CLIENT,
                pathScopedCaps: startDecisionInputs({
                    videoCodecs: ['h264'],
                    audioCodecs: ['aac'],
                    subtitleFormats: ['vtt'],
                }).pathScopedCaps,
                clientType: 'native',
            });
            if (!result.ok) throw new Error(result.message);
            expect(result.data.recommended_tracks).toMatchObject({ subtitle_id: 'sidecar-fr' });
            expect(result.data.recommended_tracks?.subtitle_track_index).toBeUndefined();
            const { recommendedStreamIndexes } = await import('./playback-start-inputs');
            expect(recommendedStreamIndexes(result.data)?.subtitleId).toBe('sidecar-fr');
            expect(result.data.subtitles?.find((sub) => sub.id === 'sidecar-fr')?.kind).toBe(
                'external',
            );
        } finally {
            savedPreferences.value = undefined;
            externalRows.value = [];
        }
    },
);
