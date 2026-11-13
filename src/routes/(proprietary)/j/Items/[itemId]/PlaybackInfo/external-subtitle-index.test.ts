// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// External subtitle files (external_subtitle_files rows) in /j PlaybackInfo.
// PlaybackInfo numbered them max(stream Index) + 1, + 2, …, but the /Subtitles
// route (resolveSubtitle with a fileId) reads indices >= 1000 as sidecars at
// position index - 1000 and anything lower as an embedded stream. Every
// sidecar DeliveryUrl was a 404 (code review 2026-10-02). These tests pin the
// one scheme, 1000 + position, from PlaybackInfo through the /Subtitles route
// and the real resolver to the file on disk.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSubtitleRow } from '$lib/server/database/queries/external-subtitles.queries';
import type { MediaStreamRow } from '$lib/server/database/queries/media-streams.queries';
import type {
    JellyfinMediaSourceInfo,
    JellyfinPlaybackInfoResponse,
} from '$lib/server/proprietary/jellyfin-compat/types';

vi.setConfig({ testTimeout: 30_000 });

const {
    mockGetStreamsForFile,
    mockGetFilesForMediaItem,
    mockGetExternalSubtitlesForFile,
    mockExtractSubtitleStream,
    ITEM_ID,
} = vi.hoisted(() => ({
    mockGetStreamsForFile: vi.fn(),
    mockGetFilesForMediaItem: vi.fn(),
    mockGetExternalSubtitlesForFile: vi.fn(),
    mockExtractSubtitleStream: vi.fn(),
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
    getExternalSubtitlesForFile: mockGetExternalSubtitlesForFile,
    getExternalSubtitlesForMediaItem: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
    userNeedsMediaAccessCheck: vi.fn().mockResolvedValue(false),
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
// The resolver's own I/O edges: the media-store gate (a temp dir is no
// library root), the disk cache tier and FFmpeg, which a .vtt sidecar never needs.
vi.mock('$lib/server/utils/media-path-resolver', () => ({
    isPathWithinMediaStore: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/services/cache/subtitle-file-cache.service', () => ({
    SubtitleFileCacheService: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        getBinary: vi.fn().mockResolvedValue(null),
        setBinary: vi.fn().mockResolvedValue(undefined),
        hasFreshBinary: vi.fn().mockResolvedValue(false),
    },
}));
vi.mock('$lib/server/utils/ffmpeg-subtitle-extractor', () => ({
    extractSubtitleStream: mockExtractSubtitleStream,
    extractSubtitleStreamBinary: vi.fn(),
    extractSubtitleStreamsBinary: vi.fn(),
    FFmpegTimeoutError: class FFmpegTimeoutError extends Error {},
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

import { POST } from './+server';
import { GET as getSubtitle } from '../../../Videos/[itemId]/[mediaSourceId]/Subtitles/[subtitleIndex]/[segmentIndex]/[...streamFile]/+server';
import { clearSubtitleCache } from '$lib/server/services/subtitle-resolver.service';

const FILE_ID = '4f1e2d3c-5b6a-4789-8abc-def012345678';
const DE_VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHallo Welt\n';
const FR_VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n';
const EN_VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n';
const EN_FORCED_VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSigns only\n';

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

// h264 + aac + an embedded SRT at index 2 and an Imported-from-Jellyfin
// external English row at index 3: the old numbering put the first sidecar at 4.
const STREAMS: MediaStreamRow[] = [
    row({ stream_index: 0, stream_type: 'video', codec: 'h264', profile: 'High', level: 40 }),
    row({ stream_index: 1, stream_type: 'audio', codec: 'aac', channels: 2, is_default: true }),
    row({
        stream_index: 2,
        stream_type: 'subtitle',
        codec: 'subrip',
        is_text_subtitle: true,
        language: 'ger',
    }),
    row({
        stream_index: 3,
        stream_type: 'subtitle',
        codec: 'subrip',
        is_text_subtitle: true,
        is_external: true,
        // Jellyfin's three-letter code; the sidecar's filename token is "en".
        language: 'eng',
    }),
];

const PROFILE = {
    Name: 'Jellyfin Web',
    MaxStreamingBitrate: 8_000_000,
    DirectPlayProfiles: [
        { Container: 'mkv', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac' },
    ],
    TranscodingProfiles: [
        { Container: 'ts', Type: 'Video', AudioCodec: 'aac', VideoCodec: 'h264', Protocol: 'hls' },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }],
};

let dir: string;
let sidecars: ExternalSubtitleRow[];

function sidecar(file: string, language: string, isForced = false): ExternalSubtitleRow {
    return {
        id: `sub-${file}`,
        file_id: FILE_ID,
        subtitle_path: path.join(dir, file),
        language,
        format: 'vtt',
        is_forced: isForced,
        is_sdh: false,
        created_at: new Date(),
        updated_at: new Date(),
    } as ExternalSubtitleRow;
}

beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'jf-ext-subs-'));
    await writeFile(path.join(dir, 'Film.de.vtt'), DE_VTT);
    await writeFile(path.join(dir, 'Film.en.vtt'), EN_VTT);
    await writeFile(path.join(dir, 'Film.en.forced.vtt'), EN_FORCED_VTT);
    await writeFile(path.join(dir, 'Film.fr.vtt'), FR_VTT);
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function playbackInfo(query = ''): Promise<JellyfinMediaSourceInfo> {
    const url = `https://example.test/j/Items/${ITEM_ID}/PlaybackInfo${query}`;
    const event = {
        params: { itemId: ITEM_ID },
        url: new URL(url),
        request: new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ DeviceProfile: PROFILE }),
        }),
        locals: {
            user: { userId: '00000000-0000-0000-0000-000000000001', username: 'aleks' },
            jfClientName: 'Jellyfin Web',
        },
        cookies: { get: vi.fn(), set: vi.fn() },
    } as unknown as RequestEvent;
    const response = await (POST as unknown as (e: RequestEvent) => Promise<Response>)(event);
    expect(response.status).toBe(200);
    return ((await response.json()) as JellyfinPlaybackInfoResponse).MediaSources[0];
}

