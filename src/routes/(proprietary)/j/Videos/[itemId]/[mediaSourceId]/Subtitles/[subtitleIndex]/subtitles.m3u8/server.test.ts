// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Videos/{id}/{mediaSourceId}/Subtitles/{index}/subtitles.m3u8 — Jellyfin's
// HLS subtitle playlist over the media source's runtime.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

const h = vi.hoisted(() => ({
    access: vi.fn(),
    item: vi.fn(),
    files: vi.fn(),
    token: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/subtitle-resolver.service', () => ({ resolveSubtitle: vi.fn() }));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: h.access,
    userNeedsMediaAccessCheck: vi.fn(async () => true),
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: vi.fn(async () => null),
    getFilesForMediaItem: h.files,
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemById: h.item,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    validatePlayToken: h.token,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { GET } = await import('./+server');

const ITEM = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const FILE = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

function call(query: string, mediaSourceId = FILE, index = '3'): Promise<Response> {
    const url = new URL(
        `https://example.test/j/Videos/${ITEM}/${mediaSourceId}/Subtitles/${index}/subtitles.m3u8?${query}`,
    );
    const event = {
        params: { itemId: ITEM, mediaSourceId, subtitleIndex: index },
        url,
        request: new Request(url),
        locals: { user: { userId: 'u1', username: 'alice' }, jfToken: 'tok' },
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('/j Subtitles/{index}/subtitles.m3u8', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.access.mockResolvedValue(true);
        h.item.mockResolvedValue({ id: ITEM, runtime_seconds: 100 });
        h.files.mockResolvedValue([{ id: FILE, duration_seconds: 25 }]);
        h.token.mockResolvedValue(null);
    });

    it('cuts the picked file runtime into segments carrying the session token', async () => {
        const res = await call('segmentLength=10');
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/x-mpegURL');
        const body = await res.text();
        expect(body.match(/#EXTINF:/g)).toHaveLength(3);
        expect(body).toContain('#EXTINF:5,');
        expect(body).toContain('Stream.vtt?CopyTimestamps=true&AddVttTimeMap=true');
        expect(body).toContain('&api_key=tok');
        expect(body.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
    });

    it('resolves a file-token media source id', async () => {
        h.token.mockResolvedValue({ fileId: FILE });
        const res = await call('SegmentLength=10', 'f'.repeat(32));
        expect((await res.text()).match(/#EXTINF:/g)).toHaveLength(3);
    });

    it("falls back to the item's runtime for an unknown media source", async () => {
        h.files.mockResolvedValue([]);
        const res = await call('segmentLength=50');
        expect((await res.text()).match(/#EXTINF:/g)).toHaveLength(2);
    });

    it.each(['', 'segmentLength=0', 'segmentLength=-3', 'segmentLength=x'])(
        '400s %s',
        async (query) => {
            expect((await call(query)).status).toBe(400);
        },
    );

    it('400s when the runtime is unknown', async () => {
        h.files.mockResolvedValue([]);
        h.item.mockResolvedValue({ id: ITEM, runtime_seconds: null });
        expect((await call('segmentLength=10')).status).toBe(400);
    });

    it('404s a user without access, and a missing item', async () => {
        h.access.mockResolvedValue(false);
        expect((await call('segmentLength=10')).status).toBe(404);
        h.access.mockResolvedValue(true);
        h.item.mockResolvedValue(null);
        expect((await call('segmentLength=10')).status).toBe(404);
    });
});
