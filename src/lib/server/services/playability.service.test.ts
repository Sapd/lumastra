// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /media/{id}/playability: parity with POST /play-sessions, and no side effects.
 *
 * The real `buildPlaybackStartInfo` and the real PlaybackPlanner run; only I/O is
 * stubbed (ffprobe, DB queries, Valkey). Parity is asserted against the exact call
 * `startPlaySession` makes for a video start: `buildPlaybackStartInfo` fed by
 * `startDecisionInputs(capabilities)`, then `info.recommended` as the method.
 * Literal expectations pin direct, remux and full transcode so a probe and a start
 * that drift together still fail here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFeatures = vi.hoisted(() => ({ ffmpegAvailable: true }));

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
    config: {
        ENABLE_HDR10_PRESERVATION: false,
        ALLOW_AV1_MSE_HLS: false,
        ALLOW_HEVC_ENCODING: false,
        ALLOW_AV1_ENCODING: false,
        SOFTWARE_CODEC_PREFERENCE: 'h264',
        SOFTWARE_ENCODE_MAX_WIDTH: 1920,
    },
}));

const mockLogger = vi.hoisted(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => mockLogger } }));

// Same rule as play-sessions.service (checkPlayMethodAllowed): null = every method allowed.
const mockPolicy = vi.hoisted(() => ({
    allowed_play_methods: null as string[] | null,
    fail: false,
}));
vi.mock('./play-sessions.service.js', () => ({
    getEffectivePolicy: vi.fn(async () => {
        if (mockPolicy.fail) throw new Error('policy db down');
        return { allowed_play_methods: mockPolicy.allowed_play_methods };
    }),
    checkPlayMethodAllowed: (policy: { allowed_play_methods: string[] | null }, method: string) =>
        policy.allowed_play_methods === null || policy.allowed_play_methods.includes(method)
            ? null
            : { kind: 'transcode_not_allowed' },
}));

const mockValkey = vi.hoisted(() => ({
    setEx: vi.fn(async () => true),
    getCoordinationClient: vi.fn(() => null),
    expire: vi.fn(async () => true),
}));
vi.mock('$lib/server/cache/valkey.js', () => mockValkey);

const mockCatalog = vi.hoisted(() => ({
    getMediaItemById: vi.fn(),
    getMediaItemForWatch: vi.fn(async () => ({ id: 'media-1', original_language: 'eng' })),
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
        positionMs: 1_824_000,
        anchorMs: null,
        isWatched: false,
    })),
}));

const mockPreferences = vi.hoisted(() => ({
    prefer_original_audio: false,
    audio_language: 'eng',
    last_audio_language: null,
    subtitle_language: 'eng',
    subtitles_enabled: true,
    forced_subtitles_enabled: false,
    subtitle_track_hint: null,
}));
vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: { one: vi.fn(async () => mockPreferences) },
}));

vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn(async (path: string) => ({ isAccessible: true, containerPath: path })),
}));

const SOURCES: Record<string, { container: string; video: Record<string, unknown> }> = {
    '/media/direct.mp4': {
        container: 'mp4',
        video: { codec: 'h264', width: 1920, height: 1080, pixelFormat: 'yuv420p' },
    },
    '/media/remux.mkv': {
        container: 'matroska',
        video: { codec: 'h264', width: 1920, height: 1080, pixelFormat: 'yuv420p' },
    },
    '/media/transcode.mkv': {
        container: 'matroska',
        video: { codec: 'hevc', width: 3840, height: 2160, pixelFormat: 'yuv420p10le' },
    },
};
const mockProbe = vi.hoisted(() => ({ probeMediaFile: vi.fn() }));
vi.mock('$lib/server/utils/ffprobe.js', () => ({
    probeMediaFile: mockProbe.probeMediaFile,
    containerFromExtension: (path: string) => SOURCES[path]?.container,
}));

vi.mock('$lib/server/services/transcoding/hardware-detection.js', () => ({
    hardwareDetection: {
        getBestEncoder: vi.fn(async (codec: string) => (codec === 'h264' ? 'libx264' : null)),
        getBestDecoder: vi.fn(async () => null),
    },
}));

