// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Seam test: Sidebar's icon lookup for admin-configured SIDEBAR_LINKS /
 * SIDEBAR_SECTIONS entries must read from the server-resolved
 * `page.data.navIcons` (see resolve-nav-icons.ts / +layout.server.ts), not
 * the client-imported `navigationIconMap` catalog this task removed from
 * Sidebar.svelte.
 */

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { pageStore, setData } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writable: hoistedWritable } = require('svelte/store') as typeof import('svelte/store');
    const store = hoistedWritable({
        url: new URL('http://localhost/'),
        params: {},
        data: { dockMode: 'icons' as string, user: { username: 'testuser' }, navIcons: {} },
    });
    return {
        pageStore: store,
        setData: (navIcons: Record<string, unknown>) =>
            store.set({
                url: new URL('http://localhost/'),
                params: {},
                data: { dockMode: 'icons', user: { username: 'testuser' }, navIcons },
            }),
    };
});

vi.mock('$app/stores', () => ({ page: pageStore }));
vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    preloadData: vi.fn(async () => undefined),
    afterNavigate: vi.fn(),
}));
vi.mock('$lib/api/nav-pins', () => ({
    getNavPins: vi.fn(async () => ({ data: { pins: [] } })),
}));

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

const ICON_FIXTURE = {
    default: { a: { viewBox: '0 0 24 24' }, path: [{ d: 'M1 1 SIDEBAR-FIXTURE-PATH' }] },
};

const LINKS = [{ label: 'Support', url: '/support', icon: 'life-buoy', displayOrder: 1 }];

function renderSidebar() {
    return render(Sidebar, { customLinks: LINKS, sections: [], userGroups: ['users'] });
}

describe('Sidebar: icon resolution from page data', () => {
    afterEach(() => cleanup());

    test('renders the server-resolved icon for a configured SIDEBAR_LINKS entry', () => {
        setData({ 'life-buoy': ICON_FIXTURE });
        renderSidebar();
        const link = screen.getByRole('button', { name: 'Support' });
        const path = link.querySelector('path[d="M1 1 SIDEBAR-FIXTURE-PATH"]');
        expect(path).toBeTruthy();
    });

    test('falls back to the default link icon (not a crash) when the name is unresolved', () => {
        setData({}); // nothing configured resolves — matches an empty navIcons payload
        renderSidebar();
        const link = screen.getByRole('button', { name: 'Support' });
        // No fixture path present; the row still renders (Film default), proving
        // a missing map entry degrades gracefully rather than throwing.
        expect(link.querySelector('path[d="M1 1 SIDEBAR-FIXTURE-PATH"]')).toBeNull();
        expect(link.querySelector('svg')).toBeTruthy();
    });
});
