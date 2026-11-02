// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { writable } from 'svelte/store';

const pageStore = vi.hoisted(() => ({ authMethod: 'session' as string }));

vi.mock('$app/stores', () => ({
    page: writable({
        get data() {
            return {
                user: { username: 'alice' },
                authMethod: pageStore.authMethod,
                features: { avatarUpload: false },
            };
        },
        url: new URL('http://localhost/settings/account'),
    }),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/components/user-menu/user-menu-logout', () => ({
    resolveLogoutMode: () => 'session',
    performNativeSignOut: vi.fn(),
}));

import AccountSection from './AccountSection.svelte';

describe('AccountSection sign-in method', () => {
    afterEach(() => {
        cleanup();
        pageStore.authMethod = 'session';
    });

    test('an OIDC user sees the provider and NO password change', () => {
        render(AccountSection, {
            signIn: { method: 'oidc', providerName: 'Dex', hasPassword: false },
        });
        expect(screen.getByText('Signed in with Dex (single sign-on)')).toBeTruthy();
        expect(screen.queryByText(/username and password/)).toBeNull();
        expect(screen.queryByText('Change password')).toBeNull();
    });

    test('a built-in login user keeps the password wording and the change button', () => {
        render(AccountSection, {
            signIn: { method: 'password', providerName: null, hasPassword: true },
        });
        expect(screen.getByText('Signed in with your username and password')).toBeTruthy();
        expect(screen.getByText('Change password')).toBeTruthy();
    });

    test('a forward-auth user is told they sign in through the reverse proxy', () => {
        pageStore.authMethod = 'forward_auth';
        render(AccountSection, {
            signIn: { method: 'proxy', providerName: null, hasPassword: false },
        });
        expect(screen.getByText('Signed in through your reverse proxy')).toBeTruthy();
        expect(screen.queryByText('Change password')).toBeNull();
    });

    test('an OIDC user who ALSO has a local password may still change it', () => {
        render(AccountSection, {
            signIn: { method: 'oidc', providerName: 'Dex', hasPassword: true },
        });
        expect(screen.getByText('Change password')).toBeTruthy();
    });
});