vi.mock('$lib/server/services/trickplay-storage.service.js', () => ({
    getBestTrickplayInfo: vi.fn(async () => undefined),
}));

import { probePlayability } from './playability.service.js';
import { buildPlaybackStartInfo } from './info.service.js';
import { startDecisionInputs } from './playback-start-inputs.js';
import { PlayabilityResponseSchema } from '$lib/schemas/api-playability.js';
import type { PlaybackCapabilities } from '$lib/schemas/playback-capabilities.js';
import type { UserId } from '$lib/shared/user-id.js';

const USER = 'user-1' as UserId;
const MEDIA = '6b1f0000-0000-4000-8000-000000000001';

const CAPS: PlaybackCapabilities = {
    containers: ['mp4', 'ts'],
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
    subtitleFormats: ['vtt'],
};

const FILES = [
    {
        id: 'file-direct',
        label: 'Direct',
        file_path: '/media/direct.mp4',
        is_default: true,
        file_size_bytes: 1000,
    },
    { id: 'file-remux', label: 'Remux', file_path: '/media/remux.mkv', is_default: false },
    { id: 'file-transcode', label: '4K', file_path: '/media/transcode.mkv', is_default: false },
].map((f, i) => ({ edition: null, sort_order: i, duration_seconds: 600, ...f }));

beforeEach(() => {
    vi.clearAllMocks();
    mockPreferences.subtitle_language = 'eng';
    mockPreferences.audio_language = 'eng';
    mockPolicy.allowed_play_methods = null;
    mockPolicy.fail = false;
    mockFeatures.ffmpegAvailable = true;
    mockCatalog.getMediaItemById.mockResolvedValue({ id: MEDIA, media_type: 'movie' });
    mockFiles.getFilesForMediaItem.mockResolvedValue(FILES);
    mockExternalSubtitles.getExternalSubtitlesForFile.mockResolvedValue([]);
    mockProbe.probeMediaFile.mockImplementation(async (path: string) => ({
        success: true,
        duration: 600,
        formatBitrate: 8_000_000,
        container: SOURCES[path]?.container,
        video: {
            bitrate: 8_000_000,
            hdr: 'sdr',
            profile: 'High',
            level: 40,
            ...SOURCES[path]?.video,
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
            {
                audioRelativeIndex: 1,
                absoluteIndex: 2,
                codec: 'aac',
                channels: 2,
                language: 'deu',
                title: 'German',
                isDefault: false,
            },
        ],
        subtitleStreams: [
            {
                index: 3,
                codec: 'subrip',
                language: 'eng',
                title: null,
                isDefault: false,
                isForced: false,
            },
            {
                index: 4,
                codec: 'hdmv_pgs_subtitle',
                language: 'deu',
                title: null,
                isDefault: false,
                isForced: false,
            },
            {
                index: 5,
                codec: 'ass',
                language: 'eng',
                title: 'Signs',
                isDefault: false,
                isForced: true,
            },
        ],
    }));
});

async function probe(
    options: { fileId?: string; capabilities?: PlaybackCapabilities | null } = {},
) {
    const result = await probePlayability({
        sql: {} as never,
        userId: USER,
        mediaId: MEDIA,
        fileId: options.fileId,
        // `null` = send no capabilities at all; absent = the common test caps.
        capabilities: options.capabilities === null ? undefined : (options.capabilities ?? CAPS),
        surface: 'v1',
        username: 'alice',
    });
    if (!result.ok) throw new Error(`probe failed: ${result.status} ${result.message}`);
    return result.data;
}

/** What POST /play-sessions computes for a video start of `fileId`. */
async function startDecision(
    fileId: string,
    capabilities: PlaybackCapabilities | undefined = CAPS,
    selections: { audioStreamIndex?: number; subtitleId?: string } = {},
) {
    const result = await buildPlaybackStartInfo({
        sql: {} as never,
        userId: USER,
        internalId: MEDIA,
        fileId,
        ...selections,
        ...startDecisionInputs(capabilities),
        surface: 'v1',
    });
    if (!result.ok) throw new Error(`start failed: ${result.message}`);
    return result.data;
}

