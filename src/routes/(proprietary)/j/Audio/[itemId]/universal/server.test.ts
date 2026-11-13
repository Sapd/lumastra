// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * GET|HEAD /j/Audio/{itemId}/universal — which delivery each decision reaches.
 * The decision itself is tested in universal-audio.test.ts; the direct-play
 * case also runs against a real file in the contract suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestHandler } from './$types';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

const fakeSql = {};
vi.mock('$lib/server/database', () => ({ getDb: () => fakeSql }));

const mockCheckMediaAccess = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
}));

const mockDisarm = vi.fn(async () => undefined);
vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    disarmSilentStart: (...a: unknown[]) => mockDisarm(...(a as [])),
}));

const mockHandleStreamFile = vi.fn();
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-file-handler', () => ({
    handleStreamFile: (...a: unknown[]) => mockHandleStreamFile(...a),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    validatePlayToken: async (t: string) => (t === 'file-token' ? { fileId: FILE_B } : null),
}));

const mockResolvePlaybackSelection = vi.fn();
vi.mock('$lib/server/database/queries/media-file-resolution.queries', () => ({
    resolvePlaybackSelection: (...a: unknown[]) => mockResolvePlaybackSelection(...a),
}));

const mockGetStreamsForFile = vi.fn();
vi.mock('$lib/server/database/queries/media-streams.queries', () => ({
    getStreamsForFile: (...a: unknown[]) => mockGetStreamsForFile(...a),
}));

vi.mock('$lib/server/utils/media-path-resolver', () => ({
    resolveMediaPath: async (p: string) => ({ isAccessible: true, containerPath: p, fileSize: 10 }),
}));

vi.mock('node:fs/promises', () => ({ stat: async () => ({ mtimeMs: 1234 }) }));

const cfg = { FEATURE_MUSIC_TRANSCODE: true };
const feat = { ffmpegAvailable: true };
vi.mock('$lib/server/config', () => ({ config: cfg, features: feat }));

const mockStreamFor = vi.fn();
vi.mock('$lib/server/services/music-transcode/index', () => ({
    getMusicTranscodeService: () => ({ streamFor: (...a: unknown[]) => mockStreamFor(...a) }),
    clampBitrate: (_c: string, kbps: number) => Math.min(kbps, 320),
    defaultBitrateFor: () => 192,
    mimeFor: (c: string) => (c === 'mp3' ? 'audio/mpeg' : 'audio/aac'),
}));

const mockCheckSessionKickCooldown = vi.fn();
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: (...a: unknown[]) => mockCheckSessionKickCooldown(...a),
}));

const { GET, HEAD } = await import('./+server.js');

const ITEM_ID = '00000000-0000-4000-a000-000000000001';
const FILE_A = '00000000-0000-4000-a000-0000000000fa';
const FILE_B = '00000000-0000-4000-a000-0000000000fb';
const USER = { userId: 'uid-alice', username: 'alice' };

let audioCodecA = 'flac';
let sampleRateA = 44_100;
const FILES = {
    [FILE_A]: { id: FILE_A, file_path: '/music/a.flac', total_bitrate: 900_000 },
    [FILE_B]: { id: FILE_B, file_path: '/music/b.mp3', total_bitrate: 320_000 },
};

function makeEvent(query: string, opts: { fetch?: typeof fetch; method?: string } = {}) {
    const url = new URL(`https://app.example/j/Audio/${ITEM_ID}/universal${query}`);
    return {
        request: new Request(url, {
            method: opts.method ?? 'GET',
            headers: {
                'x-emby-authorization': 'MediaBrowser Token="tok"',
                'x-forwarded-for': '203.0.113.7, 10.0.0.2',
                'x-real-ip': '203.0.113.7',
                forwarded: 'for=203.0.113.7',
            },
        }),
        url,
        params: { itemId: ITEM_ID },
        locals: { user: USER, jfDevice: { deviceId: 'dev-1' }, jfToken: 'tok' },
        fetch: opts.fetch ?? vi.fn(),
    } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
    cfg.FEATURE_MUSIC_TRANSCODE = true;
    feat.ffmpegAvailable = true;
    audioCodecA = 'flac';
    sampleRateA = 44_100;
    FILES[FILE_A].file_path = '/music/a.flac';
    mockCheckMediaAccess.mockResolvedValue(true);
    mockCheckSessionKickCooldown.mockResolvedValue({ kicked: false });
    mockResolvePlaybackSelection.mockImplementation(
        async (_sql: unknown, _id: string, opts?: { fileId?: string }) => {
            const id = opts?.fileId ?? FILE_A;
            const f = FILES[id as keyof typeof FILES];
            return f ? { files: [f], fileId: id } : { files: [], fileId: null };
        },
    );
    mockGetStreamsForFile.mockImplementation(async (_sql: unknown, fileId: string) => [
        {
            stream_type: 'audio',
            is_external: false,
            is_default: true,
            codec: fileId === FILE_A ? audioCodecA : 'mp3',
            sample_rate: fileId === FILE_A ? sampleRateA : 44_100,
            channels: 2,
            bit_depth: fileId === FILE_A ? 16 : null,
            bitrate: null,
        },
    ]);
    mockHandleStreamFile.mockResolvedValue(
        new Response('bytes', { status: 206, headers: { 'Content-Type': 'audio/flac' } }),
    );
});

