// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * /j/Videos/{itemId}/stream.{container} is /stream with the container in the
 * path: same play-token branches, access check and disarm; `static=true`
 * serves the file (with Range), otherwise the path container drives the
 * progressive transcode. The real stream-file handler runs; only the DB,
 * path resolution and the FFmpeg runner are stubbed.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ITEM = 'b1f6c3a0-0000-4000-8000-000000000001';
const FILE = 'f11e0000-0000-4000-8000-000000000001';
const TOKEN = 'a'.repeat(32);

const dir = mkdtempSync(join(tmpdir(), 'jf-stream-container-'));
const MEDIA = join(dir, 'movie.mkv');
writeFileSync(MEDIA, Buffer.from('0123456789abcdef'));

const h = vi.hoisted(() => ({
    disarm: vi.fn(),
    access: vi.fn(),
    progressive: vi.fn(),
    authed: { value: true },
    tokens: new Map<string, { userId: string; itemId: string; fileId?: string }>(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => async (event: RequestEvent) => {
        if (!h.authed.value) return new Response(null, { status: 401 });
        (event.locals as unknown as Record<string, unknown>).user = {
            userId: 'u1',
            username: 'alice',
            isAdmin: false,
        };
        return handler(event as never);
    },
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    disarmSilentStart: h.disarm,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-limit-notice', () => ({
    serveStreamLimitClipFile: vi.fn(async () => null),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    isStreamLimitBanned: async () => false,
    validatePlayToken: vi.fn(async (t: string) => h.tokens.get(t) ?? null),
    renewPlayTokenBySession: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token-user', () => ({
    // 2026-10-13: routes call applyPlayTokenIdentity (user + never-admin stream_token principal).
    applyPlayTokenIdentity: (event: { locals: Record<string, unknown> }, user: unknown) => {
        event.locals.user = user;
        event.locals.principal = { kind: 'stream_token', isAdmin: false, scopes: [] };
    },
    buildPlayTokenUserContext: vi.fn(async (username: string) => ({
        userId: 'u1',
        username,
        isAdmin: false,
    })),
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: h.access }));
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: vi.fn(async () => ({ kicked: false })),
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: vi.fn(async () => null),
}));
vi.mock('$lib/server/database/queries/media-file-resolution.queries', () => ({
    resolvePlaybackSelection: vi.fn(async () => ({
        files: [{ id: FILE, file_path: MEDIA, total_bitrate: 8_000_000 }],
        fileId: FILE,
    })),
}));
vi.mock('$lib/server/utils/media-path-resolver', () => ({
    resolveMediaPath: vi.fn(async (p: string) => ({
        isAccessible: true,
        containerPath: p,
        fileSize: 16,
    })),
}));
vi.mock('$lib/server/database/queries/media-streams.queries', () => ({
    getStreamsForFile: vi.fn(async () => [
        {
            stream_type: 'video',
            stream_index: 0,
            codec: 'hevc',
            width: 1920,
            height: 1080,
            bitrate: null,
            is_external: false,
            video_range: 'SDR',
            dv_profile: null,
            color_transfer: null,
        },
        {
            stream_type: 'audio',
            stream_index: 1,
            codec: 'aac',
            channels: 2,
            is_default: true,
            bitrate: 128_000,
            is_external: false,
        },
    ]),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/progressive-transcode-runner', () => ({
    serveProgressiveTranscode: h.progressive,
}));

const { GET } = await import('./+server');

function call(
    pathId: string,
    container: string,
    query = '',
    headers: Record<string, string> = {},
): Promise<Response> {
    const url = new URL(`https://example.test/j/Videos/${pathId}/stream.${container}${query}`);
    const event = {
        params: { itemId: pathId, container },
        url,
        request: new Request(url, { headers }),
        locals: {},
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('/j/Videos/{itemId}/stream.{container}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.authed.value = true;
        h.access.mockResolvedValue(true);
        h.progressive.mockResolvedValue(new Response('transcoded', { status: 200 }));
        h.tokens.clear();
        h.tokens.set(TOKEN, { userId: 'alice', itemId: ITEM, fileId: FILE });
    });

    it('static=true serves the file whole', async () => {
        const res = await call(ITEM, 'mkv', '?static=true');
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('0123456789abcdef');
        expect(h.progressive).not.toHaveBeenCalled();
        expect(h.disarm).toHaveBeenCalledWith(expect.objectContaining({ itemId: ITEM }));
    });

    it('static=true honours Range', async () => {
        const res = await call(ITEM, 'mkv', '?static=true', { Range: 'bytes=2-5' });
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe('bytes 2-5/16');
        expect(await res.text()).toBe('2345');
    });

    it('without static, the PATH container drives the progressive transcode', async () => {
        const res = await call(ITEM, 'mp4', '?container=mkv&videoCodec=h264&audioCodec=aac');
        expect(res.status).toBe(200);
        expect(h.progressive).toHaveBeenCalledTimes(1);
        expect(h.progressive.mock.calls[0][0].plan.container).toBe('mp4');
    });

    it('400s a container Jellyfin would reject', async () => {
        const res = await call(ITEM, 'mkv;rm', '?static=true');
        expect(res.status).toBe(400);
    });

    it('404s a user without access to the item', async () => {
        h.access.mockResolvedValue(false);
        const res = await call(ITEM, 'mkv', '?static=true');
        expect(res.status).toBe(404);
        expect(h.disarm).not.toHaveBeenCalled();
    });

    it('needs auth when no play token is present', async () => {
        h.authed.value = false;
        const res = await call(ITEM, 'mkv', '?static=true');
        expect(res.status).toBe(401);
    });

    it('serves a file-token path id without auth headers (play-token branch)', async () => {
        h.authed.value = false;
        const res = await call(TOKEN, 'mkv', '?static=true', { Range: 'bytes=0-1' });
        expect(res.status).toBe(206);
        expect(await res.text()).toBe('01');
        expect(h.disarm).toHaveBeenCalledWith(
            expect.objectContaining({ username: 'alice', itemId: ITEM }),
        );
    });

    it('re-checks access on the play-token branch (404 once revoked)', async () => {
        h.authed.value = false;
        h.access.mockResolvedValue(false);
        const res = await call(TOKEN, 'mkv', '?static=true');
        expect(res.status).toBe(404);
    });
});
