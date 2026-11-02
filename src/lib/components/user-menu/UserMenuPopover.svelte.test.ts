// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

// vi.hoisted runs before vi.mock factories; creates a mutable store without require()
const { pageStore } = vi.hoisted(() => {
    type Subscriber<T> = (value: T) => void;
    type PageValue = { data: Record<string, unknown>; url: URL };
    let _value: PageValue = { data: {}, url: new URL('http://localhost/') };
    const _subs = new Set<Subscriber<PageValue>>();
    const store = {
        subscribe(fn: Subscriber<PageValue>) {
            fn(_value);
            _subs.add(fn);
            return () => _subs.delete(fn);
        },
        set(v: PageValue) {
            _value = v;
            _subs.forEach((fn) => fn(_value));
        },
    };
    return { pageStore: store };
});

// --- mocks: stores/runtime the popup reads ---
vi.mock('$app/stores', () => ({
    page: pageStore,
}));
vi.mock('$lib/paraglide/runtime.js', () => ({
    getLocale: () => 'en',
    setLocale: vi.fn(),
    locales: ['en', 'de'],
    isLocale: (v: string) => v === 'en' || v === 'de',
    experimentalStaticLocale: null,
}));
const { getActiveSessions } = vi.hoisted(() => ({
    getActiveSessions: vi.fn(async () => ({ data: { items: [] as unknown[] }, error: null })),
}));
vi.mock('$lib/api/playback', () => ({ getActiveSessions }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_LOGOUTURL: '', PUBLIC_AUTHURL: '' } }));

import UserMenuPopover from './UserMenuPopover.svelte';

const baseUser = { username: 'testuser', isAgeRestricted: false };

function renderPopover(data: Record<string, unknown>) {
    pageStore.set({ data, url: new URL('http://localhost/') });
    return render(UserMenuPopover, { id: 'popupClick' });
}

describe('UserMenuPopover', () => {
    afterEach(() => {
        cleanup();
        getActiveSessions.mockClear();
    });

    test('guaranteed floor: Settings + Sign out render even with every flag off', () => {
        renderPopover({ user: baseUser, features: {}, authMethod: 'forward', userMenuLinks: [] });
        expect(screen.getByRole('link', { name: /Settings/ })).toBeTruthy();
        expect(screen.getByRole('link', { name: /Sign out/ })).toBeTruthy();
    });

    test('Sessions & devices points at /settings/sessions and uses the settings name', () => {
        renderPopover({
            user: baseUser,
            features: { deviceAuth: true },
            authMethod: 'forward',
            userMenuLinks: [],
        });
        const link = screen.getByRole('link', { name: /Sessions & Devices/ });
        expect(link.getAttribute('href')).toBe('/settings/sessions');
    });

    test('Sessions & devices is hidden when deviceAuth is off', () => {
        renderPopover({
            user: baseUser,
            features: { deviceAuth: false },
            authMethod: 'forward',
            userMenuLinks: [],
        });
        expect(screen.queryByRole('link', { name: /Sessions/ })).toBeNull();
    });

    test('My Stats link hidden when personalStats is off', () => {
        renderPopover({
            user: baseUser,
            features: { personalStats: false },
            authMethod: 'forward',
            userMenuLinks: [],
        });
        expect(screen.queryByRole('link', { name: /My Stats/ })).toBeNull();
    });

    // The quick settings made the menu 620px tall, so Settings and Logout were
    // scrolled out of view inside it on a laptop. They live in /settings only.
    test('holds no preference controls', () => {
        renderPopover({
            user: baseUser,
            features: { dockToggle: true },
            authMethod: 'forward',
            userMenuLinks: [],
            themes: {
                enabled: [
                    { id: 'a', name: 'A' },
                    { id: 'b', name: 'B' },
                ],
                active: 'a',
            },
        });
        expect(screen.queryAllByRole('switch')).toHaveLength(0);
        expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    });

    test('native session signs out with a button (POST flow), not a /logout anchor', () => {
        renderPopover({ user: baseUser, features: {}, authMethod: 'session', userMenuLinks: [] });
        expect(screen.getByRole('button', { name: /Sign out/ })).toBeTruthy();
        expect(screen.queryByRole('link', { name: /Sign out/ })).toBeNull();
    });

    test('sign out is NOT error-red (routine action)', () => {
        renderPopover({ user: baseUser, features: {}, authMethod: 'forward', userMenuLinks: [] });
        const signOut = screen.getByRole('link', { name: /Sign out/ });
        expect(signOut.className).not.toMatch(/error/);
    });

    test('a custom link to /logout is not rendered twice', () => {
        renderPopover({
            user: baseUser,
            features: {},
            authMethod: 'forward',
            userMenuLinks: [{ label: 'Logout', url: '/logout' }],
        });
        expect(screen.getAllByRole('link', { name: /Sign out|Logout/ })).toHaveLength(1);
    });

    test('external admin links say they open a new tab', () => {
        renderPopover({
            user: baseUser,
            features: {},
            authMethod: 'forward',
            userMenuLinks: [{ label: 'All apps', url: 'https://auth.example.com', external: true }],
        });
        const link = screen.getByRole('link', { name: /All apps.*new tab/ });
        expect(link.getAttribute('target')).toBe('_blank');
    });

    test('renders the server-resolved icon (page.data.navIcons) for a configured USER_MENU_LINKS entry', () => {
        const iconFixture = {
            default: { a: { viewBox: '0 0 24 24' }, path: [{ d: 'M1 1 USERMENU-FIXTURE-PATH' }] },
        };
        renderPopover({
            user: baseUser,
            features: {},
            authMethod: 'forward',
            userMenuLinks: [
                { label: 'Support', url: '/support', icon: 'life-buoy', external: false },
            ],
            navIcons: { 'life-buoy': iconFixture },
        });
        const link = screen.getByRole('link', { name: 'Support' });
        expect(link.querySelector('path[d="M1 1 USERMENU-FIXTURE-PATH"]')).toBeTruthy();
    });

    test('an unresolved icon falls back to a generic link icon (not a crash)', () => {
        renderPopover({
            user: baseUser,
            features: {},
            authMethod: 'forward',
            userMenuLinks: [
                { label: 'Support', url: '/support', icon: 'life-buoy', external: false },
            ],
            navIcons: {},
        });
        const link = screen.getByRole('link', { name: 'Support' });
        expect(link.querySelector('svg')).toBeTruthy();
    });

    test('shows an Admin badge for admins', () => {
        renderPopover({
            user: { ...baseUser, isAdmin: true },
            features: {},
            authMethod: 'forward',
            userMenuLinks: [],
        });
        expect(screen.getByText('Admin')).toBeTruthy();
    });

    test('shows what you are playing when the menu opens', async () => {
        getActiveSessions.mockResolvedValueOnce({
            data: { items: [{ userId: 'u1', title: 'Jenseits der Zeit' }] },
            error: null,
        });
        const { container } = renderPopover({
            user: { ...baseUser, userId: 'u1' },
            features: {},
            authMethod: 'forward',
            userMenuLinks: [],
        });
        expect(screen.queryByText('Jenseits der Zeit')).toBeNull();
        const root =
            document.querySelector('[data-popup="popupClick"]') ?? container.firstElementChild;
        root?.classList.add('popup-visible');
        await waitFor(() => expect(screen.getByText('Jenseits der Zeit')).toBeTruthy());
    });
});
