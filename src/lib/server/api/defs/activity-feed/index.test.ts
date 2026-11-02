// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/activity:
 *   - the service answered [] on a DB outage, so the admin saw "No activity
 *     recorded yet" and the documented 503 was unreachable;
 *   - hasMore was `items.length === limit`, which offered "Load more" in front
 *     of an empty page when the remainder was exactly one page;
 *   - offset had no maximum although each source fetches offset + limit rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

vi.mock('$lib/server/services/image-descriptor/avatars.js', () => ({
    userImageSets: async () => new Map(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
const getRecentActivity = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/activity-feed.service.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/services/activity-feed.service.js')>();
    return {
        ActivityFeedUnavailableError: actual.ActivityFeedUnavailableError,
        activityFeedService: { getRecentActivity },
    };
});

import { def } from './index.js';
import { ActivityFeedUnavailableError } from '$lib/server/services/activity-feed.service.js';

function row(id: number) {
    return {
        id,
        user_id: 'u1',
        display_name: 'Denis',
        activity_type: 'completed',
        media_id: null,
        media_type: 'movie',
        activity_time: new Date('2026-10-06T10:00:00Z'),
        created_at: new Date('2026-10-06T10:00:00Z'),
        last_update_time: null,
    };
}

async function get(query: Record<string, number>): Promise<Response> {
    return def.handlers.GET!(
        { locals: {} } as unknown as RequestEvent,
        { surface: 'internal', input: { query } } as unknown as ApiContext,
    );
}

beforeEach(() => {
    getRecentActivity.mockReset();
});

describe('GET /api/admin/activity', () => {
    it('answers 503 when the feed database is unavailable', async () => {
        getRecentActivity.mockRejectedValue(new ActivityFeedUnavailableError());
        expect((await get({ limit: 2, offset: 0 })).status).toBe(503);
    });

    it('answers 500 when a query fails', async () => {
        getRecentActivity.mockRejectedValue(new Error('boom'));
        expect((await get({ limit: 2, offset: 0 })).status).toBe(500);
    });

    it('reports no more pages when exactly `limit` rows remain', async () => {
        getRecentActivity.mockResolvedValue([row(1), row(2)]);
        const res = await get({ limit: 2, offset: 0 });
        const body = (await res.json()) as { items: unknown[]; page: { hasMore: boolean } };
        expect(getRecentActivity.mock.calls[0][0]).toBe(3);
        expect(body.items).toHaveLength(2);
        expect(body.page.hasMore).toBe(false);
    });

    it('reports more when the extra row came back, without returning it', async () => {
        getRecentActivity.mockResolvedValue([row(1), row(2), row(3)]);
        const body = (await (await get({ limit: 2, offset: 0 })).json()) as {
            items: unknown[];
            page: { hasMore: boolean };
        };
        expect(body.items).toHaveLength(2);
        expect(body.page.hasMore).toBe(true);
    });

    it('refuses an offset past the cap', async () => {
        expect((await get({ limit: 2, offset: 10_001 })).status).toBe(422);
        expect(getRecentActivity).not.toHaveBeenCalled();
    });
});
