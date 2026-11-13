// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    getChannel: vi.fn(),
    getStreamInfo: vi.fn(),
    issuePlayToken: vi.fn(),
    revokePlayTokenBySession: vi.fn(),
    buildStreamLimitPlaybackInfo: vi.fn(),
    canStream: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/services/livetv/index', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({
        getChannel: h.getChannel,
        getStreamInfo: h.getStreamInfo,
    }),
}));
vi.mock('$lib/server/database', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: h.canStream,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    issuePlayToken: h.issuePlayToken,
    revokePlayTokenBySession: h.revokePlayTokenBySession,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-limit-notice', () => ({
    freshPlaySessionId: vi.fn(async (id?: string) => id ?? 'fresh-session'),
    noticeLanguage: vi.fn(() => 'en'),
    buildStreamLimitPlaybackInfo: h.buildStreamLimitPlaybackInfo,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { POST } from './+server';
import {
    StreamFailureError,
    StreamLimitError,
} from '$lib/server/services/livetv/standalone-livetv-provider';

const CHANNEL = '11111111-1111-1111-1111-111111111111';
const TOKEN = '99999999-9999-4999-8999-999999999999';

function call(query: string, body: unknown = {}, hasLiveTvPermission = true): Promise<Response> {
    const locals: Record<string, unknown> = {
        user: { userId: 'user-1', username: 'alice', hasLiveTvPermission },
    };
    const event = {
        url: new URL(`https://x.test/j/LiveStreams/Open${query}`),
        request: new Request('https://x.test/j/LiveStreams/Open', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
        locals,
        cookies: { get: () => undefined },
    } as unknown as RequestEvent;
    return (POST as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('POST /j/LiveStreams/Open', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.getChannel.mockImplementation(async (id: string) =>
            id === CHANNEL ? { id: CHANNEL, name: 'One', sortOrder: 0 } : undefined,
        );
        h.getStreamInfo.mockResolvedValue({});
        h.issuePlayToken.mockResolvedValue(TOKEN);
        h.buildStreamLimitPlaybackInfo.mockResolvedValue(null);
        h.canStream.mockResolvedValue(true);
    });

    it('opens a channel (query ItemId) as a live HLS MediaSource', async () => {
        const res = await call(`?itemId=${CHANNEL}&playSessionId=abc`);
        expect(res.status).toBe(200);
        const { MediaSource } = await res.json();
        expect(MediaSource).toMatchObject({
            Id: CHANNEL,
            IsLiveTv: true,
            IsInfiniteStream: true,
            LiveStreamId: 'abc',
            TranscodingUrl: `/Videos/${CHANNEL}/live.m3u8?api_key=${TOKEN}`,
            TranscodingSubProtocol: 'hls',
        });
        expect(h.issuePlayToken).toHaveBeenCalledWith(CHANNEL, 'alice', 'abc', null);
        // Joined under the play-token viewer key, not a phantom one.
        expect(h.getStreamInfo).toHaveBeenCalledWith(CHANNEL, expect.stringContaining('alice'));
    });

    it('accepts ItemId or OpenToken in the OpenLiveStreamDto body', async () => {
        expect((await call('', { ItemId: CHANNEL })).status).toBe(200);
        expect((await call('', { OpenToken: CHANNEL })).status).toBe(200);
    });

    it('422 (ApiResponses.badRequest) without an item, 404 for an unknown or non-uuid item', async () => {
        expect((await call('')).status).toBe(422);
        expect((await call('?itemId=22222222-2222-2222-2222-222222222222')).status).toBe(404);
        expect((await call('?itemId=movie-1')).status).toBe(404);
    });

    it('404s for a channel the admin hid and never tunes it', async () => {
        h.getChannel.mockResolvedValue({
            id: CHANNEL,
            name: 'Hidden',
            images: {},
            sortOrder: 0,
            isVisible: false,
        });
        expect((await call(`?itemId=${CHANNEL}`)).status).toBe(404);
        expect(h.issuePlayToken).not.toHaveBeenCalled();
        expect(h.getStreamInfo).not.toHaveBeenCalled();
    });

    it('404s for a channel the lineup does not offer (hidden category) and never tunes it', async () => {
        h.canStream.mockResolvedValue(false);
        expect((await call(`?itemId=${CHANNEL}`)).status).toBe(404);
        expect(h.canStream).toHaveBeenCalledWith(expect.anything(), CHANNEL);
        expect(h.issuePlayToken).not.toHaveBeenCalled();
        expect(h.getStreamInfo).not.toHaveBeenCalled();
    });

    it('404s without Live TV permission and never tunes', async () => {
        expect((await call(`?itemId=${CHANNEL}`, {}, false)).status).toBe(404);
        expect(h.getChannel).not.toHaveBeenCalled();
        expect(h.getStreamInfo).not.toHaveBeenCalled();
    });

    it('source stream cap: revokes the token and serves the limit clip as the source', async () => {
        h.getStreamInfo.mockRejectedValue(new StreamLimitError(2, [], 'src'));
        h.buildStreamLimitPlaybackInfo.mockResolvedValue({
            PlaySessionId: 'n',
            MediaSources: [{ Id: 'notice', Protocol: 'Http' }],
        });
        const res = await call(`?itemId=${CHANNEL}&playSessionId=abc`);
        expect(res.status).toBe(200);
        expect((await res.json()).MediaSource.Id).toBe('notice');
        expect(h.revokePlayTokenBySession).toHaveBeenCalledWith('abc');
        expect(h.buildStreamLimitPlaybackInfo).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'livetv_source', cap: 2 }),
        );
    });

    it('source stream cap without a clip is a 503', async () => {
        h.getStreamInfo.mockRejectedValue(new StreamLimitError(2, [], 'src'));
        const res = await call(`?itemId=${CHANNEL}`);
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe('stream_limit_reached');
    });

    it('a source that fails to start is a 502 and the token is revoked', async () => {
        h.getStreamInfo.mockRejectedValue(
            new StreamFailureError('upstream_unreachable' as never, CHANNEL, 'down'),
        );
        const res = await call(`?itemId=${CHANNEL}&playSessionId=abc`);
        expect(res.status).toBe(502);
        expect(h.revokePlayTokenBySession).toHaveBeenCalledWith('abc');
    });
});