describe('parity with POST /play-sessions', () => {
    it('the same omitted preferences choose burn-in for probe and start; explicit none disables it', async () => {
        mockPreferences.subtitle_language = 'deu';
        const data = await probe();
        for (const version of data.versions) {
            const start = await startDecision(version.fileId);
            expect(version.playMethod).toBe('full_transcode');
            expect(start.recommended).toBe(version.playMethod);
            expect(version.reasonCodes).toContainEqual({ code: 'subtitle_burn_in' });
        }
        expect(data.recommended?.subtitleId).toBe('file-direct:4');
        expect((await startDecision('file-direct', CAPS, { subtitleId: 'none' })).recommended).toBe(
            'remux',
        );
    });
    it('the unit-suffixed bitrate cap changes probe and start identically', async () => {
        const capabilities = { ...CAPS, maxVideoBitrateBps: 1_000_000 };
        const data = await probe({ capabilities });
        const start = await startDecision('file-direct', capabilities);
        expect(start.recommended).toBe('full_transcode');
        expect(data.versions[0].playMethod).toBe(start.recommended);
        expect(data.versions[0].reasonCodes).toEqual(start.transcode_reason_codes);
    });

    it.each([
        ['pgs', 'hdmv_pgs_subtitle'],
        ['pgs', 'pgssub'],
        ['ass', 'ssa'],
    ])('declaring %s renders its alias %s without burn-in', async (declared, codec) => {
        const inputs = startDecisionInputs({ ...CAPS, subtitleFormats: ['vtt', declared] });
        expect(inputs.pathScopedCaps.subtitleRendering.burnInRequired).not.toContain(codec);
    });

    it('an unknown declared subtitle token does not remove the required server renderer', () => {
        expect(
            startDecisionInputs({ ...CAPS, subtitleFormats: ['vtt', 'dvbsub'] }).pathScopedCaps
                .subtitleRendering.burnInRequired,
        ).toContain('dvbsub');
    });

    it('a native multi-audio recommendation is available to start', async () => {
        const info = await startDecision('file-direct');
        expect(info.play_methods[info.recommended]?.available).toBe(true);
        expect(info.recommended).toBe('remux');
    });

    it.each([
        { hlsCopyReload: true, expected: 'muxed' },
        { hlsCopyReload: false, expected: 'demux' },
        { hlsCopyReload: undefined, expected: 'demux' },
    ] as const)(
        'native copy layout with hlsCopyReload=$hlsCopyReload',
        async ({ hlsCopyReload, expected }) => {
            const capabilities = { ...CAPS, hlsCopyReload };
            const inputs = startDecisionInputs(capabilities);
            expect(inputs.clientType).toBe('native');
            expect(inputs.clientCaps.supportsHlsCopyReload).toBe(hlsCopyReload ?? false);
            const data = await probe({ fileId: 'file-remux', capabilities });
            const start = await startDecision('file-remux', capabilities);
            expect(start.recommended).toBe('remux');
            expect(data.hlsAudioMode).toBe(expected);
            expect(data.versions[0].hlsAudioMode).toBe(expected);
            expect(start.hls_audio_mode).toBe(expected);
        },
    );

    it.each([
        ['file-direct', 'remux'],
        ['file-remux', 'remux'],
        ['file-transcode', 'full_transcode'],
    ] as const)(
        '%s decides %s, as a start with the same capabilities does',
        async (fileId, method) => {
            const data = await probe();
            const version = data.versions.find((v) => v.fileId === fileId)!;
            const start = await startDecision(fileId);

            expect(version.playMethod).toBe(method);
            expect(version.playMethod).toBe(start.recommended);
            expect(version.playable).toBe(start.playable);
            expect(version.reasons).toEqual(start.transcode_reasons);
            expect(version.reasonCodes).toEqual(start.transcode_reason_codes);
            expect(version.outputHdr).toBe(start.output_hdr);
            expect(version.hlsAudioMode).toBe(start.hls_audio_mode);
            expect(version.availableMethods.includes('direct')).toBe(
                start.play_methods.direct.available,
            );
        },
    );

    it('conversions carry structured reasons', async () => {
        const data = await probe();
        expect(data.versions.find((v) => v.fileId === 'file-direct')!.reasonCodes).toContainEqual({
            code: 'multi_audio_needs_hls',
        });
        expect(
            data.versions.find((v) => v.fileId === 'file-transcode')!.reasonCodes.length,
        ).toBeGreaterThan(0);
    });

    it('different capabilities change the answer the same way for probe and start', async () => {
        const hevc: PlaybackCapabilities = {
            ...CAPS,
            videoCodecs: ['h264', 'hevc'],
            containers: ['mp4', 'ts', 'mkv'],
        };
        const data = await probe({ capabilities: hevc });
        for (const version of data.versions) {
            expect(version.playMethod).toBe(
                (await startDecision(version.fileId, hevc)).recommended,
            );
        }
        expect(data.versions.find((v) => v.fileId === 'file-transcode')!.playMethod).not.toBe(
            'full_transcode',
        );
    });

    it('omitted capabilities take the same defaults as a start', async () => {
        const data = await probe({ capabilities: null });
        for (const version of data.versions) {
            expect(version.playMethod).toBe(
                (await startDecision(version.fileId, undefined)).recommended,
            );
        }
        // The defaults are h264 + AAC in mp4/ts: the HEVC 4K file cannot direct play.
        expect(data.versions.find((v) => v.fileId === 'file-transcode')!.playMethod).toBe(
            'full_transcode',
        );
        expect(data.versions.find((v) => v.fileId === 'file-direct')!.playMethod).toBe('remux');
    });

    it("availableMethods equal the start's available play methods, for every version", async () => {
        const data = await probe();
        for (const version of data.versions) {
            const start = await startDecision(version.fileId);
            const expected = Object.entries(start.play_methods)
                .filter(([, method]) => method.available)
                .map(([name]) => name);
            expect(version.availableMethods).toEqual(expected);
        }
        expect(data.versions[0].availableMethods).toEqual([
            'remux',
            'audio_transcode',
            'full_transcode',
            'audio_only',
        ]);
    });

    it('item-level fields and recommended tracks match what a start preselects', async () => {
        const data = await probe();
        const start = await startDecision('file-direct');
        expect(data.activeFileId).toBe(start.active_file_id);
        expect(data.resumePositionMs).toBe(start.resume_position_ms);
        expect(data.isWatched).toBe(start.is_watched);
        expect(data.hlsAudioMode).toBe(start.hls_audio_mode);
        expect(data.recommended).toMatchObject({
            audioStreamIndex: start.tracks.audio.find(
                (t) => t.index === start.recommended_tracks!.audio_track_index,
            )!.absoluteIndex,
            subtitleId: `file-direct:${start.recommended_tracks!.subtitle_track_index}`,
            reason: start.recommended_tracks!.reason,
        });
    });
});

