// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// The shared original-file handler (serves /j/Items/{id}/Download and
// /api/v1/media/{id}/download) refuses a caller canDownload rejects, with a 403
// problem of reason downloads_not_allowed, before touching any file.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCanDownload = vi.fn();
const mockResolvePlaybackSelection = vi.fn();

vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return { ...actual, config: { ...actual.config, FEATURE_MEDIA_DOWNLOAD: true } };
});
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/download-access.service.js', () => ({
    canDownload: (...a: unknown[]) => mockCanDownload(...a),
}));
vi.mock('$lib/server/database/queries/media-file-resolution.queries', () => ({
    resolvePlaybackSelection: (...a: unknown[]) => mockResolvePlaybackSelection(...a),
}));

const { handleDownloadFile } = await import('./media-download-handler');

function event(path: string, params: Record<string, string>): RequestEvent {
    const url = new URL(`http://localhost${path}`);
    return {
        params,
        url,
        request: new Request(url),
        locals: { user: { userId: 'u1', username: 'alice' } },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePlaybackSelection.mockResolvedValue({ fileId: null, files: [] });
});

describe.each([
    ['/j/Items/{id}/Download', '/j/Items/item-1/Download', { itemId: 'item-1' }],
    ['/api/v1/media/{id}/download', '/api/v1/media/item-1/download', { id: 'item-1' }],
])('%s', (_name, path, params) => {
    it('returns 403 downloads_not_allowed when canDownload is false', async () => {
        mockCanDownload.mockResolvedValue(false);
        const res = await handleDownloadFile(event(path, params));
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.reason).toBe('downloads_not_allowed');
        expect(mockResolvePlaybackSelection).not.toHaveBeenCalled();
    });

    it('proceeds past the gate when canDownload is true', async () => {
        mockCanDownload.mockResolvedValue(true);
        const res = await handleDownloadFile(event(path, params));
        expect(res.status).toBe(404); // no file in the stub selection
        expect(mockResolvePlaybackSelection).toHaveBeenCalled();
    });
});
