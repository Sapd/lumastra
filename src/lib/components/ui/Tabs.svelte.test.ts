// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Admin IA redesign (spec §8): regression coverage for the Tabs fixes —
 * (1) the empty-badge sliver rendered whenever a badge was `0` (or `''`),
 * because the old guard only checked `!== undefined`; (2) `?tab=` deep-links
 * now support a configurable `urlParam` so callers with a different query
 * param name (e.g. `?view=`) don't have to hand-roll URL sync; (3) syncToUrl
 * writes use SHALLOW `replaceState` (preserving `page.state`) instead of a
 * real `goto()` navigation — the goto wiped the shallow-routing state that
 * keeps the admin DetailPanel open, so clicking a tab closed the panel;
 * (4) localStorage tab persistence/restore keyed by the visible pathname.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import * as m from '$lib/paraglide/messages.js';

const stores = vi.hoisted(() => {
    let current: { url: URL; state: Record<string, unknown> } = {
        url: new URL('http://localhost/admin/tasks'),
        state: {},
    };
    const subscribers = new Set<(value: typeof current) => void>();
    return {
        page: {
            subscribe(run: (value: typeof current) => void) {
                subscribers.add(run);
                run(current);
                return () => subscribers.delete(run);
            },
        },
        /**
         * Set the VISIBLE url (window.location — what `visibleUrl()` reads in
         * the browser) and, unless `pageUrl` overrides it, the `$page.url`
         * too. Passing a different `pageUrl` simulates SvelteKit shallow
         * routing, where `$page.url` stays on the underlying route while
         * location shows the shallow one. The visible URL is rebased onto the
         * document's own origin — happy-dom's history rejects cross-origin
         * URLs, and only path + query matter to the component.
         */
        setUrl(url: string, opts: { pageUrl?: string; state?: Record<string, unknown> } = {}) {
            const u = new URL(url);
            window.history.replaceState(
                null,
                '',
                new URL(u.pathname + u.search + u.hash, window.location.origin),
            );
            current = {
                url: new URL(opts.pageUrl ?? url),
                state: opts.state ?? {},
            };
            subscribers.forEach((run) => run(current));
        },
    };
});

const gotoMock = vi.hoisted(() => vi.fn());
// Location-faithful mock: SvelteKit's shallow replaceState really rewrites
// the address bar, and the component reads the tab param back from
// window.location — without this, post-write reads diverge from reality.
const replaceStateMock = vi.hoisted(() =>
    vi.fn((url: string | URL, _state?: Record<string, unknown>) => {
        void _state;
        const u = new URL(String(url), window.location.href);
        window.history.replaceState(
            null,
            '',
            new URL(u.pathname + u.search + u.hash, window.location.origin),
        );
    }),
);

vi.mock('$app/stores', () => ({ page: stores.page }));
vi.mock('$app/navigation', () => ({ goto: gotoMock, replaceState: replaceStateMock }));

const { default: Tabs } = await import('./Tabs.svelte');
const { default: TabsControlledFixture } = await import('./tabs-controlled-fixture.svelte');

/** Path + query of the URL passed to the nth shallow replaceState call. */
function writtenPathAndQuery(index = 0): string {
    const u = new URL(String(replaceStateMock.mock.calls[index]?.[0]), 'http://localhost');
    return u.pathname + u.search;
}

// happy-dom's localStorage implementation is file-backed and missing in some
// harness configurations; install a plain in-memory shim per test.
function installLocalStorageShim(): void {
    const store = new Map<string, string>();
    const mock = {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
            store.set(key, String(value));
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
            return store.size;
        },
    };
    Object.defineProperty(window, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
    });
}

