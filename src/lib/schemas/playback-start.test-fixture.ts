// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PlaybackStartResponse } from './playback-start.js';

/** Shared start response fixture for endpoint security tests. */
export function playbackStartFixture(): PlaybackStartResponse {
    const playbackSessionId = '00000000-0000-4000-a000-0000000000f1';
    return {
        playbackSessionId,
        mediaId: '00000000-0000-4000-a000-000000000001',
        kind: 'music' as const,
        delivery: {
            kind: 'file' as const,
            url: '/api/v1/music/tracks/track/stream?grant=stream_test',
            container: 'flac',
            startPositionMs: 0,
            durationMs: 123000,
        },
        grant: {
            id: '00000000-0000-4000-a000-0000000000f2',
            ipPinned: true,
            token: 'stream_test',
            param: 'grant' as const,
            mediaId: '00000000-0000-4000-a000-000000000001',
            playbackSessionId,
            kind: 'music' as const,
            expiresAt: '2026-10-18T00:00:00.000Z',
            renewAfter: '2026-10-17T23:55:00.000Z',
            renewHref: '/api/v1/playback/grants/grant/renew',
        },
        reporting: {
            kind: 'progress',
            method: 'PUT',
            playbackSessionId,
            href: `/api/v1/play-sessions/${playbackSessionId}`,
            intervalMs: 10000,
            unit: 'ms' as const,
        },
    };
}