/** Fetch a DeliveryUrl through the /j Subtitles route, as a client would. */
async function fetchDeliveryUrl(deliveryUrl: string): Promise<Response> {
    const url = new URL(`/j${deliveryUrl}`, 'https://example.test');
    const m = url.pathname.match(/^\/j\/Videos\/([^/]+)\/([^/]+)\/Subtitles\/(\d+)\/(\d+)\/(.+)$/);
    expect(m).not.toBeNull();
    const [, itemId, mediaSourceId, subtitleIndex, segmentIndex, streamFile] = m!;
    const event = {
        params: { itemId, mediaSourceId, subtitleIndex, segmentIndex, streamFile },
        url,
        request: new Request(url),
        locals: { user: { userId: 'u', username: 'aleks' } },
    } as unknown as RequestEvent;
    return (getSubtitle as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('/j PlaybackInfo external subtitle files: 1000 + position', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearSubtitleCache();
        mockGetFilesForMediaItem.mockResolvedValue([
            {
                id: FILE_ID,
                file_path: path.join(dir ?? '/x', 'Film.mkv'),
                file_size_bytes: '4000000000',
                total_bitrate: '4000000',
            },
        ]);
        mockGetStreamsForFile.mockResolvedValue(STREAMS);
        // getExternalSubtitlesForFile order: de, en, en forced, fr. The full
        // "en" is the one the external stream row 3 ("eng") lists, so it is
        // skipped but keeps its position; the forced "en" is a track of its own.
        sidecars = [
            sidecar('Film.de.vtt', 'de'),
            sidecar('Film.en.vtt', 'en'),
            sidecar('Film.en.forced.vtt', 'en', true),
            sidecar('Film.fr.vtt', 'fr'),
        ];
        mockGetExternalSubtitlesForFile.mockResolvedValue(sidecars);
    });

    it('numbers sidecars 1000 + their position in the file list, skipped duplicates included', async () => {
        const source = await playbackInfo();
        const external = source.MediaStreams!.filter(
            (s) => s.Type === 'Subtitle' && s.Index >= 1000,
        );

        expect(external.map((s) => [s.Index, s.Language])).toEqual([
            [1000, 'de'],
            [1002, 'en'],
            [1003, 'fr'],
        ]);
        expect(external.find((s) => s.Index === 1002)?.IsForced).toBe(true);
        for (const s of external) {
            expect(s.DeliveryMethod).toBe('External');
            expect(s.DeliveryUrl).toBe(
                `/Videos/${ITEM_ID}/${FILE_ID}/Subtitles/${s.Index}/0/Stream.vtt?api_key=jf-token`,
            );
        }
    });

    // jellyfin-sdk-kotlin 1.7 (jellyfin-androidtv 0.19) declares these non-null
    // without a default: one stream missing any of them fails the decode of the
    // whole PlaybackInfo, and the app swallows the error and never starts playing.
    // Prod 2026-10-06: every episode with a sidecar .srt hung on Android TV.
    // IsOriginal joined the list in sdk 1.9 (spec 12.2).
    it('every MediaStream carries the booleans the Kotlin SDK requires', async () => {
        sidecars[0] = { ...sidecars[0], is_sdh: true };
        const source = await playbackInfo();

        expect(source.MediaStreams!.some((s) => s.Index >= 1000)).toBe(true);
        for (const s of source.MediaStreams!) {
            for (const key of [
                'IsInterlaced',
                'IsDefault',
                'IsForced',
                'IsHearingImpaired',
                'IsOriginal',
                'IsExternal',
                'IsTextSubtitleStream',
                'SupportsExternalStream',
            ] as const) {
                expect(typeof s[key], `${key} on stream ${s.Index}`).toBe('boolean');
            }
        }
        expect(source.MediaStreams!.find((s) => s.Index === 1000)?.IsHearingImpaired).toBe(true);
    });

    it('every sidecar DeliveryUrl serves its own file through the /Subtitles route', async () => {
        const source = await playbackInfo();
        const byLang = new Map(
            source.MediaStreams!.filter((s) => s.Index >= 1000).map((s) => [s.Language, s]),
        );

        const de = await fetchDeliveryUrl(byLang.get('de')!.DeliveryUrl!);
        expect(de.status).toBe(200);
        expect(await de.text()).toBe(DE_VTT);

        const enForced = await fetchDeliveryUrl(byLang.get('en')!.DeliveryUrl!);
        expect(enForced.status).toBe(200);
        expect(await enForced.text()).toBe(EN_FORCED_VTT);

        const fr = await fetchDeliveryUrl(byLang.get('fr')!.DeliveryUrl!);
        expect(fr.status).toBe(200);
        expect(await fr.text()).toBe(FR_VTT);

        expect(mockExtractSubtitleStream).not.toHaveBeenCalled();
    });

    it('an external media_streams row (Jellyfin import) is served from the sidecar, not the video', async () => {
        const source = await playbackInfo();
        const imported = source.MediaStreams!.find((s) => s.Index === 3)!;
        expect(imported.DeliveryMethod).toBe('External');

        // The "eng" row is the full English sidecar, not the file's first one.
        const res = await fetchDeliveryUrl(imported.DeliveryUrl!);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(EN_VTT);
        expect(mockExtractSubtitleStream).not.toHaveBeenCalled();
    });

    it('an external row with no sidecar of its language is a 404, not another language', async () => {
        mockGetStreamsForFile.mockResolvedValue([
            ...STREAMS.slice(0, 3),
            row({
                stream_index: 3,
                stream_type: 'subtitle',
                codec: 'subrip',
                is_text_subtitle: true,
                is_external: true,
                language: 'jpn',
            }),
        ]);
        const source = await playbackInfo();
        const res = await fetchDeliveryUrl(
            source.MediaStreams!.find((s) => s.Index === 3)!.DeliveryUrl!,
        );
        expect(res.status).toBe(404);
        // Nothing paired, so every sidecar is listed.
        expect(source.MediaStreams!.filter((s) => s.Index >= 1000).map((s) => s.Index)).toEqual([
            1000, 1001, 1002, 1003,
        ]);
    });

    it('SubtitleStreamIndex 1000 + n selects that sidecar as the default track', async () => {
        const source = await playbackInfo('?SubtitleStreamIndex=1003');
        expect(source.DefaultSubtitleStreamIndex).toBe(1003);
        const params = new URL(source.TranscodingUrl!, 'https://example.test').searchParams;
        // A sidecar is fetched by the client, never burned in.
        expect(params.has('SubtitleStreamIndex')).toBe(false);
        expect(params.has('SubtitleMethod')).toBe(false);
    });
});
