// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({
    resolveFiles: vi.fn(),
    serve: vi.fn(),
}));
// Isolate selection/byte delivery; auth and access gates have their own guard suites.
vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    withMediaAccess: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/services/session-kill.service.js', () => ({
    checkSessionKickCooldown: async () => ({ kicked: false }),
}));
vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolveMediaFiles: mocks.resolveFiles,
}));
vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: async () => ({
        isAccessible: true,
        containerPath: '/library/movie.mkv',
        fileSize: 4,
    }),
    isPathWithinLibraryRoots: async () => true,
}));
vi.mock('$lib/server/utils/file-streaming.js', () => ({ serveContainedMediaFile: mocks.serve }));
import { GET } from './+server.js';
import { route } from '../../../v1/playback/[id]/file/_openapi.js';
beforeEach(() => {
    mocks.resolveFiles.mockReset();
    mocks.serve.mockReset();
});
function event(query: string): RequestEvent {
    const url = new URL(`http://localhost/api/v1/playback/movie/file${query}`);
    return {
        url,
        request: new Request(url, { headers: { Range: 'bytes=1-2' } }),
        locals: { user: { username: 'reader' }, resolvedIds: { internalId: 'movie' } },
    } as unknown as RequestEvent;
}
describe('direct-file query contract', () => {
    it('declares and enforces the existing required fileId without reading a file', async () => {
        expect(route.GET!.query!.safeParse({}).success).toBe(false);
        const response = await GET(event('') as Parameters<typeof GET>[0]);
        expect(response.status).toBe(422);
        expect(mocks.resolveFiles).not.toHaveBeenCalled();
    });
    it('passes the selected file and Range through and preserves binary 206', async () => {
        const fileId = '22222222-2222-4222-8222-222222222222';
        expect(route.GET!.query!.parse({ fileId })).toEqual({ fileId });
        mocks.resolveFiles.mockResolvedValue([{ file_path: '/library/movie.mkv' }]);
        mocks.serve.mockResolvedValue(
            new Response(new Uint8Array([1, 2]), {
                status: 206,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Range': 'bytes 1-2/4',
                },
            }),
        );
        const response = await GET(event(`?fileId=${fileId}`) as Parameters<typeof GET>[0]);
        expect(mocks.resolveFiles).toHaveBeenCalledWith(expect.anything(), 'movie', { fileId });
        expect(mocks.serve).toHaveBeenCalledWith('/library/movie.mkv', 'bytes=1-2');
        expect(response.status).toBe(206);
        expect(response.headers.get('Content-Range')).toBe('bytes 1-2/4');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    });
    it.each(['bad', ''])('rejects an invalid explicit fileId %j as 404', async (fileId) => {
        mocks.resolveFiles.mockClear();
        expect((await GET(event(`?fileId=${fileId}`) as Parameters<typeof GET>[0])).status).toBe(
            404,
        );
        expect(mocks.resolveFiles).not.toHaveBeenCalled();
    });
    it('returns 404 for a foreign file instead of a default', async () => {
        mocks.resolveFiles.mockClear().mockResolvedValue([]);
        const response = await GET(
            event('?fileId=33333333-3333-4333-8333-333333333333') as Parameters<typeof GET>[0],
        );
        expect(response.status).toBe(404);
        expect(mocks.resolveFiles).toHaveBeenCalledTimes(1);
    });
});
