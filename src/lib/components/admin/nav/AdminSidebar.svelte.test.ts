// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import type { AdminStatusPayload } from '$lib/schemas/api-admin-status-payload.js';
import type { AttentionItem } from '$lib/schemas/api-attention-responses.js';
import { ADMIN_NAV } from '$lib/config/admin-nav';
import { adminNavPrefs } from '$lib/stores/admin-nav-prefs.store.svelte.js';
import AdminSidebar from './AdminSidebar.svelte';

const pageStore = vi.hoisted(() => ({ set: (_: unknown): void => undefined }));
const status = vi.hoisted(() => ({ payload: null as AdminStatusPayload | null }));

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));
vi.mock('$app/stores', async () => {
    const { writable } = await import('svelte/store');
    const page = writable({ url: new URL('http://localhost/admin'), data: { navPins: [] } });
    pageStore.set = (value: unknown): void => page.set(value as never);
    return { page };
});
vi.mock('$app/navigation', () => ({ goto: vi.fn(), afterNavigate: vi.fn() }));
vi.mock('$lib/paths', () => ({ resolve: (path: string): string => path }));
vi.mock('$lib/stores/admin-status.store.svelte.js', () => ({ adminStatus: status }));
vi.mock('$lib/api/admin.js', () => ({ setAdminNavStyle: vi.fn() }));

const sections = ADMIN_NAV.filter((s) => !s.devOnly);

function at(pathname: string): void {
    pageStore.set({ url: new URL(`http://localhost${pathname}`), data: { navPins: [] } });
}

// The store is a module singleton; initFromStorage re-reads both the rail pin
// and the user's expanded set, and applyBreakpoint sets the effective rail.
async function setup(pathname: string, { username = 'alice', rail = false } = {}): Promise<void> {
    at(pathname);
    adminNavPrefs.initFromStorage(username);
    adminNavPrefs.applyBreakpoint(rail);
    render(AdminSidebar, { sections });
    await tick();
}

function nav(): HTMLElement {
    return screen.getByRole('navigation', { name: 'Admin sections' });
}
function sectionLink(name: string): HTMLAnchorElement {
    return nav().querySelector<HTMLAnchorElement>(
        `a.section-row[title^="${name}"], a.section-row[aria-label="${name}"]`,
    )!;
}

function item(partial: Partial<AttentionItem>): AttentionItem {
    return {
        id: 'tasks:x',
        fingerprint: 'f',
        type: 'alert',
        domain: 'tasks',
        severity: 'warning',
        title: 't',
        actions: [],
        firstSeen: '2026-10-06T00:00:00Z',
        lastSeen: '2026-10-06T00:00:00Z',
        acked: false,
        ...partial,
    } as AttentionItem;
}

beforeEach(() => {
    localStorage.clear();
    status.payload = null;
});
afterEach(cleanup);

