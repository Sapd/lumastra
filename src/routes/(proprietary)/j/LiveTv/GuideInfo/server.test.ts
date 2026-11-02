// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetGuideEndDate } = vi.hoisted(() => ({ mockGetGuideEndDate: vi.fn() }));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/database/queries/livetv-programs.queries', () => ({
    getGuideEndDate: mockGetGuideEndDate,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { GET } from './+server';
import { resetGuideEndDateCache } from '$lib/server/proprietary/jellyfin-compat/livetv-guide-end';

function call(hasLiveTvPermission = true): Promise<Response> {
    const event = {
        url: new URL('https://x.test/j/LiveTv/GuideInfo'),
        locals: { user: { userId: 'u', hasLiveTvPermission } },
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('GET /j/LiveTv/GuideInfo', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetGuideEndDateCache();
    });

    it('runs from now to the end of the imported EPG', async () => {
        const epgEnd = new Date(Date.now() + 5 * 24 * 3600_000);
        mockGetGuideEndDate.mockResolvedValue(epgEnd);
        const before = Date.now();
        const body = await (await call()).json();
        expect(Date.parse(body.StartDate)).toBeGreaterThanOrEqual(before);
        expect(body.EndDate).toBe(epgEnd.toISOString());
    });

    it('falls back to one day ahead with no future listings', async () => {
        mockGetGuideEndDate.mockResolvedValue(new Date(Date.now() - 3600_000));
        const body = await (await call()).json();
        const span = Date.parse(body.EndDate) - Date.parse(body.StartDate);
        expect(span).toBe(24 * 3600_000);
        resetGuideEndDateCache();
        mockGetGuideEndDate.mockResolvedValue(null);
        const empty = await (await call()).json();
        expect(Date.parse(empty.EndDate) - Date.parse(empty.StartDate)).toBe(24 * 3600_000);
    });

    it('answers repeated polls from a 60 s cache instead of re-running MAX(end_time)', async () => {
        vi.useFakeTimers();
        try {
            const epgEnd = new Date(Date.now() + 5 * 24 * 3600_000);
            mockGetGuideEndDate.mockResolvedValue(epgEnd);
            await call();
            await call();
            expect(mockGetGuideEndDate).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(60_001);
            await call();
            expect(mockGetGuideEndDate).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('404s without Live TV permission (Jellyfin LiveTvAccess policy)', async () => {
        expect((await call(false)).status).toBe(404);
        expect(mockGetGuideEndDate).not.toHaveBeenCalled();
    });
});
