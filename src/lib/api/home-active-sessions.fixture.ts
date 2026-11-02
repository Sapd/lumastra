// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { StreamSession } from '$lib/schemas/api-playback-responses.js';

/** Enriched visibility-service rows: own playing music and another user's paused Subsonic stream. */
export function homeMusicSessions(): StreamSession[] {
    return [
        {
            __id: 'session-web',
            id: 'track-web',
            mediaItemId: 'track-web',
            title: 'Enemy (Club Mix)',
            mediaType: 'track',
            externalIds: { internal: 'track-web' },
            images: { primary: { href: '/cover-web', revision: '1', source: 'self' } },
            artistName: 'Example Artist',
            albumName: 'Example Album',
            albumId: 'album-web',
            artistId: 'artist-web',
            nextTrack: { mediaId: 'track-next', title: 'Next Song', artistName: 'Next Artist' },
            playMethod: 'direct',
            playOriginalAudioCodec: 'mp3',
            playOriginalAudioBitrate: 320_000,
            playCurrentTime: 30,
            playItemDuration: 200,
            playIsPlaying: true,
            playSessionId: 'session-web',
            username: 'alice',
            userId: '11111111-1111-4111-8111-111111111111',
            sessionSource: 'lumastra',
        },
        {
            __id: 'session-subsonic',
            id: 'track-subsonic',
            mediaItemId: 'track-subsonic',
            title: 'Alligator Fuckhouse (Bjorn Akesson Remix)',
            mediaType: 'track',
            externalIds: { internal: 'track-subsonic' },
            images: { primary: { href: '/cover-subsonic', revision: '2', source: 'self' } },
            artistName: 'Another Artist',
            albumName: 'Another Album',
            playMethod: 'direct',
            playOriginalAudioCodec: 'opus',
            playOriginalAudioBitrate: 320_000,
            playCurrentTime: 45,
            playItemDuration: 300,
            playIsPlaying: false,
            playSessionId: 'session-subsonic',
            username: 'bob',
            userId: '22222222-2222-4222-8222-222222222222',
            sessionSource: 'subsonic',
        },
    ];
}
