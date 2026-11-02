// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

let mockPageUrl = new URL('http://localhost/settings/account');

vi.mock('$app/stores', () => ({
    page: {
        subscribe: (run: (v: unknown) => void) => {
            return readable({ url: mockPageUrl }).subscribe(run);
        },
    },
    // Read by the NavigationProgressBar rendered inside the settings shell.
    navigating: readable(null),
}));

vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    afterNavigate: vi.fn(),
}));

vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }));

vi.mock('$lib/stores/modal.store', () => ({
    hasModals: readable(false),
}));

const navigateToSpy = vi.hoisted(() => vi.fn());
vi.mock('$lib/paths', () => ({
    resolve: (p: string) => p,
    navigateTo: navigateToSpy,
}));

import SettingsLayout from './+layout.svelte';

const data = {
    settingsCtx: {
        features: {},
        authMethod: 'session',
        hasWidgets: true,
        malConfigured: true,
    },
    enabledSectionIds: ['account', 'sessions', 'display', 'playback', 'subtitles', 'about'],
};

describe('settings overlay shell', () => {
    afterEach(() => {
        cleanup();
        mockPageUrl = new URL('http://localhost/settings/account');
    });

    test('renders a labelled modal dialog', () => {
        render(SettingsLayout, { data, children: undefined });
        const dialog = screen.getByRole('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('settings-dialog-heading');
    });

    test('sidebar lists only the enabled sections', () => {
        render(SettingsLayout, { data, children: undefined });
        const nav = screen.getByRole('navigation', { name: 'Settings' });
        expect(nav.querySelectorAll('a').length).toBe(data.enabledSectionIds.length);
        expect(screen.getByRole('link', { name: /Account/ })).toBeTruthy();
        expect(screen.queryByRole('link', { name: /Connections/ })).toBeNull();
    });

    test('typing in search shows synonym-matched results with a section badge', async () => {
        render(SettingsLayout, { data, children: undefined });
        const input = screen.getByLabelText('Search settings');
        await fireEvent.input(input, { target: { value: 'captions' } });
        expect(screen.getByText('Default subtitle language')).toBeTruthy();
        expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    });

    test('search with no matches shows an empty state', async () => {
        render(SettingsLayout, { data, children: undefined });
        const input = screen.getByLabelText('Search settings');
        await fireEvent.input(input, { target: { value: 'zzzznotathing' } });
        expect(screen.getByText(/No settings match/)).toBeTruthy();
    });

    test('clear search returns focus to the input', async () => {
        render(SettingsLayout, { data, children: undefined });
        const input = screen.getByLabelText('Search settings') as HTMLInputElement;
        await fireEvent.input(input, { target: { value: 'captions' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Clear settings search' }));
        expect(input.value).toBe('');
        expect(document.activeElement).toBe(input);
    });

    test('choosing a sidebar section clears search results', async () => {
        render(SettingsLayout, { data, children: undefined });
        const input = screen.getByLabelText('Search settings') as HTMLInputElement;
        await fireEvent.input(input, { target: { value: 'captions' } });
        await fireEvent.click(screen.getByRole('link', { name: 'Account' }));
        expect(input.value).toBe('');
    });

    test('a connect deep-link result links to its query param', async () => {
        const withConnections = {
            ...data,
            enabledSectionIds: [...data.enabledSectionIds, 'connections'],
        };
        render(SettingsLayout, { data: withConnections, children: undefined });
        const input = screen.getByLabelText('Search settings');
        await fireEvent.input(input, { target: { value: 'jellyfin' } });
        const link = screen.getByRole('link', { name: /Set up a Jellyfin app/ });
        expect(link.getAttribute('href')).toBe('/settings/connections?connect=jellyfin');
    });
});

describe('settings overlay shell — mobile drill-down (<1024px)', () => {
    afterEach(() => {
        cleanup();
        mockPageUrl = new URL('http://localhost/settings/account');
        vi.unstubAllGlobals();
    });

    function stubMobile(): void {
        // Stub matchMedia to report a narrow (non-desktop) viewport.
        vi.stubGlobal('matchMedia', () => ({
            matches: false,
            addEventListener() {},
            removeEventListener() {},
        }));
    }

    test('mobile root (/settings) renders a "Settings sections" nav list with one link per enabled section', () => {
        stubMobile();
        mockPageUrl = new URL('http://localhost/settings');
        render(SettingsLayout, { data, children: undefined });
        const nav = screen.getByRole('navigation', { name: 'Settings sections' });
        // One link per enabled section.
        expect(nav.querySelectorAll('a').length).toBe(data.enabledSectionIds.length);
    });

    test('mobile section view shows a "Back to settings list" link', () => {
        stubMobile();
        mockPageUrl = new URL('http://localhost/settings/account');
        render(SettingsLayout, { data, children: undefined });
        const back = screen.getByRole('link', { name: 'Back to settings list' });
        expect(back).toBeTruthy();
        expect(back.getAttribute('href')).toBe('/settings');
    });

    test('mobile section view does NOT show "Back" link when a search query is active', async () => {
        stubMobile();
        mockPageUrl = new URL('http://localhost/settings/account');
        render(SettingsLayout, { data, children: undefined });
        const input = screen.getByLabelText('Search settings');
        await fireEvent.input(input, { target: { value: 'display' } });
        expect(screen.queryByRole('link', { name: 'Back to settings list' })).toBeNull();
    });
});

describe('settings overlay shell — Escape arbitration', () => {
    afterEach(() => {
        cleanup();
        navigateToSpy.mockClear();
        document.body.querySelectorAll('.modal-overlay, dialog').forEach((n) => n.remove());
    });

    test('Escape closes the overlay when no in-settings dialog is open', async () => {
        render(SettingsLayout, { data, children: undefined });
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(navigateToSpy).toHaveBeenCalled();
    });

    test('Escape clears active search before closing settings', async () => {
        render(SettingsLayout, { data, children: undefined });
        const input = screen.getByLabelText('Search settings') as HTMLInputElement;
        await fireEvent.input(input, { target: { value: 'captions' } });
        await fireEvent.keyDown(input, { key: 'Escape' });
        expect(input.value).toBe('');
        expect(navigateToSpy).not.toHaveBeenCalled();
        await fireEvent.keyDown(input, { key: 'Escape' });
        expect(navigateToSpy).toHaveBeenCalledTimes(1);
    });

    test('Escape is deferred while a body-portalled .modal-overlay dialog is open', async () => {
        render(SettingsLayout, { data, children: undefined });
        const dialog = document.createElement('div');
        dialog.className = 'modal-overlay';
        document.body.appendChild(dialog);
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(navigateToSpy).not.toHaveBeenCalled();
    });

    test('Escape leaves settings and search intact while a native dialog is open', async () => {
        render(SettingsLayout, { data, children: undefined });
        const input = screen.getByLabelText('Search settings') as HTMLInputElement;
        await fireEvent.input(input, { target: { value: 'captions' } });
        const dialog = document.createElement('dialog');
        dialog.setAttribute('open', '');
        document.body.appendChild(dialog);
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(navigateToSpy).not.toHaveBeenCalled();
        expect(input.value).toBe('captions');
    });
});
