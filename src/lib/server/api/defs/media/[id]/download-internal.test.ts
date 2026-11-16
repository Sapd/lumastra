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
const mockResolve = vi.fn();
vi.mock('../../catalog/resolve-id.js', () => ({
    resolveCatalogInternalId: (...a: unknown[]) => mockResolve(...a),
}));

const { def } = await import('./download-internal.js');

async function call(headers: Record<string, string> = {}) {
    const url = 'http://localhost/api/media/m1/download';
    return def.handlers.GET!(
        {
            locals: {
                user: { userId: 'u1', username: 'alice', mediaAccessIsAdmin: true },
                principal: { isAdmin: false },
            },
            url: new URL(url),
            params: { id: 'm1' },
            request: new Request(url, { headers: Object.keys(headers).length ? headers : { 'sec-fetch-site': 'same-origin' } }),
        } as unknown as RequestEvent,
        { surface: 'internal' } as never,
    );
}

describe('media/{id}/download (internal)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCheck.mockResolvedValue(true);
        mockResolve.mockResolvedValue('internal-1');
    });

    it('returns the handler response untouched, surface web', async () => {
        const handlerRes = new Response('bytes', {
            status: 200,
            headers: { 'Content-Disposition': 'attachment; filename="a.mkv"' },
        });
        mockHandle.mockResolvedValue(handlerRes);
        const res = await call();
        expect(res).toBe(handlerRes);
        expect(mockHandle).toHaveBeenCalledWith(expect.anything(), {
            surface: 'web',
            itemId: 'internal-1',
        });
        // same access user as download-list: the principal decides admin, not the user row
        expect(mockCheck).toHaveBeenCalledWith(
            {},
            'internal-1',
            expect.objectContaining({ userId: 'u1', mediaAccessIsAdmin: false }),
        );
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

    it('an unresolvable id is 404', async () => {
        mockResolve.mockResolvedValue(null);
        expect((await call()).status).toBe(404);
        expect(mockHandle).not.toHaveBeenCalled();
    });

    it('a cross-site request is refused with 403 before anything else', async () => {
        const res = await call({ 'sec-fetch-site': 'cross-site' });
        expect(res.status).toBe(403);
        expect(mockCheck).not.toHaveBeenCalled();
        expect(mockHandle).not.toHaveBeenCalled();
    });

    it('same-origin requests pass, and a header-less one passes only with a same-origin Referer', async () => {
        mockHandle.mockResolvedValue(new Response('x'));
        expect((await call({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
        expect((await call({ referer: 'http://localhost/library' })).status).toBe(200);
    });

    it('a header-less request with no or a foreign Origin/Referer is refused', async () => {
        expect((await call({ accept: '*/*' })).status).toBe(403);
        expect((await call({ referer: 'https://evil.example/' })).status).toBe(403);
        expect(mockHandle).not.toHaveBeenCalled();
    });
});
