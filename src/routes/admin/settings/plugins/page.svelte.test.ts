// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'svelte';
import * as m from '$lib/paraglide/messages.js';

const { forceRefresh, invalidate, disable } = vi.hoisted(() => ({
    forceRefresh: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
    disable: vi.fn(async () => ({ data: { restartRequired: true }, error: null })),
}));
vi.mock('$lib/stores/admin-status.store.svelte.js', () => ({ adminStatus: { forceRefresh } }));
vi.mock('$lib/api/admin.js', async (orig) => ({
    ...(await orig<typeof import('$lib/api/admin.js')>()),
    disableExternalPlugin: disable,
}));
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({ url: new URL('http://localhost/admin/settings/plugins'), data: {} }),
    };
});
vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn(), invalidateAll: invalidate }));

import PluginsPage from './+page.svelte';

afterEach(cleanup);

function props(
    pending: boolean,
    mode: 'disabled' | 'uninstalled' | 'enabled',
): ComponentProps<typeof PluginsPage> {
    return {
        data: {
            externalPluginsEnabled: true,
            featurePlugins: [],
            watchSyncPlugins: [],
            integrationProviders: [],
            repositories: [],
            catalog: [],
            checkableIds: [],
            externalPlugins: Array.from({ length: 9 }, (_, i) => ({
                id: `plugin-${i}`,
                name: `Plugin ${i}`,
                version: '1.0.0',
                source: 'registry',
                status: i === 0 && mode === 'uninstalled' ? 'uninstalled' : 'installed',
                enabled: i === 0 && mode === 'enabled',
                loaded: i === 0 && (mode === 'enabled' ? !pending : pending),
                restartRequired: pending && i === 0,
                isBundle: false,
                bundleInvalid: false,
            })),
        },
    } as unknown as ComponentProps<typeof PluginsPage>;
}

it.each(['disabled', 'uninstalled', 'enabled'] as const)(
    '%s: keeps the restart banner across search and remounts until runtime agreement',
    async (mode) => {
        const page = render(PluginsPage, props(true, mode));
        expect(screen.getByRole('alert').textContent).toMatch(/still running/i);
        expect(screen.getByRole('alert').textContent).toMatch(/restart/i);
        await fireEvent.input(
            screen.getByPlaceholderText(m.admin_plugins_page_search_placeholder()),
            { target: { value: 'no match' } },
        );
        expect(screen.getByRole('alert').textContent).toMatch(/still running/i);
        page.unmount();
        const reopened = render(PluginsPage, props(true, mode));
        expect(screen.getByRole('alert')).toBeTruthy();
        await reopened.rerender(props(false, mode));
        expect(screen.queryByRole('alert')).toBeNull();
    },
);

it('refreshes the attention bell immediately after disabling a plugin, without waiting for its poll', async () => {
    forceRefresh.mockClear();
    invalidate.mockClear();
    render(PluginsPage, props(false, 'enabled'));
    await fireEvent.click(
        screen.getByRole('button', { name: m.plugins_external_action_disable() }),
    );
    await waitFor(() => expect(disable).toHaveBeenCalledWith('plugin-0'));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(forceRefresh).toHaveBeenCalledOnce();
});
