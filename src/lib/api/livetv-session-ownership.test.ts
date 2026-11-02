// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimPlaybackSession, handoffPlaybackSession } from './livetv-playback.js';
import type { PlaybackSessionStartResponse } from '$lib/schemas/livetv-playback-sessions.js';

const stationId = '00000000-0000-4000-8000-000000000001';
const first: PlaybackSessionStartResponse = {
    playbackSessionId: '00000000-0000-4000-8000-000000000002',
    kind: 'live',
    stationId,
    reporting: {
        kind: 'keepalive',
        method: 'POST',
        playbackSessionId: '00000000-0000-4000-8000-000000000002',
        intervalMs: 7_000,
        href: '/api/livetv/playback-sessions/00000000-0000-4000-8000-000000000002/keepalive',
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
        mediaId: stationId,
        playbackSessionId: '00000000-0000-4000-8000-000000000002',
        kind: 'live',
        param: 'grant',
        ipPinned: true,
        expiresAt: '2026-10-18T00:00:00Z',
        renewAfter: '2026-10-17T23:55:00Z',
        renewHref: '/api/playback/grants/00000000-0000-4000-8000-000000000099/renew',
    },
};

describe('Live TV preflight ownership', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    });
    afterEach(() => {
        claimPlaybackSession(stationId);
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('hands an allocation to the player once, without leaving or starting again', async () => {
        handoffPlaybackSession(first);
        expect(claimPlaybackSession('unknown')).toBeNull();
        expect(claimPlaybackSession(stationId)).toEqual(first);
        expect(claimPlaybackSession(stationId)).toBeNull();
        await vi.advanceTimersByTimeAsync(14_000);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('releases an unclaimed allocation by session ID', async () => {
        handoffPlaybackSession(first);
        await vi.advanceTimersByTimeAsync(7_000);
        expect(claimPlaybackSession(stationId)).toBeNull();
        expect(fetch).toHaveBeenCalledWith(
            `/api/livetv/playback-sessions/${first.playbackSessionId}`,
            expect.objectContaining({ method: 'DELETE' }),
        );
    });

    it('replacing a preflight can only leave the old allocation', async () => {
        const next = { ...first, playbackSessionId: '00000000-0000-4000-8000-000000000004' };
        handoffPlaybackSession(first);
        handoffPlaybackSession(next);
        expect(claimPlaybackSession(stationId)).toEqual(next);
        await vi.advanceTimersByTimeAsync(14_000);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(
            `/api/livetv/playback-sessions/${first.playbackSessionId}`,
            expect.objectContaining({ method: 'DELETE' }),
        );
    });
});
