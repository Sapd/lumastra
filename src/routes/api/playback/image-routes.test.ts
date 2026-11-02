// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from '@sveltejs/kit';

const h = vi.hoisted(() => ({
    select: vi.fn(),
    chapters: vi.fn(),
    episodeChapters: vi.fn(),
    params: vi.fn(),
    manifest: vi.fn(),
    sprite: vi.fn(),
    revision: vi.fn(),
    byWidth: vi.fn(),
    crop: vi.fn(),
}));
vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    withMediaAccess: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/middleware/error-handler', () => ({
    withErrorHandler: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/middleware/validate', () => ({
    withValidation: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/config.js', () => ({ config: { TRICKPLAY_SERVE_LOCAL: true } }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: h.select,
}));
vi.mock('$lib/server/database/queries/episode-chapters.queries.js', () => ({
    getChaptersForFile: h.chapters,
    getChaptersForEpisode: h.episodeChapters,
}));
vi.mock('$lib/server/database/queries/trickplay-params.queries.js', () => ({
    getTrickplayParams: h.params,
    getTrickplayParamsByWidth: h.byWidth,
}));
vi.mock('$lib/server/services/trickplay-storage.service.js', () => ({
    getTrickplayManifest: h.manifest,
    getSpriteSheet: h.sprite,
    getTrickplayRevision: h.revision,
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackTrickplay: vi.fn() },
}));
vi.mock('$lib/server/tasks/builtin/native/trickplay-providers/jellyfin-disk.js', () => ({
    getJellyfinDiskSpriteSheet: vi.fn(),
}));
vi.mock('$lib/server/utils/chapter-thumbnail.js', () => ({
    pickBestTrickplayParams: (rows: unknown[]) => rows[0],
    computeNearestChapterTiles: () => [{ sheetIndex: 0 }],
    cropChapterTile: h.crop,
}));

import { GET as manifestGET } from './[itemId]/trickplay/[width]/manifest/+server.js';
import { GET as sheetGET } from './[itemId]/trickplay/[width]/+server.js';
import { GET as chapterGET } from './[itemId]/chapter-image/[index]/+server.js';

const FILE = '00000000-0000-4000-a000-000000000002';
const ITEM = '00000000-0000-4000-a000-000000000001';
function event(width = 320, etag?: string) {
    const url = new URL(
        `https://example.test/api/playback/${ITEM}/trickplay/${width}?fileId=${FILE}`,
    );
    return {
        url,
        request: new Request(url, { headers: etag ? { 'If-None-Match': etag } : {} }),
        params: { itemId: ITEM, width: String(width), index: '0' },
        locals: { resolvedIds: { internalId: ITEM } },
        validated: { params: { width }, query: { fileId: FILE, index: 0 } },
    } as never;
}
beforeEach(() => {
    vi.clearAllMocks();
    h.select.mockResolvedValue({ fileId: FILE, files: [{ id: FILE, file_path: '/selected.mkv' }] });
    h.manifest.mockResolvedValue({
        width: 320,
        height: 180,
        tileWidth: 2,
        tileHeight: 2,
        interval: 1000,
        thumbnailCount: 5,
        sheets: [{ index: 0 }, { index: 1 }],
    });
    h.revision.mockResolvedValue('stored-revision-1');
    h.sprite.mockResolvedValue(Buffer.from('sprite'));
    h.chapters.mockResolvedValue([{ chapter_index: 0, start_ticks: 100000000 }]);
    h.params.mockResolvedValue([{ width: 320 }]);
    h.byWidth.mockResolvedValue(null);
    h.crop.mockResolvedValue(Buffer.from('cropped'));
});

