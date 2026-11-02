// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Track selection in /j/Items/[itemId]/PlaybackInfo (found 2026-10-02 in the GPU
// transcode tests). jellyfin-web sends AudioStreamIndex / SubtitleStreamIndex in
// the QUERY; the TranscodingUrl came back without them, without SubtitleMethod
// and without a channel cap, so FFmpeg mapped the default audio as 5.1 for a
// stereo client and never burned in the chosen PGS track. These tests pin the
// Jellyfin (StreamBuilder / MediaInfoHelper) behaviour.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaStreamRow } from '$lib/server/database/queries/media-streams.queries';
import type {
    JellyfinMediaSourceInfo,
    JellyfinPlaybackInfoResponse,
} from '$lib/server/proprietary/jellyfin-compat/types';

vi.setConfig({ testTimeout: 30_000 });

const { mockGetStreamsForFile, mockGetFilesForMediaItem, ITEM_ID } = vi.hoisted(() => ({
    mockGetStreamsForFile: vi.fn(),
    mockGetFilesForMediaItem: vi.fn(),
    ITEM_ID: '9b0c3a4e-2f61-4d7a-9a51-0c6d2f7e8a11',
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemById: vi.fn().mockResolvedValue({
        id: ITEM_ID,
        media_type: 'movie',
        runtime_seconds: 5400,
    }),
}));

vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: vi.fn().mockResolvedValue(null),
    getFilesForMediaItem: mockGetFilesForMediaItem,
}));

vi.mock('$lib/server/database/queries/media-streams.queries', () => ({
    getStreamsForMediaItem: vi.fn().mockResolvedValue([]),
    getStreamsForFile: mockGetStreamsForFile,
}));

vi.mock('$lib/server/database/queries/external-subtitles.queries', () => ({
    getExternalSubtitlesForFile: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    issuePlayToken: vi.fn().mockResolvedValue('play-token'),
    issueFileToken: vi.fn().mockResolvedValue('file-token'),
    validatePlayToken: vi.fn().mockResolvedValue(null),
    revokePlayTokenBySession: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/stream-limit-notice', () => ({
    streamCapReachedByOthers: vi.fn().mockResolvedValue(null),
    freshPlaySessionId: vi.fn(async (id?: string) => id ?? 'fresh-session'),
    buildStreamLimitPlaybackInfo: vi.fn(),
    noticeLanguage: vi.fn(() => 'en'),
    rateLimitedPlaybackInfo: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/utils', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/proprietary/jellyfin-compat/utils')>();
    return { ...actual, getJfToken: vi.fn(() => 'jf-token') };
});

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

import { POST } from './+server';
import webDeviceProfile from './jellyfin-web-device-profile.fixture.json';

const FILE_ID = '4f1e2d3c-5b6a-4789-8abc-def012345678';

function row(partial: Partial<MediaStreamRow>): MediaStreamRow {
    return {
        codec_tag: null,
        language: null,
        title: null,
        display_title: null,
        channels: null,
        is_external: false,
        is_text_subtitle: null,
        is_default: false,
        is_forced: false,
        ...partial,
    } as MediaStreamRow;
}

// MKV: h264 + AC3 5.1 (default, idx 1) + AAC stereo (idx 2) + PGS (idx 3) + SRT (idx 4)
const STREAMS: MediaStreamRow[] = [
    row({ stream_index: 0, stream_type: 'video', codec: 'h264', profile: 'High', level: 40 }),
    row({ stream_index: 1, stream_type: 'audio', codec: 'ac3', channels: 6, is_default: true }),
    row({ stream_index: 2, stream_type: 'audio', codec: 'aac', channels: 2 }),
    row({
        stream_index: 3,
        stream_type: 'subtitle',
        codec: 'hdmv_pgs_subtitle',
        is_text_subtitle: false,
        language: 'eng',
    }),
    row({
        stream_index: 4,
        stream_type: 'subtitle',
        codec: 'subrip',
        is_text_subtitle: true,
        language: 'ger',
    }),
];