describe('response shape', () => {
    it('a raw SRT renderer without WebVTT gets client_render, never WebVTT delivery', async () => {
        const data = await probe({ capabilities: { ...CAPS, subtitleFormats: ['srt'] } });
        expect(
            data.versions[0].tracks.subtitles.find((track) => track.codec === 'subrip')?.method,
        ).toBe('client_render');
    });

    it('validates against the response schema and is camelCase', async () => {
        const data = await probe();
        expect(PlayabilityResponseSchema.safeParse(data).success).toBe(true);
        const keys = new Set<string>();
        JSON.stringify(data, (key, value) => {
            if (key) keys.add(key);
            return value;
        });
        expect([...keys].filter((key) => key.includes('_'))).toEqual([]);
        expect(data.activeFileId).toBe('file-direct');
    });

    it('lists audio absoluteIndex, subtitle id, format, source and method', async () => {
        mockExternalSubtitles.getExternalSubtitlesForFile.mockImplementation(
            async (_sql, fileId) =>
                fileId === 'file-direct'
                    ? [
                          {
                              id: 'side-1',
                              file_id: 'file-direct',
                              language: 'fra',
                              format: 'srt',
                              is_forced: false,
                              is_sdh: false,
                          },
                      ]
                    : [],
        );
        const version = (await probe()).versions.find((v) => v.fileId === 'file-direct')!;
        expect(version.tracks.audio.map((a) => [a.index, a.absoluteIndex])).toEqual([
            [0, 1],
            [1, 2],
        ]);
        expect(version.tracks.subtitles.map((s) => [s.index, s.format, s.source])).toEqual([
            [3, 'text', 'embedded'],
            [4, 'bitmap', 'embedded'],
            [5, 'ass', 'embedded'],
            [1000, 'text', 'sidecar'],
        ]);
        expect(version.tracks.subtitles.map((s) => s.id)).toEqual([
            'file-direct:3',
            'file-direct:4',
            'file-direct:5',
            'side-1',
        ]);
        expect(version.tracks.subtitles[1].method).toBe('burn_in');
        expect(version.tracks.subtitles[3].method).toBe('external_vtt');
        expect(version.sizeBytes).toBe(1000);
        expect(version.durationMs).toBe(600_000);
    });

    it('an unscanned file has no sizeBytes (absent, not 0), also on the wire', async () => {
        const data = await probe();
        const remux = data.versions.find((v) => v.fileId === 'file-remux')!;
        expect(remux.sizeBytes).toBeUndefined();
        const wire = JSON.parse(JSON.stringify(data)).versions as Record<string, unknown>[];
        expect(wire.find((v) => v.fileId === 'file-remux')).not.toHaveProperty('sizeBytes');
        expect(PlayabilityResponseSchema.safeParse(JSON.parse(JSON.stringify(data))).success).toBe(
            true,
        );
    });

    it('a sidecar is delivered as WebVTT only to a player that declares vtt', async () => {
        const sidecar = [
            {
                id: 'side-1',
                file_id: 'file-direct',
                language: 'fra',
                format: 'srt',
                is_forced: false,
                is_sdh: false,
            },
        ];
        mockExternalSubtitles.getExternalSubtitlesForFile.mockImplementation(
            async (_sql, fileId) => (fileId === 'file-direct' ? sidecar : []),
        );
        const sidecarMethod = async (capabilities: PlaybackCapabilities) =>
            (await probe({ capabilities })).versions
                .find((v) => v.fileId === 'file-direct')!
                .tracks.subtitles.find((t) => t.source === 'sidecar')!.method;
        expect(await sidecarMethod({ ...CAPS, subtitleFormats: ['vtt'] })).toBe('external_vtt');
        expect(await sidecarMethod({ ...CAPS, subtitleFormats: ['pgs'] })).toBe('none');
    });

    it('a failing sidecar query is logged and the embedded tracks are still listed', async () => {
        mockExternalSubtitles.getExternalSubtitlesForFile.mockRejectedValue(new Error('db'));
        const data = await probe();
        expect(data.versions[0].tracks.subtitles.map((s) => s.source)).toEqual([
            'embedded',
            'embedded',
            'embedded',
        ]);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('sidecar'),
            expect.objectContaining({ fileId: 'file-direct' }),
        );
    });
});

