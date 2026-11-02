// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render } from 'svelte/server';
import { readable, writable, type Writable } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { page } from '$app/stores';
import type { MusicNavigationPage } from '$lib/utils/music-library-navigation';
import MusicNavigation from '$lib/components/music/MusicNavigation.svelte';
import MusicBottomNav from '$lib/components/music/MusicBottomNav.svelte';

vi.mock('$app/stores', () => ({
    page: writable({
        route: { id: '/music' },
        url: new URL('https://example.test/base/music'),
        data: {},
    }),
}));
// Simulate memory already restored in the browser. The initial markup must
// still match what SSR can know, before onMount applies the saved destination.
vi.mock('$lib/utils/music-library-navigation', () => ({
    musicLibrarySegment: readable('artists'),
}));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => `/base${path}` }));

const pageStore = page as unknown as Writable<MusicNavigationPage>;

describe('music navigation initial hydration markup', () => {
    it.each([
        ['/music', undefined, '/music/albums'],
        ['/music/albums/[id]', undefined, '/music/albums'],
        ['/music/artists/[id]', undefined, '/music/artists'],
        ['/playlists/[id]', 'music', '/playlists?type=music'],
    ] as const)('uses the route or default on %s before mount', (route, playlistType, destination) => {
        pageStore.set({
            route: { id: route },
            url: new URL('https://example.test/base/music'),
            data: { user: { username: 'hydration-user' }, playlist: { playlistType } },
        });
        for (const component of [MusicNavigation, MusicBottomNav]) {
            const { body } = render(component);
            expect(body).toMatch(
                new RegExp(`href="/base${destination.replace('?', '\\?')}"[^>]*>[^]*?Library`),
            );
        }
    });
});
