// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { mount, unmount, flushSync } from 'svelte';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { visibleNav, type AdminNavSection, type NavGateContext } from '$lib/config/admin-nav';

const gotoMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('$app/navigation', () => ({ goto: gotoMock }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));

const getRecentsMock = vi.hoisted(() => vi.fn(() => [] as unknown[]));
const recordRecentMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/admin/command-palette-recents', () => ({
    getRecents: getRecentsMock,
    recordRecent: recordRecentMock,
}));

import AdminHomeSearchBar from './AdminHomeSearchBar.svelte';

const GATE: NavGateContext = {
    devToolsEnabled: false,
    features: {},
    trainingAssignments: false,
    assessment: false,
    showcase: false,
};
const NAV: AdminNavSection[] = visibleNav(GATE);

beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();

    // happy-dom does not implement the Web Animations API (`Element.prototype.animate`),
    // which Svelte 5 uses to drive `in:`/`out:` transitions. AdminHomeSearchBar's
    // fade/slide transitions throw ("element.animate is not a function") without this
    // stub. Matches the pattern in ToastContainer.svelte.test.ts / IngestMap.test.ts.
    if (typeof Element !== 'undefined' && !Element.prototype.animate) {
        Element.prototype.animate = (() => {
            const anim = {
                cancel: () => {},
                finished: Promise.resolve(),
                addEventListener: (event: string, handler: EventListener) => {
                    if (event === 'finish') queueMicrotask(() => handler(new Event('finish')));
                },
                onfinish: null as EventListener | null,
                oncancel: null as EventListener | null,
                removeEventListener: () => {},
            };
            queueMicrotask(() => anim.onfinish?.(new Event('finish')));
            return anim as unknown as Animation;
        }) as typeof Element.prototype.animate;
    }
});

afterEach(() => {
    cleanup();
    gotoMock.mockClear();
    getRecentsMock.mockClear();
    recordRecentMock.mockClear();
});

describe('AdminHomeSearchBar', () => {
    it('renders the collapsed trigger and no dialog', () => {
        render(AdminHomeSearchBar, { navSections: NAV, navGate: GATE });
        expect(screen.getByTestId('admin-home-search-trigger')).toBeTruthy();
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('clicking the trigger expands the dialog with results', async () => {
        render(AdminHomeSearchBar, { navSections: NAV, navGate: GATE });
        await fireEvent.click(screen.getByTestId('admin-home-search-trigger'));
        expect(screen.getByRole('dialog')).toBeTruthy();
        expect(screen.getByText('Cost & usage')).toBeTruthy();
    });

    it('Escape collapses the dialog', async () => {
        render(AdminHomeSearchBar, { navSections: NAV, navGate: GATE });
        await fireEvent.click(screen.getByTestId('admin-home-search-trigger'));
        const input = screen.getByPlaceholderText('Search pages, settings, providers…');
        await fireEvent.keyDown(input, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('Enter navigates to the selected result and collapses', async () => {
        render(AdminHomeSearchBar, { navSections: NAV, navGate: GATE });
        await fireEvent.click(screen.getByTestId('admin-home-search-trigger'));
        const input = screen.getByPlaceholderText('Search pages, settings, providers…');
        await fireEvent.input(input, { target: { value: 'cost' } });
        await fireEvent.keyDown(input, { key: 'Enter' });
        expect(gotoMock).toHaveBeenCalledWith('/admin/system/cost');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('Enter opens the top result even after arrowing and with a recent on file', async () => {
        getRecentsMock.mockReturnValueOnce([
            {
                kind: 'page',
                href: '/admin/system/health',
                label: 'Health',
                timestamp: 1,
            },
        ]);
        render(AdminHomeSearchBar, { navSections: NAV, navGate: GATE });
        await fireEvent.click(screen.getByTestId('admin-home-search-trigger'));
        const input = screen.getByPlaceholderText('Search pages, settings, providers…');
        await fireEvent.keyDown(input, { key: 'ArrowDown' });
        await fireEvent.input(input, { target: { value: 'cost' } });
        await fireEvent.keyDown(input, { key: 'Enter' });
        expect(gotoMock).toHaveBeenCalledWith('/admin/system/cost');
    });

    it('activating a result records it as a recent', async () => {
        render(AdminHomeSearchBar, { navSections: NAV, navGate: GATE });
        await fireEvent.click(screen.getByTestId('admin-home-search-trigger'));
        const input = screen.getByPlaceholderText('Search pages, settings, providers…');
        await fireEvent.input(input, { target: { value: 'cost' } });
        await fireEvent.keyDown(input, { key: 'Enter' });
        expect(recordRecentMock).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'page',
                href: '/admin/system/cost',
                label: 'Cost & usage',
            }),
        );
    });

    it('focusAndExpand() opens the dialog imperatively (raw mount API, not testing-library)', () => {
        const instance = mount(AdminHomeSearchBar, {
            target: document.body,
            props: { navSections: NAV, navGate: GATE },
        });
        instance.focusAndExpand();
        flushSync();
        expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
        unmount(instance);
    });
});
