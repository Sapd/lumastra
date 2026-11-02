// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.{format} — the
// ticks-less form, and the ticks form's StartPositionTicks path segment, both
// on the shared subtitle handler: format from the extension, sidecar indices
// (1000+), access check, Jellyfin's window/time-map query params.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

const h = vi.hoisted(() => ({
    token: vi.fn(),
    resolve: vi.fn(),
    access: vi.fn(),
    needsCheck: vi.fn(),
    owner: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/subtitle-resolver.service', () => ({
    resolveSubtitle: h.resolve,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: h.access,
    userNeedsMediaAccessCheck: h.needsCheck,
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: h.owner,
    getFilesForMediaItem: vi.fn(async () => []),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    validatePlayToken: h.token,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { GET } = await import('./+server');
const { GET: ticksGet } = await import('../[segmentIndex]/[...streamFile]/+server');

const ITEM = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const FILE = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const S = 10_000_000;

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\none\n\n00:00:12.000 --> 00:00:13.000\ntwo\n';

function event(path: string, params: Record<string, string>): RequestEvent {
    const url = new URL(`https://example.test/j/Videos/${ITEM}/${FILE}/Subtitles/${path}`);
    return {
        params: { itemId: ITEM, mediaSourceId: FILE, ...params },
        url,
        request: new Request(url),
        locals: { user: { userId: 'u1', username: 'alice' } },
    } as unknown as RequestEvent;
}

const call = (handler: unknown, e: RequestEvent): Promise<Response> =>
    (handler as (e: RequestEvent) => Promise<Response>)(e);

describe('/j Subtitles/{index}/Stream.{format}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.needsCheck.mockResolvedValue(true);
        h.access.mockResolvedValue(true);
        h.owner.mockResolvedValue(null);
        h.resolve.mockResolvedValue({ content: VTT, contentType: 'text/vtt; charset=utf-8' });
        h.token.mockResolvedValue(null);
    });

    it('resolves a file-token media source id (MediaSource.Id, subtitles.m3u8 segments)', async () => {
        h.token.mockResolvedValue({ itemId: ITEM, fileId: FILE, userId: 'alice' });
        const token = 'dddddddd-0000-4000-8000-dddddddddddd';
        const e = event('3/Stream.vtt', { subtitleIndex: '3', format: 'vtt' });
        (e.params as Record<string, string>).mediaSourceId = token;
        await call(GET, e);
        expect(h.resolve).toHaveBeenCalledWith(expect.anything(), ITEM, 3, {
            fileId: FILE,
            format: 'vtt',
        });
    });

    it('windows a sidecar the resolver returns as bytes', async () => {
        h.resolve.mockResolvedValue({ content: Buffer.from(VTT), contentType: 'text/vtt' });
        const res = await call(
            GET,
            event(`1000/Stream.vtt?StartPositionTicks=${10 * S}&AddVttTimeMap=true`, {
                subtitleIndex: '1000',
                format: 'vtt',
            }),
        );
        expect(await res.text()).toBe(
            'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:02.000 --> 00:00:03.000\ntwo\n',
        );
    });

    it('400s an item id that is not a UUID', async () => {
        const e = event('3/Stream.vtt', { subtitleIndex: '3', format: 'vtt' });
        (e.params as Record<string, string>).itemId = 'not-a-uuid';
        expect((await call(GET, e)).status).toBe(400);
        expect(h.owner).not.toHaveBeenCalled();
    });

    it.each([
        ['srt', 'srt'],
        ['vtt', 'vtt'],
        ['ass', 'ass'],
        ['ssa', 'ass'],
        ['pgssub', 'pgssub'],
    ])('Stream.%s asks the resolver for %s', async (ext, format) => {
        const res = await call(GET, event(`3/Stream.${ext}`, { subtitleIndex: '3', format: ext }));
        expect(res.status).toBe(200);
        expect(h.resolve).toHaveBeenCalledWith(expect.anything(), ITEM, 3, {
            fileId: FILE,
            format,
        });
    });

    it('marks the subtitle private so shared caches do not serve it to others', async () => {
        const res = await call(GET, event('3/Stream.vtt', { subtitleIndex: '3', format: 'vtt' }));
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400');
    });

    it('serves an external sidecar by its 1000+position index', async () => {
        const res = await call(
            GET,
            event('1001/Stream.srt', { subtitleIndex: '1001', format: 'srt' }),
        );
        expect(res.status).toBe(200);
        expect(h.resolve).toHaveBeenCalledWith(expect.anything(), ITEM, 1001, expect.anything());
    });

    it('maps a file id in the item slot to its owning item (Android TV)', async () => {
        h.owner.mockResolvedValue('cccccccc-0000-0000-0000-cccccccccccc');
        await call(GET, event('3/Stream.vtt', { subtitleIndex: '3', format: 'vtt' }));
        expect(h.access).toHaveBeenCalledWith(
            expect.anything(),
            'cccccccc-0000-0000-0000-cccccccccccc',
            expect.anything(),
        );
        expect(h.resolve.mock.calls[0][1]).toBe('cccccccc-0000-0000-0000-cccccccccccc');
    });

    it('404s a user without access to the item', async () => {
        h.access.mockResolvedValue(false);
        const res = await call(GET, event('3/Stream.vtt', { subtitleIndex: '3', format: 'vtt' }));
        expect(res.status).toBe(404);
        expect(h.resolve).not.toHaveBeenCalled();
    });

    it('404s an index that resolves to nothing', async () => {
        h.resolve.mockResolvedValue(null);
        const res = await call(GET, event('9/Stream.vtt', { subtitleIndex: '9', format: 'vtt' }));
        expect(res.status).toBe(404);
    });

    it.each(['-1', 'abc', '1.5'])('400s index %s', async (idx) => {
        const res = await call(
            GET,
            event(`${idx}/Stream.vtt`, { subtitleIndex: idx, format: 'vtt' }),
        );
        expect(res.status).toBe(400);
    });

    it('windows WebVTT by StartPositionTicks/EndPositionTicks and adds the time map', async () => {
        const res = await call(
            GET,
            event(
                `3/Stream.vtt?StartPositionTicks=${10 * S}&EndPositionTicks=${20 * S}&AddVttTimeMap=true`,
                { subtitleIndex: '3', format: 'vtt' },
            ),
        );
        expect(await res.text()).toBe(
            'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:02.000 --> 00:00:03.000\ntwo\n',
        );
    });

    it('400s malformed position ticks', async () => {
        const res = await call(
            GET,
            event('3/Stream.vtt?startPositionTicks=-5', { subtitleIndex: '3', format: 'vtt' }),
        );
        expect(res.status).toBe(400);
    });

    it('returns ASS untouched even with a window', async () => {
        h.resolve.mockResolvedValue({ content: '[Script Info]\n', contentType: 'text/x-ssa' });
        const res = await call(
            GET,
            event(`3/Stream.ass?StartPositionTicks=${10 * S}`, {
                subtitleIndex: '3',
                format: 'ass',
            }),
        );
        expect(await res.text()).toBe('[Script Info]\n');
    });

    it('returns bitmap subtitles as bytes', async () => {
        h.resolve.mockResolvedValue({
            content: Buffer.from([0x50, 0x47, 0x00]),
            contentType: 'application/octet-stream',
        });
        const res = await call(
            GET,
            event('3/Stream.pgssub', { subtitleIndex: '3', format: 'pgssub' }),
        );
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x47, 0]));
    });
});

