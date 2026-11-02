// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin's HLS segment URL shapes reach the one /j segment handler:
 *   - hls1/{playlistId}/{N}.{container}            (this route)
 *   - hls/{playlistId}/stream.m3u8, hls/{playlistId}/{playlistId}{N}.ts  (hls/[...path])
 * with the path rewritten to our file names and the access re-check,
 * PlaySessionId normalisation and silent-start disarm of the segment route.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    handle: vi.fn(),
    access: vi.fn(),
    disarm: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/handlers/hls/lumastra-segment-handler.js', () => ({
    handleHlsSegment: h.handle,
    handleHlsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: h.access }));
vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    mediaItemExistsById: vi.fn(async () => true),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    disarmSilentStart: h.disarm,
}));

const { GET: hls1Get, OPTIONS: hls1Options } = await import('./+server');
const { GET: hlsGet } = await import('../../../hls/[...path]/+server');

const ITEM = 'b1f6c3a0-0000-4000-8000-000000000001';

function event(path: string, params: Record<string, string>): RequestEvent {
    const url = new URL(`https://example.test/j/Videos/${ITEM}/${path}`);
    return {
        params: { itemId: ITEM, ...params },
        url,
        request: new Request(url),
        locals: { user: { userId: 'u1', username: 'alice', ownerIsAdmin: false } },
    } as unknown as RequestEvent;
}

const call = (handler: unknown, e: RequestEvent): Promise<Response> =>
    (handler as (e: RequestEvent) => Promise<Response>)(e);

describe('/j/Videos/{id}/hls1/{playlistId}/{segment}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.access.mockResolvedValue(true);
        h.handle.mockResolvedValue(new Response('seg', { status: 200 }));
    });

    it('serves {N}.ts as our segment file, keyed on the camelCase playSessionId', async () => {
        const res = await call(
            hls1Get,
            event('hls1/abc/12.ts?playSessionId=ps1&runtimeTicks=1&api_key=k', {
                playlistId: 'abc',
                segment: '12.ts',
            }),
        );
        expect(res.status).toBe(200);
        expect(h.handle).toHaveBeenCalledTimes(1);
        const ctx = h.handle.mock.calls[0][0];
        expect(ctx.segmentPath).toBe('segment_00012.ts');
        expect(ctx.itemId).toBe(ITEM);
        expect(ctx.username).toBe('alice');
        expect(ctx.url.searchParams.get('PlaySessionId')).toBe('ps1');
        expect(h.disarm).toHaveBeenCalledWith(
            expect.objectContaining({ playSessionId: 'ps1', itemId: ITEM, username: 'alice' }),
        );
    });

    it('maps -1.mp4 to the init segment', async () => {
        await call(
            hls1Get,
            event('hls1/abc/-1.mp4?PlaySessionId=ps1', { playlistId: 'abc', segment: '-1.mp4' }),
        );
        expect(h.handle.mock.calls[0][0].segmentPath).toBe('init_0.mp4');
    });

    it('400s a segment id or container our engine never writes', async () => {
        for (const segment of ['x.ts', '1.mkv', '-3.ts']) {
            const res = await call(
                hls1Get,
                event(`hls1/abc/${segment}?PlaySessionId=ps1`, { playlistId: 'abc', segment }),
            );
            expect(res.status).toBe(400);
        }
        expect(h.handle).not.toHaveBeenCalled();
    });

    it('404s when the user may not see the item, before any segment lookup', async () => {
        h.access.mockResolvedValue(false);
        const res = await call(
            hls1Get,
            event('hls1/abc/0.ts?PlaySessionId=ps1', { playlistId: 'abc', segment: '0.ts' }),
        );
        expect(res.status).toBe(404);
        expect(h.handle).not.toHaveBeenCalled();
        expect(h.disarm).not.toHaveBeenCalled();
    });

    it('answers CORS preflight', async () => {
        const res = await call(hls1Options, event('hls1/abc/0.ts', {}));
        expect(res.status).toBe(204);
    });
});

describe('/j/Videos/{id}/hls/{playlistId}/… (Jellyfin legacy)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.access.mockResolvedValue(true);
        h.handle.mockResolvedValue(new Response('ok', { status: 200 }));
    });

    it.each([
        ['p1/stream.m3u8', 'master.m3u8'],
        ['p1/p17.ts', 'segment_00007.ts'],
        ['p1/segment_00002.ts', 'segment_00002.ts'],
        ['stream_0/index.m3u8', 'stream_0/index.m3u8'],
        ['segment_00001.ts', 'segment_00001.ts'],
    ])('%s is served as %s', async (path, expected) => {
        await call(hlsGet, event(`hls/${path}?PlaySessionId=ps1`, { path }));
        expect(h.handle.mock.calls[0][0].segmentPath).toBe(expected);
    });

    it('404s a revoked user on the legacy form too', async () => {
        h.access.mockResolvedValue(false);
        const res = await call(
            hlsGet,
            event('hls/p1/stream.m3u8?PlaySessionId=ps1', { path: 'p1/stream.m3u8' }),
        );
        expect(res.status).toBe(404);
        expect(h.handle).not.toHaveBeenCalled();
    });
});
