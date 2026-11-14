// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// main.m3u8 is the master.m3u8 pipeline with the muxed mode pinned, so the
// answer is a media playlist whatever hlsAudioMode the client sends; access
// check and silent-start disarm are the master route's.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

const h = vi.hoisted(() => ({
    start: vi.fn(),
    access: vi.fn(),
    disarm: vi.fn(),
}));

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return { ...actual, features: { ...actual.features, ffmpegAvailable: true } };
});
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: h.access }));
vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemById: vi.fn().mockResolvedValue({ runtime_seconds: 60 }),
}));
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: vi.fn().mockResolvedValue({ kicked: false }),
}));
vi.mock('$lib/server/utils/client-ip', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: vi.fn().mockResolvedValue(null),
    getFilesForMediaItem: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/jellyfin-compat/playback-utils', () => ({
    jellyfinCompatDeviceId: () => 'jellyfin-compat-device',
}));
vi.mock('$lib/server/services/hls/playback.service', () => ({
    startHlsPlayback: h.start,
    HlsPlaybackError: class HlsPlaybackError extends Error {
        statusCode = 500;
    },
}));
vi.mock('$lib/server/jellyfin-compat/play-token', () => ({
    validatePlayToken: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/jellyfin-compat/silent-start', () => ({
    disarmSilentStart: h.disarm,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { GET } from './+server';

const ITEM_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const MEDIA_PLAYLIST =
    '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\n/j/Videos/x/hls/segment_00000.ts?PlaySessionId=ps1\n#EXT-X-ENDLIST\n';

async function callGet(query: string): Promise<Response> {
    const url = new URL(`https://example.test/j/Videos/${ITEM_ID}/main.m3u8?${query}`);
    const event = {
        params: { itemId: ITEM_ID },
        url,
        request: new Request(url),
        locals: { user: { userId: 'u1', username: 'alice' } },
        cookies: { get: vi.fn(), set: vi.fn() },
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('/j/Videos/[itemId]/main.m3u8', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.access.mockResolvedValue(true);
        h.start.mockResolvedValue({ playlistBody: MEDIA_PLAYLIST });
    });

    it('serves the muxed media playlist', async () => {
        const res = await callGet('PlaySessionId=ps1&api_key=k');
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
        expect(await res.text()).toContain('segment_00000.ts');
        expect(h.start).toHaveBeenCalledWith(
            expect.objectContaining({
                itemId: ITEM_ID,
                playSessionId: 'ps1',
                hlsOutput: expect.objectContaining({ hlsAudioMode: 'muxed' }),
            }),
        );
        expect(h.disarm).toHaveBeenCalledWith(
            expect.objectContaining({ playSessionId: 'ps1', itemId: ITEM_ID }),
        );
    });

    it.each(['hlsAudioMode=demux', 'HlsAudioMode=demux', 'hlsaudiomode=demux'])(
        'pins muxed over %s',
        async (query) => {
            await callGet(`PlaySessionId=ps1&${query}`);
            expect(h.start.mock.calls[0][0].hlsOutput.hlsAudioMode).toBe('muxed');
        },
    );

    it('404s a user without access, before starting a transcode', async () => {
        h.access.mockResolvedValue(false);
        const res = await callGet('PlaySessionId=ps1');
        expect(res.status).toBe(404);
        expect(h.start).not.toHaveBeenCalled();
        expect(h.disarm).not.toHaveBeenCalled();
    });
});
