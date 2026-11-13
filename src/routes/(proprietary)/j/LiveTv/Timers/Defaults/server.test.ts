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
const PROGRAM = '22222222-2222-2222-2222-222222222222';
const REQUIRED = [
    'ChannelId',
    'StartDate',
    'EndDate',
    'Priority',
    'PrePaddingSeconds',
    'PostPaddingSeconds',
    'IsPrePaddingRequired',
    'IsPostPaddingRequired',
    'KeepUntil',
    'RecordAnyTime',
    'SkipEpisodesInLibrary',
    'RecordAnyChannel',
    'KeepUpTo',
    'RecordNewOnly',
];

function call(query = '', hasLiveTvPermission = true): Promise<Response> {
    const event = {
        url: new URL(`https://x.test/j/LiveTv/Timers/Defaults${query}`),
        locals: { user: { userId: 'u', hasLiveTvPermission } },
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('GET /j/LiveTv/Timers/Defaults', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetChannels.mockResolvedValue([{ id: CHANNEL, name: 'One', sortOrder: 0 }]);
        mockGetProgramById.mockResolvedValue({
            id: PROGRAM,
            channel_id: CHANNEL,
            title: 'Show',
            description: null,
            start_time: new Date('2026-10-07T20:00:00Z'),
            end_time: new Date('2026-10-07T21:00:00Z'),
        });
    });

    it('carries every SDK-required SeriesTimerInfoDto field', async () => {
        const body = await (await call()).json();
        for (const key of REQUIRED) expect(body).toHaveProperty(key);
        expect(body.ChannelId).toBe('00000000-0000-0000-0000-000000000000');
    });

    it('fills channel, name and times from a known programId', async () => {
        const body = await (await call(`?programId=${PROGRAM}`)).json();
        expect(body).toMatchObject({
            ChannelId: CHANNEL,
            ChannelName: 'One',
            ProgramId: PROGRAM,
            Name: 'Show',
            StartDate: '2026-10-07T20:00:00.000Z',
        });
    });

    it('ignores a bad programId and a program on a hidden channel', async () => {
        expect((await (await call('?programId=nope')).json()).ChannelId).toBe(
            '00000000-0000-0000-0000-000000000000',
        );
        mockGetChannels.mockResolvedValue([]);
        expect((await (await call(`?programId=${PROGRAM}`)).json()).Name).toBeUndefined();
    });

    it('404s without Live TV permission', async () => {
        expect((await call('', false)).status).toBe(404);
    });
});
