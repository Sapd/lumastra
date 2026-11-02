// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owners: packages 6/10. A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { client, episode, expectOk, reachable } from './client';
test('03 series → seasons → episode card → response image', async (ctx) => {
    const item = await episode();
    if (!item) return ctx.skip('Instance has no series with playable episodes');
    const card = expectOk(
        'GET',
        '/episodes/{id}',
        await client.GET('/api/v1/episodes/{id}', { params: { path: { id: item.id } } }),
    );
    expect(card).toBeTruthy();
    // One call, no URL building and no parent walking: the descriptor carries a ready URL.
    const thumb = (card as { images?: { thumb?: Record<string, unknown> } }).images?.thumb;
    if (thumb) {
        expect(typeof thumb.revision).toBe('string');
        expect(['self', 'frame', 'season', 'series', 'provider']).toContain(thumb.source);
        const variants = thumb.variants as Record<string, string> | undefined;
        await reachable(variants?.card ?? (thumb.href as string), 'image');
    } else {
        // No landscape image at all: the poster (episode → season → series) is the card image.
        const poster = (card as { images?: { poster?: { href?: string } } }).images?.poster;
        await reachable(poster?.href, 'image');
    }
    // Only the episode's own images: nothing inherited from a season or series.
    const own = expectOk(
        'GET',
        '/episodes/{id}?inherit=none',
        await client.GET('/api/v1/episodes/{id}', {
            params: { path: { id: item.id }, query: { inherit: 'none' } },
        }),
    );
    const ownImages = (own as { images?: Record<string, { source?: string }> }).images ?? {};
    for (const descriptor of Object.values(ownImages))
        expect(['self', 'frame']).toContain(descriptor.source);
});