describe('no side effects', () => {
    it('stores no plan in Valkey (a start does)', async () => {
        await probe();
        expect(mockValkey.setEx).not.toHaveBeenCalled();
        await startDecision('file-direct');
        expect(mockValkey.setEx).toHaveBeenCalled();
    });

    it('does not log "Playback plan created" at info (a start does)', async () => {
        vi.resetModules();
        await probe();
        expect(mockLogger.info).not.toHaveBeenCalledWith(
            'Playback plan created',
            expect.anything(),
        );
    });

    it('fileId probes only that version', async () => {
        const data = await probe({ fileId: 'file-remux' });
        expect(data.versions.map((v) => v.fileId)).toEqual(['file-remux']);
        expect(data.activeFileId).toBe('file-remux');
        expect(mockProbe.probeMediaFile).toHaveBeenCalledTimes(1);
    });
});

describe('playable', () => {
    it('without ffmpeg only direct play is playable, and the others say why', async () => {
        mockFeatures.ffmpegAvailable = false;
        const data = await probe();
        expect(data.versions.map((v) => [v.fileId, v.playable, v.blockedBy])).toEqual([
            ['file-direct', false, ['transcoding_unavailable']],
            ['file-remux', false, ['transcoding_unavailable']],
            ['file-transcode', false, ['transcoding_unavailable']],
        ]);
        for (const version of data.versions) {
            const start = await startDecision(version.fileId);
            expect(version.playable).toBe(start.playable);
            expect(version.availableMethods).toEqual([]);
        }
    });

    it("the account's allowed play methods decide playable, like a start", async () => {
        mockPolicy.allowed_play_methods = ['direct'];
        const data = await probe();
        expect(data.versions.map((v) => [v.fileId, v.playable, v.blockedBy])).toEqual([
            ['file-direct', false, ['play_method_not_allowed']],
            ['file-remux', false, ['play_method_not_allowed']],
            ['file-transcode', false, ['play_method_not_allowed']],
        ]);
    });

    it('an unreadable policy is logged and not evaluated', async () => {
        mockPolicy.allowed_play_methods = ['direct'];
        mockPolicy.fail = true;
        const data = await probe();
        expect(data.versions.every((v) => v.playable)).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalled();
    });
});

