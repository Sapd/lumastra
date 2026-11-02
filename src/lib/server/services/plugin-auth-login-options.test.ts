// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the pre-auth login page is allowed to show.
 *
 * The login page is rendered to anonymous visitors, so this list doubles as a
 * disclosure surface: anything it names tells the internet which auth plugins
 * this deployment runs. It must therefore be derived from the operator's
 * allowlist and nothing else — never from what happens to be installed.
 */

import { it, expect, vi, beforeEach } from 'vitest';

let enabled: string[] = [];
vi.mock('$lib/server/config.js', () => ({
    config: {
        get AUTH_PLUGIN_PROVIDERS() {
            return enabled;
        },
    },
}));

let registered: Array<{ id: string; name: string; kind: string }> = [];
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getAllAuthProviders: () =>
            registered.map((p) => ({
                id: p.id,
                name: p.name,
                ...(p.kind === 'credentials'
                    ? { verifyCredentials: () => {} }
                    : p.kind === 'half-redirect'
                      ? { beginLogin: () => {} }
                      : { beginLogin: () => {}, completeLogin: () => {} }),
            })),
    },
}));

import { listLoginProviders } from './plugin-auth-login-options.js';

beforeEach(() => {
    enabled = [];
    registered = [];
});

it('shows nothing when the operator has allowlisted nothing, however much is installed', () => {
    registered = [{ id: 'acme-ldap', name: 'Acme LDAP', kind: 'credentials' }];
    expect(listLoginProviders()).toEqual([]);
});

it('shows an allowlisted credentials provider', () => {
    registered = [{ id: 'acme-ldap', name: 'Acme LDAP', kind: 'credentials' }];
    enabled = ['acme-ldap'];
    expect(listLoginProviders()).toEqual([
        { id: 'acme-ldap', name: 'Acme LDAP', kind: 'credentials' },
    ]);
});

it('hides an allowlisted provider that is not actually loaded', () => {
    enabled = ['acme-ldap'];
    expect(listLoginProviders()).toEqual([]);
});

it('shows an allowlisted redirect provider, distinguished by kind', () => {
    registered = [{ id: 'discord-login', name: 'Discord', kind: 'redirect' }];
    enabled = ['discord-login'];
    expect(listLoginProviders()).toEqual([
        { id: 'discord-login', name: 'Discord', kind: 'redirect' },
    ]);
});

it('hides a redirect provider missing HALF its flow — that button would dead-end', () => {
    // The SDK validator refuses this at definition time, but a provider is
    // third-party code reaching the registry through several paths, and the
    // login page is the wrong place to find out.
    registered = [{ id: 'discord-login', name: 'Discord', kind: 'half-redirect' }];
    enabled = ['discord-login'];
    expect(listLoginProviders()).toEqual([]);
});

it('falls back to the id when a provider declares no display name', () => {
    registered = [{ id: 'acme-ldap', name: '', kind: 'credentials' }];
    enabled = ['acme-ldap'];
    expect(listLoginProviders()[0].name).toBe('acme-ldap');
});

it('preserves the operator ALLOWLIST order, not load order', () => {
    registered = [
        { id: 'b-corp', name: 'B', kind: 'credentials' },
        { id: 'a-corp', name: 'A', kind: 'credentials' },
    ];
    enabled = ['a-corp', 'b-corp'];
    expect(listLoginProviders().map((p) => p.id)).toEqual(['a-corp', 'b-corp']);
});
