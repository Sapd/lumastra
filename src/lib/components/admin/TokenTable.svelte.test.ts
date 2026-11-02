// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The service-token list shows each token's scope (its ceiling) and no longer
 * labels a non-impersonating token "Admin" — it acts as its creator with the
 * token's own scope (admin/users review 2026-10-07, item 8a). Headers and
 * empty states are localized.
 */

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TokenTable from './TokenTable.svelte';
import * as m from '$lib/paraglide/messages.js';

afterEach(() => {
    cleanup();
});

const author = (displayName: string) => ({
    userId: '11111111-1111-4111-8111-111111111111',
    displayName,
    images: { primary: { href: '/avatar', revision: '0', source: 'self' as const } },
});

const tokenDefaults = {
    description: null,
    createdAt: '2026-10-01T00:00:00Z',
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    isExpired: false,
};
const serviceDefaults = {
    ...tokenDefaults,
    actAsUserId: null,
    allowedIps: [],
    allowedPathPrefixes: [],
    allowedMethods: [],
    forceNonAdmin: false,
    createdVia: null,
};

const base = {
    loading: false,
    onRevoke: vi.fn(),
    formatRelativeDate: () => 'just now',
};

describe('TokenTable (service)', () => {
    it('shows the scope column and the creator label for a non-impersonating token', () => {
        render(TokenTable, {
            ...base,
            type: 'service',
            tokens: [
                {
                    ...serviceDefaults,
                    id: 1,
                    name: 'uptime-kuma',
                    tokenPrefix: 'svc_abcdefgh',
                    scopes: ['read'],
                    actAs: null,
                    owner: author('testuser'),
                },
                {
                    ...serviceDefaults,
                    id: 2,
                    name: 'grafana',
                    tokenPrefix: 'svc_ijklmnop',
                    scopes: ['admin'],
                    actAs: author('metrics-bot'),
                    owner: author('testuser'),
                },
            ],
        });

        expect(
            screen.getByRole('columnheader', { name: m.route_admin_api_tokens_col_scopes() }),
        ).toBeTruthy();
        expect(screen.getByText('read')).toBeTruthy();
        expect(screen.getByText('admin')).toBeTruthy();
        expect(screen.getByText(m.route_admin_api_tokens_act_as_creator())).toBeTruthy();
        expect(screen.getByText('metrics-bot')).toBeTruthy();
        expect(screen.queryByText('Admin')).toBeNull();
    });

    it('localizes the empty state', () => {
        render(TokenTable, { ...base, type: 'service', tokens: [] });
        expect(screen.getByText(m.route_admin_api_tokens_empty_service())).toBeTruthy();
    });
});

describe('TokenTable (pat)', () => {
    it('renders localized headers', () => {
        render(TokenTable, {
            ...base,
            type: 'pat',
            tokens: [
                {
                    ...tokenDefaults,
                    allowedIps: null,
                    id: 3,
                    name: 'cli',
                    tokenPrefix: 'pat_abcdefgh',
                    scopes: ['read'],
                    owner: author('bob'),
                },
            ],
        });
        for (const header of [
            m.route_admin_api_tokens_col_user(),
            m.route_admin_api_tokens_col_name(),
            m.route_admin_api_tokens_col_expires(),
            m.route_admin_api_tokens_col_actions(),
        ]) {
            expect(screen.getByRole('columnheader', { name: header })).toBeTruthy();
        }
        expect(
            screen.getByRole('button', { name: m.route_admin_api_tokens_revoke_title() }),
        ).toBeTruthy();
    });
});
