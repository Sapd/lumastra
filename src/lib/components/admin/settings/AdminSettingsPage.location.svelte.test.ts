// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { Cog6Tooth } from 'svelte-hero-icons';
import type { SubmitFunction } from '@sveltejs/kit';
import type { BeforeNavigate } from '@sveltejs/kit';
import type { SectionDefinition, SettingDefinition } from '$lib/config/schema';
import { page } from '$app/state';
import AdminSettingsPage from './AdminSettingsPage.svelte';
import { showAdvancedSettings } from '$lib/stores/admin-show-advanced.store';

type AnimationCallback = (time: number) => void;

const fixture = vi.hoisted(() => ({
    sections: [
        {
            id: 'general',
            label: 'General category',
            description: 'General controls',
            order: 1,
            featureFlag: 'HEADER_ENABLED',
        },
        { id: 'playback', label: 'Playback category', description: 'Playback controls', order: 2 },
    ] satisfies SectionDefinition[],
    settings: [
        {
            key: 'SITE_NAME',
            type: 'string',
            label: 'Site name',
            description: 'Display name',
            defaultValue: 'My Media',
            section: 'general',
        },
        {
            key: 'PLAYER_NAME',
            type: 'string',
            label: 'Player name',
            description: 'Player label',
            defaultValue: 'Default player',
            section: 'playback',
            uiHints: { advanced: true },
        },
    ] satisfies SettingDefinition[],
    beforeNavigate: undefined as ((navigation: BeforeNavigate) => void) | undefined,
    goto: vi.fn(),
    enhanceCallbacks: new Map<string, SubmitFunction>(),
}));

vi.mock('$app/state', async () => {
    const { SvelteURL } = await import('svelte/reactivity');
    const { writable, fromStore } = await import('svelte/store');
    const state = fromStore(writable<App.PageState>({}));
    return {
        page: {
            url: new SvelteURL('http://localhost/admin/settings/general'),
            get state() {
                return state.current;
            },
            set state(value: App.PageState) {
                state.current = value;
            },
        },
    };
});
vi.mock('$app/navigation', async () => {
    const { page } = await import('$app/state');
    return {
        beforeNavigate: (callback: (navigation: BeforeNavigate) => void): void => {
            fixture.beforeNavigate = callback;
        },
        afterNavigate: vi.fn(),
        goto: fixture.goto,
        pushState: (_url: URL, state: App.PageState): void => {
            page.state = state;
        },
        replaceState: (_url: URL, state: App.PageState): void => {
            page.state = state;
        },
    };
});
vi.mock('$app/forms', () => ({
    enhance: (form: HTMLFormElement, callback: SubmitFunction): object => {
        fixture.enhanceCallbacks.set(form.getAttribute('action') ?? '', callback);
        return { destroy(): void {} };
    },
}));
vi.mock('$lib/paths', () => ({ resolve: (path: string): string => path }));
vi.mock('$lib/config/schema', () => ({
    configSchema: fixture.settings,
    configSections: fixture.sections,
    getSettingsBySection: (id: string): SettingDefinition[] =>
        fixture.settings.filter((s) => s.section === id),
    getVisibleSettingsBySection: (
        id: string,
        flags: { showAdvanced: boolean },
    ): SettingDefinition[] =>
        fixture.settings.filter(
            (s) => s.section === id && (flags.showAdvanced || !s.uiHints?.advanced),
        ),
    isSettingVisible: (): boolean => true,
    isSettingEnabled: (): boolean => true,
}));
// Use actual section/input/save/dialog components, without importing the whole admin barrel.
vi.mock('$lib/components/admin', async () => ({
    SettingSection: (await import('../SettingSection.svelte')).default,
    StickySaveBar: (await import('./StickySaveBar.svelte')).default,
    SearchInput: (await import('./SearchInput.svelte')).default,
    ActionModal: (await import('../ActionModal.svelte')).default,
}));
vi.mock('../inputs/registry', async () => {
    const { default: TextInput } = await import('../inputs/TextInput.svelte');
    return { getInputComponentForSetting: (): typeof TextInput => TextInput };
});
vi.mock('$lib/api/admin', () => ({ checkProviderHealth: vi.fn() }));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('$lib/stores/admin-show-advanced.store', async () => {
    const { writable } = await import('svelte/store');
    return { showAdvancedSettings: writable(false) };
});
// Read the source catalog so these tests don't require regenerating shared translations.
vi.mock('$lib/paraglide/messages.js', async () => {
    const { default: messages } = await import('../../../../../messages/en.json');
    return Object.fromEntries(
        Object.entries(messages).map(([key, value]) => [
            key,
            (args: Record<string, string | number> = {}): string =>
                String(value).replace(/\{(\w+)\}/g, (_, name: string) =>
                    String(args[name] ?? `{${name}}`),
                ),
        ]),
    );
});

