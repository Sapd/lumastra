// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockCheckMediaAccess,
    mockDeleteWatchlistItem,
    mockGetDb,
    mockHealNullFavoriteOrder,
    mockSetChannelFavorite,
    mockUpsertWatchlistItem,
} = vi.hoisted(() => ({
    mockCheckMediaAccess: vi.fn(),
    mockDeleteWatchlistItem: vi.fn(),
    mockGetDb: vi.fn(),
    mockHealNullFavoriteOrder: vi.fn(),
    mockSetChannelFavorite: vi.fn(),
    mockUpsertWatchlistItem: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', () => ({
    getDb: mockGetDb,
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
}));

vi.mock('$lib/server/database/queries/watchlist.queries', async (importOriginal) => {
    // Real `WatchlistMediaTypeNotAllowedError` class (not a mock) so the
    // route's `instanceof` check against it works the same as in production.
    const actual =
        await importOriginal<typeof import('$lib/server/database/queries/watchlist.queries')>();
    return {
        ...actual,
        upsertWatchlistItem: mockUpsertWatchlistItem,
        deleteWatchlistItem: mockDeleteWatchlistItem,
    };
});

vi.mock('$lib/server/database/queries/livetv-channels.queries', () => ({
    healNullFavoriteOrder: mockHealNullFavoriteOrder,
    setChannelFavorite: mockSetChannelFavorite,
}));

vi.mock('$lib/server/cache', () => ({
    cacheInvalidation: {
        onWatchlistChange: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    },
}));

import { DELETE, POST } from './+server';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '00000000-0000-0000-0000-000000000101';
const MEDIA_ID = '00000000-0000-0000-0000-000000000202';

function makeSql(channelIds = new Set<string>()) {
    const sql = vi.fn(async (_strings: TemplateStringsArray, itemId: string) =>
        channelIds.has(itemId) ? [{ id: itemId }] : [],
    );
    return Object.assign(sql, {
        begin: vi.fn(async (callback: (tx: typeof sql) => Promise<void>) => callback(sql)),
    });
}

function makeEvent(itemId: string, hasLiveTvPermission = true): RequestEvent {
    return {
        params: { itemId, userId: USER_ID },
        locals: {
            user: {
                userId: USER_ID,
                username: 'michael',
                hasLiveTvPermission,
            },
        },
    } as unknown as RequestEvent;
}

async function call(handler: unknown, itemId: string): Promise<Record<string, unknown>> {
    const response = await (handler as (event: RequestEvent) => Promise<Response>)(
        makeEvent(itemId),
    );
    return (await response.json()) as Record<string, unknown>;
}

describe('/j/Users/{userId}/FavoriteItems/{itemId}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetDb.mockReturnValue(makeSql(new Set([CHANNEL_ID])));
        // N8 (2026-09-22 edge-case pass): the route now branches on whether
        // upsertWatchlistItem actually inserted/found a row (`[]` = no-op,
        // non-empty = success) rather than only on whether it threw — so
        // tests need a realistic default resolved value, not vitest's
        // implicit `undefined`.
        mockUpsertWatchlistItem.mockResolvedValue([{ id: 1, inserted: true }]);
    });

    it('adds Live TV channels via livetv_channel_favorites, not user_watchlist', async () => {
        const body = await call(POST, CHANNEL_ID);

        expect(body.IsFavorite).toBe(true);
        expect(mockHealNullFavoriteOrder).toHaveBeenCalledWith(expect.any(Function), USER_ID);
        expect(mockSetChannelFavorite).toHaveBeenCalledWith(
            expect.any(Function),
            USER_ID,
            CHANNEL_ID,
            true,
        );
        expect(mockUpsertWatchlistItem).not.toHaveBeenCalled();
        expect(mockCheckMediaAccess).not.toHaveBeenCalled();
    });

    it('removes Live TV channels via livetv_channel_favorites, not user_watchlist', async () => {
        const body = await call(DELETE, CHANNEL_ID);

        expect(body.IsFavorite).toBe(false);
        expect(mockSetChannelFavorite).toHaveBeenCalledWith(
            expect.any(Function),
            USER_ID,
            CHANNEL_ID,
            false,
        );
        expect(mockDeleteWatchlistItem).not.toHaveBeenCalled();
    });

    it('keeps normal media favorites on the watchlist system playlist', async () => {
        const body = await call(POST, MEDIA_ID);

        expect(body.IsFavorite).toBe(true);
        expect(mockUpsertWatchlistItem).toHaveBeenCalledWith(
            expect.any(Function),
            USER_ID,
            MEDIA_ID,
        );
        expect(mockSetChannelFavorite).not.toHaveBeenCalled();
        expect(mockCheckMediaAccess).toHaveBeenCalled();
    });

    // N8 (2026-09-22 edge-case pass): `upsertWatchlistItem` returns `[]`
    // (never throws) for a non-existent media id — e.g. a Live TV/EPG
    // program GUID `checkMediaAccess` doesn't reject. Its INSERT is
    // `INSERT ... SELECT FROM media_items WHERE id = ...`, which can't
    // violate a foreign key; it just selects zero rows. This used to be
    // handled by a `23503` catch branch that can no longer be reached —
    // proves the success-path no-op branch does the same job.
    it('acknowledges a non-media id as a no-op (200, IsFavorite: true) without throwing', async () => {
        mockUpsertWatchlistItem.mockResolvedValueOnce([]);

        const body = await call(POST, MEDIA_ID);

        expect(body.IsFavorite).toBe(true);
    });

    it('degrades to a clean 4xx (not a 500) when upsertWatchlistItem rejects the media type', async () => {
        const { WatchlistMediaTypeNotAllowedError } =
            await import('$lib/server/database/queries/watchlist.queries');
        mockUpsertWatchlistItem.mockRejectedValueOnce(
            new WatchlistMediaTypeNotAllowedError('episode'),
        );

        const response = await (POST as (event: RequestEvent) => Promise<Response>)(
            makeEvent(MEDIA_ID),
        );

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
    });
});
