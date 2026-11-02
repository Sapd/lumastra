// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// `vi.mock` factories are hoisted above module scope, so the store has to be
// built inside a hoisted block rather than captured from a top-level const.
const { pageStore, setPath } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writable: hoistedWritable } = require('svelte/store') as typeof import('svelte/store');
    const store = hoistedWritable({
        url: new URL('http://localhost/'),
        params: {},
        data: { dockMode: 'icons' as string, user: { username: 'denis' } },
    });
    return {
        pageStore: store,
        setPath: (path: string, dockMode = 'icons') =>
            store.set({
                url: new URL(`http://localhost${path}`),
                params: {},
                data: { dockMode, user: { username: 'denis' } },
            }),
    };
});

vi.mock('$app/stores', () => ({ page: pageStore }));
vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    preloadData: vi.fn(async () => undefined),
    afterNavigate: vi.fn(),
}));
const { navPinsResult } = vi.hoisted(() => ({
    navPinsResult: { current: [] as Array<{ href: string; label: string }> },
}));
vi.mock('$lib/api/nav-pins', () => ({
    getNavPins: vi.fn(async () => ({ data: { pins: navPinsResult.current } })),
}));

// happy-dom here provides neither of these, and the dock reads both on mount.
beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
        },
    });
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
});

import Sidebar from './Sidebar.svelte';
import { dockMode } from './stores/dock.store';

const SECTIONS = [{ id: 'media', label: 'Media', icon: 'film', collapsed: true, displayOrder: 1 }];
const LINKS = [
    { label: 'Movies', url: '/movies', icon: 'film', section: 'media', displayOrder: 1 },
    { label: 'Shows', url: '/shows', icon: 'tv', section: 'media', displayOrder: 2 },
];

function renderSidebar() {
    return render(Sidebar, { customLinks: LINKS, sections: SECTIONS, userGroups: ['users'] });
}

