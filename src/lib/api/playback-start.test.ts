// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('$app/environment', () => ({ version: 'v0.1.0-test-build' }));
import { playbackStartFixture } from '$lib/utils/playback-start.fixture';
const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), del: vi.fn() }));
vi.mock('./client.js', () => ({
    apiPost: api.post,
    apiGet: api.get,
    apiDelete: api.del,
    apiPatch: vi.fn(),
    apiPut: vi.fn(),
}));
vi.mock('$lib/components/player/device-id.js', () => ({ getDeviceId: () => 'preview-device' }));
import {
    cancelSession,
    createPreviewSession,
    probePlayability,
    releasePreviewPlayback,
    startPlaySession,
} from './playback';
const capabilities = {
    containers: ['mp4'],
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
    subtitleFormats: ['vtt'],
    hdr: [],
};
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('navigator', { userAgent: 'Web test agent' });
    api.post.mockReset().mockResolvedValue({ data: null, status: 204, error: null });
    api.del.mockResolvedValue({ data: null, status: 204, error: null });
});
afterEach(() => vi.unstubAllGlobals());
it('starts using the camelCase public body and envelope', async () => {
    const start = playbackStartFixture();
    api.post.mockResolvedValueOnce({ data: start });
    const body = {
        mediaId: start.mediaId,
        deviceId: 'device',
        capabilities,
        audio: { format: 'mp3', bitrateKbps: 192 },
    };
    expect((await startPlaySession(body)).data).toBe(start);
    expect(api.post).toHaveBeenCalledWith('/api/play-sessions', expect.anything(), {
        ...body,
        clientInfo: { client: 'web', version: 'v0.1.0-test-build', userAgent: 'Web test agent' },
    });
});
it('probes with typed capabilities and file selection in the body', async () => {
    await probePlayability('media/id', { capabilities, fileId: 'file' });
    expect(api.post).toHaveBeenCalledWith('/api/media/media%2Fid/playability', expect.anything(), {
        capabilities,
        fileId: 'file',
    });
});
it('allocates exactly one dedicated preview and releases that same session', async () => {
    api.post.mockResolvedValueOnce({
        data: {
            id: 'preview-job',
            mediaId: 'media',
            mode: 'preview',
            streamUrl: '/api/playback/media/hls?grant=preview',
            playMethod: 'Transcode',
            transcodeMode: 'local',
            hlsStartPosition: 0,
        },
        error: null,
        status: 201,
    });
    const result = await createPreviewSession('media', {
        internalId: 'media',
        startPositionSeconds: 12,
    });
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/playback/previews', expect.anything(), {
        mediaId: 'media',
        startPositionSeconds: 12,
    });
    expect(result.data).toMatchObject({
        playSessionId: 'preview-job',
        sessionItemId: 'media',
        streamUrl: '/api/playback/media/hls?grant=preview',
    });
    releasePreviewPlayback('preview-job');
    expect(api.del.mock.calls[0][0]).toBe('/api/playback/previews/preview-job');
});
it('keeps a no-trailer result free of delivery sessions', async () => {
    api.post.mockResolvedValueOnce({ data: { mode: 'none' }, error: null, status: 200 });
    const result = await createPreviewSession('media', {
        internalId: 'media',
        startPositionSeconds: 0,
        trailerRequired: true,
    });
    expect(result.data).toEqual({ mode: 'none' });
    expect(api.post).toHaveBeenCalledOnce();
});

it('forwards music AirPlay cast intent through the public start API', async () => {
    const { startMusicPlaySession } = await import('./music');
    await startMusicPlaySession({ trackId: 'track', deviceId: 'device', castTarget: true });
    expect(api.post).toHaveBeenCalledWith(
        '/api/play-sessions',
        expect.anything(),
        expect.objectContaining({
            mediaId: 'track',
            castTarget: true,
            clientInfo: {
                client: 'web',
                version: 'v0.1.0-test-build',
                userAgent: 'Web test agent',
            },
        }),
    );
});

it('adds web build metadata to audiobook starts', async () => {
    const { audiobookSessionTransport } = await import('./audiobooks');
    // The refusal ends the transport after the start request, before book-detail loading.
    await expect(
        audiobookSessionTransport.openSession({
            mediaId: 'book',
            deviceId: 'device',
        }),
    ).rejects.toThrow();
    expect(api.post).toHaveBeenCalledWith(
        '/api/play-sessions',
        expect.anything(),
        expect.objectContaining({
            mediaId: 'book',
            clientInfo: {
                client: 'web',
                version: 'v0.1.0-test-build',
                userAgent: 'Web test agent',
            },
        }),
    );
});

it('cancels a session with DELETE on the shared session resource', async () => {
    await cancelSession('session');
    expect(api.del).toHaveBeenCalledWith(
        '/api/play-sessions/session',
        expect.anything(),
        undefined,
        undefined,
    );
    expect(api.post).not.toHaveBeenCalled();
});