describe('selected-file playback images', () => {
    it('returns JSON geometry and selected-file sheet hrefs without custom headers', async () => {
        const response = await manifestGET(event());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            fileId: FILE,
            width: 320,
            height: 180,
            tileColumns: 2,
            tileRows: 2,
            intervalMs: 1000,
            thumbnailCount: 5,
            sheets: [
                {
                    index: 0,
                    startMs: 0,
                    endMs: 4000,
                    href: `/api/playback/${ITEM}/trickplay/320?fileId=${FILE}&index=0&rev=stored-revision-1`,
                },
                {
                    index: 1,
                    startMs: 4000,
                    endMs: 5000,
                    href: `/api/playback/${ITEM}/trickplay/320?fileId=${FILE}&index=1&rev=stored-revision-1`,
                },
            ],
        });
        expect([...response.headers.keys()].some((key) => key.startsWith('x-trickplay-'))).toBe(
            false,
        );
        expect(h.manifest).toHaveBeenCalledWith(FILE, 320, '/selected.mkv');
    });
    it('returns 404 for an unknown requested width without serving another width', async () => {
        expect((await manifestGET(event(640))).status).toBe(404);
        expect(h.byWidth).toHaveBeenCalledWith({}, ITEM, 640, FILE);
        expect((await sheetGET(event(640))).status).toBe(404);
    });
    it('honours fileId for chapter and params lookups and returns 304 for its revision', async () => {
        const first = await chapterGET(event());
        expect(first.status).toBe(200);
        expect(h.select).toHaveBeenCalledWith({}, ITEM, { fileId: FILE });
        expect(h.chapters).toHaveBeenCalledWith({}, FILE, ITEM);
        expect(h.params).toHaveBeenCalledWith({}, ITEM, FILE);
        const second = await chapterGET(event(320, first.headers.get('etag')!));
        expect(second.status).toBe(304);
        expect(h.crop).toHaveBeenCalledTimes(1);
        h.revision.mockResolvedValue('stored-revision-2');
        expect((await chapterGET(event(320, first.headers.get('etag')!))).status).toBe(200);
    });
    it('does not substitute default-file chapters for a selected file without chapters', async () => {
        h.chapters.mockResolvedValue([]);
        expect((await chapterGET(event())).status).toBe(404);
        expect(h.chapters).toHaveBeenCalledWith({}, FILE, ITEM);
        expect(h.sprite).not.toHaveBeenCalled();
    });
    it('uses a strong sheet ETag that changes with revision or bytes', async () => {
        const first = await sheetGET(event());
        const etag = first.headers.get('etag')!;
        expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
        expect((await sheetGET(event(320, etag))).status).toBe(304);
        h.sprite.mockResolvedValue(Buffer.from('changed sprite'));
        expect((await sheetGET(event(320, etag))).status).toBe(200);
    });
    it('permits the same episode fallback as timeline only for the default cut', async () => {
        h.select.mockResolvedValue({
            fileId: FILE,
            files: [{ id: FILE, is_default: true, file_path: '/selected.mkv' }],
        });
        h.chapters.mockResolvedValue([]);
        h.episodeChapters.mockResolvedValue([{ chapter_index: 0, start_ticks: 100000000 }]);
        expect((await chapterGET(event())).status).toBe(200);
        expect(h.episodeChapters).toHaveBeenCalledWith({}, ITEM);
    });
    it.each([sheetGET, chapterGET])(
        'uses immutable caching only for a matching current revision',
        async (get) => {
            const first = await get(event());
            expect(first.headers.get('cache-control')).toBe('no-cache');
            const revision =
                get === sheetGET
                    ? 'stored-revision-1'
                    : first.headers.get('etag')!.replaceAll('"', '');
            const current = event() as unknown as { url: URL };
            current.url.searchParams.set('rev', revision);
            expect((await get(current as never)).headers.get('cache-control')).toBe(
                'public, max-age=31536000, immutable',
            );
            current.url.searchParams.set('rev', 'stale');
            expect((await get(current as never)).headers.get('cache-control')).toBe('no-cache');
        },
    );
    it('keeps manifest sheet hrefs on the v1 surface for a v1 request', async () => {
        const request = event() as unknown as { url: URL };
        request.url.pathname = request.url.pathname.replace('/api/', '/api/v1/');
        const body = await (await manifestGET(request as never)).json();
        expect(body.sheets[0].href).toContain('/api/v1/playback/');
    });
});
