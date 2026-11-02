// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

import AdminCommandPalette from './AdminCommandPalette.svelte';

const GATE: NavGateContext = {
    devToolsEnabled: false,
    features: {},
    trainingAssignments: false,
    assessment: false,
    showcase: false,
};
const NAV: AdminNavSection[] = visibleNav(GATE);

afterEach(() => {
    cleanup();
    gotoMock.mockClear();
    getRecentsMock.mockClear();
    recordRecentMock.mockClear();
});

describe('AdminCommandPalette', () => {
    it('renders nothing when closed', () => {
        render(AdminCommandPalette, { open: false, navSections: NAV, navGate: GATE });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('renders the dialog and every page when open with an empty query', () => {
        render(AdminCommandPalette, { open: true, navSections: NAV, navGate: GATE });
        expect(screen.getByRole('dialog')).toBeTruthy();
        expect(screen.getByText('Audit log')).toBeTruthy();
        expect(screen.getByText('Cost & usage')).toBeTruthy();
    });

    it('typing filters the page list', async () => {
        render(AdminCommandPalette, { open: true, navSections: NAV, navGate: GATE });
        const input = screen.getByPlaceholderText('Search pages, settings, providers…');
        await fireEvent.input(input, { target: { value: 'cost' } });
        expect(screen.queryByText('Audit log')).toBeNull();
        expect(screen.getByText('Cost & usage')).toBeTruthy();
    });

    it('Escape closes the dialog', async () => {
        render(AdminCommandPalette, { open: true, navSections: NAV, navGate: GATE });
        const input = screen.getByPlaceholderText('Search pages, settings, providers…');
        await fireEvent.keyDown(input, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('Enter navigates to the selected page and closes', async () => {
        render(AdminCommandPalette, { open: true, navSections: NAV, navGate: GATE });
        const input = screen.getByPlaceholderText('Search pages, settings, providers…');
        await fireEvent.input(input, { target: { value: 'cost' } });
        await fireEvent.keyDown(input, { key: 'Enter' });
        expect(gotoMock).toHaveBeenCalledWith('/admin/system/cost');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('activating a result records it as a recent', async () => {
        render(AdminCommandPalette, { open: true, navSections: NAV, navGate: GATE });
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

    it('reopening without typing reflects a recent recorded during the previous open (no stale render)', async () => {
        // Reproduces the real bug found in manual QA: AdminCommandPalette mounts once
        // (in +layout.svelte) and toggles `open` — the underlying CommandPaletteController
        // is a long-lived singleton across every open/close cycle. If the query was never
        // typed into (stays '' the whole time), reopening must still show a just-recorded
        // recent, not a stale cached value.
        //
        // Critically, `query` must stay '' for the ENTIRE open→activate→close→reopen
        // cycle — never typing anything at all — because `reset()`'s `query = ''` write
        // is only a genuine no-op (the exact precondition for the bug) when `query` was
        // already ''. Typing a query first (even one later cleared by activation) would
        // make the pre-reopen `query` non-empty, so `reset()`'s write becomes a real
        // '<query>' -> '' change, which correctly invalidates even the buggy $derived —
        // masking the bug instead of reproducing it.
        let stored: unknown[] = [];
        getRecentsMock.mockImplementation(() => stored);
        recordRecentMock.mockImplementation((entry: unknown) => {
            stored = [entry, ...stored];
        });

        const { rerender } = render(AdminCommandPalette, {
            open: true,
            navSections: NAV,
            navGate: GATE,
        });
        const input = screen.getByPlaceholderText('Search pages, settings, providers…');
        // Activate the first page via the default selection, WITHOUT ever typing into
        // the query — activates "Home" (flat[0] with an empty query), records
        // it, and closes.
        await fireEvent.keyDown(input, { key: 'Enter' });
        expect(recordRecentMock).toHaveBeenCalledWith(
            expect.objectContaining({ href: '/admin', label: 'Home' }),
        );

        // Reopen WITHOUT ever changing the query away from '' in between opens — same
        // component instance the whole time (rerender, not a fresh render/mount), exactly
        // matching how the real app never unmounts AdminCommandPalette.
        await rerender({ open: true, navSections: NAV, navGate: GATE });

        expect(screen.getByRole('dialog')).toBeTruthy();
        expect(screen.getByText('Recent')).toBeTruthy();
        expect(screen.getByRole('dialog').textContent).toContain('Home');
    });
});
