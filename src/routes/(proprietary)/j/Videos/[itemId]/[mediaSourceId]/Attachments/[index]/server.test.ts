// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Videos/{id}/{mediaSourceId}/Attachments/{index}: access check, media
// source resolution (raw file id or file token), 404 when absent.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

const h = vi.hoisted(() => ({
    access: vi.fn(),
    owner: vi.fn(),
    selection: vi.fn(),
    extract: vi.fn(),
    token: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: h.access }));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: h.owner,
}));
vi.mock('$lib/server/database/queries/media-file-resolution.queries', () => ({
    resolvePlaybackSelection: h.selection,
}));
vi.mock('$lib/server/utils/media-path-resolver', () => ({
    resolveMediaPath: vi.fn(async (p: string) => ({ isAccessible: true, containerPath: p })),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    validatePlayToken: h.token,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/video-attachments', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/proprietary/jellyfin-compat/video-attachments')
    >()),
    extractVideoAttachment: h.extract,
}));

const { GET } = await import('./+server');

const ITEM = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const FILE = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const TOKEN = 'cccccccc-0000-0000-0000-cccccccccccc';
const FONT = Buffer.from('font-bytes');

function call(index: string, mediaSourceId = FILE): Promise<Response> {
    const url = new URL(
        `https://example.test/j/Videos/${ITEM}/${mediaSourceId}/Attachments/${index}?api_key=k`,
    );
    const event = {
        params: { itemId: ITEM, mediaSourceId, index },
        url,
        request: new Request(url),
        locals: { user: { userId: 'u1', username: 'alice' } },
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('/j/Videos/{id}/{mediaSourceId}/Attachments/{index}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.access.mockResolvedValue(true);
        h.owner.mockResolvedValue(null);
        h.token.mockResolvedValue(null);
        h.selection.mockImplementation(
            async (_sql: unknown, itemId: string, opts: { fileId: string }) =>
                itemId === ITEM && opts.fileId === FILE
                    ? { files: [{ id: FILE, file_path: '/media/a.mkv' }], fileId: FILE }
                    : { files: [], fileId: null },
        );
        h.extract.mockResolvedValue({
            attachment: {
                index: 4,
                codec: 'ttf',
                codecTag: null,
                fileName: 'Fancy Font.ttf',
                mimeType: 'font/ttf',
                comment: null,
            },
            data: FONT,
        });
    });

    it('serves the attachment with its mimetype', async () => {
        const res = await call('4');
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('font/ttf');
        expect(res.headers.get('Content-Length')).toBe(String(FONT.length));
        expect(res.headers.get('Content-Disposition')).toBe(
            "attachment; filename*=UTF-8''Fancy%20Font.ttf",
        );
        expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('font-bytes');
        expect(h.extract).toHaveBeenCalledWith('/media/a.mkv', 4);
    });

    it('never serves a file-authored non-font mimetype (stored XSS)', async () => {
        h.extract.mockResolvedValue({
            attachment: {
                index: 4,
                codec: null,
                codecTag: null,
                fileName: 'x.html',
                mimeType: 'text/html',
                comment: null,
            },
            data: Buffer.from('<script>alert(1)</script>'),
        });
        const res = await call('4');
        expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
        expect(res.headers.get('Content-Disposition')).toMatch(/^attachment/);
        expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    });

    it('accepts the file token PlaybackInfo issued as MediaSource.Id', async () => {
        h.token.mockResolvedValue({ itemId: ITEM, fileId: FILE, userId: 'alice' });
        const res = await call('4', TOKEN);
        expect(res.status).toBe(200);
    });

    it('404s a user without access, before touching the file', async () => {
        h.access.mockResolvedValue(false);
        const res = await call('4');
        expect(res.status).toBe(404);
        expect(h.extract).not.toHaveBeenCalled();
    });

    it("404s a media source that is not this item's", async () => {
        const res = await call('4', 'dddddddd-0000-0000-0000-dddddddddddd');
        expect(res.status).toBe(404);
        expect(h.extract).not.toHaveBeenCalled();
    });

    it('404s an index with no attachment', async () => {
        h.extract.mockResolvedValue(null);
        expect((await call('9')).status).toBe(404);
    });

    it('400s an item id that is not a UUID, before any DB lookup', async () => {
        const url = new URL('https://example.test/j/Videos/nope/x/Attachments/1');
        const res = await (GET as unknown as (e: RequestEvent) => Promise<Response>)({
            params: { itemId: 'nope', mediaSourceId: FILE, index: '1' },
            url,
            request: new Request(url),
            locals: { user: { userId: 'u1', username: 'alice' } },
        } as unknown as RequestEvent);
        expect(res.status).toBe(400);
        expect(h.owner).not.toHaveBeenCalled();
    });

    it.each(['-1', 'x', '1.5'])('400s index %s', async (idx) => {
        expect((await call(idx)).status).toBe(400);
    });
});