describe('Sidebar section flyout (icon mode)', () => {
    beforeEach(() => {
        setPath('/');
        dockMode.set('icons');
    });
    afterEach(() => cleanup());

    test('a section header opens a labelled panel instead of more icons', async () => {
        renderSidebar();
        const header = screen.getByRole('button', { name: 'Media' });
        expect(header.getAttribute('aria-haspopup')).toBe('menu');

        await fireEvent.click(header);

        await waitFor(() => {
            const menu = screen.getByRole('menu', { name: 'Media' });
            expect(menu.textContent).toContain('Movies');
            expect(menu.textContent).toContain('Shows');
        });
        expect(header.getAttribute('aria-expanded')).toBe('true');
    });

    test('hover opens it after the intent delay, not instantly', async () => {
        vi.useFakeTimers();
        try {
            renderSidebar();
            const header = screen.getByRole('button', { name: 'Media' });
            // The handlers live on the wrapper around the header, so that leaving
            // the row (not just the 48px button) is what starts the close grace.
            const trigger = header.closest('.dock-section-trigger');
            expect(trigger).toBeTruthy();

            await fireEvent.mouseEnter(trigger!);
            expect(screen.queryByRole('menu', { name: 'Media' })).toBeNull();

            await vi.advanceTimersByTimeAsync(200);
            expect(screen.getByRole('menu', { name: 'Media' })).toBeTruthy();

            // Leaving closes it, but only after the grace period — otherwise the
            // pointer could never travel from the icon to the panel.
            await fireEvent.mouseLeave(trigger!);
            expect(screen.queryByRole('menu', { name: 'Media' })).toBeTruthy();
            await vi.advanceTimersByTimeAsync(250);
            expect(screen.queryByRole('menu', { name: 'Media' })).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    test('Escape closes the panel', async () => {
        renderSidebar();
        const header = screen.getByRole('button', { name: 'Media' });
        await fireEvent.click(header);
        await waitFor(() => screen.getByRole('menu', { name: 'Media' }));

        await fireEvent.keyDown(screen.getByRole('menu', { name: 'Media' }), { key: 'Escape' });

        await waitFor(() => expect(screen.queryByRole('menu', { name: 'Media' })).toBeNull());
    });
});

describe('Sidebar sections (labelled mode)', () => {
    beforeEach(() => {
        setPath('/');
        dockMode.set('labels');
    });
    afterEach(() => cleanup());

    test('the header expands the group in place, with no flyout', async () => {
        renderSidebar();
        const header = screen.getByRole('button', { name: /Media/ });
        expect(header.getAttribute('aria-haspopup')).toBeNull();

        await fireEvent.click(header);

        await waitFor(() => expect(screen.getByText('Movies')).toBeTruthy());
        expect(screen.queryByRole('menu', { name: 'Media' })).toBeNull();
    });
});

/**
 * /admin renders its own 220px sidebar, so the dock drops to its icon rail
 * there regardless of the stored preference — and its collapse control has to
 * go with it, or it is a button that stores a new mode and changes nothing on
 * screen.
 */
describe('Sidebar on /admin', () => {
    beforeEach(() => {
        setPath('/admin', 'labels');
        dockMode.set('labels');
    });
    afterEach(() => {
        setPath('/');
        cleanup();
    });

    test('shows the icon rail even when labels are the stored preference', () => {
        renderSidebar();
        expect(document.querySelectorAll('.dock-label').length).toBe(0);
        // Same store, off /admin: labels come back.
        cleanup();
        setPath('/', 'labels');
        renderSidebar();
        expect(document.querySelectorAll('.dock-label').length).toBeGreaterThan(0);
    });

    test('hides the collapse control, which would do nothing there', () => {
        renderSidebar();
        expect(
            screen.queryByRole('button', { name: /collapse sidebar|expand sidebar/i }),
        ).toBeNull();

        cleanup();
        setPath('/', 'labels');
        renderSidebar();
        expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeTruthy();
    });
});

/**
 * `admin_pinned` can demote a member of an admin group
 * (`isAdmin = admin_pinned ? is_admin : oidcIsAdmin` in forward-auth), and the
 * admin layout redirects on `locals.user.isAdmin`. So a supplied `false` has to
 * win over group membership here, or the dock advertises a door that bounces.
 */
describe('Sidebar admin gating', () => {
    afterEach(() => cleanup());

    const ADMIN_GROUPS = { userGroups: ['Librarians'], adminGroups: ['Librarians'] };
    const adminEntry = () => screen.queryByRole('button', { name: 'Admin' });

    test('a demoted admin does not get the Admin entry back from their groups', () => {
        render(Sidebar, { ...ADMIN_GROUPS, isAdmin: false });
        expect(adminEntry()).toBeNull();
    });

    test('a server verdict of true shows it', () => {
        render(Sidebar, { ...ADMIN_GROUPS, isAdmin: true });
        expect(adminEntry()).toBeTruthy();
    });

    test('with no verdict supplied, group membership still decides', () => {
        render(Sidebar, ADMIN_GROUPS);
        expect(adminEntry()).toBeTruthy();
        cleanup();
        render(Sidebar, { userGroups: ['users'], adminGroups: ['Librarians'] });
        expect(adminEntry()).toBeNull();
    });
});

/**
 * The dock used to fetch the pin list once per session and keep it forever, so
 * pinning a page left this menu insisting nothing was pinned until a reload.
 * (The pin button's `invalidateAll()` re-runs load functions; the dock's copy is
 * a client-side fetch, so invalidation never touched it.)
 */
describe('Sidebar admin pins freshness', () => {
    beforeEach(() => {
        setPath('/');
        dockMode.set('icons');
        navPinsResult.current = [];
    });
    afterEach(() => cleanup());

    test('picks up a pin made after the menu was first opened', async () => {
        render(Sidebar, { userGroups: ['Librarians'], adminGroups: ['Librarians'] });
        const admin = screen.getByRole('button', { name: 'Admin' });

        await fireEvent.focus(admin);
        // Empty: the panel is its header and nothing else — no list, no copy.
        await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());
        expect(screen.getByRole('menu').querySelector('.dock-flyout-list')).toBeNull();

        // …the operator pins a page elsewhere in the app…
        navPinsResult.current = [{ href: '/admin/tasks', label: 'Tasks' }];

        await fireEvent.blur(admin);
        await fireEvent.focus(admin);
        await waitFor(() => expect(screen.getByRole('menu').textContent).toContain('Tasks'));
    });
});

/**
 * The hover unfurl: in icon mode an item's name grows out of its own icon, so a
 * sweep down the rail reads as a wave. It replaces the tooltip there — two
 * labels for one icon would be worse than none.
 */
// Top-level, NOT inside a section: in icon mode a section's children live in
// its flyout, so only top-level items are on the rail to unfurl.
const TOP_LEVEL = [{ label: 'Movies', url: '/movies', icon: 'film', displayOrder: 1 }];

describe('Sidebar hover unfurl (icon mode)', () => {
    beforeEach(() => {
        setPath('/');
        dockMode.set('icons');
    });
    afterEach(() => cleanup());

    const unfurl = () => document.querySelector('.dock-unfurl');

    test('hovering an item unfurls its name, leaving retracts it', async () => {
        render(Sidebar, { customLinks: TOP_LEVEL, userGroups: ['users'] });
        const movies = screen.getByRole('button', { name: 'Movies' });

        expect(unfurl()).toBeNull();
        await fireEvent.pointerEnter(movies);
        expect(unfurl()?.textContent?.trim()).toBe('Movies');

        await fireEvent.pointerLeave(movies);
        expect(unfurl()).toBeNull();
    });

    test('keyboard focus unfurls too — the rail is navigable without a pointer', async () => {
        render(Sidebar, { customLinks: TOP_LEVEL, userGroups: ['users'] });
        const movies = screen.getByRole('button', { name: 'Movies' });

        await fireEvent.focus(movies);
        expect(unfurl()?.textContent?.trim()).toBe('Movies');

        await fireEvent.blur(movies);
        expect(unfurl()).toBeNull();
    });

    test('labelled mode does not unfurl — the name is already on the row', async () => {
        dockMode.set('labels');
        render(Sidebar, { customLinks: TOP_LEVEL, userGroups: ['users'] });

        await fireEvent.pointerEnter(screen.getByRole('button', { name: 'Movies' }));

        expect(unfurl()).toBeNull();
    });

    test('the Admin entry opens its pins panel instead of unfurling', async () => {
        render(Sidebar, { userGroups: ['Librarians'], adminGroups: ['Librarians'] });

        await fireEvent.pointerEnter(screen.getByRole('button', { name: 'Admin' }));

        expect(unfurl()).toBeNull();
    });
});
