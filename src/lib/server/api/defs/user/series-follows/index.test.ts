// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
    sql: vi.fn(),
    flags: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    access: vi.fn(),
    invalidate: vi.fn(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => mocks.sql }));
vi.mock('$lib/server/database/queries/availability.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/availability.queries.js')>()),
    // Keep composing a SQL fragment from consuming the queued SELECT results.
    isAvailableExpr: () => 'mi.has_files',
}));
vi.mock('$lib/server/database/queries/user-media-flags.queries.js', () => ({
    getUserFlags: { all: mocks.flags },
    setFlag: { execute: mocks.set },
    removeFlag: mocks.remove,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: mocks.access }));
vi.mock('$lib/server/cache', () => ({
    CACHE_NAMESPACES: { upcomingEpisodes: {} },
    cacheManager: { for: () => ({ deleteUserCache: mocks.invalidate }) },
}));

import { def as list } from './index.js';
import { def as detail } from './[seriesId].js';

const userId = 'aaaaaaaa-0000-4000-8000-000000000001';
const seriesId = 'bbbbbbbb-0000-4000-8000-000000000002';
const otherId = 'cccccccc-0000-4000-8000-000000000003';
const event = { locals: { user: { userId } } } as unknown as RequestEvent;
const mutation = { surface: 'internal' as const, input: { params: { seriesId } } };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue(true);
    mocks.sql.mockResolvedValue([{ exists: true }]);
    mocks.flags.mockResolvedValue([]);
    mocks.invalidate.mockResolvedValue(undefined);
});

describe('user/series-follows', () => {
    it('follows idempotently with PUT, returns no body and invalidates upcoming', async () => {
        for (let i = 0; i < 2; i++) {
            const response = await detail.handlers.PUT!(event, mutation as never);
            expect(response.status).toBe(204);
            expect(await response.text()).toBe('');
        }
        expect(mocks.set).toHaveBeenCalledWith(mocks.sql, {
            userId,
            targetId: seriesId,
            targetType: 'series',
            flagType: 'series_episode_notifications',
        });
        expect(mocks.invalidate).toHaveBeenCalledTimes(2);
        expect(mocks.invalidate).toHaveBeenCalledWith(userId);
    });

    it('does not follow inaccessible media or a non-series', async () => {
        mocks.access.mockResolvedValueOnce(false);
        expect((await detail.handlers.PUT!(event, mutation as never)).status).toBe(404);
        expect(mocks.sql).not.toHaveBeenCalled();
        mocks.sql.mockResolvedValueOnce([{ exists: false }]);
        expect((await detail.handlers.PUT!(event, mutation as never)).status).toBe(404);
        expect(mocks.set).not.toHaveBeenCalled();
        expect(mocks.invalidate).not.toHaveBeenCalled();
    });

    it('unfollows repeatedly, including inaccessible series, and invalidates upcoming', async () => {
        mocks.access.mockResolvedValue(false);
        for (let i = 0; i < 2; i++) {
            const response = await detail.handlers.DELETE!(event, mutation as never);
            expect(response.status).toBe(204);
            expect(await response.text()).toBe('');
        }
        expect(mocks.remove).toHaveBeenCalledWith(mocks.sql, {
            userId,
            targetId: seriesId,
            flagType: 'series_episode_notifications',
        });
        expect(mocks.invalidate).toHaveBeenCalledTimes(2);
        expect(mocks.access).not.toHaveBeenCalled();
    });

    it('paginates after filtering inaccessible and non-series flags', async () => {
        mocks.flags.mockResolvedValue([
            { target_id: 'denied' },
            { target_id: seriesId },
            { target_id: otherId },
            { target_id: 'movie' },
        ]);
        mocks.access.mockImplementation(async (_sql: unknown, id: string) => id !== 'denied');
        mocks.sql
            .mockResolvedValueOnce([{ id: seriesId, title: 'Alpha', media_type: 'tv' }])
            .mockResolvedValueOnce([{ id: otherId, title: 'Beta', media_type: 'tv' }])
            .mockResolvedValueOnce([{ id: 'movie', title: 'Movie', media_type: 'movie' }]);
        const response = await list.handlers.GET!(event, {
            surface: 'internal',
            input: { query: { limit: 1, offset: 1 } },
        } as never);
        expect(await response.json()).toEqual({
            items: [{ id: otherId, title: 'Beta' }],
            page: { limit: 1, offset: 1, hasMore: false },
        });
    });

    it('does not fail a successful mutation when cache invalidation is unavailable', async () => {
        mocks.invalidate.mockRejectedValueOnce(new Error('Cache unavailable'));
        expect((await detail.handlers.PUT!(event, mutation as never)).status).toBe(204);
    });

    it('requires authentication and validates series UUIDs', async () => {
        const anonymous = { locals: {} } as RequestEvent;
        expect((await detail.handlers.PUT!(anonymous, mutation as never)).status).toBe(401);
        expect((await detail.handlers.DELETE!(anonymous, mutation as never)).status).toBe(401);
        expect((await list.handlers.GET!(anonymous, {} as never)).status).toBe(401);
        expect(detail.request!.params.safeParse({ seriesId: 'bad' }).success).toBe(false);
        expect(list.request!.query.parse({})).toEqual({ limit: 50, offset: 0 });
    });
});
