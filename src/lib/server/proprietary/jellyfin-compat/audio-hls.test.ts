// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The preflight master.m3u8 and main.m3u8 share: a kicked user gets 403 and
 * no transcode starts, a hidden item is 404, and a request that passes
 * disarms the silent-start guard for its play session.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    access: vi.fn(),
    kick: vi.fn(),
    start: vi.fn(),
    disarm: vi.fn(),
}));

vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: h.access }));
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: h.kick,
}));
vi.mock('$lib/server/services/hls/playback.service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/hls/playback.service')>()),
    startHlsPlayback: h.start,
}));
import { HlsPlaybackError } from '$lib/server/services/hls/playback.service';
vi.mock('./silent-start', () => ({ disarmSilentStart: h.disarm }));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getFilesForMediaItem: vi.fn(async () => [{ id: 'file-1', duration_seconds: 200 }]),
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemById: vi.fn(async () => ({ runtime_seconds: 200 })),
}));
vi.mock('$lib/server/utils/client-ip', () => ({ getClientIp: () => '203.0.113.1' }));
vi.mock('./play-token', () => ({ validatePlayToken: vi.fn(async () => null) }));
vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return { ...actual, features: { ...actual.features, ffmpegAvailable: true } };
});

const { handleAudioMasterPlaylist, handleAudioMediaPlaylist } = await import('./audio-hls');

const ITEM = '00000000-0000-4000-a000-000000000001';

function event(file: 'master.m3u8' | 'main.m3u8'): RequestEvent {
    const url = new URL(`https://app.example/j/Audio/${ITEM}/${file}?PlaySessionId=ps-1`);
    return {
        url,
        request: new Request(url),
        params: { itemId: ITEM },
        locals: {
            user: { userId: 'uid-alice', username: 'alice', ownerIsAdmin: false },
            jfDevice: { deviceId: 'dev-1' },
        },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    h.access.mockReset().mockResolvedValue(true);
    h.kick.mockReset().mockResolvedValue({ kicked: false });
    h.start.mockReset().mockResolvedValue({ playlistBody: '#EXTM3U\n#EXT-X-ENDLIST\n' });
    h.disarm.mockReset().mockResolvedValue(undefined);
});

describe.each([
    ['master.m3u8', handleAudioMasterPlaylist],
    ['main.m3u8', handleAudioMediaPlaylist],
] as const)('audio HLS preflight: %s', (file, handler) => {
    it('answers 403 inside a kick cooldown and starts no transcode', async () => {
        h.kick.mockResolvedValue({ kicked: true, remainingSeconds: 30 });
        const res = await handler(event(file));
        expect(res.status).toBe(403);
        expect(h.kick).toHaveBeenCalledWith('alice');
        expect(h.start).not.toHaveBeenCalled();
        expect(h.disarm).not.toHaveBeenCalled();
    });

    it('answers 404 for an item the user cannot see', async () => {
        h.access.mockResolvedValue(false);
        const res = await handler(event(file));
        expect(res.status).toBe(404);
        expect(h.start).not.toHaveBeenCalled();
        expect(h.disarm).not.toHaveBeenCalled();
    });

    it('disarms the silent-start guard for the play session on success', async () => {
        const res = await handler(event(file));
        expect(res.status).toBe(200);
        expect(h.disarm).toHaveBeenCalledWith({
            playSessionId: 'ps-1',
            username: 'alice',
            itemId: ITEM,
            userId: 'uid-alice',
            deviceId: 'dev-1',
        });
        // Only main starts the transcode; the master does no work.
        expect(h.start).toHaveBeenCalledTimes(file === 'main.m3u8' ? 1 : 0);
    });
});

describe('audio HLS admission response', () => {
    it.each(['transcode_capacity', 'transcode_load_shed'])(
        'forwards a retryable 503 for %s',
        async (code) => {
            h.start.mockRejectedValue(
                new HlsPlaybackError(JSON.stringify({ error: code, retry_after: 30 }), 503, 30),
            );
            const res = await handleAudioMediaPlaylist(event('main.m3u8'));
            expect(res.status).toBe(503);
            expect(res.headers.get('Retry-After')).toBe('30');
            expect(res.headers.get('Content-Type')).toBe('application/json');
            expect(await res.json()).toMatchObject({ error: code, retry_after: 30 });
        },
    );
});
