// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Seam test: the homepage's admin-configured hero toolbar (HERO_BUTTONS)
 * must resolve an icon NAME from the server-provided `data.navIcons` (see
 * resolve-nav-icons.ts / +layout.server.ts), not the client-side
 * navigationIconMap catalog import this task removed.
 */

import { render, cleanup, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('$app/stores', () => ({
    page: readable({ data: {}, url: new URL('http://localhost/') }),
    navigating: readable(null),
}));
vi.mock('$app/navigation', () => ({
    afterNavigate: vi.fn(),
    beforeNavigate: vi.fn(),
    goto: vi.fn(),
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
    preloadData: vi.fn(async () => undefined),
    replaceState: vi.fn(),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/user', () => ({
    dismissOnboardingStep: vi.fn(async () => undefined),
}));

import HomePage from './+page.svelte';
import { env } from '$env/dynamic/public';
import * as m from '$lib/paraglide/messages';

const ICON_FIXTURE = {
    default: { a: { viewBox: '0 0 24 24' }, path: [{ d: 'M1 1 FIXTURE-PATH' }] },
};

function baseData(overrides: Record<string, unknown> = {}) {
    return {
        user: { username: 'denis' },
        features: {},
        homepage: {},
        hero: {},
        heroButtons: [],
        widgetOrder: [],
        widgetVisibility: {},
        pluginWidgets: [],
        navIcons: {},
        ...overrides,
    };
}

describe('homepage hero buttons: icon resolution from page data', () => {
    afterEach(() => {
        cleanup();
        delete env.PUBLIC_JELLYFINURL;
        delete env.PUBLIC_AUDIOBOOKURL;
        vi.restoreAllMocks();
    });

    test.each(['jellyfin.local', 'jellyfin.local:8096'])(
        'invalid public upstream URL %s does not crash the homepage',
        (base) => {
            env.PUBLIC_JELLYFINURL = base;
            env.PUBLIC_AUDIOBOOKURL = base;
            render(HomePage, {
                data: baseData({ features: { jellyfin: true, audiobooks: true } }),
            } as never);
            expect(screen.getByRole('link', { name: m.browse() })).toBeTruthy();
            expect(screen.queryByRole('link', { name: /Movies|Audiobooks/i })).toBeNull();
        },
    );

    test('keeps public base paths and queries on valid homepage links', () => {
        env.PUBLIC_JELLYFINURL = 'https://proxy/jellyfin/?tenant=one';
        env.PUBLIC_AUDIOBOOKURL = 'https://proxy/audiobookshelf/?tenant=one';
        render(HomePage, {
            data: baseData({ features: { jellyfin: true, audiobooks: true } }),
        } as never);
        const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
        expect(hrefs).toContain('https://proxy/jellyfin/web/?tenant=one#/home.html');
        expect(hrefs).toContain('https://proxy/audiobookshelf?tenant=one');
    });

    test('localizes the non-Mac modifier label', () => {
        expect(m.shortcut_ctrl_f({}, { locale: 'en' })).toBe('(Ctrl+F)');
        expect(m.shortcut_ctrl_f({}, { locale: 'de' })).toBe('(Strg+F)');
    });

    test.each(['MacIntel', 'Win32'])('shows the search shortcut for %s', async (platform) => {
        vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
        render(HomePage, { data: baseData() } as never);
        await waitFor(() => {
            expect(
                screen.getByText(platform === 'MacIntel' ? '(⌘F)' : m.shortcut_ctrl_f()),
            ).toBeTruthy();
        });
    });

    test('renders the server-resolved icon for a configured hero button', () => {
        render(HomePage, {
            data: baseData({
                heroButtons: [
                    {
                        id: 'b1',
                        action: 'link',
                        label: 'Docs',
                        icon: 'book-open',
                        enabled: true,
                        url: '/docs',
                    },
                ],
                navIcons: { 'book-open': ICON_FIXTURE },
            }),
        } as never);

        const path = document.querySelector('path[d="M1 1 FIXTURE-PATH"]');
        expect(path).toBeTruthy();
        expect(screen.getByText('Docs')).toBeTruthy();
    });

    test('renders no icon (not a crash) for a hero button whose name is unresolved', () => {
        render(HomePage, {
            data: baseData({
                heroButtons: [
                    {
                        id: 'b1',
                        action: 'link',
                        label: 'Docs',
                        icon: 'this-was-never-configured',
                        enabled: true,
                        url: '/docs',
                    },
                ],
                navIcons: {},
            }),
        } as never);

        expect(screen.getByText('Docs')).toBeTruthy();
        expect(document.querySelector('.hero-btn__icon')).toBeNull();
    });
});