describe('/j Subtitles/{index}/{startPositionTicks}/Stream.{format}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.needsCheck.mockResolvedValue(false);
        h.owner.mockResolvedValue(null);
        h.resolve.mockResolvedValue({ content: VTT, contentType: 'text/vtt' });
    });

    it('takes the start from the path and shifts cues onto it', async () => {
        const res = await call(
            ticksGet,
            event(`3/${10 * S}/Stream.vtt`, {
                subtitleIndex: '3',
                segmentIndex: String(10 * S),
                streamFile: 'Stream.vtt',
            }),
        );
        expect(await res.text()).toBe('WEBVTT\n\n00:00:02.000 --> 00:00:03.000\ntwo\n');
    });

    it('lets a StartPositionTicks query param win over the path', async () => {
        const res = await call(
            ticksGet,
            event(`3/${10 * S}/Stream.vtt?StartPositionTicks=0`, {
                subtitleIndex: '3',
                segmentIndex: String(10 * S),
                streamFile: 'Stream.vtt',
            }),
        );
        expect(await res.text()).toBe(VTT);
    });

    it('400s a non-numeric ticks segment', async () => {
        const res = await call(
            ticksGet,
            event('3/x/Stream.vtt', {
                subtitleIndex: '3',
                segmentIndex: 'x',
                streamFile: 'Stream.vtt',
            }),
        );
        expect(res.status).toBe(400);
    });
});
