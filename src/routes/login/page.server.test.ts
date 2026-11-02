// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
const getSql = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/database.service.js', () => ({ aiDbService: { getSql } }));
vi.mock('$lib/server/config.js', () => ({
    config: { AUTH_NATIVE_LOGIN_ENABLED: true, AUTH_OIDC_LOGIN_AVAILABLE: false, ADMIN_GROUPS: [] },
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
}));
vi.mock('$lib/server/services/plugin-auth-login-options.js', () => ({
    listLoginProviders: () => [],
}));
import { load } from './+page.server';
describe('login during a database outage', () => {
    it('renders temporary unavailability instead of throwing a 500', async () => {
        getSql.mockRejectedValue(new Error('ECONNREFUSED'));
        const result = await load({
            locals: {},
            url: new URL('http://localhost/login'),
            setHeaders: vi.fn(),
        } as never);
        expect(result).toMatchObject({ unavailable: true, redirectTo: '/' });
    });
});