// The DeviceProfile from the repro.
const REPRO_PROFILE = {
    Name: 'Jellyfin Web',
    MaxStreamingBitrate: 8_000_000,
    DirectPlayProfiles: [
        { Container: 'mp4', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac' },
    ],
    TranscodingProfiles: [
        {
            Container: 'ts',
            Type: 'Video',
            AudioCodec: 'aac',
            VideoCodec: 'h264',
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: '2',
        },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [
        { Format: 'pgssub', Method: 'Encode' },
        { Format: 'srt', Method: 'External' },
    ],
};

function makeEvent(query: string, body: Record<string, unknown>): RequestEvent {
    const url = `https://example.test/j/Items/${ITEM_ID}/PlaybackInfo${query}`;
    return {
        params: { itemId: ITEM_ID },
        url: new URL(url),
        request: new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        locals: {
            user: { userId: '00000000-0000-0000-0000-000000000001', username: 'aleks' },
            jfClientName:
                (body.DeviceProfile as { Name?: string } | undefined)?.Name ?? 'Jellyfin Web',
        },
        cookies: { get: vi.fn(), set: vi.fn() },
    } as unknown as RequestEvent;
}

async function playbackInfo(
    query: string,
    body: Record<string, unknown> = { DeviceProfile: REPRO_PROFILE },
): Promise<JellyfinMediaSourceInfo> {
    const response = await (POST as unknown as (e: RequestEvent) => Promise<Response>)(
        makeEvent(query, body),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as JellyfinPlaybackInfoResponse;
    return json.MediaSources[0];
}

function transcodingParams(source: JellyfinMediaSourceInfo): URLSearchParams {
    expect(source.TranscodingUrl).toBeDefined();
    return new URL(source.TranscodingUrl!, 'https://example.test').searchParams;
}

const REPRO_QUERY =
    '?UserId=u1&AudioStreamIndex=2&SubtitleStreamIndex=3&MaxStreamingBitrate=8000000&IsPlayback=true';

describe('PlaybackInfo track selection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetFilesForMediaItem.mockResolvedValue([
            {
                id: FILE_ID,
                file_path: '/data/movies/Film (2020)/Film.mkv',
                file_size_bytes: '4000000000',
                total_bitrate: '12000000',
            },
        ]);
        mockGetStreamsForFile.mockResolvedValue(STREAMS);
    });

    it('carries the query track selection, burn-in and channel cap into the TranscodingUrl', async () => {
        const source = await playbackInfo(REPRO_QUERY);
        const params = transcodingParams(source);

        expect(params.get('AudioStreamIndex')).toBe('2');
        expect(params.get('SubtitleStreamIndex')).toBe('3');
        expect(params.get('SubtitleMethod')).toBe('Encode');
        expect(params.get('TranscodingMaxAudioChannels')).toBe('2');
        expect(params.get('VideoCodec')).toBe('h264');
        expect(params.get('AudioCodec')).toBe('aac');
        expect(source.SupportsDirectPlay).toBe(false);
    });

    it('reports the selected tracks as the defaults', async () => {
        const source = await playbackInfo(REPRO_QUERY);
        expect(source.DefaultAudioStreamIndex).toBe(2);
        expect(source.DefaultSubtitleStreamIndex).toBe(3);
    });

    it('sets DeliveryMethod per stream: Encode for PGS, External for SRT, never Embed in HLS', async () => {
        const source = await playbackInfo(REPRO_QUERY);
        const subs = source.MediaStreams!.filter((s) => s.Type === 'Subtitle');
        const pgs = subs.find((s) => s.Index === 3)!;
        const srt = subs.find((s) => s.Index === 4)!;

        expect(pgs.DeliveryMethod).toBe('Encode');
        expect(srt.DeliveryMethod).toBe('External');
        expect(srt.DeliveryUrl).toBe(
            `/Videos/${ITEM_ID}/${FILE_ID}/Subtitles/4/0/Stream.srt?api_key=jf-token`,
        );
    });

    it('leaves a sidecar subtitle out of the TranscodingUrl', async () => {
        const source = await playbackInfo(
            '?AudioStreamIndex=2&SubtitleStreamIndex=4&MaxStreamingBitrate=8000000',
        );
        const params = transcodingParams(source);
        expect(params.has('SubtitleStreamIndex')).toBe(false);
        expect(params.has('SubtitleMethod')).toBe(false);
        expect(source.DefaultSubtitleStreamIndex).toBe(4);
    });

    it('passes "subtitles off" (-1) through without a burn-in', async () => {
        const source = await playbackInfo('?SubtitleStreamIndex=-1');
        const params = transcodingParams(source);
        expect(params.has('SubtitleStreamIndex')).toBe(false);
        expect(source.DefaultSubtitleStreamIndex).toBe(-1);
    });

    it('lets the query win over the body (Jellyfin: audioStreamIndex ??= dto.AudioStreamIndex)', async () => {
        const source = await playbackInfo('?AudioStreamIndex=2', {
            DeviceProfile: REPRO_PROFILE,
            AudioStreamIndex: 1,
        });
        expect(transcodingParams(source).get('AudioStreamIndex')).toBe('2');
    });

    it('still reads the selection from the body when the query has none', async () => {
        const source = await playbackInfo('', {
            DeviceProfile: REPRO_PROFILE,
            AudioStreamIndex: 2,
            SubtitleStreamIndex: 3,
            StartTimeTicks: 600_000_000,
        });
        const params = transcodingParams(source);
        expect(params.get('AudioStreamIndex')).toBe('2');
        expect(params.get('SubtitleMethod')).toBe('Encode');
        expect(params.get('StartTimeTicks')).toBe('600000000');
    });

    it('falls back to the default audio track (and names it) when none is requested', async () => {
        const source = await playbackInfo('');
        expect(transcodingParams(source).get('AudioStreamIndex')).toBe('1');
        expect(source.DefaultAudioStreamIndex).toBe(1);
    });

    it('ignores an AudioStreamIndex that is not an audio stream', async () => {
        const source = await playbackInfo('?AudioStreamIndex=3');
        expect(transcodingParams(source).get('AudioStreamIndex')).toBe('1');
    });

    it('tightens the channel cap with a request MaxAudioChannels', async () => {
        const profile = {
            ...REPRO_PROFILE,
            TranscodingProfiles: [
                { ...REPRO_PROFILE.TranscodingProfiles[0], MaxAudioChannels: '6' },
            ],
        };
        const six = await playbackInfo('', { DeviceProfile: profile });
        expect(transcodingParams(six).get('TranscodingMaxAudioChannels')).toBe('6');
        const two = await playbackInfo('?MaxAudioChannels=2', { DeviceProfile: profile });
        expect(transcodingParams(two).get('TranscodingMaxAudioChannels')).toBe('2');
    });

    it('a burn-in rules out direct play that the codecs would allow', async () => {
        const mkvProfile = {
            ...REPRO_PROFILE,
            Name: 'Swiftfin',
            DirectPlayProfiles: [
                { Container: 'mkv', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'ac3,aac' },
            ],
        };
        const withSrt = await playbackInfo('?SubtitleStreamIndex=4', {
            DeviceProfile: mkvProfile,
            MaxStreamingBitrate: 100_000_000,
        });
        expect(withSrt.SupportsDirectPlay).toBe(true);

        const withPgs = await playbackInfo('?SubtitleStreamIndex=3', {
            DeviceProfile: mkvProfile,
            MaxStreamingBitrate: 100_000_000,
        });
        expect(withPgs.SupportsDirectPlay).toBe(false);
        expect(transcodingParams(withPgs).get('SubtitleMethod')).toBe('Encode');
    });

    it('keeps an Embed delivery for direct play when the profile embeds PGS', async () => {
        const embedProfile = {
            ...REPRO_PROFILE,
            Name: 'Swiftfin',
            DirectPlayProfiles: [
                { Container: 'mkv', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'ac3,aac' },
            ],
            SubtitleProfiles: [
                { Format: 'pgssub', Method: 'Embed' },
                { Format: 'srt', Method: 'Embed' },
            ],
        };
        const source = await playbackInfo('?SubtitleStreamIndex=3', {
            DeviceProfile: embedProfile,
            MaxStreamingBitrate: 100_000_000,
        });
        expect(source.SupportsDirectPlay).toBe(true);
        const subs = source.MediaStreams!.filter((s) => s.Type === 'Subtitle');
        expect(subs.map((s) => s.DeliveryMethod)).toEqual(['Embed', 'Embed']);
    });

    it('without subtitle profiles keeps the legacy pass-through', async () => {
        const source = await playbackInfo('?SubtitleStreamIndex=3', {
            DeviceProfile: { ...REPRO_PROFILE, SubtitleProfiles: [] },
        });
        const params = transcodingParams(source);
        expect(params.get('SubtitleStreamIndex')).toBe('3');
        expect(params.has('SubtitleMethod')).toBe(false);
        expect(source.MediaStreams!.find((s) => s.Index === 3)!.DeliveryMethod).toBe('Embed');
    });

    it('decides direct play by the SELECTED audio track, not the default one', async () => {
        const aacOnly = {
            ...REPRO_PROFILE,
            Name: 'Swiftfin',
            DirectPlayProfiles: [
                { Container: 'mkv', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac' },
            ],
        };
        const body = { DeviceProfile: aacOnly, MaxStreamingBitrate: 100_000_000 };
        // Default audio (idx 1) is AC3 — not playable directly.
        expect((await playbackInfo('?SubtitleStreamIndex=-1', body)).SupportsDirectPlay).toBe(
            false,
        );
        expect(
            (await playbackInfo('?AudioStreamIndex=2&SubtitleStreamIndex=-1', body))
                .SupportsDirectPlay,
        ).toBe(true);
    });

    it('takes StartTimeTicks from the query', async () => {
        const source = await playbackInfo('?StartTimeTicks=600000000');
        expect(transcodingParams(source).get('StartTimeTicks')).toBe('600000000');
    });

    it('ignores malformed query numbers and falls back to the body', async () => {
        const source = await playbackInfo('?AudioStreamIndex=0x2&MaxAudioChannels=2abc', {
            DeviceProfile: REPRO_PROFILE,
            AudioStreamIndex: 2,
        });
        const params = transcodingParams(source);
        expect(params.get('AudioStreamIndex')).toBe('2');
        expect(params.get('TranscodingMaxAudioChannels')).toBe('2'); // the profile's, untouched
    });

    it('treats a null body index as absent (never AudioStreamIndex=null)', async () => {
        const source = await playbackInfo('', {
            DeviceProfile: REPRO_PROFILE,
            AudioStreamIndex: null,
            SubtitleStreamIndex: null,
        });
        expect(source.TranscodingUrl).not.toContain('null');
        expect(transcodingParams(source).get('AudioStreamIndex')).toBe('1');
    });

    it('clamps the channel cap to the server maximum', async () => {
        const profile = {
            ...REPRO_PROFILE,
            TranscodingProfiles: [
                { ...REPRO_PROFILE.TranscodingProfiles[0], MaxAudioChannels: '16' },
            ],
        };
        const source = await playbackInfo('', { DeviceProfile: profile });
        expect(transcodingParams(source).get('TranscodingMaxAudioChannels')).toBe('8');
    });

    it('burns in a default-flagged subtitle when the client names none (Jellyfin default selection)', async () => {
        mockGetStreamsForFile.mockResolvedValue(
            STREAMS.map((s) => (s.stream_index === 3 ? { ...s, is_default: true } : s)),
        );
        const source = await playbackInfo('');
        expect(source.DefaultSubtitleStreamIndex).toBe(3);
        expect(transcodingParams(source).get('SubtitleMethod')).toBe('Encode');
    });

    it('does not report or burn in a SubtitleStreamIndex that is not a subtitle', async () => {
        const source = await playbackInfo('?SubtitleStreamIndex=1');
        expect(source.DefaultSubtitleStreamIndex).toBeUndefined();
        expect(transcodingParams(source).has('SubtitleStreamIndex')).toBe(false);
    });

    // Our engine burns in only EMBEDDED BITMAP tracks. Encode for anything else
    // would rule out direct play and still show nothing (Opus review 2026-10-02).
    it('an external image sidecar the client would need burned in is left as it was', async () => {
        mockGetStreamsForFile.mockResolvedValue([
            ...STREAMS,
            row({
                stream_index: 5,
                stream_type: 'subtitle',
                codec: 'hdmv_pgs_subtitle',
                is_text_subtitle: false,
                is_external: true,
            }),
        ]);
        const source = await playbackInfo('?SubtitleStreamIndex=5');
        const sidecar = source.MediaStreams!.find((s) => s.Index === 5)!;
        expect(sidecar.DeliveryMethod).toBe('External');
        expect(sidecar.DeliveryUrl).toContain('/Subtitles/5/');
        const params = transcodingParams(source);
        expect(params.has('SubtitleMethod')).toBe(false);
        expect(params.has('SubtitleStreamIndex')).toBe(false);
    });

    it('an ASS track the client cannot embed goes out as a converted sidecar, never as a burn-in', async () => {
        mockGetStreamsForFile.mockResolvedValue([
            ...STREAMS,
            row({
                stream_index: 6,
                stream_type: 'subtitle',
                codec: 'ass',
                is_text_subtitle: true,
                language: 'eng',
            }),
        ]);
        const source = await playbackInfo('?SubtitleStreamIndex=6');
        const ass = source.MediaStreams!.find((s) => s.Index === 6)!;
        expect(ass.DeliveryMethod).toBe('External');
        expect(ass.DeliveryUrl).toContain('/Subtitles/6/0/Stream.srt');
        expect(transcodingParams(source).has('SubtitleMethod')).toBe(false);
    });

    it('selecting an ASS track does not rule out direct play', async () => {
        mockGetStreamsForFile.mockResolvedValue([
            ...STREAMS,
            row({
                stream_index: 6,
                stream_type: 'subtitle',
                codec: 'ass',
                is_text_subtitle: true,
            }),
        ]);
        const mkvProfile = {
            ...REPRO_PROFILE,
            Name: 'Swiftfin',
            DirectPlayProfiles: [
                { Container: 'mkv', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'ac3,aac' },
            ],
        };
        const source = await playbackInfo('?SubtitleStreamIndex=6', {
            DeviceProfile: mkvProfile,
            MaxStreamingBitrate: 100_000_000,
        });
        expect(source.SupportsDirectPlay).toBe(true);
    });

    it('survives a file with no container extension', async () => {
        mockGetFilesForMediaItem.mockResolvedValue([
            {
                id: FILE_ID,
                file_path: '/data/movies/Film',
                file_size_bytes: '1',
                total_bitrate: null,
            },
        ]);
        const profile = {
            ...REPRO_PROFILE,
            SubtitleProfiles: [{ Format: 'pgssub', Method: 'Embed', Container: 'mkv' }],
        };
        const source = await playbackInfo('?SubtitleStreamIndex=3', { DeviceProfile: profile });
        expect(transcodingParams(source).get('SubtitleMethod')).toBe('Encode');
    });

    it('audio-only items: no VideoCodec, no DefaultAudioStreamIndex, the Audio profile cap', async () => {
        mockGetFilesForMediaItem.mockResolvedValue([
            {
                id: FILE_ID,
                file_path: '/data/music/a.flac',
                file_size_bytes: '1',
                total_bitrate: null,
            },
        ]);
        mockGetStreamsForFile.mockResolvedValue([
            row({
                stream_index: 0,
                stream_type: 'audio',
                codec: 'flac',
                channels: 6,
                is_default: true,
            }),
        ]);
        const profile = {
            ...REPRO_PROFILE,
            Name: 'Swiftfin',
            DirectPlayProfiles: [{ Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3' }],
            TranscodingProfiles: [
                ...REPRO_PROFILE.TranscodingProfiles,
                {
                    Container: 'ts',
                    Type: 'Audio',
                    AudioCodec: 'aac',
                    Context: 'Streaming',
                    Protocol: 'hls',
                    MaxAudioChannels: '1',
                },
            ],
        };
        const source = await playbackInfo('', { DeviceProfile: profile });
        const params = transcodingParams(source);
        expect(params.has('VideoCodec')).toBe(false);
        expect(params.get('TranscodingMaxAudioChannels')).toBe('1');
        expect(source.DefaultAudioStreamIndex).toBeUndefined();
    });
});

// Captured jellyfin-web 12.4 profile from failure-reproductions.json (2026-10-29).
// It includes MKV, despite the report summary. The browser transport needs HLS
// for this raw Matroska response; native MKV-capable clients keep direct play.
describe('third-party transport negotiation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetFilesForMediaItem.mockResolvedValue([
            {
                id: FILE_ID,
                file_path: '/data/movies/Film.mkv',
                file_size_bytes: '2068652',
                total_bitrate: '137883',
            },
        ]);
        mockGetStreamsForFile.mockResolvedValue([
            row({
                stream_index: 0,
                stream_type: 'video',
                codec: 'h264',
                profile: 'High',
                level: 30,
                video_range_type: 'SDR',
            }),
            row({ stream_index: 1, stream_type: 'audio', codec: 'aac', channels: 2 }),
        ]);
    });

    it('the exact captured Web DeviceProfile selects an HLS URL', async () => {
        const source = await playbackInfo('', { DeviceProfile: webDeviceProfile });
        expect(source.SupportsDirectPlay).toBe(false);
        expect(source.SupportsDirectStream).toBe(false);
        expect(source.TranscodingUrl).toContain('/master.m3u8?');
        expect(source.TranscodingSubProtocol).toBe('hls');
        expect(transcodingParams(source).get('VideoCodec')).toBe('h264');
        expect(transcodingParams(source).get('AudioCodec')).toBe('aac');
    });

    for (const client of ['Infuse', 'Swiftfin', 'Streamyfin']) {
        it(`${client} with MKV support gets direct play without HLS metadata`, async () => {
            const e = makeEvent('', {
                DeviceProfile: {
                    ...webDeviceProfile,
                    Name: client,
                    DirectPlayProfiles: [
                        { Container: 'mkv', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac' },
                    ],
                },
            });
            const response = await POST(e);
            const source = ((await response.json()) as JellyfinPlaybackInfoResponse)
                .MediaSources[0];
            expect(source.SupportsDirectPlay).toBe(true);
            expect(source.DirectStreamUrl).toContain('/stream?static=true');
            expect(source.TranscodingUrl).toBeUndefined();
            expect(source.TranscodingSubProtocol).toBe('http');
            expect(source.TranscodingContainer).toBeUndefined();
        });
    }

    for (const mismatch of ['container', 'video', 'audio', 'type']) {
        it(`a ${mismatch} mismatch cannot select direct play`, async () => {
            const dp = {
                Container: mismatch === 'container' ? 'mp4' : 'mkv',
                Type: mismatch === 'type' ? 'Audio' : 'Video',
                VideoCodec: mismatch === 'video' ? 'hevc' : 'h264',
                AudioCodec: mismatch === 'audio' ? 'ac3' : 'aac',
            };
            const e = makeEvent('', {
                DeviceProfile: { ...webDeviceProfile, Name: 'Infuse', DirectPlayProfiles: [dp] },
            });
            const source = ((await (await POST(e)).json()) as JellyfinPlaybackInfoResponse)
                .MediaSources[0];
            expect(source.SupportsDirectPlay).toBe(false);
            if (mismatch === 'container') {
                expect(source.SupportsDirectStream).toBe(true);
                expect(source.DirectStreamUrl).toContain('static=false');
                expect(source.TranscodingUrl).toBeUndefined();
            } else {
                expect(source.TranscodingUrl).toContain('/master.m3u8?');
            }
        });
    }

    it('honours EnableDirectPlay=false for a compatible source', async () => {
        const e = makeEvent('', {
            DeviceProfile: { ...webDeviceProfile, Name: 'Infuse' },
            EnableDirectPlay: false,
        });
        const source = ((await (await POST(e)).json()) as JellyfinPlaybackInfoResponse)
            .MediaSources[0];
        expect(source.SupportsDirectPlay).toBe(false);
        expect(source.TranscodingUrl).toContain('/master.m3u8?');
    });
});

