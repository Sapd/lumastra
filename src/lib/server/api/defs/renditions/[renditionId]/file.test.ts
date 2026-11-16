// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/renditions/{id}/file: auth -> checkMediaAccess (404) -> canDownload (403).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckMediaAccess = vi.fn();
const mockOverride = vi.fn();
const cfgOverrides = { FEATURE_MEDIA_DOWNLOAD: false };
const mockGetRendition = vi.fn();

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            ...actual.config,
            FEATURE_DOWNLOAD_RENDITIONS: true,
            DOWNLOAD_THROTTLE_KBPS: 0,
            DOWNLOADS_ALLOWED_BY_DEFAULT: true,
            get FEATURE_MEDIA_DOWNLOAD() {
                return cfgOverrides.FEATURE_MEDIA_DOWNLOAD;
            },
        },
    };
});
vi.mock('$lib/server/utils/file-streaming.js', () => ({
    serveFileByPath: async () => new Response('ok', { status: 200 }),
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemForDownloadNaming: async () => null,
}));
vi.mock('$lib/server/services/download-rendition/service.js', () => ({
    artifactPath: (n: string) => `/tmp/${n}`,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserAllowDownloads: (...a: unknown[]) => mockOverride(...a),
}));
vi.mock('$lib/server/database/queries/download-renditions.queries.js', () => ({
    getRendition: (...a: unknown[]) => mockGetRendition(...a),
    touchRendition: vi.fn(),
}));

const { def } = await import('./file.js');
const { invalidateDownloadAccess } =
    await import('$lib/server/services/download-access.service.js');

async function call(): Promise<Response> {
    return await def.handlers.GET!(
        {
            locals: { user: { userId: 'u1', username: 'alice' } },
            params: { renditionId: 'r1' },
            url: new URL('http://localhost/api/v1/renditions/r1/file'),
            request: new Request('http://localhost/api/v1/renditions/r1/file'),
        } as unknown as RequestEvent,
        { surface: 'v1' } as never,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetRendition.mockResolvedValue({
        id: 'r1',
        media_item_id: 'm1',
        status: 'ready',
        artifact_name: 'a.mp4',
        rung_id: '720p',
    });
    mockCheckMediaAccess.mockResolvedValue(true);
    mockOverride.mockResolvedValue(null);
    cfgOverrides.FEATURE_MEDIA_DOWNLOAD = false;
    invalidateDownloadAccess('u1');
});

describe('rendition file download gate', () => {
    it('is not blocked by FEATURE_MEDIA_DOWNLOAD being off (own flag is the switch)', async () => {
        const res = await call();
        expect(res.status).toBe(200);
        mockOverride.mockResolvedValue(false);
        invalidateDownloadAccess('u1');
        expect((await call()).status).toBe(403);
    });

    it('403 downloads_not_allowed when canDownload is false', async () => {
        mockOverride.mockResolvedValue(false);
        const res = await call();
        expect(res.status).toBe(403);
        expect((await res.json()).reason).toBe('downloads_not_allowed');
    });

    it('an item the user cannot see stays 404 and canDownload is not consulted', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        mockOverride.mockResolvedValue(false);
        const res = await call();
        expect(res.status).toBe(404);
        expect(mockOverride).not.toHaveBeenCalled();
    });
});
