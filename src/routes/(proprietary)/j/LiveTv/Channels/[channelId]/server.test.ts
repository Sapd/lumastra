// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetChannel, mockGetChannels, mockGetCategories, mockCanStream } = vi.hoisted(() => ({
    mockGetChannel: vi.fn(),
    mockGetChannels: vi.fn(),
    mockGetCategories: vi.fn(),
    mockCanStream: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/services/livetv/index', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({
        getChannel: mockGetChannel,
        getChannels: mockGetChannels,
        getCategories: mockGetCategories,
    }),
}));
vi.mock('$lib/server/services/livetv/channel-access', () => ({
    canStreamLiveTvChannel: mockCanStream,
}));
vi.mock('$lib/server/database', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/database/queries/livetv-channels.queries', () => ({
    getFavoriteChannelIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { GET } from './+server';

const CHANNEL = '11111111-1111-1111-1111-111111111111';

function call(channelId: string, hasLiveTvPermission = true): Promise<Response> {
    const event = {
        url: new URL(`https://x.test/j/LiveTv/Channels/${channelId}`),
        params: { channelId },
        locals: { user: { userId: 'u', hasLiveTvPermission } },
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('GET /j/LiveTv/Channels/{channelId}', () => {
    const base = { id: CHANNEL, name: 'One', sortOrder: 0, images: {} };
    const currentProgram = {
        id: 'p',
        channelId: CHANNEL,
        title: 'On now',
        startTime: new Date(Date.now() - 60_000).toISOString(),
        endTime: new Date(Date.now() + 60_000).toISOString(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetChannel.mockImplementation(async (id: string) =>
            id === CHANNEL ? { ...base } : undefined,
        );
        mockGetChannels.mockResolvedValue([{ ...base, currentProgram }]);
        mockGetCategories.mockResolvedValue([]);
        mockCanStream.mockResolvedValue(true);
    });

    it('returns the channel with its number and what is on now', async () => {
        const res = await call(CHANNEL);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ Id: CHANNEL, Type: 'TvChannel', Number: '1' });
        expect(body.CurrentProgram).toMatchObject({ Id: 'p', Name: 'On now' });
        expect(body.MediaSources).toHaveLength(1);
        expect(body.MediaSources[0]).toMatchObject({ Id: CHANNEL, MediaStreams: [] });
        expect(body.MediaSources[0]).not.toHaveProperty('TranscodingUrl');
        expect(body.MediaSources[0]).not.toHaveProperty('LiveStreamId');
    });

    it('404s without Live TV permission, for unknown and for non-uuid ids', async () => {
        expect((await call(CHANNEL, false)).status).toBe(404);
        expect((await call('22222222-2222-2222-2222-222222222222')).status).toBe(404);
        expect((await call('not-a-uuid')).status).toBe(404);
        expect(mockGetChannel).toHaveBeenCalledTimes(1);
    });

    it('404s for a channel the viewer may not stream, without reading it', async () => {
        mockCanStream.mockResolvedValue(false);
        const res = await call(CHANNEL);
        expect(res.status).toBe(404);
        expect(mockCanStream).toHaveBeenCalledWith(expect.anything(), CHANNEL);
        expect(mockGetChannel).not.toHaveBeenCalled();
    });
});
