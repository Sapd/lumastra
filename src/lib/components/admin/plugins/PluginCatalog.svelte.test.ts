// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The catalog UI's honesty properties.
 *
 * A catalog grants zero trust, and the failure mode this guards against is a
 * UI that quietly implies otherwise: an install button offered when this host
 * cannot verify signatures at all, or offered for a version that would be
 * refused. Those are the assertions here — what the page declines to offer.
 */

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PluginCatalog from './PluginCatalog.svelte';

vi.mock('$lib/api/admin.js', () => ({
    addPluginRepository: vi.fn(),
    removePluginRepository: vi.fn(),
    syncPluginRepositories: vi.fn(),
    installExternalPlugin: vi.fn(),
}));

vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: vi.fn(), success: vi.fn() },
}));

const entry = {
    name: 'acme',
    title: 'Acme Widgets',
    description: 'Does things',
    publisher: 'Acme',
    homepage: null,
    repositoryName: 'Official',
    version: '1.1.0',
    manifestUrl: 'https://x/m.json',
    signature: 'sig',
    security: false,
    advisoryKeyId: 'k1',
    installedVersion: null as string | null,
};

function mount(over: Partial<Parameters<typeof PluginCatalog>[1]> = {}) {
    return render(PluginCatalog, {
        repositories: [],
        catalog: [entry],
        installEnabled: true,
        trustedKeysConfigured: true,
        onchanged: () => {},
        ...over,
    } as never);
}

afterEach(cleanup);

describe('what it offers', () => {
    it('shows an advertised plugin with its repository named, so provenance is visible', () => {
        mount();
        expect(screen.getByText('Acme Widgets')).toBeTruthy();
        expect(screen.getByText(/Official/)).toBeTruthy();
    });

    it('offers an update, labelled with the target version', () => {
        mount({ catalog: [{ ...entry, installedVersion: '1.0.0' }] } as never);
        expect(screen.getByText(/Update to v1\.1\.0/)).toBeTruthy();
    });

    it('offers nothing for a version older than the installed one', () => {
        mount({ catalog: [{ ...entry, installedVersion: '2.0.0' }] } as never);
        expect(screen.getByText('Up to date')).toBeTruthy();
        expect(screen.queryByText(/Install/)).toBeNull();
    });

    it('says so plainly when nothing matches this host ABI', () => {
        mount({ catalog: [{ ...entry, version: null }] } as never);
        expect(screen.getByText(/Not compatible with this version/)).toBeTruthy();
    });
});

describe('what it withholds', () => {
    it('disables install when no trusted signing key is configured', () => {
        mount({ trustedKeysConfigured: false } as never);
        const button = screen.getByRole('button', { name: /Install/ });
        expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('disables install when the install gate is off', () => {
        mount({ installEnabled: false } as never);
        const button = screen.getByRole('button', { name: /Install/ });
        expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('states that a repository grants no trust — an operator must not read the catalog as a vetting step', () => {
        mount();
        expect(screen.getByText(/grants no trust/)).toBeTruthy();
    });
});

describe('repository list', () => {
    it("shows a repository's last error rather than presenting an empty catalog silently", () => {
        mount({
            repositories: [
                {
                    id: 'r1',
                    url: 'https://example.org/index.json',
                    name: 'Broken',
                    enabled: true,
                    lastSyncedAt: null,
                    lastError: 'connect ECONNREFUSED',
                    indexUpdatedAt: null,
                },
            ],
        } as never);
        expect(screen.getByText('connect ECONNREFUSED')).toBeTruthy();
    });
});
