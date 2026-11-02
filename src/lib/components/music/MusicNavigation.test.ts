// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable, type Writable } from 'svelte/store';
import { Squares2x2 } from 'svelte-hero-icons';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from '$app/stores';
import type { MusicNavigationPage } from '$lib/utils/music-library-navigation';
import { librarySegmentStorageKey } from '$lib/utils/music-bottom-nav';
import MusicNavigation from './MusicNavigation.svelte';
import MusicBottomNav from './MusicBottomNav.svelte';
import MusicDetailNavigation from './MusicDetailNavigation.svelte';
import MusicSubpageHeader from './MusicSubpageHeader.svelte';

vi.mock('$app/stores', () => ({
    page: writable({
        route: { id: '/music' },
        url: new URL('https://example.test/base/music'),
        data: { user: { username: 'initial' }, features: {} },
    }),
}));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => `/base${path}` }));

const pageStore = page as unknown as Writable<MusicNavigationPage>;

async function navigate(route: string, username: string, playlistType?: string): Promise<void> {
    pageStore.set({
        route: { id: route },
        url: new URL(`https://example.test/base${route.replace('[id]', 'item')}`),
        data: { user: { username }, playlist: { playlistType } },
    });
    await tick();
}

function libraryLinks(containers: HTMLElement[]): HTMLAnchorElement[] {
    return containers.map(
        (container) =>
            within(container).getByRole('link', { name: 'Library' }) as HTMLAnchorElement,
    );
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('primary music navigation components', () => {
    it('publishes changing border-box height, ignores hidden geometry and cleans up observation', async () => {
        let height = 56;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
            () => new DOMRect(0, 0, 320, height),
        );
        let notify: (() => void) | undefined;
        const observe = vi.fn();
        const disconnect = vi.fn();
        vi.stubGlobal(
            'ResizeObserver',
            class {
                constructor(callback: () => void) {
                    notify = callback;
                }
                observe = observe;
                disconnect = disconnect;
            },
        );
        await navigate('/music', 'measured-nav');
        const view = render(MusicBottomNav);
        await tick();
        const style = document.documentElement.style;
        expect(observe).toHaveBeenCalledWith(view.container.querySelector('nav'), { box: 'border-box' });
        expect(style.getPropertyValue('--music-bottom-nav-measured-h')).toBe('56px');
        height = 92;
        notify?.();
        expect(style.getPropertyValue('--music-bottom-nav-measured-h')).toBe('92px');
        await navigate('/music/search', 'measured-nav');
        expect(style.getPropertyValue('--music-bottom-nav-measured-h')).toBe('92px');
        height = 0;
        notify?.();
        expect(style.getPropertyValue('--music-bottom-nav-measured-h')).toBe('');
        height = 104;
        notify?.();
        expect(style.getPropertyValue('--music-bottom-nav-measured-h')).toBe('104px');
        view.unmount();
        expect(disconnect).toHaveBeenCalledOnce();
        expect(style.getPropertyValue('--music-bottom-nav-measured-h')).toBe('');
    });

    it.each([
        ['/music/albums/[id]', undefined, '/music/albums'],
        ['/music/artists/[id]', undefined, '/music/artists'],
        ['/playlists/[id]', 'music', '/playlists?type=music'],
    ] as const)(
        'keeps both bars in agreement after leaving %s',
        async (route, type, destination) => {
            const username = `detail-${destination}`;
            await navigate(route, username, type);
            const desktop = render(MusicNavigation);
            const mobile = render(MusicBottomNav);
            await tick();
            const containers = [desktop.container, mobile.container];
            for (const container of containers) {
                expect(within(container).getAllByRole('link')).toHaveLength(4);
            }
            for (const link of libraryLinks(containers)) {
                expect(link.getAttribute('href')).toBe(`/base${destination}`);
                expect(link.getAttribute('aria-current')).toBe('page');
            }
            await navigate('/music/explore', username);
            for (const link of libraryLinks(containers)) {
                expect(link.getAttribute('href')).toBe(`/base${destination}`);
                expect(link.hasAttribute('aria-current')).toBe(false);
            }
            for (const container of containers) {
                expect(
                    within(container)
                        .getByRole('link', { name: 'Explore' })
                        .getAttribute('aria-current'),
                ).toBe('page');
            }
            expect(localStorage.getItem(librarySegmentStorageKey(username))).toBe(
                destination.includes('playlists') ? 'playlists' : destination.split('/').pop(),
            );
        },
    );

    it('updates both mounted bars on account changes and defaults an invalid stored value', async () => {
        localStorage.setItem(librarySegmentStorageKey('switch-alice'), 'artists');
        localStorage.setItem(librarySegmentStorageKey('switch-bob'), 'playlists');
        localStorage.setItem(librarySegmentStorageKey('switch-invalid'), 'unknown');
        await navigate('/music', 'switch-alice');
        const containers = [render(MusicNavigation).container, render(MusicBottomNav).container];
        await tick();
        for (const [username, href] of [
            ['switch-bob', '/playlists?type=music'],
            ['switch-invalid', '/music/albums'],
            ['switch-alice', '/music/artists'],
        ]) {
            await navigate('/music', username);
            for (const link of libraryLinks(containers))
                expect(link.getAttribute('href')).toBe(`/base${href}`);
        }
    });

    it('retains detail memory with blocked storage across unmounts without leaking accounts', async () => {
        vi.stubGlobal('localStorage', {
            getItem: (): never => {
                throw new Error('blocked');
            },
            setItem: (): never => {
                throw new Error('blocked');
            },
        });
        await navigate('/music/artists/[id]', 'blocked-alice');
        const initial = render(MusicNavigation);
        await tick();
        initial.unmount();
        await navigate('/music/search', 'blocked-alice');
        const containers = [render(MusicNavigation).container, render(MusicBottomNav).container];
        await tick();
        for (const link of libraryLinks(containers))
            expect(link.getAttribute('href')).toBe('/base/music/artists');
        await navigate('/music/search', 'blocked-bob');
        for (const link of libraryLinks(containers))
            expect(link.getAttribute('href')).toBe('/base/music/albums');
    });

    it.each([
        '/music/genres/[genre]',
        '/music/radio',
        '/music/path',
        '/music/collections',
        '/music/alchemy',
        '/music/map',
    ])('selects Explore for %s', async (route) => {
        await navigate(route, 'explore-owner');
        for (const container of [
            render(MusicNavigation).container,
            render(MusicBottomNav).container,
        ]) {
            expect(
                within(container)
                    .getByRole('link', { name: 'Explore' })
                    .getAttribute('aria-current'),
            ).toBe('page');
            expect(container.querySelector('[role="tab"]')).toBeNull();
        }
    });

    it('does not select Library for a loaded video playlist', async () => {
        await navigate('/playlists/[id]', 'video-owner', 'video');
        for (const link of libraryLinks([
            render(MusicNavigation).container,
            render(MusicBottomNav).container,
        ])) {
            expect(link.hasAttribute('aria-current')).toBe(false);
        }
    });

    it('keeps the contextual return alongside one primary row on detail pages', async () => {
        await navigate('/music/albums/[id]', 'return-link');
        const { container } = render(MusicDetailNavigation, {
            destination: '/music/albums',
            label: 'Albums',
        });
        expect(container.querySelectorAll('nav')).toHaveLength(1);
        expect(within(container).getByRole('link', { name: 'Albums' }).getAttribute('href')).toBe(
            '/base/music/albums',
        );
    });

    it('adds one primary row to regular discovery headers and preserves compact contextual exits', async () => {
        await navigate('/music/map', 'header-owner');
        const regular = render(MusicSubpageHeader, { title: 'Music map', icon: Squares2x2 });
        expect(within(regular.container).getByRole('link', { name: 'Library' })).toBeTruthy();
        regular.unmount();
        const compact = render(MusicSubpageHeader, {
            title: 'Music map',
            icon: Squares2x2,
            compact: true,
        });
        expect(within(compact.container).queryByRole('link', { name: 'Library' })).toBeNull();
        expect(
            within(compact.container).getByRole('link', { name: 'Explore' }).getAttribute('href'),
        ).toBe('/base/music/explore');
        expect(compact.container.querySelector('a[href="/base/music"]')).toBeTruthy();
    });
});
