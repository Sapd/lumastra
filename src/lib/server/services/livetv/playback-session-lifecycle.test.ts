// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const { service, proxy, gate, lock, unlock, resources, revoke } = vi.hoisted(() => ({
    resources: vi.fn(),
    revoke: vi.fn(),
    service: {
        getPlaybackSession: vi.fn(),
        consumeKicked: vi.fn(),
        endPlaybackSession: vi.fn(),
        refreshPlaybackSession: vi.fn(),
        releasePlaybackSession: vi.fn(),
        getSession: vi.fn(),
        removeSessionIfChannel: vi.fn(),
    },
    proxy: { heartbeat: vi.fn(), leaveChannel: vi.fn() },
    gate: vi.fn(),
    lock: vi.fn(),
    unlock: vi.fn(),
}));
vi.mock('./livetv-session.service.js', () => ({
    getLiveTvSessionService: () => service,
    listUserLiveTvResources: resources,
}));
vi.mock('../playback-grant.js', () => ({ revokeLiveGrantsForUser: revoke }));
vi.mock('./stream-proxy-client.js', () => ({ getStreamProxyClient: () => proxy }));
vi.mock('./channel-access.js', () => ({ canReadLiveTvChannelStream: gate }));
vi.mock('$lib/server/cache/valkey.js', () => ({
    acquireLock: lock,
    releaseLock: unlock,
}));
import { playbackKeepalive, playbackLeave, playbackState } from './playback-session-lifecycle.js';
const session = {
    sessionId: 's',
    stationId: 'station',
    feedId: 'feed',
    sourceId: 'source',
    viewerKey: 'alice:old-credential',
    username: 'alice',
    startedAt: 1,
    state: 'active',
};
function event(username = 'alice'): RequestEvent {
    return {
        params: { playbackSessionId: 's' },
        locals: {
            user: { username, hasLiveTvPermission: true },
            liveTvCredentialId: 'new-credential',
        },
        request: new Request('http://localhost'),
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.resetAllMocks();
    lock.mockResolvedValue('token');
    unlock.mockResolvedValue(true);
    service.getPlaybackSession.mockResolvedValue({ ...session });
    service.consumeKicked.mockResolvedValue({ kicked: false });
    service.refreshPlaybackSession.mockResolvedValue(undefined);
    service.endPlaybackSession.mockResolvedValue(undefined);
    service.releasePlaybackSession.mockResolvedValue(true);
    service.getSession.mockResolvedValue({ sourceId: 'source' });
    proxy.heartbeat.mockResolvedValue({ success: true });
    gate.mockResolvedValue(true);
});
describe('playback session lifecycle', () => {
    it('uses the recorded viewer key after credential rotation', async () => {
        expect((await playbackKeepalive(event())).status).toBe(204);
        expect(proxy.heartbeat).toHaveBeenCalledWith(
            'feed',
            'alice:old-credential',
            expect.any(AbortSignal),
        );
    });
    it.each([playbackKeepalive, playbackLeave, playbackState])(
        'refuses a foreign user without touching proxy or flags',
        async (handler) => {
            const response = await handler(event('bob'));
            expect(response.status).toBe(handler === playbackLeave ? 204 : 404);
            if (handler !== playbackLeave) {
                expect(await response.json()).toMatchObject({ reason: 'session_not_found' });
            }
            expect(service.releasePlaybackSession).not.toHaveBeenCalled();
            expect(proxy.heartbeat).not.toHaveBeenCalled();
            expect(proxy.leaveChannel).not.toHaveBeenCalled();
            expect(service.consumeKicked).not.toHaveBeenCalled();
        },
    );
    it.each(['superseded', 'left', 'expired', 'evicted'])(
        'returns a typed terminal reason %s',
        async (reason) => {
            service.getPlaybackSession.mockResolvedValue({
                ...session,
                state: 'ended',
                endReason: reason,
            });
            const response = await playbackKeepalive(event());
            expect(response.status).toBe(410);
            expect(await response.json()).toMatchObject({
                code: 'gone',
                error: 'playback_session_ended',
                reason,
            });
            expect(proxy.heartbeat).not.toHaveBeenCalled();
            if (reason === 'evicted') {
                expect(service.consumeKicked).toHaveBeenCalledWith(session.viewerKey, 'feed');
            } else {
                expect(service.consumeKicked).not.toHaveBeenCalled();
            }
        },
    );
    it('takes an applicable kicked flag even when eviction already ended the record', async () => {
        service.getPlaybackSession.mockResolvedValue({
            ...session,
            state: 'ended',
            endReason: 'evicted',
        });
        service.consumeKicked.mockResolvedValue({ kicked: true, reason: 'higher_priority_viewer' });
        expect((await playbackKeepalive(event())).status).toBe(410);
        expect(service.consumeKicked).toHaveBeenCalledWith(session.viewerKey, 'feed');
    });
    it('distinguishes missing and proxy-expired sessions', async () => {
        service.getPlaybackSession.mockResolvedValueOnce(null);
        expect(await (await playbackKeepalive(event())).json()).toMatchObject({
            reason: 'session_not_found',
        });
        proxy.heartbeat.mockRejectedValueOnce(new Error('Proxy 404: absent'));
        expect(await (await playbackKeepalive(event())).json()).toMatchObject({
            reason: 'session_expired',
        });
        expect(service.endPlaybackSession).toHaveBeenCalledWith('s', 'expired');
    });
    it('returns 503 when the proxy is unavailable; preserves successful proxy heartbeats on store refresh failure', async () => {
        proxy.heartbeat.mockRejectedValueOnce(new Error('offline'));
        expect((await playbackKeepalive(event())).status).toBe(503);
        service.refreshPlaybackSession.mockRejectedValueOnce(new Error('offline'));
        expect((await playbackKeepalive(event())).status).toBe(204);
    });
    it('leaves without the lineup gate and cleans presence even when the proxy fails', async () => {
        gate.mockResolvedValue(false);
        proxy.leaveChannel.mockRejectedValueOnce(new Error('offline'));
        expect((await playbackLeave(event())).status).toBe(204);
        expect(service.removeSessionIfChannel).toHaveBeenCalledWith(
            session.viewerKey,
            'source',
            'feed',
        );
        expect(gate).not.toHaveBeenCalled();
    });
    it('leaves after Live TV permission is revoked, but still requires a signed-in user', async () => {
        const revoked = event();
        revoked.locals.user!.hasLiveTvPermission = false;
        expect((await playbackLeave(revoked)).status).toBe(204);
        expect(service.releasePlaybackSession).toHaveBeenCalledTimes(1);
        expect(proxy.leaveChannel).toHaveBeenCalledTimes(1);

        const anonymous = event();
        anonymous.locals = {} as RequestEvent['locals'];
        expect((await playbackLeave(anonymous)).status).toBe(401);
        expect(service.releasePlaybackSession).toHaveBeenCalledTimes(1);
    });
    it('waits for a concurrent start to release the viewer lock before leaving', async () => {
        vi.useFakeTimers();
        try {
            lock.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue('token');
            const pending = playbackLeave(event());
            await vi.advanceTimersByTimeAsync(0);
            expect(service.releasePlaybackSession).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(400);
            expect((await pending).status).toBe(204);
            expect(lock).toHaveBeenCalledTimes(3);
            expect(lock).toHaveBeenCalledWith(`livetv:v2:psess-lock:${session.viewerKey}`, 120);
            expect(unlock).toHaveBeenCalledWith(
                `livetv:v2:psess-lock:${session.viewerKey}`,
                'token',
            );
        } finally {
            vi.useRealTimers();
        }
    });
    it('waits up to two seconds before returning session_busy for a held viewer lock', async () => {
        vi.useFakeTimers();
        try {
            lock.mockResolvedValue(null);
            const pending = playbackLeave(event());
            await vi.advanceTimersByTimeAsync(1_999);
            expect(lock).toHaveBeenCalledTimes(10);
            expect(service.releasePlaybackSession).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            const response = await pending;
            expect(response.status).toBe(409);
            expect(await response.json()).toMatchObject({ reason: 'session_busy' });
            expect(lock).toHaveBeenCalledTimes(11);
            expect(unlock).not.toHaveBeenCalled();
            expect(proxy.leaveChannel).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
    it('does not release a newer session, including a replacement on the same feed', async () => {
        service.releasePlaybackSession.mockResolvedValue(false);
        expect((await playbackLeave(event())).status).toBe(204);
        expect(proxy.leaveChannel).not.toHaveBeenCalled();
        expect(service.removeSessionIfChannel).not.toHaveBeenCalled();
    });
    it('leave is idempotent for missing and ended sessions', async () => {
        service.getPlaybackSession
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ ...session, state: 'ended', endReason: 'left' });
        expect((await playbackLeave(event())).status).toBe(204);
        expect((await playbackLeave(event())).status).toBe(204);
        expect(proxy.leaveChannel).not.toHaveBeenCalled();
    });
    it('state exposes only public identity and output metadata', async () => {
        const response = await playbackState(event());
        expect(await response.json()).toEqual({
            playbackSessionId: 's',
            stationId: 'station',
            feedId: 'feed',
            purpose: 'playback',
            state: 'active',
        });
    });
});

describe('playback session lifecycle: failed channel', () => {
    const feedsTried = [
        { index: 0, feedId: 'feed-a', reason: 'provider_auth_failed', upstreamStatus: 403 },
        { index: 1, feedId: 'feed-b', reason: 'channel_offline', upstreamStatus: 404 },
    ];
    function adminEvent(): RequestEvent {
        const base = event();
        return {
            ...base,
            locals: { ...base.locals, principal: { isAdmin: true } },
        } as unknown as RequestEvent;
    }
    const storedFeeds = [
        { id: 'feed-a', name: 'Primary' },
        { id: 'feed-b', name: 'Backup' },
    ];
    beforeEach(() => {
        service.getPlaybackSession.mockResolvedValue({ ...session, feeds: storedFeeds });
        proxy.leaveChannel.mockResolvedValue({ success: true });
        service.removeSessionIfChannel.mockResolvedValue(true);
        proxy.heartbeat.mockResolvedValue({
            success: false,
            message: 'channel failed',
            failure: { reason: 'all_feeds_failed', retryable: false, feedsTried },
        });
    });
    it('ends the session as failed, frees the slot and answers a typed 410', async () => {
        const response = await playbackKeepalive(event());
        expect(response.status).toBe(410);
        expect(response.headers.get('Content-Type')).toContain('application/problem+json');
        const body = await response.json();
        expect(body).toMatchObject({
            code: 'all_feeds_failed',
            error: 'playback_session_ended',
            reason: 'failed',
            failure: { retryable: false },
            status: 410,
        });
        expect(body.failure.feedsTried).toBeUndefined();
        expect(service.endPlaybackSession).toHaveBeenCalledWith(
            's',
            'failed',
            expect.objectContaining({
                code: 'all_feeds_failed',
                retryable: false,
                at: expect.any(String),
            }),
        );
        expect(proxy.leaveChannel).toHaveBeenCalledWith(
            'feed',
            'alice:old-credential',
            expect.any(AbortSignal),
        );
        expect(service.removeSessionIfChannel).toHaveBeenCalledWith(
            'alice:old-credential',
            'source',
            'feed',
        );
    });
    it('shows feedsTried to administrators only', async () => {
        const body = await (await playbackKeepalive(adminEvent())).json();
        expect(body.failure.feedsTried).toEqual([
            {
                feedId: 'feed-a',
                feedName: 'Primary',
                reason: 'provider_auth_failed',
                upstreamStatus: 403,
            },
            {
                feedId: 'feed-b',
                feedName: 'Backup',
                reason: 'channel_offline',
                upstreamStatus: 404,
            },
        ]);
    });
    it('translates feedsTried with the stored feed names, ignoring proxy-supplied ids', async () => {
        proxy.heartbeat.mockResolvedValue({
            success: false,
            failure: {
                reason: 'all_feeds_failed',
                feedsTried: [
                    { index: 1, feedId: 'attacker-id', reason: 'geo_blocked' },
                    { index: 9, feedId: 'feed-a', reason: 'geo_blocked' },
                ],
            },
        });
        const body = await (await playbackKeepalive(adminEvent())).json();
        expect(body.failure.feedsTried).toEqual([
            { feedId: 'feed-b', feedName: 'Backup', reason: 'geo_blocked' },
        ]);
    });
    it('has no feedsTried for a session that stored no feeds (older record)', async () => {
        service.getPlaybackSession.mockResolvedValue({ ...session });
        const body = await (await playbackKeepalive(adminEvent())).json();
        expect(body.failure.feedsTried).toBeUndefined();
    });
    it('answers an evicted viewer with the eviction, never the stored retryable failure', async () => {
        service.getPlaybackSession.mockResolvedValue({
            ...session,
            state: 'ended',
            endReason: 'failed',
            failure: {
                code: 'upstream_stalled',
                retryable: true,
                retryAfterMs: 3000,
                at: '2026-10-20T10:00:00.000Z',
            },
        });
        service.consumeKicked.mockResolvedValue({ kicked: true, reason: 'higher_priority_viewer' });
        const response = await playbackKeepalive(event());
        expect(response.status).toBe(410);
        const body = await response.json();
        expect(body).toMatchObject({ reason: 'evicted', details: 'higher_priority_viewer' });
        expect(body.code).not.toBe('upstream_stalled');
        expect(body.failure).toBeUndefined();
    });
    it('answers an active evicted viewer with the eviction', async () => {
        service.consumeKicked.mockResolvedValue({ kicked: true, reason: 'higher_priority_viewer' });
        const body = await (await playbackKeepalive(event())).json();
        expect(body).toMatchObject({ reason: 'evicted' });
        expect(service.endPlaybackSession).toHaveBeenCalledWith('s', 'evicted');
        expect(proxy.heartbeat).not.toHaveBeenCalled();
    });
    it('sets retryAfter and the Retry-After header for a retryable failure', async () => {
        proxy.heartbeat.mockResolvedValue({
            success: false,
            failure: { reason: 'upstream_stalled', retryAfterMs: 2500, feedsTried: [] },
        });
        const response = await playbackKeepalive(event());
        expect(response.headers.get('Retry-After')).toBe('3');
        expect(await response.json()).toMatchObject({
            code: 'upstream_stalled',
            failure: { retryable: true },
            retryAfter: 3,
        });
    });
    it('answers the same 410 again for a later keepalive of the failed session', async () => {
        service.getPlaybackSession.mockResolvedValue({
            ...session,
            state: 'ended',
            endReason: 'failed',
            failure: {
                code: 'channel_offline',
                retryable: false,
                at: '2026-10-20T10:00:00.000Z',
            },
        });
        const response = await playbackKeepalive(event());
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({
            code: 'channel_offline',
            reason: 'failed',
            failure: { retryable: false },
        });
        expect(proxy.heartbeat).not.toHaveBeenCalled();
    });
    it('keeps the expired path when the proxy fails without a typed failure', async () => {
        proxy.heartbeat.mockResolvedValue({ success: false });
        const response = await playbackKeepalive(event());
        expect(response.status).toBe(404);
        expect(service.endPlaybackSession).toHaveBeenCalledWith('s', 'expired');
    });
    it('state carries the failure when endReason is failed', async () => {
        service.getPlaybackSession.mockResolvedValue({
            ...session,
            state: 'ended',
            endReason: 'failed',
            failure: {
                code: 'upstream_stalled',
                retryable: true,
                retryAfterMs: 3000,
                at: '2026-10-20T10:00:00.000Z',
                feedsTried: [{ feedId: 'feed-a', reason: 'upstream_stalled' }],
            },
        });
        const body = await (await playbackState(event())).json();
        expect(body.endReason).toBe('failed');
        expect(body.failure).toEqual({
            code: 'upstream_stalled',
            retryable: true,
            retryAfterMs: 3000,
            at: '2026-10-20T10:00:00.000Z',
        });
    });
});

it('keeps adaptive rung bitrates in Bps when reading session state', async () => {
    const adaptive = {
        rungs: [{ id: '720p4m', height: 720, maxBitrateBps: 4000000, codec: 'h264' }],
        includesOriginal: false,
    };
    service.getPlaybackSession.mockResolvedValue({ ...session, adaptive });
    const response = await playbackState(event());
    expect(response.status).toBe(200);
    expect((await response.json()).adaptive).toEqual(adaptive);
});

it('revocation releases every owned viewer, including previews and legacy streams, and live grants', async () => {
    const { revokeUserLiveTvPlayback } = await import('./playback-session-lifecycle.js');
    resources.mockResolvedValue({
        playback: [session],
        viewers: [
            { viewerKey: session.viewerKey, channelId: session.feedId, sourceId: session.sourceId },
            { viewerKey: 'alice:preview:p', channelId: 'preview', sourceId: 'source' },
            { viewerKey: 'alice:legacy', channelId: 'legacy', sourceId: 'source' },
        ],
    });
    proxy.leaveChannel.mockResolvedValue({ success: true });
    const sql = {} as never;
    await revokeUserLiveTvPlayback(sql, 'alice');
    expect(revoke).toHaveBeenCalledWith(sql, 'alice');
    expect(service.releasePlaybackSession).toHaveBeenCalledWith(session);
    for (const [feed, viewer] of [
        [session.feedId, session.viewerKey],
        ['preview', 'alice:preview:p'],
        ['legacy', 'alice:legacy'],
    ]) {
        expect(proxy.leaveChannel).toHaveBeenCalledWith(feed, viewer, undefined, {
            immediate: true,
        });
        expect(service.removeSessionIfChannel).toHaveBeenCalledWith(viewer, 'source', feed);
    }
});
it('revocation preserves failed proxy cleanup for a safe retry and still revokes grants', async () => {
    const { revokeUserLiveTvPlayback } = await import('./playback-session-lifecycle.js');
    resources.mockResolvedValue({
        playback: [],
        viewers: [{ viewerKey: 'alice:legacy', channelId: 'legacy', sourceId: 'source' }],
    });
    proxy.leaveChannel.mockRejectedValue(new Error('private proxy detail'));
    await expect(revokeUserLiveTvPlayback({} as never, 'alice')).rejects.toThrow();
    expect(revoke).toHaveBeenCalled();
    expect(service.removeSessionIfChannel).not.toHaveBeenCalled();
});
