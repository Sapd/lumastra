// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { client, expectOk, reachable } from './client';
export async function playEpisode(id: string): Promise<void> {
    // One start call: ready URLs that already carry a scoped grant.
    const started = expectOk(
        'POST',
        '/play-sessions',
        await client.POST('/api/v1/play-sessions', {
            body: {
                mediaId: id,
                deviceId: 'api-recipes',
                clientInfo: { client: 'API recipes' },
                capabilities: {
                    containers: ['mp4', 'mkv'],
                    videoCodecs: ['h264'],
                    audioCodecs: ['aac'],
                    subtitleFormats: ['vtt'],
                    hdr: [],
                },
            },
        }),
    );
    const delivery = started.delivery;
    if (!('url' in delivery)) throw new Error(`Unexpected ${delivery.kind} delivery for a video`);
    try {
        // An external player (VLC, a cast receiver) has only the URL: no Authorization header.
        await reachable(delivery.url, 'stream', 20000, null);
        expectOk(
            'PUT',
            '/play-sessions/{id}',
            await client.PUT('/api/v1/play-sessions/{id}', {
                params: { path: { id: started.playbackSessionId } },
                body: {
                    positionMs: 120000,
                    status: 'PAUSED',
                    eventSeq: 1,
                    sessionElapsedMs: 120000,
                },
            }),
        );
    } finally {
        expectOk(
            'PUT',
            '/play-sessions/{id} stop',
            await client.PUT('/api/v1/play-sessions/{id}', {
                params: { path: { id: started.playbackSessionId } },
                body: {
                    positionMs: 120000,
                    status: 'COMPLETED',
                    eventSeq: 2,
                    sessionElapsedMs: 120000,
                    endReason: 'user',
                },
            }),
        );
    }
}
export async function clearProgress(id: string): Promise<void> {
    expectOk(
        'DELETE',
        '/continue-watching/{id}',
        await client.DELETE('/api/v1/continue-watching/{id}', { params: { path: { id } } }),
    );
}
