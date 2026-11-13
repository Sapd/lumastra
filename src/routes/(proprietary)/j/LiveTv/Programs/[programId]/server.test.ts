// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetChannels, mockGetProgramById } = vi.hoisted(() => ({
    mockGetChannels: vi.fn(),
    mockGetProgramById: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/services/livetv/index', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({ getChannels: mockGetChannels }),
}));
vi.mock('$lib/server/database', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/database/queries/livetv-programs.queries', () => ({
    getProgramById: mockGetProgramById,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { GET } from './+server';

const CHANNEL = '11111111-1111-1111-1111-111111111111';
const HIDDEN_CHANNEL = '33333333-3333-3333-3333-333333333333';
const PROGRAM = '22222222-2222-2222-2222-222222222222';

function call(programId: string, hasLiveTvPermission = true): Promise<Response> {
    const event = {
        url: new URL(`https://x.test/j/LiveTv/Programs/${programId}`),
        params: { programId },
        locals: { user: { userId: 'u', hasLiveTvPermission } },
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('GET /j/LiveTv/Programs/{programId}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetChannels.mockResolvedValue([
            {
                id: CHANNEL,
                name: 'News One',
                sortOrder: 0,
                images: { primary: { href: 'x', revision: '0', source: 'self' } },
                category: 'News',
            },
        ]);
        mockGetProgramById.mockImplementation(async (_sql: unknown, id: string) =>
            id === PROGRAM
                ? {
                      id: PROGRAM,
                      channel_id: CHANNEL,
                      title: 'Evening News',
                      description: 'Today',
                      start_time: new Date('2026-10-07T18:00:00Z'),
                      end_time: new Date('2026-10-07T18:30:00Z'),
                      epg_id: 'news.1',
                      genres: ['News'],
                      official_rating: null,
                  }
                : null,
        );
    });

    it('returns the program as a BaseItemDto', async () => {
        const res = await call(PROGRAM);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
            Id: PROGRAM,
            Type: 'Program',
            Name: 'Evening News',
            ChannelId: CHANNEL,
            ChannelName: 'News One',
            IsNews: true,
            StartDate: '2026-10-07T18:00:00.000Z',
            ImageTags: { Primary: '0' },
        });
        expect(body.UserData).toBeDefined();
    });

    it('404s without Live TV permission', async () => {
        const res = await call(PROGRAM, false);
        expect(res.status).toBe(404);
        expect(mockGetProgramById).not.toHaveBeenCalled();
    });

    it('404s for an unknown id and for a non-uuid id', async () => {
        expect((await call('44444444-4444-4444-4444-444444444444')).status).toBe(404);
        expect((await call('not-a-uuid')).status).toBe(404);
    });

    it('404s for a program on a hidden channel', async () => {
        mockGetProgramById.mockResolvedValueOnce({
            id: PROGRAM,
            channel_id: HIDDEN_CHANNEL,
            title: 'Hidden',
            description: null,
            start_time: new Date(),
            end_time: new Date(Date.now() + 60_000),
            epg_id: null,
            genres: null,
            official_rating: null,
        });
        expect((await call(PROGRAM)).status).toBe(404);
    });

    it('resolves the synthetic no-EPG program Recommended serves', async () => {
        const res = await call(`${CHANNEL}-live`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ Id: `${CHANNEL}-live`, ChannelId: CHANNEL, IsLive: true });
        expect((await call(`${HIDDEN_CHANNEL}-live`)).status).toBe(404);
    });
});
