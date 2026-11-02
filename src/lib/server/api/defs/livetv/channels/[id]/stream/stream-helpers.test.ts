// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { provider, access, priority, sessions, proxy } = vi.hoisted(() => ({
    provider: { getStreamInfo: vi.fn() },
    access: vi.fn(),
    priority: { checkAndEnforcePriority: vi.fn(), confirmEviction: vi.fn() },
    sessions: {
        getSession: vi.fn(),
        removeSessionIfChannel: vi.fn(),
        endViewerPlaybackSession: vi.fn(),
    },
    proxy: { leaveChannel: vi.fn() },
}));
vi.mock('$lib/server/services/livetv/livetv-session.service.js', () => ({
    getLiveTvSessionService: () => sessions,
}));
vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => proxy,
}));
vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: async () => provider,
}));
vi.mock('$lib/server/services/livetv/livetv-priority.service.js', () => ({
    getLiveTvPriorityService: () => priority,
}));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: access,
}));
vi.mock('$lib/server/config.js', () => ({
    config: { LIVETV_SHOW_ACTIVE_STREAMS: false },
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));

import {
    joinWithEviction,
    proxyErrorResponse,
    streamFailureResponse,
    streamLimitResponse,
} from './stream-helpers.js';
import {
    LiveTvFailureError,
    StreamFailureError,
    StreamLimitError,
} from '$lib/server/services/livetv/standalone-livetv-provider.js';
import { LIVETV_FAILURE_REASONS } from '../../../../../../../../shared/livetv-failure-reason.js';

const feedsTried = [
    { feedId: 'feed-a', feedName: 'Primary', reason: 'provider_auth_failed' as const },
];
const admin = { principal: { isAdmin: true } };
const viewer = { principal: { isAdmin: false } };

beforeEach(() => {
    vi.resetAllMocks();
    access.mockResolvedValue(true);
    sessions.getSession.mockResolvedValue(null);
    sessions.removeSessionIfChannel.mockResolvedValue(true);
    sessions.endViewerPlaybackSession.mockResolvedValue(undefined);
    proxy.leaveChannel.mockResolvedValue({ success: true });
});

describe('streamFailureResponse', () => {
    it.each(LIVETV_FAILURE_REASONS)('maps the typed failure %s to its code', async (reason) => {
        const err = new LiveTvFailureError(reason, 'ch', 'x', {
            retryable: true,
            retryAfterMs: 4000,
            feedsTried,
        });
        const response = streamFailureResponse(err, false);
        const body = await response.json();
        expect(body).toMatchObject({ code: reason, failure: { retryable: true }, retryAfter: 4 });
        expect('feedsTried' in body.failure).toBe(false);
        expect(response.headers.get('Retry-After')).toBe('4');
    });

    it('lets administrators see feedsTried', async () => {
        const err = new LiveTvFailureError('all_feeds_failed', 'ch', 'x', {
            retryable: false,
            feedsTried,
        });
        expect((await streamFailureResponse(err, true).json()).failure.feedsTried).toEqual(
            feedsTried,
        );
    });

    it('maps an unreachable proxy to dependency_unavailable 503 with a retry hint', async () => {
        const response = streamFailureResponse(
            new StreamFailureError('proxy_unreachable', 'ch', 'down'),
            false,
        );
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('5');
        expect(await response.json()).toMatchObject({
            code: 'dependency_unavailable',
            failure: { retryable: true },
            retryAfter: 5,
        });
    });

    it.each([
        ['spawn_failed', 'encoder_failed', 500],
        ['source_unreachable', 'provider_unreachable', 504],
    ] as const)('maps the legacy code %s to %s', async (legacy, code, status) => {
        const response = streamFailureResponse(new StreamFailureError(legacy, 'ch', 'm'), false);
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code });
    });

    it.each(['channel_not_found', 'no_segments'] as const)(
        'answers the proxy state loss %s as a retryable dependency problem, never offline',
        async (legacy) => {
            const response = streamFailureResponse(
                new StreamFailureError(legacy, 'ch', 'm'),
                false,
            );
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({
                code: 'dependency_unavailable',
                failure: { retryable: true },
            });
        },
    );

    it('keeps internal_error a plain bad_gateway', async () => {
        const response = streamFailureResponse(
            new StreamFailureError('internal_error', 'ch', 'm'),
            false,
        );
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({ code: 'bad_gateway' });
    });
});