describe('review regressions: covers, refusal and copy-only remux', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetFilesForMediaItem.mockResolvedValue([
            {
                id: FILE_ID,
                file_path: '/media/film.avi',
                total_bitrate: '3000000',
                file_size_bytes: '1000000',
            },
        ]);
        mockGetStreamsForFile.mockResolvedValue([
            row({
                stream_index: 0,
                stream_type: 'video',
                codec: 'h264',
                profile: 'High',
                level: 40,
                width: 1280,
                height: 720,
            }),
            row({
                stream_index: 1,
                stream_type: 'audio',
                codec: 'aac',
                channels: 2,
                is_default: true,
            }),
        ]);
    });

    for (const [container, codec] of [
        ['mp3', 'mp3'],
        ['flac', 'flac'],
        ['m4a', 'aac'],
        ['m4b', 'aac'],
    ]) {
        for (const cover of ['mjpeg', 'png']) {
            it(`${container} with a stored ${cover} cover uses the Audio profile`, async () => {
                mockGetFilesForMediaItem.mockResolvedValue([
                    {
                        id: FILE_ID,
                        file_path: `/music/album/track.${container}`,
                        total_bitrate: '320000',
                        file_size_bytes: '1000000',
                    },
                ]);
                mockGetStreamsForFile.mockResolvedValue([
                    row({
                        stream_index: 0,
                        stream_type: 'audio',
                        codec,
                        channels: 2,
                        is_default: true,
                    }),
                    row({
                        stream_index: 1,
                        stream_type: 'video',
                        codec: cover,
                        width: 1200,
                        height: 1200,
                    }),
                ]);
                const source = await playbackInfo('', {
                    DeviceProfile: {
                        Name: 'Music client',
                        DirectPlayProfiles: [
                            { Type: 'Audio', Container: container, AudioCodec: codec },
                        ],
                        TranscodingProfiles: [],
                        CodecProfiles: [],
                        SubtitleProfiles: [],
                    },
                });
                expect(source.SupportsDirectPlay).toBe(true);
                expect(source.TranscodingUrl).toBeUndefined();
                expect(source.DirectStreamUrl).toContain('/Audio/');
            });
        }
    }

    for (const reason of ['disabled direct play', 'unsupported video', 'web MKV']) {
        it(`${reason}, transcoding disabled: explicit SDK-compatible refusal`, async () => {
            mockGetFilesForMediaItem.mockResolvedValue([
                { id: FILE_ID, file_path: '/media/film.mkv', total_bitrate: '3000000' },
            ]);
            const body = {
                DeviceProfile: {
                    ...webDeviceProfile,
                    Name: reason === 'web MKV' ? 'Jellyfin Web' : 'Native client',
                    ...(reason !== 'web MKV'
                        ? {
                              DirectPlayProfiles: [
                                  {
                                      Type: 'Video',
                                      Container: 'mkv',
                                      VideoCodec: reason === 'unsupported video' ? 'hevc' : 'h264',
                                      AudioCodec: 'aac',
                                  },
                              ],
                          }
                        : {}),
                },
                EnableTranscoding: false,
                ...(reason === 'disabled direct play' ? { EnableDirectPlay: false } : {}),
            };
            const response = await POST(makeEvent('', body));
            expect(response.status).toBe(200);
            const result = (await response.json()) as JellyfinPlaybackInfoResponse;
            expect(result.ErrorCode).toBe('NoCompatibleStream');
            expect(result.MediaSources).toEqual([]);
            expect(result.PlaySessionId).toBeTruthy();
        });
    }

    for (const subtitle of ['bitmap', 'sidecar']) {
        it(`remux preserves the selected ${subtitle} subtitle delivery`, async () => {
            mockGetStreamsForFile.mockResolvedValue([
                row({
                    stream_index: 0,
                    stream_type: 'video',
                    codec: 'h264',
                    width: 1280,
                    height: 720,
                }),
                row({
                    stream_index: 1,
                    stream_type: 'audio',
                    codec: 'aac',
                    channels: 2,
                    is_default: true,
                }),
                row({
                    stream_index: 2,
                    stream_type: 'subtitle',
                    codec: subtitle === 'bitmap' ? 'hdmv_pgs_subtitle' : 'subrip',
                    is_text_subtitle: subtitle !== 'bitmap',
                }),
            ]);
            const source = await playbackInfo('', {
                DeviceProfile: {
                    Name: 'Infuse',
                    DirectPlayProfiles: [
                        {
                            Type: 'Video',
                            Container: 'mkv,mp4',
                            VideoCodec: 'h264',
                            AudioCodec: 'aac',
                        },
                    ],
                    SubtitleProfiles: [
                        {
                            Format: subtitle === 'bitmap' ? 'pgssub' : 'srt',
                            Method: subtitle === 'bitmap' ? 'Embed' : 'External',
                        },
                    ],
                },
                SubtitleStreamIndex: 2,
            });
            expect(source.SupportsDirectStream).toBe(subtitle === 'sidecar');
            if (subtitle === 'bitmap')
                expect(source.TranscodingUrl).toContain('SubtitleMethod=Encode');
            else
                expect(
                    source.MediaStreams?.find((stream) => stream.Index === 2)?.DeliveryUrl,
                ).toContain('/Subtitles/2/0/Stream.srt');
        });
    }

    for (const constraint of [
        'audio codec',
        'video level',
        'channel cap',
        'request disables direct stream',
    ]) {
        it(`does not call an incompatible path a remux: ${constraint}`, async () => {
            const response = await POST(
                makeEvent('', {
                    DeviceProfile: {
                        Name: 'Infuse',
                        DirectPlayProfiles: [
                            {
                                Type: 'Video',
                                Container: 'mp4',
                                VideoCodec: 'h264',
                                AudioCodec: constraint === 'audio codec' ? 'ac3' : 'aac',
                            },
                        ],
                        CodecProfiles:
                            constraint === 'video level'
                                ? [
                                      {
                                          Type: 'Video',
                                          Codec: 'h264',
                                          Conditions: [
                                              {
                                                  Condition: 'LessThanEqual',
                                                  Property: 'VideoLevel',
                                                  Value: '30',
                                              },
                                          ],
                                      },
                                  ]
                                : [],
                    },
                    EnableTranscoding: false,
                    ...(constraint === 'channel cap' ? { MaxAudioChannels: 1 } : {}),
                    ...(constraint === 'request disables direct stream'
                        ? { EnableDirectStream: false }
                        : {}),
                }),
            );
            const result = (await response.json()) as JellyfinPlaybackInfoResponse;
            expect(result.ErrorCode).toBe('NoCompatibleStream');
            expect(result.MediaSources).toEqual([]);
        });
    }

    for (const [client, input, video, audio, containers] of [
        ['Infuse', 'avi', 'h264', 'aac', 'mkv,mp4'],
        ['Infuse', 'ts', 'hevc', 'eac3', 'mkv,mp4'],
        ['Swiftfin', 'avi', 'h264', 'ac3', 'mp4'],
        ['Swiftfin', 'mkv', 'hevc', 'aac', 'mp4'],
        ['DTS client', 'avi', 'h264', 'dts', 'mkv'],
    ]) {
        it(`${client}: ${input} ${video}/${audio} selects a copy-only HTTP remux`, async () => {
            mockGetFilesForMediaItem.mockResolvedValue([
                { id: FILE_ID, file_path: `/media/film.${input}`, total_bitrate: '3000000' },
            ]);
            mockGetStreamsForFile.mockResolvedValue([
                row({
                    stream_index: 0,
                    stream_type: 'video',
                    codec: video,
                    width: 1280,
                    height: 720,
                }),
                row({
                    stream_index: 1,
                    stream_type: 'audio',
                    codec: audio,
                    channels: 2,
                    is_default: true,
                }),
            ]);
            const source = await playbackInfo('', {
                DeviceProfile: {
                    Name: client,
                    DirectPlayProfiles: [
                        {
                            Type: 'Video',
                            Container: containers,
                            VideoCodec: 'hevc,h264',
                            AudioCodec: 'aac,ac3,eac3,dts',
                        },
                    ],
                    TranscodingProfiles: [],
                    CodecProfiles: [],
                    SubtitleProfiles: [],
                },
                EnableTranscoding: false,
            });
            expect(source.SupportsDirectPlay).toBe(false);
            expect(source.SupportsDirectStream).toBe(true);
            expect(source.TranscodingUrl).toBeUndefined();
            expect(source.TranscodingSubProtocol).toBe('http');
            const url = new URL(source.DirectStreamUrl!, 'https://media.example');
            expect(url.searchParams.get('static')).toBe('false');
            const { parseProgressiveRequest, planProgressiveTranscode, buildProgressiveArgs } =
                await import('$lib/server/proprietary/jellyfin-compat/progressive-transcode');
            const request = parseProgressiveRequest(url.searchParams);
            expect(request).not.toBeNull();
            const plan = planProgressiveTranscode(request!, {
                container: input,
                video: { codec: video, width: 1280, height: 720, bitrate: null, isHdr: false },
                audio: [{ index: 1, codec: audio, channels: 2, isDefault: true }],
            });
            expect(plan).toMatchObject({
                kind: 'transcode',
                video: { mode: 'copy' },
                audio: { mode: 'copy' },
            });
            if (plan.kind !== 'transcode') throw new Error('expected remux');
            const args = buildProgressiveArgs(plan, '/media/film.avi', null);
            expect(args.join(' ')).toContain('-c:v copy');
            expect(args.join(' ')).toContain('-c:a copy');
        });
    }
});
