// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { CommandPaletteController, toRecentEntry } from './use-command-palette.svelte';
import { visibleNav, type NavGateContext } from '$lib/config/admin-nav';
import type { RecentEntry } from '$lib/utils/admin/command-palette-recents';

const GATE: NavGateContext = {
    devToolsEnabled: true,
    features: {},
    trainingAssignments: false,
    assessment: false,
    showcase: false,
};
const NAV = visibleNav(GATE);
const NAV_PAGE_COUNT = NAV.flatMap((s) => s.pages).length;

function makeController(recents: RecentEntry[] = []): CommandPaletteController {
    return new CommandPaletteController({
        navSections: () => NAV,
        navGate: () => GATE,
        providerIndex: () => [],
        devFeaturesEnabled: () => true,
        getRecents: () => recents,
    });
}

describe('CommandPaletteController', () => {
    it('empty query lists every page and no settings/providers', () => {
        const controller = makeController();
        expect(controller.flat.length).toBe(NAV_PAGE_COUNT);
        expect(controller.flat.every((item) => item.kind === 'page')).toBe(true);
        expect(controller.results.settings).toEqual([]);
        expect(controller.results.providers).toEqual([]);
    });

    it('filters to matching pages by query', () => {
        const controller = makeController();
        controller.query = 'audit log';
        expect(controller.flat[0].href).toBe('/admin/system/audit-log');
    });

    it('moveSelection clamps at both ends of the flat list', () => {
        const controller = makeController();
        expect(controller.selectedIndex).toBe(0);
        controller.moveSelection(-1);
        expect(controller.selectedIndex).toBe(0);
        controller.moveSelection(1);
        expect(controller.selectedIndex).toBe(1);
        controller.moveSelection(10_000);
        expect(controller.selectedIndex).toBe(controller.flat.length - 1);
    });

    it('clampSelection pulls a stale index back inside a shrunken list', () => {
        const controller = makeController();
        controller.query = 'audit log';
        controller.selectedIndex = 10_000; // stale: past the end of the new list
        controller.clampSelection();
        expect(controller.selectedIndex).toBe(controller.flat.length - 1);
    });

    it('itemAt defaults to the current selection', () => {
        const controller = makeController();
        controller.selectedIndex = 1;
        expect(controller.itemAt()).toEqual(controller.flat[1]);
        expect(controller.itemAt(0)?.href).toBe('/admin');
    });

    it('reset clears the query and selection', () => {
        const controller = makeController();
        controller.query = 'cost';
        controller.selectedIndex = 3;
        controller.reset();
        expect(controller.query).toBe('');
        expect(controller.selectedIndex).toBe(0);
    });

    it('empty query prepends recents before pages, and shifts the offsets', () => {
        const recents: RecentEntry[] = [
            { kind: 'page', href: '/admin/system/cost', label: 'Cost', timestamp: 1 },
        ];
        const controller = makeController(recents);
        expect(controller.flat[0].kind).toBe('recent');
        expect(controller.flat[1].kind).toBe('page');
        expect(controller.pagesOffset).toBe(1);
        expect(controller.settingsOffset).toBe(1 + NAV_PAGE_COUNT);
        expect(controller.providersOffset).toBe(1 + NAV_PAGE_COUNT);
    });

    it('non-empty query excludes recents entirely', () => {
        const recents: RecentEntry[] = [
            { kind: 'page', href: '/admin/system/cost', label: 'Cost', timestamp: 1 },
        ];
        const controller = makeController(recents);
        controller.query = 'audit log';
        expect(controller.recents).toEqual([]);
        expect(controller.flat.some((item) => item.kind === 'recent')).toBe(false);
    });

    // NOTE: this file runs under vitest.config.ts (node env, server-compiled Svelte —
    // no client-side $derived memoization), so this test alone cannot catch the
    // same-value-reassignment staleness bug it documents (it would pass identically
    // against buggy code, since the server runtime just re-evaluates on every read).
    // The real regression guard for that specific bug lives in
    // AdminCommandPalette.test.ts, which runs under vitest.config.components.ts
    // (happy-dom + real client reactivity) and reproduces the bug end-to-end.
    it('reset() re-reads recents even when query was already empty (reopen-without-typing case)', () => {
        // Reproduces a real bug found in manual QA: the controller is a long-lived
        // singleton (one instance per admin session, shared across every open/close
        // cycle). If `reset()`'s `query = ''` write is a no-op (query was already
        // empty — the common case of reopening without ever typing), a naive
        // `$derived` gated only on `query` never re-reads localStorage, so a
        // just-recorded activation doesn't show up in "Recent" on the very next open.
        let stored: RecentEntry[] = [];
        const controller = new CommandPaletteController({
            navSections: () => NAV,
            navGate: () => GATE,
            providerIndex: () => [],
            devFeaturesEnabled: () => true,
            getRecents: () => stored,
        });
        expect(controller.recents).toEqual([]);

        // Simulate an activation recording a new recent while the palette was closed —
        // `query` is untouched, still ''.
        stored = [{ kind: 'page', href: '/admin/system/cost', label: 'Cost', timestamp: 1 }];
        controller.reset(); // simulates reopening the palette without typing anything
        expect(controller.recents).toEqual(stored);
    });

    it('typing moves the selection back to the top result', () => {
        const controller = makeController();
        controller.moveSelection(1);
        expect(controller.selectedIndex).toBe(1);
        controller.query = 'c';
        expect(controller.selectedIndex).toBe(0);
        controller.moveSelection(1);
        controller.query = 'c'; // same value: not a change, selection stays
        expect(controller.selectedIndex).toBe(1);
    });

    it('a tab result links to its tab and is recorded as a page recent with its full href', () => {
        const controller = makeController();
        controller.query = 'cluster';
        const first = controller.itemAt(0);
        expect(first?.href).toBe('/admin/system/health?tab=cluster');
        expect(first && toRecentEntry(first)).toMatchObject({
            kind: 'page',
            href: '/admin/system/health?tab=cluster',
            label: expect.stringContaining(' › '),
        });
    });
});
