// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * A drop-in plugin's card must not offer controls that cannot work.
 *
 * Enable, disable, reload and uninstall all resolve an `external_plugins` row
 * and 404 without one. A drop-in has no row, so every one of those buttons
 * would fail — the card has to say the plugin is managed on disk instead.
 */

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExternalPluginCard from './ExternalPluginCard.svelte';

vi.mock('$lib/api/admin.js', () => ({
    enableExternalPlugin: vi.fn(),
    disableExternalPlugin: vi.fn(),
    reloadExternalPlugin: vi.fn(),
    uninstallExternalPlugin: vi.fn(),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn(), success: vi.fn() } }));

const base = {
    id: 'shoutbox',
    name: 'shoutbox',
    version: '2.1.0',
    kind: 'feature',
    enabled: true,
    status: 'installed' as const,
    loaded: true,
    restartRequired: false,
    isBundle: false,
    bundleInvalid: false,
    installedAt: '',
    updatedAt: '',
};

const mount = (over: Record<string, unknown> = {}) =>
    render(ExternalPluginCard, { plugin: { ...base, ...over }, onchanged: () => {} } as never);

afterEach(cleanup);

describe('a drop-in', () => {
    it('is listed at all', () => {
        mount({ source: 'drop-in' });
        expect(screen.getByText('shoutbox')).toBeTruthy();
    });

    it('offers NO lifecycle buttons', () => {
        mount({ source: 'drop-in' });
        for (const label of [/disable/i, /enable/i, /reload/i, /uninstall/i]) {
            expect(screen.queryByRole('button', { name: label })).toBeNull();
        }
    });

    it('explains where it is managed instead', () => {
        mount({ source: 'drop-in' });
        expect(screen.getByText(/plugins folder/i)).toBeTruthy();
    });
});

describe('a registry-managed plugin is unaffected', () => {
    it('still offers its lifecycle buttons', () => {
        mount({ source: 'registry' });
        expect(screen.getByRole('button', { name: /disable/i })).toBeTruthy();
        expect(screen.getByRole('button', { name: /uninstall/i })).toBeTruthy();
    });

    it('treats an ABSENT source as registry-managed, for back-compat', () => {
        mount();
        expect(screen.getByRole('button', { name: /disable/i })).toBeTruthy();
    });
});
