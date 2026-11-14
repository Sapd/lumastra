// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetChannels } = vi.hoisted(() => ({ mockGetChannels: vi.fn() }));

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/services/livetv/index', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({ getChannels: mockGetChannels }),
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { GET } from './+server';

const USER = '00000000-0000-4000-8000-000000000001';

async function call(hasLiveTvPermission: boolean): Promise<Record<string, unknown>> {
    const event = {
        url: new URL('https://x.test/j/LiveTv/Info'),
        locals: { user: { userId: USER, hasLiveTvPermission } },
    } as unknown as RequestEvent;
    const res = await (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
    expect(res.status).toBe(200);
    return res.json();
}

describe('GET /j/LiveTv/Info', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetChannels.mockResolvedValue([{ id: 'c', name: 'C', sortOrder: 0 }]);
    });

    it('is enabled with one service and lists only the caller (Jellyfin N-format id)', async () => {
        const body = await call(true);
        expect(body.IsEnabled).toBe(true);
        expect(body.EnabledUsers).toEqual(['00000000000040008000000000000001']);
        expect(body.Services).toEqual([
            expect.objectContaining({ Status: 'Ok', IsVisible: true, HasUpdateAvailable: false }),
        ]);
    });

    it('is disabled when there is no lineup', async () => {
        mockGetChannels.mockResolvedValue([]);
        expect(await call(true)).toEqual({ Services: [], IsEnabled: false, EnabledUsers: [] });
    });

    it('answers the disabled shape without Live TV permission', async () => {
        expect(await call(false)).toEqual({ Services: [], IsEnabled: false, EnabledUsers: [] });
        expect(mockGetChannels).not.toHaveBeenCalled();
    });
});
