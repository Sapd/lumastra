// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { apiUrl, type ApiSurface } from '$lib/shared/api-urls.js';
import type { PlaybackStartResponse } from '$lib/schemas/playback-start.js';

/** Public playback envelope used by client contract tests. */
export function playbackStartFixture(
    mediaId = 'media-1',
    playbackSessionId = 'sess-1',
    token = 'tok',
    surface: ApiSurface = 'v1',
): PlaybackStartResponse {
    return {
        mediaId,
        playbackSessionId,
        kind: 'music',
        delivery: {
            kind: 'file',
            url: apiUrl(surface, `/music/tracks/${mediaId}/stream?grant=${token}`),
            container: 'mp3',
            startPositionMs: 0,
            durationMs: 180_000,
        },
        grant: {
            id: '00000000-0000-4000-8000-000000000001',
            ipPinned: true,
            token,
            param: 'grant',
            mediaId,
            playbackSessionId,
            kind: 'music',
            expiresAt: '2099-01-01T00:00:00.000Z',
            renewAfter: '2098-12-31T23:55:00.000Z',
            renewHref: apiUrl(
                surface,
                '/playback/grants/00000000-0000-4000-8000-000000000001/renew',
            ),
        },
        reporting: {
            kind: 'progress',
            method: 'PUT',
            playbackSessionId,
            href: apiUrl(surface, `/play-sessions/${playbackSessionId}`),
            intervalMs: 15_000,
            unit: 'ms',
        },
    };
}