function mountPage(
    storageStatus: { willPersist: boolean; message?: string } | null = null,
): ReturnType<typeof render> {
    return render(AdminSettingsPage, {
        data: {
            values: { SITE_NAME: 'My Media', PLAYER_NAME: 'Default player', HEADER_ENABLED: true },
            envOverrides: [],
            schema: { sections: fixture.sections, settings: fixture.settings },
            configPath: '/config/settings.json',
            storageStatus,
        },
        form: null,
        icon: Cog6Tooth,
        heading: 'Settings',
        description: 'Configure My Media',
    });
}

const scroll = vi.fn();
beforeEach(() => {
    page.url.href = 'http://localhost/admin/settings/general';
    page.state = {};
    showAdvancedSettings.set(false);
    vi.stubGlobal('requestAnimationFrame', (callback: AnimationCallback): number => {
        callback(0);
        return 1;
    });
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: true }),
    });
    HTMLElement.prototype.scrollIntoView = scroll;
    scroll.mockClear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it('uses the real scroll helper to reveal advanced exact targets and retains their shareable URL', async () => {
    page.url.search = '?section=playback&highlight=PLAYER_NAME';
    mountPage();
    await waitFor(() =>
        expect(
            document.getElementById('setting-PLAYER_NAME')?.classList.contains('search-highlight'),
        ).toBe(true),
    );
    expect(screen.getByLabelText(/Player name/)).toBeTruthy();
    expect(page.url.searchParams.get('highlight')).toBe('PLAYER_NAME');
    expect(scroll).toHaveBeenCalled();
    expect(screen.queryByText(/requested setting is unavailable/)).toBeNull();
});

it('flashes section-only and header-toggle targets without unavailable feedback', async () => {
    page.url.search = '?section=general';
    mountPage();
    await waitFor(() =>
        expect(
            document.getElementById('section-general')?.classList.contains('search-highlight'),
        ).toBe(true),
    );
    page.state = {
        adminWorkspaceUrl:
            'http://localhost/admin/settings/general?section=general&highlight=HEADER_ENABLED',
    };
    await waitFor(() =>
        expect(
            document
                .getElementById('setting-HEADER_ENABLED')
                ?.classList.contains('search-highlight'),
        ).toBe(true),
    );
    expect(screen.queryByText(/requested setting is unavailable/)).toBeNull();
});

it('reports a genuinely absent exact target and clears that report after Back', async () => {
    page.url.search = '?section=general&highlight=MISSING';
    mountPage();
    await screen.findByText(/requested setting is unavailable/);
    page.state = { adminWorkspaceUrl: 'http://localhost/admin/settings/general?section=general' };
    await waitFor(() => expect(screen.queryByText(/requested setting is unavailable/)).toBeNull());
});

it('reselects the same result and clears active search on restored category history while preserving drafts', async () => {
    page.url.search = '?section=general&category=general&highlight=SITE_NAME';
    mountPage();
    await waitFor(() =>
        expect(
            document.getElementById('setting-SITE_NAME')?.classList.contains('search-highlight'),
        ).toBe(true),
    );
    await fireEvent.input(screen.getByLabelText('Site name'), {
        target: { value: 'Draft survives history' },
    });
    const search = document.querySelector<HTMLInputElement>('input[placeholder]');
    if (!search) throw new Error('Missing settings search');
    await fireEvent.input(search, { target: { value: 'site name' } });
    const calls = scroll.mock.calls.length;
    await fireEvent.click(screen.getByRole('button', { name: /Site name General category/ }));
    await waitFor(() => expect(scroll.mock.calls.length).toBeGreaterThan(calls));
    await fireEvent.input(search, { target: { value: 'not matching the target' } });
    await waitFor(() => expect(screen.queryByText(/requested setting is unavailable/)).toBeNull());
    page.state = { adminWorkspaceUrl: 'http://localhost/admin/settings/general?category=general' };
    await tick();
    expect((search as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Site name') as HTMLInputElement).value).toBe(
        'Draft survives history',
    );
});

it('preserves scroll position for deliberate category selection while incoming section links still scroll', async () => {
    showAdvancedSettings.set(true);
    page.url.search = '?section=general';
    mountPage();
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    scroll.mockClear();
    await fireEvent.click(screen.getByRole('button', { name: /Playback category/ }));
    await tick();
    expect(screen.getByLabelText(/Player name/)).toBeTruthy();
    expect(scroll).not.toHaveBeenCalled();
    page.state = { adminWorkspaceUrl: 'http://localhost/admin/settings/general?section=general' };
    await waitFor(() => expect(scroll).toHaveBeenCalled());
});
