// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/renditions/{id}/file: auth -> checkMediaAccess (404) -> canDownload (403).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckMediaAccess = vi.fn();
const mockOverride = vi.fn();
const cfgOverrides = { FEATURE_MEDIA_DOWNLOAD: false };
const mockGetRendition = vi.fn();
const mockTrack = vi.fn();
const mockServe = vi.fn();
const tracker = {
    rate: () => 5,
    observer: { onBytes() {}, onEnd() {} },
    onBytes() {},
    onEnd() {},
    served: vi.fn(),
    discard: vi.fn(),
};
let useFakeTracker = false;

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
            DOWNLOAD_GROUPS: [] as string[],
            get FEATURE_MEDIA_DOWNLOAD() {
                return cfgOverrides.FEATURE_MEDIA_DOWNLOAD;
            },
        },
    };
});
vi.mock('$lib/server/utils/file-streaming.js', () => ({
    serveFileByPath: (...a: unknown[]) => mockServe(...a),
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemForDownloadNaming: async () => null,
}));
vi.mock('$lib/server/services/download-rendition/service.js', () => ({
    artifactPath: (n: string) => `/tmp/${n}`,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserAllowDownloads: async (...a: unknown[]) => {
        const v = await mockOverride(...a);
        return v === undefined ? undefined : { allowDownloads: v, groups: [] };
    },
}));
vi.mock('$lib/server/services/download-tracking.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/services/download-tracking.js')>();
    return {
        ...actual,
        trackDownload: (...a: unknown[]) => {
            mockTrack(...a);
            if (useFakeTracker) return Promise.resolve({ ok: true, tracker });
            return (actual.trackDownload as (...b: unknown[]) => unknown)(...a);
        },
    };
});
vi.mock('$lib/server/database/queries/download-renditions.queries.js', () => ({
    getRendition: (...a: unknown[]) => mockGetRendition(...a),
    touchRendition: vi.fn(),
}));

const { def } = await import('./file.js');
const { invalidateDownloadAccess } =
    await import('$lib/server/services/download-access.service.js');

async function call(method = 'GET'): Promise<Response> {
    return await def.handlers.GET!(
        {
            locals: { user: { userId: 'u1', username: 'alice' } },
            params: { renditionId: 'r1' },
            url: new URL('http://localhost/api/v1/renditions/r1/file'),
            request: new Request('http://localhost/api/v1/renditions/r1/file', { method }),
        } as unknown as RequestEvent,
        { surface: 'v1' } as never,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetRendition.mockResolvedValue({
        id: 'r1',
        media_item_id: '22222222-2222-4222-8222-222222222222',
        status: 'ready',
        artifact_name: 'a.mp4',
        rung_id: '720p',
    });
    mockServe.mockImplementation(async () => new Response('ok', { status: 200 }));
    useFakeTracker = false;
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

describe('rendition file download tracking', () => {
    it('a HEAD takes no lease and logs no row', async () => {
        expect((await call('HEAD')).status).toBe(200);
        expect(mockTrack).not.toHaveBeenCalled();
    });

    it('a GET goes through trackDownload', async () => {
        expect((await call('GET')).status).toBe(200);
        expect(mockTrack).toHaveBeenCalledTimes(1);
    });
});

describe('rendition file download wiring', () => {
    beforeEach(() => {
        useFakeTracker = true;
    });

    it('serves with the tracker observer and a throttle function', async () => {
        await call('GET');
        const args = mockServe.mock.calls[0]!;
        expect(typeof args[5]).toBe('function');
        expect(args[5]()).toBe(5);
        expect(args[6]).toBe(tracker.observer);
        expect(tracker.served).toHaveBeenCalledWith(200);
        expect(tracker.discard).not.toHaveBeenCalled();
    });

    it('a 416 discards the lease', async () => {
        mockServe.mockResolvedValue(new Response(null, { status: 416 }));
        await call('GET');
        expect(tracker.discard).toHaveBeenCalledTimes(1);
    });

    it('a missing artifact (ENOENT) discards the lease and answers 404', async () => {
        mockServe.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        expect((await call('GET')).status).toBe(404);
        expect(tracker.discard).toHaveBeenCalledTimes(1);
    });

    it('any other throw discards the lease and propagates', async () => {
        mockServe.mockRejectedValue(new Error('disk'));
        await expect(call('GET')).rejects.toThrow('disk');
        expect(tracker.discard).toHaveBeenCalledTimes(1);
    });
});
