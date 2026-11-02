// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type { PlaybackSessionStartResponse } from '$lib/schemas/livetv-playback-sessions.js';
import { playbackStartFixture } from './playback-start.fixture.js';
import { apiUrl, type ApiSurface } from '$lib/shared/api-urls.js';
export function liveStartFixture(
    id = 'live-session',
    surface: ApiSurface = 'internal',
): PlaybackSessionStartResponse {
    const stationId = '00000000-0000-4000-8000-000000000002';
    return {
        kind: 'live',
        playbackSessionId: id,
        stationId,
        grant: { ...playbackStartFixture(stationId, id, 'original', surface).grant, kind: 'live' },
        reporting: {
            kind: 'keepalive',
            method: 'POST',
            playbackSessionId: id,
            intervalMs: 10000,
            href: apiUrl(surface, `/livetv/playback-sessions/${encodeURIComponent(id)}/keepalive`),
        },
        delivery: {
            kind: 'live-hls',
            url: apiUrl(surface, `/livetv/channels/${stationId}/stream/master.m3u8?grant=original`),
            feedId: stationId,
            requestedQuality: 'server',
            appliedQuality: 'original',
            requiresProxy: true,
            rungId: null,
            requestedMaxBitrateBps: null,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
            reason: null,
        },
    };
}
