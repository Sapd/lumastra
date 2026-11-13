// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// /j/Items/[itemId]/PlaybackInfo arms the silent-start detector only for a real
// answer to a POST with a DeviceProfile from a /j session login.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const ITEM = 'b1f6c3a0-0000-4000-8000-000000000001';
const FILE = 'f11e0000-0000-4000-8000-000000000001';
const ME = '00000000-0000-0000-0000-000000000001';

const h = vi.hoisted(() => ({
    arm: vi.fn(),
    store: new Map<string, string>(),
    mediaType: 'movie',
    clipFails: false,
    issuePlayToken: vi.fn(async () => 'stream-token'),
    issueFileToken: vi.fn(async () => 'file-token'),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
// The Live TV channel access gate has its own tests (channel-access.test.ts).
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/database', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemById: vi.fn(async () => ({
        id: ITEM,
        media_type: h.mediaType,
        runtime_seconds: 6000,
    })),
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: vi.fn().mockResolvedValue(null),
    getFilesForMediaItem: vi.fn(async () => [
        {
            id: FILE,
            file_path: '/data/movies/Film (2020)/Film.mkv',
            file_size_bytes: '1000',
            total_bitrate: '5000000',
        },
    ]),
}));
vi.mock('$lib/server/database/queries/media-streams.queries', () => ({
    getStreamsForMediaItem: vi.fn().mockResolvedValue([]),
    getStreamsForFile: vi.fn().mockResolvedValue([]),
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
vi.mock('$lib/server/proprietary/jellyfin-compat/video-attachments', () => ({
    mediaAttachmentsForSource: async () => [],
}));
vi.mock('$lib/server/cache/valkey', () => ({
    hGetAll: async () => ({}),
    cacheGet: async (k: string) => h.store.get(k) ?? null,
    cacheSet: async (k: string, v: string) => {
        h.store.set(k, v);
        return true;
    },
    // The library-permissions cache (via play-token-user) subscribes on load.
    subscribeToChannel: async () => undefined,
    publishMessage: async () => true,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-limit-clip', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/proprietary/jellyfin-compat/stream-limit-clip')
        >();
    return {
        ...actual,
        ensureStreamLimitClip: async () => {
            if (h.clipFails) throw new Error('no ffmpeg');
            return { dir: '/tmp/x', mp4Path: '/tmp/x/clip.mp4', playlistPath: '', mp4Bytes: 1 };
        },
    };
});
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    issuePlayToken: h.issuePlayToken,
    issueFileToken: h.issueFileToken,
    validatePlayToken: vi.fn().mockResolvedValue(null),
    revokePlayTokenBySession: vi.fn(),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/utils', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/proprietary/jellyfin-compat/utils')>();
    return { ...actual, getJfToken: vi.fn(() => 'jf-token') };
});
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    armSilentStart: h.arm,
    disarmSilentStart: h.arm,
}));

import { GET, POST } from './+server';
import { config } from '$lib/server/config';
import { StreamLimitError } from '$lib/server/services/livetv/standalone-livetv-provider.js';