describe('AdminSidebar — sub-pages in the full sidebar', () => {
    it('lists the active section pages and marks exactly the current page', async () => {
        await setup('/admin/tasks/runs');
        const list = document.getElementById('admin-nav-pages-tasks')!;
        expect(list.hidden).toBe(false);
        const links = within(list).getAllByRole('link');
        expect(links.map((a) => a.getAttribute('href'))).toEqual([
            '/admin/tasks',
            '/admin/tasks/runs',
            '/admin/tasks/pipeline',
        ]);
        const current = nav().querySelectorAll('[aria-current="page"]');
        expect(current).toHaveLength(1);
        expect(current[0].getAttribute('href')).toBe('/admin/tasks/runs');
        // The section row is the current SECTION, not a second current page.
        expect(sectionLink('Tasks').getAttribute('aria-current')).toBe('true');
    });

    it('gives the active section and single-page Home no chevron, others one each', async () => {
        await setup('/admin/tasks/runs');
        expect(screen.queryByRole('button', { name: 'Show Tasks pages' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Show Home pages' })).toBeNull();
        for (const name of ['System', 'Library', 'Users & sessions', 'Settings']) {
            const chevron = screen.getByRole('button', { name: `Show ${name} pages` });
            expect(chevron.getAttribute('aria-expanded')).toBe('false');
            // aria-controls must point at a real element even while closed.
            expect(document.getElementById(chevron.getAttribute('aria-controls')!)).not.toBeNull();
        }
    });

    it('expands and collapses a section with its chevron without navigating', async () => {
        await setup('/admin/tasks/runs');
        const list = document.getElementById('admin-nav-pages-library')!;
        expect(list.hidden).toBe(true);

        await fireEvent.click(screen.getByRole('button', { name: 'Show Library pages' }));
        expect(list.hidden).toBe(false);
        const hide = screen.getByRole('button', { name: 'Hide Library pages' });
        expect(hide.getAttribute('aria-expanded')).toBe('true');
        expect(within(list).getAllByRole('link')[0].getAttribute('href')).toBe(
            '/admin/library/media',
        );

        await fireEvent.click(hide);
        expect(list.hidden).toBe(true);
        expect(vi.mocked(goto)).not.toHaveBeenCalled();
    });

    it('keeps the section name a link to its landing page (remembered last sub-page)', async () => {
        localStorage.setItem('admin:last-page:library', '/admin/library/sources');
        await setup('/admin/tasks/runs');
        expect(sectionLink('Library').getAttribute('href')).toBe('/admin/library/sources');
    });

    it('persists expanded sections per user', async () => {
        await setup('/admin', { username: 'alice' });
        await fireEvent.click(screen.getByRole('button', { name: 'Show System pages' }));
        expect(JSON.parse(localStorage.getItem('admin-nav-expanded:alice')!)).toEqual(['system']);
        cleanup();

        await setup('/admin', { username: 'alice' });
        expect(document.getElementById('admin-nav-pages-system')!.hidden).toBe(false);
        cleanup();

        await setup('/admin', { username: 'bob' });
        expect(document.getElementById('admin-nav-pages-system')!.hidden).toBe(true);
    });

    it('opens Settings as a grouped flyout, never as an inline list', async () => {
        await setup('/admin/settings/media');
        expect(document.getElementById('admin-nav-pages-settings')).toBeNull();
        const flyout = document.getElementById('admin-nav-flyout-settings')!;
        expect(flyout.hidden).toBe(true);
        const chevron = screen.getByRole('button', { name: 'Show Settings pages' });
        expect(chevron.getAttribute('aria-controls')).toBe('admin-nav-flyout-settings');

        await fireEvent.click(chevron);
        expect(flyout.hidden).toBe(false);
        expect(chevron.getAttribute('aria-expanded')).toBe('true');
        expect(within(flyout).getAllByRole('link')).toHaveLength(
            sections.find((s) => s.id === 'settings')!.pages.length,
        );
        expect(flyout.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe(
            '/admin/settings/media',
        );
        expect(flyout.querySelectorAll('.flyout-group-label')).toHaveLength(3);

        await fireEvent.keyDown(chevron, { key: 'Escape' });
        expect(flyout.hidden).toBe(true);

        // Opened from the chevron, Esc from inside returns focus to the chevron.
        chevron.focus();
        await fireEvent.keyDown(chevron, { key: 'ArrowDown' });
        await tick();
        const inside = flyout.querySelector<HTMLAnchorElement>('[data-flyout-link]')!;
        expect(document.activeElement).toBe(inside);
        await fireEvent.keyDown(inside, { key: 'Escape' });
        expect(flyout.hidden).toBe(true);
        expect(document.activeElement).toBe(chevron);
    });

    it('closes a pinned panel when keyboard focus lands outside its row', async () => {
        await setup('/admin');
        const chevron = screen.getByRole('button', { name: 'Show Settings pages' });
        const flyout = document.getElementById('admin-nav-flyout-settings')!;
        await fireEvent.click(chevron);
        expect(flyout.hidden).toBe(false);
        await fireEvent.focusIn(screen.getByRole('button', { name: 'Collapse navigation' }));
        expect(flyout.hidden).toBe(true);
    });

    it('dots only the page an open warning/critical item links to', async () => {
        status.payload = {
            attention: {
                items: [
                    item({ id: 'tasks:a', sourceRef: '/admin/tasks/pipeline?stage=probe' }),
                    item({ id: 'tasks:b', severity: 'info', sourceRef: '/admin/tasks/runs' }),
                    item({ id: 'tasks:c', acked: true, sourceRef: '/admin/tasks/runs' }),
                ],
                unavailable: false,
            },
            sectionStatus: { tasks: 'degraded' },
        } as unknown as AdminStatusPayload;
        await setup('/admin/tasks');
        const list = document.getElementById('admin-nav-pages-tasks')!;
        const dotted = [...list.querySelectorAll('.page-dot')].map((dot) =>
            dot.closest('a')!.getAttribute('href'),
        );
        expect(dotted).toEqual(['/admin/tasks/pipeline']);
        // The section row keeps its count (open items, info included — unchanged).
        expect(sectionLink('Tasks').querySelector('.status-count')?.textContent).toBe('2');
    });
});

describe('AdminSidebar — slim rail flyout', () => {
    it('lists no inline pages on the rail', async () => {
        await setup('/admin/tasks/runs', { rail: true });
        expect(nav().querySelector('.page-list')).toBeNull();
        expect(nav().querySelectorAll('.chevron-btn')).toHaveLength(0);
    });

    it('opens on focus, arrows into the pages, Esc closes and returns focus', async () => {
        await setup('/admin', { rail: true });
        const link = sectionLink('Users & sessions');
        const flyout = document.getElementById('admin-nav-flyout-users')!;
        expect(flyout.hidden).toBe(true);

        link.focus();
        await fireEvent.focus(link);
        expect(flyout.hidden).toBe(false);
        expect(link.getAttribute('aria-expanded')).toBe('true');
        expect(link.getAttribute('aria-controls')).toBe('admin-nav-flyout-users');

        await fireEvent.keyDown(link, { key: 'ArrowDown' });
        await tick();
        const pages = within(flyout).getAllByRole('link');
        expect(document.activeElement).toBe(pages[0]);
        await fireEvent.keyDown(pages[0], { key: 'ArrowDown' });
        expect(document.activeElement).toBe(pages[1]);
        await fireEvent.keyDown(pages[1], { key: 'End' });
        expect(document.activeElement).toBe(pages[pages.length - 1]);
        await fireEvent.keyDown(pages[pages.length - 1], { key: 'Home' });
        expect(document.activeElement).toBe(pages[0]);
        // Modified arrows (Alt+Left = back, …) stay with the browser.
        await fireEvent.keyDown(pages[0], { key: 'ArrowLeft', altKey: true });
        expect(flyout.hidden).toBe(false);
        await fireEvent.keyDown(pages[0], { key: 'ArrowDown' });

        await fireEvent.keyDown(pages[1], { key: 'Escape' });
        expect(flyout.hidden).toBe(true);
        expect(document.activeElement).toBe(link);
    });

    it('does not trap focus: moving focus out of the row closes the flyout', async () => {
        await setup('/admin', { rail: true });
        const link = sectionLink('Library');
        const flyout = document.getElementById('admin-nav-flyout-library')!;
        await fireEvent.focus(link);
        expect(flyout.hidden).toBe(false);
        // No element inside opts out of the tab order or grabs focus back.
        expect(flyout.querySelector('[tabindex]')).toBeNull();

        // Focus going nowhere focusable (panel padding, window blur) keeps it.
        await fireEvent.focusOut(link, { relatedTarget: null });
        expect(flyout.hidden).toBe(false);

        const next = sectionLink('Users & sessions');
        await fireEvent.focusOut(link, { relatedTarget: next });
        expect(flyout.hidden).toBe(true);
    });

    it('Esc closes a hover-opened panel while focus is elsewhere', async () => {
        vi.useFakeTimers();
        try {
            await setup('/admin', { rail: true });
            const row = sectionLink('System').closest('li')!;
            const flyout = document.getElementById('admin-nav-flyout-system')!;
            await fireEvent.pointerEnter(row, { pointerType: 'mouse' });
            vi.advanceTimersByTime(150);
            await tick();
            expect(flyout.hidden).toBe(false);
            await fireEvent.keyDown(document.body, { key: 'Escape' });
            expect(flyout.hidden).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('hover never hides a panel the keyboard is working in', async () => {
        vi.useFakeTimers();
        try {
            await setup('/admin', { rail: true });
            const link = sectionLink('Users & sessions');
            const flyout = document.getElementById('admin-nav-flyout-users')!;
            link.focus();
            await fireEvent.focus(link);
            await fireEvent.keyDown(link, { key: 'ArrowDown' });
            await tick();
            const inside = within(flyout).getAllByRole('link')[0];
            expect(document.activeElement).toBe(inside);

            // Pointer wanders over another row, then leaves ours.
            const other = sectionLink('System').closest('li')!;
            await fireEvent.pointerEnter(other, { pointerType: 'mouse' });
            await fireEvent.pointerLeave(link.closest('li')!, { pointerType: 'mouse' });
            vi.advanceTimersByTime(400);
            await tick();
            expect(flyout.hidden).toBe(false);
            expect(document.activeElement).toBe(inside);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a mouse click on a rail link does not open its panel via focus', async () => {
        await setup('/admin', { rail: true });
        const link = sectionLink('Library');
        const flyout = document.getElementById('admin-nav-flyout-library')!;
        await fireEvent.pointerDown(link);
        await fireEvent.focus(link);
        expect(flyout.hidden).toBe(true);
    });

    it('closes on a pointer press outside the row, not inside the panel', async () => {
        await setup('/admin', { rail: true });
        const link = sectionLink('Library');
        const flyout = document.getElementById('admin-nav-flyout-library')!;
        await fireEvent.focus(link);
        await fireEvent.pointerDown(flyout);
        expect(flyout.hidden).toBe(false);
        await fireEvent.pointerDown(document.body);
        expect(flyout.hidden).toBe(true);
    });

    it('keeps a chevron-opened flyout when the pointer hovered the row first', async () => {
        vi.useFakeTimers();
        try {
            await setup('/admin');
            const chevron = screen.getByRole('button', { name: 'Show Settings pages' });
            const row = chevron.closest('li')!;
            const flyout = document.getElementById('admin-nav-flyout-settings')!;
            // A real click: the pointer enters the row (hover-open), then clicks.
            await fireEvent.pointerEnter(row, { pointerType: 'mouse' });
            vi.advanceTimersByTime(150);
            await tick();
            await fireEvent.click(chevron);
            expect(flyout.hidden).toBe(false);
            expect(chevron.getAttribute('aria-label')).toBe('Hide Settings pages');
            await fireEvent.pointerLeave(row, { pointerType: 'mouse' });
            vi.advanceTimersByTime(250);
            await tick();
            expect(flyout.hidden).toBe(false);
            await fireEvent.click(chevron);
            expect(flyout.hidden).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('opens on hover and closes after the pointer leaves', async () => {
        vi.useFakeTimers();
        try {
            await setup('/admin', { rail: true });
            const row = sectionLink('System').closest('li')!;
            const flyout = document.getElementById('admin-nav-flyout-system')!;
            await fireEvent.pointerEnter(row, { pointerType: 'mouse' });
            expect(flyout.hidden).toBe(true); // hover intent: not on a mere sweep
            vi.advanceTimersByTime(150);
            await tick();
            expect(flyout.hidden).toBe(false);
            await fireEvent.pointerLeave(row, { pointerType: 'mouse' });
            expect(flyout.hidden).toBe(false); // grace period to reach the panel
            vi.advanceTimersByTime(250);
            await tick();
            expect(flyout.hidden).toBe(true);

            // A touch tap never opens a hover panel that nothing would close.
            await fireEvent.pointerEnter(row, { pointerType: 'touch' });
            vi.advanceTimersByTime(150);
            await tick();
            expect(flyout.hidden).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('AdminSidebar — shared hover with the in-page nav', () => {
    it('lights the same page in the Settings flyout and Settings own strip', async () => {
        const { default: AdminSectionTabs } = await import('./AdminSectionTabs.svelte');
        await setup('/admin/settings');
        render(AdminSectionTabs, { sections, sidebarExpanded: true });
        await tick();

        const strip = screen.getByRole('navigation', { name: 'Settings' });
        const stripLink = strip.querySelector<HTMLAnchorElement>(
            'a[href="/admin/settings/playback"]',
        )!;
        const flyoutLink = document
            .getElementById('admin-nav-flyout-settings')!
            .querySelector<HTMLAnchorElement>('a[href="/admin/settings/playback"]')!;

        await fireEvent.pointerEnter(stripLink);
        expect(flyoutLink.classList.contains('linked-hover')).toBe(true);
        await fireEvent.pointerLeave(stripLink);
        expect(flyoutLink.classList.contains('linked-hover')).toBe(false);

        await fireEvent.pointerEnter(flyoutLink);
        expect(stripLink.className).toContain('bg-surface-700/50 text-white');
        await fireEvent.pointerLeave(flyoutLink);
        expect(stripLink.className).not.toContain('bg-surface-700/50 text-white');
    });
});
