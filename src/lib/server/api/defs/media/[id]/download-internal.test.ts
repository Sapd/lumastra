// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/media/{id}/download (browser session): same handler as v1, surface 'web'.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockHandle = vi.fn();
vi.mock('$lib/server/handlers/media-download-handler.js', () => ({
    handleDownloadFile: (...a: unknown[]) => mockHandle(...a),
}));
const mockCheck = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheck(...a),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));

const { def } = await import('./download-internal.js');

async function call() {
    const url = 'http://localhost/api/media/m1/download';
    return def.handlers.GET!(
        {
            locals: { user: { userId: 'u1', username: 'alice' } },
            url: new URL(url),
            params: { id: 'm1' },
            request: new Request(url),
        } as unknown as RequestEvent,
        { surface: 'internal' } as never,
    );
}

describe('media/{id}/download (internal)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCheck.mockResolvedValue(true);
    });

    it('returns the handler response untouched, surface web', async () => {
        const handlerRes = new Response('bytes', {
            status: 200,
            headers: { 'Content-Disposition': 'attachment; filename="a.mkv"' },
        });
        mockHandle.mockResolvedValue(handlerRes);
        const res = await call();
        expect(res).toBe(handlerRes);
        expect(mockHandle).toHaveBeenCalledWith(expect.anything(), { surface: 'web' });
    });

    it('passes the handler 403 through (download not allowed)', async () => {
        mockHandle.mockResolvedValue(new Response('no', { status: 403 }));
        expect((await call()).status).toBe(403);
    });

    it('an invisible item is 404 and never reaches the handler', async () => {
        mockCheck.mockResolvedValue(false);
        expect((await call()).status).toBe(404);
        expect(mockHandle).not.toHaveBeenCalled();
    });
});