describe('Tabs badge rendering', () => {
    afterEach(() => {
        cleanup();
        gotoMock.mockClear();
        stores.setUrl('http://localhost/admin/tasks');
    });

    it('renders a badge when the count is a positive number', () => {
        render(Tabs, {
            items: [{ id: 'runs', label: 'Runs', badge: 3 }],
        });
        expect(screen.getByText('3')).toBeTruthy();
    });

    it('does NOT render a badge sliver when the count is 0', () => {
        const { container } = render(Tabs, {
            items: [{ id: 'runs', label: 'Runs', badge: 0 }],
        });
        // The rounded-full badge pill must not exist at all — a `0` badge is
        // exactly the "empty-badge sliver" bug (the old guard only checked
        // `item.badge !== undefined`, which 0 satisfies).
        expect(container.querySelector('.rounded-full')).toBeNull();
    });

    it('does NOT render a badge sliver when the badge is undefined', () => {
        const { container } = render(Tabs, {
            items: [{ id: 'runs', label: 'Runs' }],
        });
        expect(container.querySelector('.rounded-full')).toBeNull();
    });

    it('does NOT render a badge sliver when the badge is an empty string', () => {
        const { container } = render(Tabs, {
            items: [{ id: 'runs', label: 'Runs', badge: '' }],
        });
        expect(container.querySelector('.rounded-full')).toBeNull();
    });

    it('renders a non-empty string badge', () => {
        render(Tabs, {
            items: [{ id: 'runs', label: 'Runs', badge: 'NEW' }],
        });
        expect(screen.getByText('NEW')).toBeTruthy();
    });

    it('the last tab never carries a stray badge element when it has none', () => {
        const { container } = render(Tabs, {
            items: [
                { id: 'a', label: 'A', badge: 2 },
                { id: 'b', label: 'B' },
            ],
        });
        const badges = container.querySelectorAll('.rounded-full');
        expect(badges.length).toBe(1);
        expect(badges[0].textContent?.trim()).toBe('2');
    });
});

describe('Tabs syncToUrl / urlParam', () => {
    beforeEach(() => {
        installLocalStorageShim();
    });

    afterEach(() => {
        cleanup();
        gotoMock.mockClear();
        replaceStateMock.mockClear();
        stores.setUrl('http://localhost/admin/tasks');
    });

    const items = [
        { id: 'paths', label: 'Paths' },
        { id: 'types', label: 'Library Types' },
    ];

    it('defaults to the `tab` query param', async () => {
        stores.setUrl('http://localhost/admin/library');
        render(Tabs, { items, syncToUrl: true });

        const typesTab = screen.getByRole('tab', { name: 'Library Types' });
        typesTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();

        expect(replaceStateMock).toHaveBeenCalledTimes(1);
        expect(writtenPathAndQuery()).toBe('/admin/library?tab=types');
    });

    it('uses a caller-supplied urlParam instead of `tab`', async () => {
        stores.setUrl('http://localhost/admin/tasks/pipeline');
        render(Tabs, {
            items: [
                { id: 'flow', label: 'Flow' },
                { id: 'completion', label: 'Completion' },
            ],
            syncToUrl: true,
            urlParam: 'view',
        });

        const completionTab = screen.getByRole('tab', { name: 'Completion' });
        completionTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();

        expect(replaceStateMock).toHaveBeenCalledTimes(1);
        expect(writtenPathAndQuery()).toBe('/admin/tasks/pipeline?view=completion');
    });

    it('reads the initial active tab from the configured urlParam', () => {
        stores.setUrl('http://localhost/admin/tasks/pipeline?view=completion');
        render(Tabs, {
            items: [
                { id: 'flow', label: 'Flow' },
                { id: 'completion', label: 'Completion' },
            ],
            syncToUrl: true,
            urlParam: 'view',
        });

        expect(screen.getByRole('tab', { name: 'Completion' }).getAttribute('aria-selected')).toBe(
            'true',
        );
    });

    it('a tab click never performs a real navigation — shallow replaceState only', async () => {
        stores.setUrl('http://localhost/admin/library');
        render(Tabs, { items, syncToUrl: true });

        const typesTab = screen.getByRole('tab', { name: 'Library Types' });
        typesTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();

        expect(gotoMock).not.toHaveBeenCalled();
        expect(replaceStateMock).toHaveBeenCalledTimes(1);
    });

    it('preserves shallow-routing page.state on tab click (DetailPanel stays open)', async () => {
        // Simulate a shallow-routed DetailPanel: location shows the panel's
        // own URL, $page.url stays on the underlying list route, and
        // page.state carries the panel marker. The old goto()-based sync
        // built its target from $page.url and navigated for real — wiping
        // this state and closing the panel.
        const panelState = { detailPanel: { path: '/admin/tasks/auto-identify-personal-media' } };
        stores.setUrl('http://localhost/admin/tasks/auto-identify-personal-media', {
            pageUrl: 'http://localhost/admin/tasks',
            state: panelState,
        });
        render(Tabs, {
            items: [
                { id: 'overview', label: 'Overview' },
                { id: 'runs', label: 'Recent Runs' },
            ],
            syncToUrl: true,
        });

        const runsTab = screen.getByRole('tab', { name: 'Recent Runs' });
        runsTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();

        expect(gotoMock).not.toHaveBeenCalled();
        expect(replaceStateMock).toHaveBeenCalledTimes(1);
        // Written onto the VISIBLE (panel) URL, not the underlying list URL…
        expect(writtenPathAndQuery()).toBe('/admin/tasks/auto-identify-personal-media?tab=runs');
        // …and the shallow state is passed straight through, keeping the panel open.
        expect(replaceStateMock.mock.calls[0]?.[1]).toEqual(panelState);
    });
});