describe('unreadable files', () => {
    it('an explicitly selected unreadable file never starts a different edition', async () => {
        const implementation = mockProbe.probeMediaFile.getMockImplementation()!;
        mockProbe.probeMediaFile.mockImplementation(async (path: string) =>
            path === '/media/direct.mp4' ? { success: false } : implementation(path),
        );
        const result = await buildPlaybackStartInfo({
            sql: {} as never,
            userId: USER,
            internalId: MEDIA,
            fileId: 'file-direct',
            ...startDecisionInputs(CAPS),
            surface: 'v1',
        });
        expect(result).toMatchObject({ ok: false, status: 404 });
    });

    it('a version that fails ffprobe is listed as unplayable, and the active file stays consistent', async () => {
        const probed = mockProbe.probeMediaFile.getMockImplementation()!;
        mockProbe.probeMediaFile.mockImplementation(async (path: string) =>
            path === '/media/direct.mp4' ? { success: false } : probed(path),
        );
        const data = await probe();
        const failed = data.versions.find((v) => v.fileId === 'file-direct')!;
        expect(failed).toMatchObject({
            isDefault: true,
            playable: false,
            blockedBy: ['probe_failed'],
            availableMethods: [],
            tracks: { video: null, audio: [], subtitles: [] },
        });
        expect(failed.playMethod).toBeUndefined();
        // The default could not be read: a start would fall back to the first readable version too.
        expect(data.versions.filter((v) => v.playable).map((v) => v.fileId)).toContain(
            data.activeFileId,
        );
        expect(data.activeFileId).not.toBe('file-direct');
        expect(PlayabilityResponseSchema.safeParse(JSON.parse(JSON.stringify(data))).success).toBe(
            true,
        );
    });

    it('nothing readable is a 503, not a 500', async () => {
        mockProbe.probeMediaFile.mockResolvedValue({ success: false });
        const result = await probePlayability({
            sql: {} as never,
            userId: USER,
            mediaId: MEDIA,
            surface: 'v1',
        });
        expect(result).toMatchObject({ ok: false, status: 503 });
    });

    it('stops probing after the deadline and reports the rest as unreadable', async () => {
        let now = 1_700_000_000_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const probed = mockProbe.probeMediaFile.getMockImplementation()!;
        mockProbe.probeMediaFile.mockImplementation(async (path: string) => {
            now += 11_000; // hung storage: the first file eats the whole budget
            return probed(path);
        });
        try {
            const data = await probe();
            expect(mockProbe.probeMediaFile).toHaveBeenCalledTimes(1);
            expect(data.versions.map((v) => [v.fileId, v.playable, v.blockedBy])).toEqual([
                ['file-direct', true, []],
                ['file-remux', false, ['probe_failed']],
                ['file-transcode', false, ['probe_failed']],
            ]);
        } finally {
            clock.mockRestore();
        }
    });
});