describe('stream_limit', () => {
    it('carries the failure extension and retryAfter and keeps its details', async () => {
        const response = streamLimitResponse(new StreamLimitError(2, [], 'src'));
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('30');
        const body = await response.json();
        expect(body).toMatchObject({
            code: 'stream_limit',
            failure: { retryable: true },
            retryAfter: 30,
        });
        expect(JSON.parse(body.details)).toMatchObject({ limit: 2 });
    });
});

describe('joinWithEviction', () => {
    it('answers a classified start failure as the typed problem', async () => {
        provider.getStreamInfo.mockRejectedValue(
            new LiveTvFailureError('geo_blocked', 'ch', 'x', { retryable: false, feedsTried }),
        );
        const response = (await joinWithEviction(viewer, 'ch', 'alice', 'low', 'test')) as Response;
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({
            code: 'geo_blocked',
            failure: { retryable: false },
        });
    });

    it('shows feedsTried only to an admin principal', async () => {
        provider.getStreamInfo.mockRejectedValue(
            new LiveTvFailureError('all_feeds_failed', 'ch', 'x', { retryable: false, feedsTried }),
        );
        const adminResponse = (await joinWithEviction(admin, 'ch', 'a', 'low', 't')) as Response;
        expect((await adminResponse.json()).failure.feedsTried).toEqual(feedsTried);
    });
});

describe('joinWithEviction: feedsTried is for administrators only', () => {
    const secretFeeds = [
        { feedId: 'feed-secret-id', feedName: 'Secret Feed Name', reason: 'geo_blocked' as const },
    ];
    const failure = () =>
        new LiveTvFailureError('all_feeds_failed', 'ch', 'x', {
            retryable: false,
            feedsTried: secretFeeds,
        });

    it('leaves feedsTried, feed ids and feed names out of a non-admin answer', async () => {
        provider.getStreamInfo.mockRejectedValue(failure());
        const response = (await joinWithEviction(viewer, 'ch', 'v', 'low', 't')) as Response;
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({ code: 'all_feeds_failed' });
        expect(text).not.toContain('feedsTried');
        expect(text).not.toContain('feed-secret-id');
        expect(text).not.toContain('Secret Feed Name');
    });

    it('does the same in the post-eviction retry branch', async () => {
        provider.getStreamInfo
            .mockRejectedValueOnce(new StreamLimitError(1, [], 'src'))
            .mockRejectedValueOnce(failure());
        priority.checkAndEnforcePriority.mockResolvedValue({
            allowed: true,
            evicted: [{ viewerKey: 'other', channelId: 'x' }],
        });
        const response = (await joinWithEviction(viewer, 'ch', 'v', 'high', 't')) as Response;
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({ code: 'all_feeds_failed' });
        expect(text).not.toContain('feedsTried');
        expect(text).not.toContain('feed-secret-id');
        expect(text).not.toContain('Secret Feed Name');
        expect(priority.confirmEviction).not.toHaveBeenCalled();
    });

    it('still shows the admin the post-eviction feedsTried', async () => {
        provider.getStreamInfo
            .mockRejectedValueOnce(new StreamLimitError(1, [], 'src'))
            .mockRejectedValueOnce(failure());
        priority.checkAndEnforcePriority.mockResolvedValue({ allowed: true });
        const response = (await joinWithEviction(admin, 'ch', 'a', 'high', 't')) as Response;
        expect((await response.json()).failure.feedsTried).toEqual(secretFeeds);
    });
});

describe('joinWithEviction: join options', () => {
    const joined = { streamUrl: 'u', requiresProxy: true };
    const opts = { awaitReady: true };

    it('passes the options to the first join only, never to the post-eviction retry', async () => {
        provider.getStreamInfo
            .mockRejectedValueOnce(new StreamLimitError(1, [], 'src'))
            .mockResolvedValueOnce(joined);
        priority.checkAndEnforcePriority.mockResolvedValue({ allowed: true });
        await joinWithEviction(
            viewer,
            'ch',
            'v',
            'high',
            't',
            undefined,
            undefined,
            undefined,
            opts,
        );
        expect(provider.getStreamInfo).toHaveBeenCalledTimes(2);
        expect(provider.getStreamInfo.mock.calls[0][5]).toBe(opts);
        expect(provider.getStreamInfo.mock.calls[1]).toHaveLength(4);
    });

    it('keeps the legacy call shape when no options are given', async () => {
        provider.getStreamInfo.mockResolvedValue(joined);
        await joinWithEviction(viewer, 'ch', 'v', 'low', 't');
        expect(provider.getStreamInfo.mock.calls[0]).toHaveLength(4);
    });
});

