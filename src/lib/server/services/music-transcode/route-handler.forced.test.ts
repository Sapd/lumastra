// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `serveTrack(..., forced)` — the fixed-format encode behind the cluster
 * shuffle stream. `?format=mp3` direct-plays an MP3 source untouched (its own
 * sample rate, channels and cover-art tag), which a 44.1 kHz-only Bluetooth
 * device cannot play; a forced call must ALWAYS encode and never fall back to
 * the original file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserContext } from '$lib/server/types.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));

const features = vi.hoisted(() => ({ musicTranscode: true }));
vi.mock('$lib/server/config.js', () => ({
    features,
    config: { MUSIC_TRANSCODE_DEFAULT_CODEC: 'mp3' },
}));

// An MP3 source at 128 kbps: `?format=mp3` alone would direct-play it.
vi.mock('./stream-source.js', () => ({
    resolveStreamSource: vi.fn(async () => ({
        kind: 'ok',
        trackId: 'T',
        containerPath: '/music/song.mp3',
        fileSize: 4_000_000,
        mtimeMs: 1,
    })),
    probeAudioSourceCached: vi.fn(async () => ({
        codec: 'mp3',
        container: 'mp3',
        bitrate: 128_000,
    })),
}));
vi.mock('node:fs/promises', () => ({
    open: vi.fn(),
    readFile: vi.fn(async () => Buffer.from('ORIGINAL-FILE')),
    stat: vi.fn(async () => ({ mtimeMs: 1 })),
}));

const streamFor = vi.fn();
vi.mock('$lib/server/services/music-transcode/index.js', () => ({
    getMusicTranscodeService: () => ({ streamFor }),
    clampBitrate: (_codec: string, kbps: number) => kbps,
    defaultBitrateFor: () => 192,
    containerFor: () => 'mp3',
}));
const upsertTranscodeSession = vi.fn();
vi.mock('$lib/server/subsonic-compat/utils/transcode-session.js', () => ({
    upsertTranscodeSession: (...a: unknown[]) => upsertTranscodeSession(...a),
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackDirectPlay: vi.fn() },
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

const { createMusicStreamHandlers } = await import('./route-handler.js');
const { probeAudioSourceCached } = await import('./stream-source.js');

const user = { userId: 'usr_1', username: 'marc' } as unknown as UserContext;
function event(query = '', headers: Record<string, string> = {}) {
    const request = new Request(`http://localhost/api/v1/music/tracks/T/stream${query}`, {
        headers,
    });
    return { request, locals: { user } } as unknown as Parameters<
        ReturnType<typeof createMusicStreamHandlers>['serveTrack']
    >[0];
}
const handlers = () =>
    createMusicStreamHandlers({ source: 'public-api', deviceId: () => 'd', loggerName: 't' });
const FORCED = { bitrateKbps: 128, headers: { 'X-Track-Id': 'T', 'X-Title': 'A%20B' } };

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeAudioSourceCached).mockReset().mockResolvedValue({
        codec: 'mp3',
        container: 'mp3',
        bitrate: 128000,
        channels: 2,
        sampleRate: 44100,
        bitDepth: 16,
    });
    features.musicTranscode = true;
    upsertTranscodeSession.mockResolvedValue('11111111-1111-4111-8111-111111111111');
    streamFor.mockResolvedValue({
        body: new ReadableStream(),
        contentType: 'audio/mpeg',
        contentLength: 1234,
        acceptRanges: 'none',
        status: 200,
        cacheState: 'cached',
    });
});

describe('serveTrack forced MP3', () => {
    it('re-encodes an MP3 source that format alone would direct-play', async () => {
        const plain = await handlers().serveTrack(event('?format=mp3'), 'T');
        expect(streamFor).not.toHaveBeenCalled();
        expect(await plain.text()).toBe('ORIGINAL-FILE');

        const res = await handlers().serveTrack(event(), 'T', FORCED);
        expect(res.status).toBe(200);
        expect(streamFor).toHaveBeenCalledWith(
            expect.objectContaining({ codec: 'mp3', bitrateKbps: 128, timeOffset: 0 }),
        );
        expect(res.headers.get('X-Track-Id')).toBe('T');
        expect(res.headers.get('X-Title')).toBe('A%20B');
        expect(res.headers.get('Content-Length')).toBe('1234');
    });

    it('ignores query params that would change the output (format=raw, timeOffset, download)', async () => {
        await handlers().serveTrack(
            event('?format=raw&startPositionSeconds=30&download=1'),
            'T',
            FORCED,
        );
        expect(streamFor).toHaveBeenCalledWith(
            expect.objectContaining({ codec: 'mp3', timeOffset: 0 }),
        );
        expect(upsertTranscodeSession).toHaveBeenCalled(); // a play, not a download
    });

    it('returns Retry-After before range headers when a shared encode failed during admission', async () => {
        streamFor.mockRejectedValueOnce(
            Object.assign(new Error('Music encode failed before response; retry'), { status: 503 }),
        );
        const res = await handlers().serveTrack(event('', { Range: 'bytes=1000-' }), 'T', FORCED);
        expect(res.status).toBe(503);
        expect(res.headers.get('Retry-After')).toBe('5');
        expect(res.headers.has('Content-Range')).toBe(false);
    });

    it('answers 503 instead of the original file when transcoding is off', async () => {
        features.musicTranscode = false;
        const res = await handlers().serveTrack(event(), 'T', FORCED);
        expect(res.status).toBe(503);
        expect(streamFor).not.toHaveBeenCalled();
    });

    it('answers 503 instead of the original file when no play session can be opened', async () => {
        upsertTranscodeSession.mockResolvedValue(null);
        const res = await handlers().serveTrack(event(), 'T', FORCED);
        expect(res.status).toBe(503);
        expect(res.headers.get('Retry-After')).toBe('5');
    });
});

