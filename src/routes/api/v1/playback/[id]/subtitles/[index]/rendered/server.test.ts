// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    getRenderedSubtitle: vi.fn(),
    getOwnerItemForFile: vi.fn(),
    resolvePlaybackSelection: vi.fn(),
}));
vi.mock('$lib/server/middleware/auth.js', () => ({ requireAuth: (handler: unknown) => handler }));
vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: mocks.resolvePlaybackSelection,
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/subtitle-render.service.js', () => ({
    getRenderedSubtitle: mocks.getRenderedSubtitle,
}));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getOwnerItemForFile: mocks.getOwnerItemForFile,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    userNeedsMediaAccessCheck: async () => false,
    checkMediaAccess: vi.fn(),
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackSubtitle: vi.fn() },
}));
import { GET } from './+server.js';
const id = '12345678-1234-4234-8234-123456789012';
function event(etag?: string, fileId: string | null = 'file-2') {
    const url = new URL(
        `http://localhost/api/v1/playback/${id}/subtitles/7/rendered${fileId ? `?fileId=${fileId}` : ''}`,
    );
    return {
        params: { id, index: '7' },
        url,
        locals: { user: {} },
        request: new Request(url, { headers: etag ? { 'if-none-match': etag } : {} }),
    } as unknown as Parameters<typeof GET>[0];
}
describe('rendered subtitle REST manifest', () => {
    beforeEach(() => {
        mocks.getOwnerItemForFile.mockResolvedValue(null);
        mocks.resolvePlaybackSelection.mockImplementation(async (_sql, _id, options) => ({
            fileId: options.fileId ?? 'default-file',
        }));
        mocks.getRenderedSubtitle.mockResolvedValue({
            manifest: {
                canvas: { w: 1920, h: 1080 },
                cues: [
                    {
                        startMs: 1000,
                        endMs: 2000,
                        rects: [{ x: 10, y: 20, w: 300, h: 40, image: 'abc123' }],
                    },
                ],
            },
        });
    });
    it('resolves the server default when fileId is omitted', async () => {
        const response = await GET(event(undefined, null));
        expect(response.status).toBe(200);
        const manifest = await response.json();
        expect(manifest.cues[0].rects[0].href).toContain('?fileId=default-file');
        expect(mocks.getRenderedSubtitle).toHaveBeenCalledWith({}, id, 7, 'default-file');
    });
    it('replaces internal image identity with a selected-file PNG href and revalidates', async () => {
        const response = await GET(event());
        expect(response.status).toBe(200);
        const manifest = await response.json();
        expect(manifest.cues[0].rects[0]).toEqual({
            x: 10,
            y: 20,
            w: 300,
            h: 40,
            href: `/api/v1/playback/${id}/subtitles/7/rendered/abc123.png?fileId=file-2`,
        });
        expect(mocks.getRenderedSubtitle).toHaveBeenCalledWith({}, id, 7, 'file-2');
        const etag = response.headers.get('etag');
        expect(etag).toBeTruthy();
        expect((await GET(event(etag!))).status).toBe(304);
    });
    it('keeps rendered rectangle hrefs on the internal surface when re-exported there', async () => {
        const request = event();
        request.url.pathname = request.url.pathname.replace('/api/v1/', '/api/');
        const manifest = await (await GET(request)).json();
        expect(manifest.cues[0].rects[0].href).toBe(
            `/api/playback/${id}/subtitles/7/rendered/abc123.png?fileId=file-2`,
        );
    });
});