describe('joinWithEviction: switching channels on a full source', () => {
    const joined = { streamUrl: 'u', requiresProxy: true };
    const opts = { awaitReady: true };
    const ownSession = (channelId: string, sourceId = 'src') => ({
        viewerKey: 'v',
        username: 'u',
        channelId,
        sourceId,
        priority: 'high' as const,
        startedAt: 1,
    });
    /** The proxy's refusal: the source's one slot is `ch1`, held by `viewers` viewers. */
    const full = (viewers = 1) =>
        new StreamLimitError(1, [{ channelId: 'ch1', channelName: 'One', viewers }], 'src');
    const join = (priorityLevel: 'high' | 'low') =>
        joinWithEviction(
            viewer,
            'ch2',
            'v',
            priorityLevel,
            't',
            undefined,
            undefined,
            undefined,
            opts,
        );

    it.each(['high', 'low'] as const)(
        "frees the slot of the viewer's own previous channel and joins (%s priority)",
        async (priorityLevel) => {
            provider.getStreamInfo.mockRejectedValueOnce(full()).mockResolvedValueOnce(joined);
            sessions.getSession.mockResolvedValue(ownSession('ch1'));

            expect(await join(priorityLevel)).toBe(joined);
            expect(proxy.leaveChannel).toHaveBeenCalledWith('ch1', 'v');
            expect(sessions.removeSessionIfChannel).toHaveBeenCalledWith('v', 'src', 'ch1');
            // The switch join is the viewer's real start: it keeps its options.
            expect(provider.getStreamInfo.mock.calls[1][5]).toBe(opts);
            expect(sessions.endViewerPlaybackSession).toHaveBeenCalledWith(
                'v',
                'ch1',
                'superseded',
            );
            expect(priority.checkAndEnforcePriority).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['on another source', ownSession('ch1', 'other-src')],
        ['already on the requested channel', ownSession('ch2')],
        ['without a session', null],
    ])('leaves nothing when the viewer is %s', async (_label, session) => {
        provider.getStreamInfo.mockRejectedValue(full());
        sessions.getSession.mockResolvedValue(session);

        const response = (await join('low')) as Response;
        expect(response.status).toBe(503);
        expect(proxy.leaveChannel).not.toHaveBeenCalled();
        expect(provider.getStreamInfo).toHaveBeenCalledTimes(1);
    });

    it('falls back to eviction when the proxy would not let the old channel go', async () => {
        provider.getStreamInfo.mockRejectedValueOnce(full()).mockResolvedValueOnce(joined);
        sessions.getSession.mockResolvedValue(ownSession('ch1'));
        proxy.leaveChannel.mockRejectedValue(new Error('proxy down'));
        priority.checkAndEnforcePriority.mockResolvedValue({ allowed: true });

        expect(await join('high')).toBe(joined);
        expect(sessions.removeSessionIfChannel).not.toHaveBeenCalled();
        expect(priority.checkAndEnforcePriority).toHaveBeenCalledOnce();
    });

    it.each([
        ['someone else also watches it', [{ channelId: 'ch1', channelName: 'One', viewers: 2 }]],
        ['the proxy does not list it', [{ channelId: 'ch9', channelName: 'Nine', viewers: 1 }]],
        ['it is in its grace period', [{ channelId: 'ch1', channelName: 'One', viewers: 0 }]],
    ])('keeps the old channel when %s: leaving frees no slot', async (_label, active) => {
        provider.getStreamInfo.mockRejectedValue(new StreamLimitError(1, active, 'src'));
        sessions.getSession.mockResolvedValue(ownSession('ch1'));

        const response = (await join('low')) as Response;
        expect(response.status).toBe(503);
        expect(proxy.leaveChannel).not.toHaveBeenCalled();
        expect(provider.getStreamInfo).toHaveBeenCalledTimes(1);
    });

    it('goes on to eviction when the switch join is still refused', async () => {
        provider.getStreamInfo
            .mockRejectedValueOnce(full())
            .mockRejectedValueOnce(new StreamLimitError(1, [], 'src'))
            .mockResolvedValueOnce(joined);
        sessions.getSession.mockResolvedValue(ownSession('ch1'));
        priority.checkAndEnforcePriority.mockResolvedValue({ allowed: true });

        expect(await join('high')).toBe(joined);
        expect(provider.getStreamInfo).toHaveBeenCalledTimes(3);
        // The post-eviction retry keeps answering at once: no options.
        expect(provider.getStreamInfo.mock.calls[2]).toHaveLength(4);
        expect(priority.checkAndEnforcePriority).toHaveBeenCalledWith('v', 'high', 'ch2', 'src', 1);
    });

    it.each([
        ['rejects', () => proxy.leaveChannel.mockRejectedValue(new Error('proxy down'))],
        ['answers success: false', () => proxy.leaveChannel.mockResolvedValue({ success: false })],
    ])('answers stream_limit without a second join when the leave %s', async (_l, arrange) => {
        provider.getStreamInfo.mockRejectedValue(full());
        sessions.getSession.mockResolvedValue(ownSession('ch1'));
        arrange();

        const response = (await join('low')) as Response;
        expect(response.status).toBe(503);
        expect(provider.getStreamInfo).toHaveBeenCalledTimes(1);
        expect(sessions.removeSessionIfChannel).not.toHaveBeenCalled();
    });

    it('answers stream_limit to a low-priority viewer the switch did not help', async () => {
        provider.getStreamInfo.mockRejectedValue(full());
        sessions.getSession.mockResolvedValue(ownSession('ch1'));

        const response = (await join('low')) as Response;
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'stream_limit' });
        expect(provider.getStreamInfo).toHaveBeenCalledTimes(2);
    });
});