describe('startDecisionInputs subtitle rendering', () => {
    const rendering = (subtitleFormats: string[]) =>
        startDecisionInputs({ ...CAPS, subtitleFormats }).pathScopedCaps.subtitleRendering;

    it('vtt only: text renders, everything else is burned in', () => {
        const r = rendering(['vtt']);
        expect(r).toMatchObject({ vtt: true, ass: false, pgs: false, vobsub: false });
        expect(r.burnInRequired).toEqual(expect.arrayContaining(['ass', 'ssa', 'pgs', 'dvdsub']));
        expect(r.burnInRequired).not.toContain('srt');
    });

    it('a declared format is rendered by the client and never burned in', () => {
        const r = rendering(['vtt', 'ass', 'pgs']);
        expect(r).toMatchObject({ vtt: true, ass: true, pgs: true, vobsub: false });
        expect(r.burnInRequired).not.toContain('ass');
        expect(r.burnInRequired).not.toContain('pgs');
        expect(r.burnInRequired).toContain('dvdsub');
        // Only the declared token leaves the list: other spellings of the same format
        // ('pgssub', 'hdmv_pgs_subtitle', 'ssa') stay in it. That is how a start prepares
        // its caps today; the probe must match it, so this is pinned, not endorsed.
    });

    it('webvtt is an alias of vtt, and no vtt burns text subtitles in', () => {
        expect(rendering(['webvtt']).vtt).toBe(true);
        const none = rendering(['pgs']);
        expect(none.vtt).toBe(false);
        expect(none.burnInRequired).toEqual(expect.arrayContaining(['srt', 'subrip']));
    });
});

describe('errors', () => {
    it('unknown item is 404', async () => {
        mockCatalog.getMediaItemById.mockResolvedValue(null);
        const result = await probePlayability({
            sql: {} as never,
            userId: USER,
            mediaId: MEDIA,
            surface: 'v1',
        });
        expect(result).toMatchObject({ ok: false, status: 404 });
    });

    it('unknown fileId is 404', async () => {
        const result = await probePlayability({
            sql: {} as never,
            userId: USER,
            mediaId: MEDIA,
            fileId: 'nope',
            surface: 'v1',
        });
        expect(result).toMatchObject({ ok: false, status: 404 });
    });

    it.each(['track', 'audiobook', 'tvchannel', 'tv'])('%s is 422', async (mediaType) => {
        mockCatalog.getMediaItemById.mockResolvedValue({ id: MEDIA, media_type: mediaType });
        const result = await probePlayability({
            sql: {} as never,
            userId: USER,
            mediaId: MEDIA,
            surface: 'v1',
        });
        expect(result).toMatchObject({ ok: false, status: 422 });
    });
});

it('probe and start preserve a saved sidecar recommendation through its stable descriptor ID', async () => {
    mockPreferences.subtitle_language = 'fra';
    mockExternalSubtitles.getExternalSubtitlesForFile.mockImplementation(async (_sql, fileId) => [
        {
            id: `side-${fileId}`,
            file_id: fileId,
            language: 'fra',
            format: 'srt',
            is_forced: false,
            is_sdh: false,
        },
    ]);
    const data = await probe();
    expect(data.recommended?.subtitleId).toBe('side-file-direct');
    expect(data.versions[0].tracks.subtitles).toContainEqual(
        expect.objectContaining({
            id: 'side-file-direct',
            source: 'sidecar',
            method: 'external_vtt',
        }),
    );
    const start = await startDecision('file-direct');
    expect(start.recommended_tracks).toMatchObject({ subtitle_id: 'side-file-direct' });
    const { recommendedStreamIndexes } = await import('./playback-start-inputs');
    expect(recommendedStreamIndexes(start)?.subtitleId).toBe(data.recommended?.subtitleId);
});
