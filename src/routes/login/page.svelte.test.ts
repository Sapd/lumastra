// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The login page's handling of auth-provider plugins.
 *
 * Two kinds render differently and must not be confused: a credentials
 * provider shares the built-in username/password form (only the endpoint
 * differs), while a redirect provider has nothing to type and gets a link.
 * Rendering a redirect provider inside the form's source picker would produce
 * a form that posts a password to an endpoint that does not accept one.
 */

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAll } from '$app/navigation';
import LoginPage from './+page.svelte';

vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({
            data: { branding: { appName: 'Lumastra' } },
            url: new URL('http://x/login'),
        }),
    };
});

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

vi.mock('$lib/api/client.js', () => ({ apiPost: vi.fn(async () => ({ error: null, data: {} })) }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn(), success: vi.fn() } }));
vi.mock('$lib/paths', () => ({ url: (p: string) => p }));

const base = {
    redirectTo: '/',
    nativeEnabled: true,
    oidcEnabled: false,
    oidcProviderName: 'SSO',
    pluginProviders: [],
};

const mount = (over: Record<string, unknown> = {}) =>
    render(LoginPage, { data: { ...base, ...over } } as never);

afterEach(cleanup);

describe('redirect providers', () => {
    it('render as a link to our OWN start endpoint, carrying returnTo', () => {
        mount({
            redirectTo: '/music',
            pluginProviders: [{ id: 'discord-login', name: 'Discord', kind: 'redirect' }],
        });
        const link = screen.getByText('Sign in with Discord').closest('a');
        expect(link?.getAttribute('href')).toBe(
            '/api/auth/plugin/discord-login/start?returnTo=%2Fmusic',
        );
    });

    it('do NOT appear in the credentials source picker', () => {
        mount({
            pluginProviders: [{ id: 'discord-login', name: 'Discord', kind: 'redirect' }],
        });
        // Native alone is one source, so there is no picker at all — and a
        // redirect provider must not be what makes one appear.
        expect(screen.queryByLabelText('Sign in with')).toBeNull();
    });

    it('are the only sign-in method on a plugin-only deployment, and still render', () => {
        mount({
            nativeEnabled: false,
            pluginProviders: [{ id: 'discord-login', name: 'Discord', kind: 'redirect' }],
        });
        expect(screen.getByText('Sign in with Discord')).toBeTruthy();
        expect(screen.queryByLabelText('Password')).toBeNull();
    });
});

describe('credentials providers', () => {
    it('preselect the built-in directory, matching where the form actually posts', () => {
        // With `bind:value` and an initial '', the select renders with
        // selectedIndex -1 — blank — while submit silently targets
        // credentialSources[0]. A visitor picks nothing, types LDAP
        // credentials, and they go to the native directory.
        mount({
            pluginProviders: [{ id: 'acme-ldap', name: 'Acme LDAP', kind: 'credentials' }],
        });
        const select = screen.getByLabelText('Sign in with') as HTMLSelectElement;
        expect(select.selectedIndex).toBe(0);
        expect(select.value).toBe('native');
    });

    it('preselect the plugin when it is the ONLY directory', () => {
        mount({
            nativeEnabled: false,
            pluginProviders: [
                { id: 'acme-ldap', name: 'Acme LDAP', kind: 'credentials' },
                { id: 'other-ldap', name: 'Other', kind: 'credentials' },
            ],
        });
        const select = screen.getByLabelText('Sign in with') as HTMLSelectElement;
        expect(select.value).toBe('acme-ldap');
    });

    it('DO appear in the source picker alongside the built-in directory', () => {
        mount({
            pluginProviders: [{ id: 'acme-ldap', name: 'Acme LDAP', kind: 'credentials' }],
        });
        expect(screen.getByLabelText('Sign in with')).toBeTruthy();
        expect(screen.getByText('Acme LDAP')).toBeTruthy();
    });

    it('render the password form even when native login is off', () => {
        mount({
            nativeEnabled: false,
            pluginProviders: [{ id: 'acme-ldap', name: 'Acme LDAP', kind: 'credentials' }],
        });
        expect(screen.getByLabelText('Password')).toBeTruthy();
    });
});

describe('both kinds at once', () => {
    it('separates the link from the form with a divider', () => {
        mount({
            pluginProviders: [
                { id: 'discord-login', name: 'Discord', kind: 'redirect' },
                { id: 'acme-ldap', name: 'Acme LDAP', kind: 'credentials' },
            ],
        });
        expect(screen.getByText('Sign in with Discord')).toBeTruthy();
        expect(screen.getByText('or')).toBeTruthy();
    });
});

describe('credentials form before hydration', () => {
    it('posts, so a submit before the JS loads never puts the password in the URL', () => {
        const { container } = mount();
        const form = container.querySelector('form.auth-form');
        expect(form).toBeTruthy();
        expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
    });
});

it('shows temporary unavailability without offering a broken sign-in form', () => {
    mount({ unavailable: true });
    expect(screen.getByRole('status').textContent).toContain('temporarily unavailable');
    expect(screen.queryByLabelText('Password')).toBeNull();
});

it('automatically rechecks the login page after temporary unavailability', async () => {
    vi.useFakeTimers();
    vi.mocked(invalidateAll).mockClear();
    try {
        const view = mount({ unavailable: true });
        await vi.advanceTimersByTimeAsync(5000);
        expect(invalidateAll).toHaveBeenCalledOnce();
        await view.rerender({ data: { ...base, unavailable: false } } as never);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(invalidateAll).toHaveBeenCalledOnce();
        expect(screen.queryByRole('status')).toBeNull();
        expect(screen.getByLabelText('Password')).toBeTruthy();
    } finally {
        cleanup();
        vi.useRealTimers();
    }
});