async function call(
    opts: {
        method?: string;
        body?: Record<string, unknown>;
        authMethod?: string;
        device?: Record<string, unknown> | undefined;
        user?: Record<string, unknown>;
    } = {},
): Promise<Response> {
    const method = opts.method ?? 'POST';
    const event = {
        params: { itemId: ITEM },
        url: new URL(`https://example.test/j/Items/${ITEM}/PlaybackInfo`),
        request: new Request(`https://example.test/j/Items/${ITEM}/PlaybackInfo`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
        }),
        locals: {
            user: opts.user ?? { userId: ME, username: 'me', hasLiveTvPermission: true },
            authMethod: opts.authMethod ?? 'jellyfin_compat_session',
            jfDevice: 'device' in opts ? opts.device : DEVICE,
        },
        cookies: { get: vi.fn(), set: vi.fn() },
    } as unknown as RequestEvent;
    const handler = method === 'GET' ? GET : POST;
    return (handler as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

const DEVICE = {
    deviceId: 'dev-1',
    deviceName: 'Pixel',
    clientName: 'Jellyfin Android',
    clientVersion: '2.6.0',
};
const PROFILE = { DeviceProfile: { Name: 'x' }, PlaySessionId: 'abc' };

describe('PlaybackInfo — arms the silent-start detector', () => {
    beforeEach(() => {
        h.store.clear();
        h.mediaType = 'movie';
        h.clipFails = false;
        h.arm.mockClear();
        vi.restoreAllMocks();
    });

    it('does not arm while FEATURE_CLIENT_DIAGNOSTICS is off', async () => {
        vi.spyOn(config, 'FEATURE_CLIENT_DIAGNOSTICS', 'get').mockReturnValue(false);
        const res = await call({ body: PROFILE });
        expect(res.status).toBe(200);
        expect(h.arm).not.toHaveBeenCalled();
    });

    it('POST with a DeviceProfile on a normal item arms with the exact response', async () => {
        const res = await call({ body: PROFILE });
        const json = await res.json();

        expect(h.arm).toHaveBeenCalledTimes(1);
        const input = h.arm.mock.calls[0]![0] as Record<string, unknown>;
        expect(input).toMatchObject({
            playSessionId: 'abc',
            itemId: ITEM,
            clientName: 'Jellyfin Android',
            clientVersion: '2.6.0',
            deviceId: 'dev-1',
            deviceName: 'Pixel',
            userId: ME,
            username: 'me',
        });
        expect(input.response).toEqual(json);
    });

    it('GET does not arm', async () => {
        await call({ method: 'GET' });
        expect(h.arm).not.toHaveBeenCalled();
    });

    it('a POST without a DeviceProfile does not arm', async () => {
        await call({ body: {} });
        expect(h.arm).not.toHaveBeenCalled();
    });

    it('a PAT login does not arm', async () => {
        await call({ body: PROFILE, authMethod: 'jellyfin_compat_pat' });
        expect(h.arm).not.toHaveBeenCalled();
    });

    it('no device id does not arm', async () => {
        await call({ body: PROFILE, device: undefined });
        expect(h.arm).not.toHaveBeenCalled();
    });

    async function capTvChannel(): Promise<void> {
        vi.spyOn(config, 'FEATURE_LIVETV', 'get').mockReturnValue(true);
        h.mediaType = 'tvchannel';
        const { getLiveTvProvider } = await import('$lib/server/services/livetv/index.js');
        vi.mocked(getLiveTvProvider).mockResolvedValue({
            getChannel: vi.fn(),
            getStreamInfo: vi.fn().mockRejectedValue(new StreamLimitError(1, [])),
        } as never);
    }

    it('the Live TV source-limit clip does not arm', async () => {
        await capTvChannel();
        const res = await call({ body: PROFILE });
        expect(((await res.json()) as { MediaSources: unknown[] }).MediaSources).toHaveLength(1);
        expect(h.arm).not.toHaveBeenCalled();
    });

    it('the rate-limited refusal (clip cannot be produced) does not arm', async () => {
        h.clipFails = true;
        await capTvChannel();
        const res = await call({ body: PROFILE });
        expect(((await res.json()) as { ErrorCode?: string }).ErrorCode).toBe('RateLimitExceeded');
        expect(h.arm).not.toHaveBeenCalled();
    });

    it('a tvchannel answer arms too', async () => {
        vi.spyOn(config, 'FEATURE_LIVETV', 'get').mockReturnValue(true);
        h.mediaType = 'tvchannel';
        const { getLiveTvProvider } = await import('$lib/server/services/livetv/index.js');
        vi.mocked(getLiveTvProvider).mockResolvedValue({
            getChannel: vi.fn(),
            getStreamInfo: vi.fn().mockResolvedValue({}),
        } as never);
        await call({ body: PROFILE });
        expect(h.arm).toHaveBeenCalledTimes(1);
        expect(h.arm.mock.calls[0]![0]).toMatchObject({ itemId: ITEM, playSessionId: 'abc' });
    });
});

describe('PlaybackInfo — play and file tokens record the issuing admin capability', () => {
    beforeEach(() => {
        h.store.clear();
        h.mediaType = 'movie';
        h.clipFails = false;
        h.issuePlayToken.mockClear();
        h.issueFileToken.mockClear();
        vi.restoreAllMocks();
    });

    const base = { userId: ME, username: 'me', hasLiveTvPermission: true, userGroups: [] };

    it('an admin password session issues admin tokens', async () => {
        const res = await call({
            body: PROFILE,
            user: { ...base, ownerIsAdmin: true, mediaAccessIsAdmin: true },
        });
        expect(res.status).toBe(200);
        expect(h.issuePlayToken).toHaveBeenCalledWith(
            ITEM,
            'me',
            expect.any(String),
            expect.anything(),
            { mintedByAdmin: true },
        );
        expect(h.issueFileToken).toHaveBeenCalled();
        for (const c of h.issueFileToken.mock.calls as unknown[][]) {
            expect(c[4]).toEqual({ mintedByAdmin: true, playSessionId: 'abc', deviceId: 'dev-1' });
        }
    });

    it('a compat PAT of an admin owner issues non-admin tokens', async () => {
        await call({
            body: PROFILE,
            authMethod: 'jellyfin_compat_pat',
            user: { ...base, ownerIsAdmin: false, mediaAccessIsAdmin: false },
        });
        expect((h.issuePlayToken.mock.calls[0] as unknown[])[4]).toEqual({ mintedByAdmin: false });
        for (const c of h.issueFileToken.mock.calls as unknown[][]) {
            expect(c[4]).toEqual({ mintedByAdmin: false, playSessionId: 'abc', deviceId: 'dev-1' });
        }
    });

    it('an admin owner flag without the explicit capability issues non-admin tokens', async () => {
        await call({ body: PROFILE, user: { ...base, ownerIsAdmin: true } });
        expect((h.issuePlayToken.mock.calls[0] as unknown[])[4]).toEqual({ mintedByAdmin: false });
    });
});
