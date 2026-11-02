// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a music transcode opens its own play_sessions row, or rides on the
 * `Lumastra Music` session our own player already reports.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserContext } from '$lib/server/types.js';
import { ShutdownInterruptedError } from '$lib/server/lifecycle/shutdown-interrupted.js';
import * as shutdown from '$lib/server/lifecycle/web-shutdown.js';

const musicLog = vi.hoisted(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => musicLog } }));
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
const hasLivePlayerMusicSession = vi.fn();
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    hasLivePlayerMusicSession: (...a: unknown[]) => hasLivePlayerMusicSession(...a),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

const { createMusicStreamHandlers } = await import('./route-handler.js');

const user = { userId: 'usr_1', username: 'testlistener' } as unknown as UserContext;
const IOS = { kind: 'bearer', userId: 'usr_1', clientId: 'lumastra-ios' };
const STREAM_TOKEN = { kind: 'stream_token', userId: 'usr_1' };
const PAT = { kind: 'pat', userId: 'usr_1' };

function event(principal: unknown, query = '?format=mp3&bitrateKbps=96') {
    const request = new Request(`http://localhost/api/v1/music/tracks/T/stream${query}`);
    return { request, locals: { user, principal } } as unknown as Parameters<
        ReturnType<typeof createMusicStreamHandlers>['serveTrack']
    >[0];
}
const handlers = () =>
    createMusicStreamHandlers({ source: 'public-api', deviceId: () => 'd', loggerName: 't' });
const sessionIdPassed = (): string =>
    (streamFor.mock.calls[0][0] as { session: { sessionId: string } }).session.sessionId;

