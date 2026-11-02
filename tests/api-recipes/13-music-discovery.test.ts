// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owners: package 14. A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { client, expectOk, reachable } from './client';

async function firstTrackId(): Promise<string | undefined> {
    const tracks = expectOk(
        'GET',
        '/music/tracks',
        await client.GET('/api/v1/music/tracks', { params: { query: { limit: 5 } } }),
    );
    return tracks.items.find((t) => typeof t.id === 'string')?.id;
}

test('13a show music home: listener rows, stations, mixes, more like this', async (ctx) => {
    const recent = expectOk(
        'GET',
        '/me/music/recently-played',
        await client.GET('/api/v1/me/music/recently-played', {
            params: { query: { limit: 10 } },
        }),
    );
    expect(Array.isArray(recent.items)).toBe(true);
    expect(typeof recent.page.truncated).toBe('boolean');

    const top = expectOk(
        'GET',
        '/me/music/top-artists',
        await client.GET('/api/v1/me/music/top-artists', { params: { query: { limit: 10 } } }),
    );
    for (const artist of top.items) expect(['personal', 'catalog']).toContain(artist.source);

    // A station id is opaque and may be stored; its tracks are one call away.
    const stations = expectOk(
        'GET',
        '/me/music/taste-stations',
        await client.GET('/api/v1/me/music/taste-stations'),
    );
    const station = stations.items[0];
    if (station) {
        const tracks = expectOk(
            'GET',
            '/me/music/taste-stations/{id}/tracks',
            await client.GET('/api/v1/me/music/taste-stations/{id}/tracks', {
                params: { path: { id: station.id }, query: { limit: 10 } },
            }),
        );
        expect(tracks.items.length).toBeGreaterThan(0);
    }

    // Sonic mixes are a server feature; 404 means the server has none.
    const clusters = await client.GET('/api/v1/music/sonic-mixes');
    if (clusters.response.status !== 404) {
        const list = expectOk('GET', '/music/sonic-mixes', clusters);
        const mix = list.items[0];
        if (mix) {
            // The full listing (no `compact`) carries counts and a cover collage.
            if ('images' in mix && mix.images?.primary)
                await reachable(mix.images.primary.href, 'image');
            const members = expectOk(
                'GET',
                '/music/sonic-mixes/{id}/tracks',
                await client.GET('/api/v1/music/sonic-mixes/{id}/tracks', {
                    params: { path: { id: String(mix.id) }, query: { limit: 10 } },
                }),
            );
            expect(typeof members.page.hasMore).toBe('boolean');
        }
    }

    const trackId = await firstTrackId();
    if (!trackId) return ctx.skip('Instance has no music tracks');
    const similar = expectOk(
        'GET',
        '/music/tracks/{id}/similar',
        await client.GET('/api/v1/music/tracks/{id}/similar', {
            params: { path: { id: trackId }, query: { limit: 5 } },
        }),
    );
    expect(['sonic', 'metadata']).toContain(similar.source);
    expect(similar.items.every((t) => t.id !== trackId)).toBe(true);
});

test('13b start a radio from a song: next track, then the following hop', async (ctx) => {
    const trackId = await firstTrackId();
    if (!trackId) return ctx.skip('Instance has no music tracks');

    const first = expectOk(
        'POST',
        '/music/recommendations',
        await client.POST('/api/v1/music/recommendations', {
            body: { context: { currentTrackId: trackId, startedBy: 'user' } },
        }),
    );
    expect(['sonic', 'metadata', 'fallback']).toContain(first.source);
    expect(first.alternatives.length).toBeLessThanOrEqual(3);
    if (!first.next) return ctx.skip('Library too small for a recommendation');
    expect(first.next.id).not.toBe(trackId);
    expect(first.alternatives.every((t) => t.id !== first.next!.id)).toBe(true);
    if (first.next.images?.primary) await reachable(first.next.images.primary.href, 'image');

    // When `next` starts playing, ask again with what was played.
    const second = expectOk(
        'POST',
        '/music/recommendations',
        await client.POST('/api/v1/music/recommendations', {
            body: {
                context: {
                    currentTrackId: first.next.id,
                    startedBy: 'autoplay',
                    history: [first.next.id, trackId],
                },
            },
        }),
    );
    if (second.next) expect([trackId, first.next.id]).not.toContain(second.next.id);
});
