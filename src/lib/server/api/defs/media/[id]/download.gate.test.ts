// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET media/{id}/download: access denial is a 404 and never reaches the
// handler (where the canDownload 403 lives), so an unseen item is not leaked.

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockHandleDownloadFile = vi.fn();
vi.mock('$lib/server/handlers/media-download-handler.js', () => ({
    handleDownloadFile: (...a: unknown[]) => mockHandleDownloadFile(...a),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(false),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));

const { def } = await import('./download.js');

describe('media/{id}/download access ordering', () => {
    it('an item the user cannot see is 404 before the download gate', async () => {
        const url = 'http://localhost/api/v1/media/m1/download';
        const res = await def.handlers.GET!(
            {
                locals: { user: { userId: 'u1', username: 'alice' } },
                url: new URL(url),
                params: { id: 'm1' },
                request: new Request(url),
            } as unknown as RequestEvent,
            { surface: 'v1' } as never,
        );
        expect(res.status).toBe(404);
        expect(mockHandleDownloadFile).not.toHaveBeenCalled();
    });
});