// AVPlayer reconnects mid-track with `bytes=N-`; a 200 from byte 0 to that is
// spliced into the middle of the song. The service answers ranges — this pins
// that the route actually hands it the header and passes 206/416 through.
describe('serveTrack ranges on a transcode', () => {
    it('forwards the Range header and answers 206 with Content-Range', async () => {
        streamFor.mockResolvedValue({
            body: new ReadableStream(),
            contentType: 'audio/mpeg',
            contentLength: 3000,
            acceptRanges: 'bytes',
            status: 206,
            contentRange: 'bytes 1000-3999/4000',
            cacheState: 'cached',
        });
        const res = await handlers().serveTrack(event('', { Range: 'bytes=1000-' }), 'T', FORCED);
        expect(streamFor).toHaveBeenCalledWith(
            expect.objectContaining({ rangeHeader: 'bytes=1000-' }),
        );
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe('bytes 1000-3999/4000');
        expect(res.headers.get('Content-Length')).toBe('3000');
        expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    });

    it('passes null when there is no Range, so the service may stream live', async () => {
        await handlers().serveTrack(event(), 'T', FORCED);
        expect(streamFor).toHaveBeenCalledWith(expect.objectContaining({ rangeHeader: null }));
    });

    it('turns an unsatisfiable range into 416 with the size', async () => {
        streamFor.mockRejectedValue(Object.assign(new Error('nope'), { status: 416, size: 4000 }));
        const res = await handlers().serveTrack(event('', { Range: 'bytes=9000-' }), 'T', FORCED);
        expect(res.status).toBe(416);
        expect(res.headers.get('Content-Range')).toBe('bytes */4000');
    });
});

describe.each(['GET', 'HEAD'] as const)('%s query negotiation', (method) => {
    async function invoke(query = '') {
        const input = {
            ...event(query),
            url: new URL(event(query).request.url),
            params: { id: 'T' },
        } as Parameters<ReturnType<typeof handlers>['GET']>[0];
        return handlers()[method](input);
    }
    it.each(['', '?download=1'])('serves direct without probing for %s', async (query) => {
        const { probeAudioSourceCached } = await import('./stream-source.js');
        vi.mocked(probeAudioSourceCached).mockRejectedValueOnce(new Error('probe unavailable'));
        const response = await invoke(query);
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
        expect(response.headers.get('Content-Length')).toBe(method === 'GET' ? '13' : '4000000');
        expect(probeAudioSourceCached).not.toHaveBeenCalled();
        if (method === 'GET') expect(await response.text()).toBe('ORIGINAL-FILE');
        vi.mocked(probeAudioSourceCached).mockReset().mockResolvedValue({
            codec: 'mp3',
            container: 'mp3',
            bitrate: 128000,
            channels: 2,
            sampleRate: 44100,
            bitDepth: 16,
        });
    });
    it.each([
        'maxBitRate=128',
        'bitrate=128',
        'timeOffset=1',
        'bitrateKbps=',
        'bitrateKbps=0',
        'bitrateKbps=-1',
        'bitrateKbps=1.5',
        'bitrateKbps=NaN',
        'maxBitrateKbps=',
        'maxBitrateKbps=-1',
        'startPositionSeconds=NaN',
        'startPositionSeconds=Infinity',
        'startPositionSeconds=-1',
        'startPositionSeconds=',
        'format=',
        'format=bogus',
    ])('rejects malformed %s as 400 before probing', async (query) => {
        const { probeAudioSourceCached } = await import('./stream-source.js');
        const response = await invoke(`?${query}`);
        expect(response.status).toBe(400);
        expect(probeAudioSourceCached).not.toHaveBeenCalled();
        expect(streamFor).not.toHaveBeenCalled();
    });
    it('accepts maxBitrateKbps=0 as an uncapped negotiation request', async () => {
        const { probeAudioSourceCached } = await import('./stream-source.js');
        expect((await invoke('?maxBitrateKbps=0')).status).toBe(200);
        expect(probeAudioSourceCached).toHaveBeenCalledOnce();
    });
});
