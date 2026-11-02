// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackSessionStartResponse } from '$lib/schemas/livetv-playback-sessions.js';

const handles = vi.hoisted(
    () =>
        [] as Array<{
            sessionId: string;
            startInfo: PlaybackSessionStartResponse;
            intervalMs: number;
            onLost?: () => void;
            onKicked?: () => void;
            onFailed?: (failure: unknown) => void;
            onRenew?: () => void | Promise<void>;
            destroy: ReturnType<typeof vi.fn>;
        }>,
);
vi.mock('./livetv-heartbeat', () => ({
    LiveTvHeartbeat: class {
        destroy = vi.fn().mockResolvedValue(undefined);
        constructor(
            startInfo: PlaybackSessionStartResponse,
            intervalMs: number,
            onLost?: () => void,
            _onRestored?: () => void,
            onKicked?: () => void,
            onFailed?: (failure: unknown) => void,
            onRenew?: () => void | Promise<void>,
        ) {
            handles.push({
                sessionId: startInfo.playbackSessionId,
                startInfo,
                intervalMs,
                onLost,
                onKicked,
                onFailed,
                onRenew,
                destroy: this.destroy,
            });
        }
    },
}));

import { PlayerController } from './player-controller.svelte';

interface SessionController {
    ownLiveTvSession(info: PlaybackSessionStartResponse): void;
    liveTvSessionId: string | null;
    liveTvFailure: { type: string } | null;
    wasKicked: boolean;
}
const session: PlaybackSessionStartResponse = {
    playbackSessionId: '00000000-0000-4000-8000-000000000001',
    kind: 'live',
    stationId: '00000000-0000-4000-8000-000000000002',
    reporting: {
        kind: 'keepalive',
        method: 'POST',
        playbackSessionId: '00000000-0000-4000-8000-000000000001',
        intervalMs: 7_000,
        href: '/api/livetv/playback-sessions/00000000-0000-4000-8000-000000000001/keepalive',
    },
    delivery: {
        kind: 'live-hls',
        url: '/returned/master.m3u8',
        feedId: '00000000-0000-4000-8000-000000000003',
        requestedQuality: 'server',
        appliedQuality: 'original',
        requiresProxy: true,
        rungId: null,
        requestedMaxBitrateBps: null,
        appliedMaxBitrateBps: null,
        appliedMaxHeight: null,
        reason: null,
    },
    grant: {
        id: '00000000-0000-4000-8000-000000000099',
        token: 'stream_live_secret',
        mediaId: '00000000-0000-4000-8000-000000000002',
        playbackSessionId: '00000000-0000-4000-8000-000000000001',
        kind: 'live',
        param: 'grant',
        ipPinned: true,
        expiresAt: '2026-10-18T00:00:00Z',
        renewAfter: '2026-10-17T23:55:00Z',
        renewHref: '/api/playback/grants/00000000-0000-4000-8000-000000000099/renew',
    },
};

let controller: SessionController;
beforeEach(() => {
    handles.length = 0;
    const target = Object.create(PlayerController.prototype);
    for (const [key, value] of Object.entries({
        liveTvHeartbeat: null,
        liveTvSessionId: null,
        liveTvCurrentFeedId: undefined,
        liveTvFailure: null,
        wasKicked: false,
        playbackManager: { destroy: vi.fn() },
    }))
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
    controller = target as SessionController;
});

describe('Live TV player session ownership', () => {
    it('has no heartbeat before allocation and uses the returned handle and interval', () => {
        expect(handles).toHaveLength(0);
        controller.ownLiveTvSession(session);
        expect(handles[0]).toMatchObject({
            sessionId: session.playbackSessionId,
            startInfo: session,
            intervalMs: 7_000,
        });
    });

    it('replaces only the previous handle and ignores its late terminal callback', () => {
        controller.ownLiveTvSession(session);
        const next = { ...session, playbackSessionId: '00000000-0000-4000-8000-000000000004' };
        controller.ownLiveTvSession(next);
        expect(handles[0].destroy).toHaveBeenCalledTimes(1);
        expect(handles[1].destroy).not.toHaveBeenCalled();
        handles[0].onLost?.();
        handles[0].onKicked?.();
        expect(controller.wasKicked).toBe(false);
        expect(controller.liveTvFailure).toBeNull();
        expect(controller.liveTvSessionId).toBe(next.playbackSessionId);
        handles[1].onKicked?.();
        expect(controller.wasKicked).toBe(true);
        expect(controller.liveTvFailure?.type).toBe('kicked');
    });

    it('renews without reloading an unchanged URL and ignores rotation from a replaced session', async () => {
        const current = structuredClone(session);
        const manager = { updateConfig: vi.fn(), load: vi.fn().mockResolvedValue(undefined) };
        Object.defineProperties(controller, {
            videoElement: { value: { paused: false }, configurable: true },
            ensurePlaybackManager: { value: () => manager, configurable: true },
        });
        controller.ownLiveTvSession(current);
        await handles[0].onRenew?.();
        expect(manager.load).not.toHaveBeenCalled();
        current.delivery.url = '/returned/master.m3u8?grant=rotated';
        await handles[0].onRenew?.();
        expect(manager.load).toHaveBeenCalledWith(current.delivery.url, 'hls');
        controller.ownLiveTvSession({ ...session, playbackSessionId: 'replacement' });
        current.delivery.url = '/returned/master.m3u8?grant=stale';
        await handles[0].onRenew?.();
        expect(manager.load).toHaveBeenCalledOnce();
    });

    it('a failed channel shows the typed failure, never the kicked overlay', () => {
        const show = vi.fn();
        Object.defineProperty(controller, 'showLiveTvFailure', { value: show, configurable: true });
        controller.ownLiveTvSession(session);
        const failure = { kind: 'failure', code: 'upstream_stalled', retryable: true };
        handles[0].onFailed?.(failure);
        expect(show).toHaveBeenCalledWith(failure);
        expect(controller.wasKicked).toBe(false);
    });

    it('a failed channel without a code falls back to the source-down screen', () => {
        const show = vi.fn();
        Object.defineProperty(controller, 'showLiveTvFailure', { value: show, configurable: true });
        controller.ownLiveTvSession(session);
        handles[0].onFailed?.(undefined);
        expect(show).not.toHaveBeenCalled();
        expect(controller.liveTvFailure?.type).toBe('source_down');
    });

    it('ignores a late failure from a replaced session', () => {
        const show = vi.fn();
        Object.defineProperty(controller, 'showLiveTvFailure', { value: show, configurable: true });
        controller.ownLiveTvSession(session);
        controller.ownLiveTvSession({
            ...session,
            playbackSessionId: '00000000-0000-4000-8000-000000000004',
        });
        handles[0].onFailed?.({ kind: 'failure', code: 'channel_offline', retryable: false });
        expect(show).not.toHaveBeenCalled();
        expect(controller.liveTvFailure).toBeNull();
    });
});