describe('Tabs remember (localStorage persistence)', () => {
    const items = [
        { id: 'paths', label: 'Paths' },
        { id: 'types', label: 'Library Types' },
    ];

    beforeEach(() => {
        installLocalStorageShim();
    });

    afterEach(() => {
        cleanup();
        gotoMock.mockClear();
        replaceStateMock.mockClear();
        stores.setUrl('http://localhost/admin/tasks');
    });

    it('persists the clicked tab to localStorage keyed by pathname', async () => {
        stores.setUrl('http://localhost/admin/library');
        render(Tabs, { items, syncToUrl: true });

        const typesTab = screen.getByRole('tab', { name: 'Library Types' });
        typesTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();

        expect(localStorage.getItem('admin:last-tab:/admin/library')).toBe('types');
    });

    it('restores the remembered tab when the URL has no ?tab= param', async () => {
        stores.setUrl('http://localhost/admin/library');
        localStorage.setItem('admin:last-tab:/admin/library', 'types');

        const onchange = vi.fn();
        render(Tabs, { items, syncToUrl: true, onchange });

        // The highlight restores immediately…
        expect(
            screen.getByRole('tab', { name: 'Library Types' }).getAttribute('aria-selected'),
        ).toBe('true');
        // …and the URL reflection + parent notify land one macrotask later
        // (deferred past the initial effect cascade).
        await new Promise((r) => setTimeout(r, 0));

        // Reflected via SHALLOW replaceState — no history entry, no real
        // navigation (goto), and the current page.state passed through so a
        // restore inside a shallow-routed panel can never close it.
        expect(gotoMock).not.toHaveBeenCalled();
        expect(replaceStateMock).toHaveBeenCalledTimes(1);
        expect(writtenPathAndQuery()).toBe('/admin/library?tab=types');
        // Controlled callers (DetailPanel) are told about the restore so
        // their own tab state — which drives the content — follows.
        expect(onchange).toHaveBeenCalledWith({ id: 'types', item: items[1] });
    });

    it('an explicit ?tab= param wins over a remembered value', () => {
        stores.setUrl('http://localhost/admin/library?tab=paths');
        localStorage.setItem('admin:last-tab:/admin/library', 'types');

        render(Tabs, { items, syncToUrl: true });

        expect(screen.getByRole('tab', { name: 'Paths' }).getAttribute('aria-selected')).toBe(
            'true',
        );
    });

    it('ignores a stale remembered tab id that no longer matches an item', () => {
        stores.setUrl('http://localhost/admin/library');
        localStorage.setItem('admin:last-tab:/admin/library', 'removed-tab');

        render(Tabs, { items, syncToUrl: true });

        expect(screen.getByRole('tab', { name: 'Paths' }).getAttribute('aria-selected')).toBe(
            'true',
        );
    });

    it('does not restore when remember is false', () => {
        stores.setUrl('http://localhost/admin/library');
        localStorage.setItem('admin:last-tab:/admin/library', 'types');

        render(Tabs, { items, syncToUrl: true, remember: false });

        expect(screen.getByRole('tab', { name: 'Paths' }).getAttribute('aria-selected')).toBe(
            'true',
        );
    });

    it('does not persist when remember is false', async () => {
        stores.setUrl('http://localhost/admin/library');
        render(Tabs, { items, syncToUrl: true, remember: false });

        const typesTab = screen.getByRole('tab', { name: 'Library Types' });
        typesTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();

        expect(localStorage.getItem('admin:last-tab:/admin/library')).toBeNull();
    });

    it('restore converges highlight AND parent state under a controlled parent with a reset effect', async () => {
        // TaskDetail-in-DetailPanel shape: parent owns the tab state (content
        // renders from it), passes `active` down unbound, follows via
        // `onchange`, and has a mount effect resetting the state to its
        // default — the restore must still win.
        stores.setUrl('http://localhost/admin/tasks/auto-identify-personal-media', {
            pageUrl: 'http://localhost/admin/tasks',
            state: { detailPanel: { path: '/admin/tasks/auto-identify-personal-media' } },
        });
        localStorage.setItem('admin:last-tab:/admin/tasks/auto-identify-personal-media', 'runs');

        render(TabsControlledFixture, {
            items: [
                { id: 'overview', label: 'Overview' },
                { id: 'runs', label: 'Recent Runs' },
            ],
            defaultTab: 'overview',
        });
        // Let the deferred restore-reflection (one macrotask) and the
        // parent's follow-up re-render settle.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        expect(screen.getByRole('tab', { name: 'Recent Runs' }).getAttribute('aria-selected')).toBe(
            'true',
        );
        expect(screen.getByTestId('parent-content').textContent).toBe('runs');
        expect(gotoMock).not.toHaveBeenCalled();
    });
});