describe('GET /j/Audio/{itemId}/universal', () => {
    it('direct-plays a listed container through handleStreamFile, and disarms the detector', async () => {
        const ev = makeEvent('?container=flac,mp3&PlaySessionId=ps1&deviceId=d-q');
        const res = await GET!(ev);

        expect(res.status).toBe(206);
        expect(mockHandleStreamFile).toHaveBeenCalledTimes(1);
        const passed = mockHandleStreamFile.mock.calls[0][0] as { url: URL };
        expect(passed.url.searchParams.get('mediaSourceId')).toBe(FILE_A);
        expect(mockDisarm).toHaveBeenCalledWith({
            playSessionId: 'ps1',
            username: 'alice',
            itemId: ITEM_ID,
            userId: 'uid-alice',
            deviceId: 'dev-1',
        });
        expect(mockStreamFor).not.toHaveBeenCalled();
    });

    it('serves the version a file token names', async () => {
        await GET!(makeEvent('?container=mp3&mediaSourceId=file-token'));
        const passed = mockHandleStreamFile.mock.calls[0][0] as { url: URL };
        expect(passed.url.searchParams.get('mediaSourceId')).toBe(FILE_B);
    });

    it('is a 404 when the item is not accessible, and touches nothing', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await GET!(makeEvent('?container=flac'));
        expect(res.status).toBe(404);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
        expect(mockDisarm).not.toHaveBeenCalled();
    });

    it('answers the HLS master playlist in place for transcodingProtocol=hls', async () => {
        const fetchMock = vi.fn(
            async () =>
                new Response('#EXTM3U\n/j/Videos/x/hls/0.ts\n', {
                    status: 200,
                    headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
                }),
        );
        const res = await GET!(
            makeEvent(
                '?container=mp3&transcodingContainer=ts&transcodingProtocol=hls&audioCodec=aac&maxStreamingBitrate=192000&PlaySessionId=ps1&startTimeTicks=300000000',
                { fetch: fetchMock as unknown as typeof fetch },
            ),
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
        expect(await res.text()).toContain('#EXTM3U');
        const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const u = new URL(target, 'https://app.example');
        expect(u.pathname).toBe(`/j/Videos/${ITEM_ID}/master.m3u8`);
        expect(Object.fromEntries(u.searchParams)).toEqual({
            PlaySessionId: 'ps1',
            MediaSourceId: FILE_A,
            AudioCodec: 'aac',
            MaxStreamingBitrate: '192000',
            StartTimeTicks: '300000000',
            api_key: 'tok',
        });
        const sent = new Headers(init.headers);
        expect(sent.get('x-emby-authorization')).toBe('MediaBrowser Token="tok"');
        // The client's address reaches master.m3u8's stream policy, not the proxy's.
        expect(sent.get('x-forwarded-for')).toBe('203.0.113.7, 10.0.0.2');
        expect(sent.get('x-real-ip')).toBe('203.0.113.7');
        expect(sent.get('forwarded')).toBe('for=203.0.113.7');
    });

    it('sends no PlaySessionId to master.m3u8 when the client sent none', async () => {
        const fetchMock = vi.fn(async () => new Response('#EXTM3U\n', { status: 200 }));
        await GET!(
            makeEvent('?transcodingProtocol=hls', { fetch: fetchMock as unknown as typeof fetch }),
        );
        const [target] = fetchMock.mock.calls[0] as unknown as [string];
        const u = new URL(target, 'https://app.example');
        expect(u.searchParams.has('PlaySessionId')).toBe(false);
        expect(u.searchParams.get('MediaSourceId')).toBe(FILE_A);
    });

    it('passes the HLS route failure through', async () => {
        const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));
        const res = await GET!(
            makeEvent('?transcodingProtocol=hls', { fetch: fetchMock as unknown as typeof fetch }),
        );
        expect(res.status).toBe(503);
    });

    it('progressive-transcodes through the music transcode service without a play_sessions row', async () => {
        mockStreamFor.mockResolvedValue({
            body: new ReadableStream(),
            contentType: 'audio/mpeg',
            contentLength: null,
            acceptRanges: 'bytes',
            status: 200,
            cacheState: 'live',
        });
        const res = await GET!(
            makeEvent(
                '?container=mp3&transcodingContainer=mp3&audioCodec=mp3&maxStreamingBitrate=128000&startTimeTicks=600000000',
            ),
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
        expect(mockStreamFor).toHaveBeenCalledWith(
            expect.objectContaining({
                trackUuid: ITEM_ID,
                sourcePath: '/music/a.flac',
                sourceMtimeMs: 1234,
                codec: 'mp3',
                bitrateKbps: 128,
                timeOffset: 60,
                session: expect.objectContaining({
                    sessionId: `player:uid-alice:${ITEM_ID}`,
                    userId: 'uid-alice',
                }),
                rangeHeader: null,
            }),
        );
    });

    it('maps a busy transcode service to 503', async () => {
        mockStreamFor.mockRejectedValue(Object.assign(new Error('cap'), { status: 503 }));
        const res = await GET!(makeEvent('?container=mp3'));
        expect(res.status).toBe(503);
    });

    it('with music transcoding off: HLS for an ALAC .m4a when only m4a|aac is listed', async () => {
        cfg.FEATURE_MUSIC_TRANSCODE = false;
        FILES[FILE_A].file_path = '/music/a.m4a';
        audioCodecA = 'alac';
        const fetchMock = vi.fn(async () => new Response('#EXTM3U\n', { status: 200 }));
        const res = await GET!(
            makeEvent('?container=m4a|aac', { fetch: fetchMock as unknown as typeof fetch }),
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
        expect(mockStreamFor).not.toHaveBeenCalled();
    });

    it('with music transcoding off: HLS for 24/192 FLAC past maxAudioSampleRate', async () => {
        cfg.FEATURE_MUSIC_TRANSCODE = false;
        sampleRateA = 192_000;
        const fetchMock = vi.fn(async () => new Response('#EXTM3U\n', { status: 200 }));
        const res = await GET!(
            makeEvent('?container=flac&maxAudioSampleRate=48000', {
                fetch: fetchMock as unknown as typeof fetch,
            }),
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
    });

    it('with music transcoding off: direct play on a clean match, HLS when over maxStreamingBitrate', async () => {
        cfg.FEATURE_MUSIC_TRANSCODE = false;
        await GET!(makeEvent('?container=flac'));
        expect(mockHandleStreamFile).toHaveBeenCalledTimes(1);

        // Container listed, but the 900 kbps FLAC is over the client's limit.
        mockHandleStreamFile.mockClear();
        const fetchMock = vi.fn(async () => new Response('#EXTM3U\n', { status: 200 }));
        const res = await GET!(
            makeEvent('?container=flac&maxStreamingBitrate=128000', {
                fetch: fetchMock as unknown as typeof fetch,
            }),
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();
        expect(mockStreamFor).not.toHaveBeenCalled();
    });

    it('with music transcoding AND ffmpeg off: 415 instead of a file the client cannot play', async () => {
        cfg.FEATURE_MUSIC_TRANSCODE = false;
        feat.ffmpegAvailable = false;
        sampleRateA = 192_000;
        const res = await GET!(makeEvent('?container=flac&maxAudioSampleRate=48000'));
        expect(res.status).toBe(415);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();

        // A clean match still plays.
        sampleRateA = 44_100;
        const ok = await GET!(makeEvent('?container=flac&maxAudioSampleRate=48000'));
        expect(ok.status).toBe(206);
        expect(mockHandleStreamFile).toHaveBeenCalledTimes(1);
    });
});

describe('GET /j/Audio/{itemId}/universal — kick cooldown', () => {
    beforeEach(() => {
        mockCheckSessionKickCooldown.mockResolvedValue({ kicked: true, remainingSeconds: 30 });
    });

    it('refuses direct play and the progressive transcode while the user is kicked', async () => {
        const direct = await GET!(makeEvent('?container=flac'));
        expect(direct.status).toBe(403);
        expect(mockHandleStreamFile).not.toHaveBeenCalled();

        const progressive = await GET!(makeEvent('?container=mp3'));
        expect(progressive.status).toBe(403);
        expect(mockStreamFor).not.toHaveBeenCalled();
        expect(mockCheckSessionKickCooldown).toHaveBeenCalledWith('alice');
    });

    it('leaves the HLS path to master.m3u8, which checks the cooldown itself', async () => {
        const fetchMock = vi.fn(async () => new Response('#EXTM3U\n', { status: 200 }));
        await GET!(
            makeEvent('?transcodingProtocol=hls', { fetch: fetchMock as unknown as typeof fetch }),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mockCheckSessionKickCooldown).not.toHaveBeenCalled();
    });
});

describe('HEAD /j/Audio/{itemId}/universal', () => {
    it('starts no transcode and fetches no playlist', async () => {
        const fetchMock = vi.fn();
        const hls = await HEAD!(
            makeEvent('?transcodingProtocol=hls', {
                method: 'HEAD',
                fetch: fetchMock as unknown as typeof fetch,
            }),
        );
        expect(hls.status).toBe(200);
        expect(hls.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
        expect(fetchMock).not.toHaveBeenCalled();

        const prog = await HEAD!(makeEvent('?container=mp3', { method: 'HEAD' }));
        expect(prog.status).toBe(200);
        expect(prog.headers.get('Content-Type')).toBe('audio/mpeg');
        expect(mockStreamFor).not.toHaveBeenCalled();
    });

    it('answers the direct-play headers without a body', async () => {
        const res = await HEAD!(makeEvent('?container=flac', { method: 'HEAD' }));
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Type')).toBe('audio/flac');
        expect(res.body).toBeNull();
    });
});