describe('proxyErrorResponse (HLS routes)', () => {
    function proxy410(body: unknown): Response {
        return new Response(JSON.stringify(body), {
            status: 410,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    it('turns a proxy 410 channel_failed into a typed 410 problem', async () => {
        const response = await proxyErrorResponse(
            proxy410({
                error: 'channel_failed',
                reason: 'channel_offline',
                retryable: false,
            }),
        );
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({
            code: 'channel_offline',
            status: 410,
            failure: { retryable: false },
        });
    });

    it('carries retryAfter and never feedsTried or URLs', async () => {
        const response = await proxyErrorResponse(
            proxy410({
                error: 'channel_failed',
                reason: 'upstream_stalled',
                retryAfterMs: 3000,
                feedsTried: [{ index: 0, reason: 'upstream_stalled' }],
                url: 'http://secret.example/live.m3u8?token=abc',
            }),
        );
        const text = await response.text();
        expect(text).not.toContain('feedsTried');
        expect(text).not.toContain('secret.example');
        expect(JSON.parse(text)).toMatchObject({
            code: 'upstream_stalled',
            failure: { retryable: true },
            retryAfter: 3,
        });
        expect(response.headers.get('Retry-After')).toBe('3');
    });

    it('answers a plain 404 or 502 of an older or Rust proxy as a generic 502', async () => {
        expect((await proxyErrorResponse(new Response('', { status: 404 }))).status).toBe(502);
        expect(
            (
                await proxyErrorResponse(
                    new Response('{"error":"no_segments"}', {
                        status: 404,
                        headers: { 'Content-Type': 'application/json' },
                    }),
                )
            ).status,
        ).toBe(502);
        expect((await proxyErrorResponse(new Response('', { status: 502 }))).status).toBe(502);
    });

    it('answers any other proxy failure as a 502', async () => {
        expect((await proxyErrorResponse(new Response('boom', { status: 500 }))).status).toBe(502);
        expect((await proxyErrorResponse(new Response('not json', { status: 410 }))).status).toBe(
            502,
        );
        expect(
            (await proxyErrorResponse(proxy410({ error: 'something', reason: 'nope' }))).status,
        ).toBe(502);
    });
});