describe('Tabs overflow ("More") menu', () => {
    afterEach(() => {
        cleanup();
    });

    const fourItems = [
        { id: 'overview', label: 'Overview' },
        { id: 'episodes', label: 'Episodes' },
        { id: 'health', label: 'Health', badge: 3 },
        { id: 'files', label: 'Files' },
    ];

    /**
     * happy-dom (like jsdom) never runs real layout — every element's
     * offsetLeft/offsetWidth/clientWidth is 0. Shadow those with own-property
     * overrides so `updateHiddenItems`'s bounding-box comparison has real
     * numbers to compare, then re-fire the `scroll` handler it's wired to
     * (the effect that runs it automatically only fires once, at mount,
     * before this layout exists).
     */
    async function mockLayoutAndRecompute(
        container: HTMLElement,
        containerWidth: number,
        buttons: Record<string, { left: number; width: number }>,
    ): Promise<HTMLElement> {
        const scrollEl = container.querySelector('.tabs-container') as HTMLElement;
        Object.defineProperty(scrollEl, 'clientWidth', {
            value: containerWidth,
            configurable: true,
        });
        const scrollWidth = Math.max(...Object.values(buttons).map((b) => b.left + b.width));
        Object.defineProperty(scrollEl, 'scrollWidth', { value: scrollWidth, configurable: true });
        for (const [id, { left, width }] of Object.entries(buttons)) {
            const button = scrollEl.querySelector(`[data-tab-id="${id}"]`) as HTMLElement;
            Object.defineProperty(button, 'offsetLeft', { value: left, configurable: true });
            Object.defineProperty(button, 'offsetWidth', { value: width, configurable: true });
        }
        scrollEl.dispatchEvent(new Event('scroll'));
        // The `$state` write inside the native scroll handler is real, but
        // Svelte batches the resulting DOM update onto a microtask — without
        // this, assertions right after `dispatchEvent` would run one tick
        // too early and see the pre-recompute DOM.
        await tick();
        return scrollEl;
    }

    // Four 100px-wide tabs at x=0,100,200,300; a 220px viewport fully shows
    // only the first two (overview, episodes) — health and files overflow.
    async function mockTwoOfFourHidden(container: HTMLElement): Promise<HTMLElement> {
        return mockLayoutAndRecompute(container, 220, {
            overview: { left: 0, width: 100 },
            episodes: { left: 100, width: 100 },
            health: { left: 200, width: 100 },
            files: { left: 300, width: 100 },
        });
    }

    it('does not render the More trigger when every tab fits', async () => {
        const { container } = render(Tabs, { items: fourItems });
        // A container as wide as the full strip — nothing hidden.
        await mockLayoutAndRecompute(container, 1000, {
            overview: { left: 0, width: 100 },
            episodes: { left: 100, width: 100 },
            health: { left: 200, width: 100 },
            files: { left: 300, width: 100 },
        });

        // Reverted (e.g. the `{#if hiddenItems.length > 0}` gate dropped, or
        // always true) would render the trigger even though nothing is cut
        // off — this assertion fails the moment that happens.
        expect(screen.queryByRole('button', { name: m.ui_tabs_more() })).toBeNull();
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('lists exactly the hidden tabs when the strip overflows', async () => {
        const { container } = render(Tabs, { items: fourItems });
        await mockTwoOfFourHidden(container);

        const trigger = screen.getByRole('button', { name: m.ui_tabs_more() });
        expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        await fireEvent.click(trigger);

        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        const menu = screen.getByRole('menu');
        const menuItems = menu.querySelectorAll('[role="menuitem"]');
        // Reverted overflow detection (wrong comparison, or a hidden set that
        // includes visible tabs / omits an actually-hidden one) fails this —
        // it pins the hidden set to exactly {health, files}.
        expect(menuItems.length).toBe(2);
        expect(Array.from(menuItems).map((el) => el.textContent?.trim())).toEqual([
            expect.stringContaining('Health'),
            expect.stringContaining('Files'),
        ]);
        expect(menu.textContent).not.toContain('Overview');
        expect(menu.textContent).not.toContain('Episodes');
    });

    it("selecting a hidden tab from the menu activates it via the strip's own click path", async () => {
        const onchange = vi.fn();
        const { container } = render(Tabs, { items: fourItems, active: 'overview', onchange });
        await mockTwoOfFourHidden(container);

        await fireEvent.click(screen.getByRole('button', { name: m.ui_tabs_more() }));
        const filesMenuItem = screen.getByRole('menuitem', { name: /Files/ });
        await fireEvent.click(filesMenuItem);

        // A reverted/duplicated activation path (calling something other
        // than handleTabClick) would leave the strip's own `active` state —
        // and therefore aria-selected — untouched, or skip the onchange
        // notification the strip's real clicks always send.
        expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe(
            'true',
        );
        expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe(
            'false',
        );
        expect(onchange).toHaveBeenCalledWith({
            id: 'files',
            item: expect.objectContaining({ id: 'files' }),
        });
        // The menu closes after a selection.
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it("shows a hidden item's badge inside the menu", async () => {
        const { container } = render(Tabs, { items: fourItems });
        await mockTwoOfFourHidden(container);

        await fireEvent.click(screen.getByRole('button', { name: m.ui_tabs_more() }));
        const healthMenuItem = screen.getByRole('menuitem', { name: /Health/ });

        // Reverting the menu's badge render (dropping `{@render tabBadge(item)}`
        // for the menu items, or re-deriving the label without the badge)
        // makes the badge text disappear from the hidden item's row.
        expect(healthMenuItem.textContent).toContain('3');
    });
});
