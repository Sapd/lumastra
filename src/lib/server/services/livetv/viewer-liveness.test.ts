// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { proxy, sessions } = vi.hoisted(() => ({
    proxy: { heartbeat: vi.fn() },
    sessions: {
        getViewerPlaybackSession: vi.fn(),
        refreshPlaybackSession: vi.fn(),
        refreshSession: vi.fn(),
    },
}));
vi.mock('./stream-proxy-client.js', () => ({ getStreamProxyClient: () => proxy }));
vi.mock('./livetv-session.service.js', () => ({ getLiveTvSessionService: () => sessions }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import {
    LIVENESS_INTERVAL_MS,
    resetLivenessForTests,
    touchLiveTvViewer,
} from './viewer-liveness.js';

const event = {
    locals: { user: { username: 'vlc-user' }, liveTvCredentialId: 'stream:abc' },
    cookies: { get: () => undefined },
    url: new URL('http://localhost/api/v1/livetv/channels/f/stream/segment.ts'),
} as never;

beforeEach(() => {
    vi.clearAllMocks();
    resetLivenessForTests();
    proxy.heartbeat.mockResolvedValue({ success: true });
    sessions.getViewerPlaybackSession.mockResolvedValue({
        sessionId: 's1',
        feedId: 'feed-1',
        state: 'active',
    });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('segment-only players stay alive', () => {
    it('steady segment fetches heartbeat the proxy viewer at the interval and refresh the session', async () => {
        // A 60 s watch with a segment every 2 s and no keepalive/leave call at all.
        for (let t = 0; t <= 60_000; t += 2_000) {
            touchLiveTvViewer(event, 'feed-1', t + 1);
            await flush();
        }
        // First fetch + one per interval: well inside the proxy reaper timeout.
        expect(proxy.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(
            Math.floor(60_000 / LIVENESS_INTERVAL_MS),
        );
        expect(proxy.heartbeat.mock.calls.length).toBeLessThanOrEqual(8);
        expect(proxy.heartbeat).toHaveBeenCalledWith('feed-1', 'vlc-user:stream:abc');
        expect(sessions.refreshPlaybackSession).toHaveBeenCalled();
    });

    it('does not hammer the proxy for fetches inside the interval', async () => {
        touchLiveTvViewer(event, 'feed-1', 1_000);
        touchLiveTvViewer(event, 'feed-1', 2_000);
        touchLiveTvViewer(event, 'feed-1', 3_000);
        await flush();
        expect(proxy.heartbeat).toHaveBeenCalledTimes(1);
    });

    it('swallows proxy failures and an unknown viewer', async () => {
        proxy.heartbeat.mockRejectedValue(new Error('Proxy 404'));
        expect(() => touchLiveTvViewer(event, 'feed-1', 1_000)).not.toThrow();
        expect(() =>
            touchLiveTvViewer({ ...(event as object), locals: {} } as never, 'feed-1', 2_000),
        ).not.toThrow();
        await flush();
    });
});