beforeEach(() => {
    vi.clearAllMocks();
    features.musicTranscode = true;
    hasLivePlayerMusicSession.mockResolvedValue(true);
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

// The iOS app preloads the NEXT track through this route while the player
// reports the listen through /play-sessions/{id}. A play_sessions row here
// was a second "Subsonic" stream one track ahead, and took a second slot of
// the stream cap.
describe('serveTrack transcode while our own player reports the listen', () => {
    it('returns a retryable response when an in-flight encode is interrupted by shutdown', async () => {
        const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(false);
        streamFor.mockImplementationOnce(async () => {
            draining.mockReturnValue(true);
            throw new ShutdownInterruptedError();
        });
        try {
            const res = await handlers().serveTrack(event(IOS), 'T');
            expect(res.status).toBe(503);
            expect(res.headers.get('Retry-After')).toBe('2');
            expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
            expect(musicLog.error).not.toHaveBeenCalled();
            expect(musicLog.info).toHaveBeenCalledWith('Music transcode interrupted by shutdown', {
                trackId: 'T',
            });
        } finally {
            draining.mockRestore();
        }
    });

    it.each([415, 416, 500])(
        'preserves status %s for a real failure during draining',
        async (status) => {
            const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(false);
            const failure = Object.assign(new Error('real failure'), { status, size: 123 });
            streamFor.mockImplementationOnce(async () => {
                draining.mockReturnValue(true);
                throw failure;
            });
            try {
                const res = await handlers().serveTrack(event(IOS), 'T');
                expect(res.status).toBe(status);
                expect(res.headers.get('Retry-After')).toBeNull();
                if (status === 500)
                    expect(musicLog.error).toHaveBeenCalledWith(
                        'Music transcode service failure',
                        failure,
                        { trackId: 'T' },
                    );
            } finally {
                draining.mockRestore();
            }
        },
    );

    it('opens no play_sessions row for the iOS app with a live player session', async () => {
        const res = await handlers().serveTrack(event(IOS), 'T');
        expect(res.status).toBe(200);
        expect(upsertTranscodeSession).not.toHaveBeenCalled();
        expect(sessionIdPassed()).toBe('player:usr_1:T');
        expect(hasLivePlayerMusicSession).toHaveBeenCalledWith(expect.anything(), 'usr_1');
    });

    it('treats a stream-token fetch (the AVPlayer URL) the same way', async () => {
        await handlers().serveTrack(event(STREAM_TOKEN), 'T');
        expect(upsertTranscodeSession).not.toHaveBeenCalled();
        expect(sessionIdPassed()).toBe('player:usr_1:T');
    });

    it('keeps the row when no player session is live (first fetch, or a client that never reports)', async () => {
        hasLivePlayerMusicSession.mockResolvedValue(false);
        await handlers().serveTrack(event(IOS), 'T');
        expect(upsertTranscodeSession).toHaveBeenCalledWith(
            expect.objectContaining({ source: 'music', surface: 'native_app' }),
        );
        expect(sessionIdPassed()).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('keeps the row for a third-party credential even while a player session is live', async () => {
        await handlers().serveTrack(event(PAT), 'T');
        expect(hasLivePlayerMusicSession).not.toHaveBeenCalled();
        expect(upsertTranscodeSession).toHaveBeenCalledWith(
            expect.objectContaining({ surface: 'third_party_api' }),
        );
    });

    it('falls back to the row when the lookup fails', async () => {
        hasLivePlayerMusicSession.mockRejectedValue(new Error('db down'));
        const res = await handlers().serveTrack(event(IOS), 'T');
        expect(res.status).toBe(200);
        expect(upsertTranscodeSession).toHaveBeenCalled();
    });

    it('keeps the row for a forced encode (cluster shuffle feeds devices that never report)', async () => {
        await handlers().serveTrack(event(IOS, ''), 'T', { bitrateKbps: 128, headers: {} });
        expect(hasLivePlayerMusicSession).not.toHaveBeenCalled();
        expect(upsertTranscodeSession).toHaveBeenCalled();
    });

    it('leaves downloads on their own synthetic id', async () => {
        await handlers().serveTrack(event(IOS, '?format=mp3&bitrateKbps=96&download=1'), 'T');
        expect(upsertTranscodeSession).not.toHaveBeenCalled();
        expect(sessionIdPassed()).toBe('download:usr_1:T');
    });
});

describe('serveTrack with a playback-start grant', () => {
    it('returns a 410 problem when the queued playback session expires', async () => {
        const request = event(PAT);
        Object.assign(request.locals, {
            streamingSession: {
                userId: user.userId,
                mediaItemId: 'T',
                playbackSessionId: '22222222-2222-4222-8222-222222222222',
            },
        });
        streamFor.mockRejectedValueOnce(
            Object.assign(new Error('Playback session ended while queued'), { status: 410 }),
        );

        const response = await handlers().serveTrack(request, 'T');

        expect(response.status).toBe(410);
        expect(response.headers.get('Content-Type')).toContain('application/problem+json');
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(await response.json()).toMatchObject({
            code: 'gone',
            status: 410,
            error: 'Playback session ended while queued',
        });
        expect(musicLog.error).not.toHaveBeenCalled();
    });

    it('uses the grant-bound row as the transcode work key without creating a second row', async () => {
        const request = event(PAT);
        const playbackSessionId = '22222222-2222-4222-8222-222222222222';
        Object.assign(request.locals, {
            streamingSession: { userId: user.userId, mediaItemId: 'T', playbackSessionId },
        });
        expect((await handlers().serveTrack(request, 'T')).status).toBe(200);
        expect(sessionIdPassed()).toBe(playbackSessionId);
        expect(upsertTranscodeSession).not.toHaveBeenCalled();
        expect(hasLivePlayerMusicSession).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'ignores grant work key for download/forced encode (forced=%s)',
        async (forced) => {
            const request = event(PAT, forced ? '' : '?format=mp3&bitrateKbps=96&download=true');
            Object.assign(request.locals, {
                streamingSession: {
                    userId: user.userId,
                    mediaItemId: 'T',
                    playbackSessionId: 'grant-bound',
                },
            });
            await handlers().serveTrack(
                request,
                'T',
                forced ? { bitrateKbps: 128, headers: {} } : undefined,
            );
            expect(sessionIdPassed()).toBe(
                forced ? '11111111-1111-4111-8111-111111111111' : 'download:usr_1:T',
            );
            expect(hasLivePlayerMusicSession).not.toHaveBeenCalled();
            if (forced) expect(upsertTranscodeSession).toHaveBeenCalled();
            else expect(upsertTranscodeSession).not.toHaveBeenCalled();
        },
    );

    it('does not reuse a session bound to another track', async () => {
        const request = event(PAT);
        Object.assign(request.locals, {
            streamingSession: {
                userId: user.userId,
                mediaItemId: 'other-track',
                playbackSessionId: '22222222-2222-4222-8222-222222222222',
            },
        });
        await handlers().serveTrack(request, 'T');
        expect(upsertTranscodeSession).toHaveBeenCalled();
    });
});
