// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({ select: vi.fn(), serve: vi.fn() }));
vi.mock('$lib/server/config', () => ({ config: { FEATURE_MEDIA_DOWNLOAD: true } }));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/media-file-resolution.queries', () => ({
    resolvePlaybackSelection: mocks.select,
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemForDownloadNaming: async () => null,
}));
vi.mock('$lib/server/utils/media-path-resolver', () => ({
    resolveMediaPath: async () => ({
        isAccessible: true,
        containerPath: '/media/source.mkv',
        fileSize: 4,
    }),
    isPathWithinLibraryRoots: async () => true,
}));
vi.mock('$lib/server/utils/file-streaming', () => ({ serveContainedMediaFile: mocks.serve }));
import { handleDownloadFile } from './media-download-handler.js';
const selected = '22222222-2222-4222-8222-222222222222';
const file = { id: selected, file_path: '/media/source.mkv' };
function event(path: string): RequestEvent {
    const url = new URL(path, 'https://test.invalid');
    return {
        url,
        params: { id: 'media', itemId: 'media' },
        request: new Request(url),
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.serve.mockResolvedValue(new Response('data'));
});
describe('attachment selected file', () => {
    it('uses fileId and never falls back for a foreign selection', async () => {
        mocks.select.mockResolvedValue({ files: [], fileId: null });
        expect(
            (await handleDownloadFile(event(`/api/v1/media/media/download?fileId=${selected}`)))
                .status,
        ).toBe(404);
        expect(mocks.select).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'media', {
            fileId: selected,
        });
        expect(mocks.serve).not.toHaveBeenCalled();
    });
    it.each(['bad', ''])(
        'invalid explicit selector %j returns 404 without default bytes',
        async (value) => {
            expect(
                (await handleDownloadFile(event(`/api/v1/media/media/download?fileId=${value}`)))
                    .status,
            ).toBe(404);
            expect(mocks.select).not.toHaveBeenCalled();
        },
    );
    it('an omitted selector asks for the default once', async () => {
        mocks.select.mockResolvedValue({ files: [file], fileId: selected });
        expect((await handleDownloadFile(event('/api/v1/media/media/download'))).status).toBe(200);
        expect(mocks.select).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'media', {
            fileId: undefined,
        });
    });
    it('Jellyfin retains its own mediaSourceId adapter and stale-source fallback', async () => {
        mocks.select
            .mockResolvedValueOnce({ files: [], fileId: null })
            .mockResolvedValueOnce({ files: [file], fileId: selected });
        expect(
            (await handleDownloadFile(event(`/j/Items/media/Download?mediaSourceId=${selected}`)))
                .status,
        ).toBe(200);
        expect(mocks.select).toHaveBeenNthCalledWith(1, expect.anything(), 'media', {
            fileId: selected,
        });
        expect(mocks.select).toHaveBeenNthCalledWith(2, expect.anything(), 'media');
    });
});
