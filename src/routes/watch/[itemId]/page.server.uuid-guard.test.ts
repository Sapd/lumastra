// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A non-UUID `itemId` that the id resolver cannot resolve to an internal UUID
 * must 404, not fall through to `getMediaItemForWatch` with the raw id (which
 * makes Postgres throw `invalid input syntax for type uuid`, surfacing as a
 * 500 instead of a 404).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

const { getMediaItemForWatch, checkMediaAccess, resolveAnyMediaId, resolveStation } = vi.hoisted(
    () => ({
        getMediaItemForWatch: vi.fn(),
        checkMediaAccess: vi.fn(),
        resolveAnyMediaId: vi.fn(),
        resolveStation: vi.fn(),
    }),
);

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemForWatch,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess }));
vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: { resolveAnyMediaId },
}));
vi.mock('$lib/server/plugins/runtime/widget-metadata.js', () => ({
    listPluginWidgetsFor: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/services/livetv/station.service.js', () => ({ resolveStation }));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: vi.fn().mockResolvedValue(true),
}));

const { load } = await import('./+page.server.js');

beforeEach(() => {
    vi.clearAllMocks();
});

describe('/watch/<itemId> — non-UUID id', () => {
    it('404s without querying getMediaItemForWatch when resolution finds nothing', async () => {
        resolveAnyMediaId.mockResolvedValue({ internalId: null });
        const url = new URL('http://localhost/watch/not-a-uuid');

        await expect(
            load({
                params: { itemId: 'not-a-uuid' },
                locals: { user: { username: 'alice', userId: 'user-1' } },
                url,
            } as unknown as Parameters<typeof load>[0]),
        ).rejects.toSatisfy((e: unknown) => isHttpError(e) && e.status === 404);

        expect(getMediaItemForWatch).not.toHaveBeenCalled();
    });

    it('404s when resolution itself throws', async () => {
        resolveAnyMediaId.mockRejectedValue(new Error('resolver down'));
        const url = new URL('http://localhost/watch/also-not-a-uuid');

        await expect(
            load({
                params: { itemId: 'also-not-a-uuid' },
                locals: { user: { username: 'alice', userId: 'user-1' } },
                url,
            } as unknown as Parameters<typeof load>[0]),
        ).rejects.toSatisfy((e: unknown) => isHttpError(e) && e.status === 404);

        expect(getMediaItemForWatch).not.toHaveBeenCalled();
    });
});

describe('/watch/<stationId> — station identity', () => {
    const stationId = '00000000-0000-4000-8000-000000000001';
    const feedId = '00000000-0000-4000-8000-000000000002';
    const event = () =>
        ({
            params: { itemId: stationId },
            locals: { user: { username: 'alice', userId: 'user-1', hasLiveTvPermission: true } },
            url: new URL(`http://localhost/watch/${stationId}`),
        }) as unknown as Parameters<typeof load>[0];

    it('resolves the shown feed without changing the public playback identity', async () => {
        getMediaItemForWatch.mockResolvedValueOnce(null).mockResolvedValueOnce({
            title: 'News',
            media_type: 'tvchannel',
        });
        checkMediaAccess.mockResolvedValue(true);
        resolveStation.mockResolvedValue({ stationId, shownFeedId: feedId, groupId: stationId });
        const result = await load(event());
        expect(resolveStation).toHaveBeenCalledWith(stationId);
        expect(getMediaItemForWatch).toHaveBeenLastCalledWith(expect.anything(), feedId);
        expect(result).toMatchObject({
            itemId: stationId,
            mediaDbId: feedId,
            playbackInfo: { itemId: stationId, internalId: feedId, isLive: true },
        });
    });

    it('treats an unknown cached feed id as absent', async () => {
        getMediaItemForWatch.mockResolvedValue({ title: 'Old feed', media_type: 'tvchannel' });
        checkMediaAccess.mockResolvedValue(true);
        resolveStation.mockResolvedValue(null);
        await expect(load(event())).rejects.toSatisfy(
            (e: unknown) => isHttpError(e) && e.status === 404,
        );
    });
});
