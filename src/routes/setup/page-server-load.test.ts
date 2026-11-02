// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /setup load without a database handle. Whether setup is complete is unknown
 * then, so the page must fail inert (redirect home) instead of treating the
 * install as admin-less and serving the wizard plus its proxy diagnostics
 * (peer address, gateway, ADMIN_GROUPS, OIDC issuer) to anyone. The lock-state
 * cases with a real database are in setup-locked-page.integration.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

const { mockAdminExists } = vi.hoisted(() => ({ mockAdminExists: vi.fn() }));

vi.mock('./setup-environment.js', () => ({
    buildSetupEnvironment: vi.fn(),
    buildSetupEnvironmentDetails: vi.fn(),
    setupProxyState: () => 'direct',
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => null },
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: (...a: unknown[]) => mockAdminExists(...a),
    adminExistsIgnoringSetupLock: vi.fn(),
}));

import { appPath } from '$lib/shared/api-urls.js';
import { load } from './+page.server.js';
import { buildSetupEnvironment } from './setup-environment.js';

describe('/setup load with no database handle', () => {
    it('redirects home and never consults the setup gate', async () => {
        const url = new URL('http://localhost/setup');
        const event = {
            request: new Request(url),
            url,
            locals: {},
            getClientAddress: () => '10.9.8.7',
            depends: () => undefined,
        } as never;

        let location: string | null = null;
        try {
            await load(event);
        } catch (e) {
            if (!isRedirect(e)) throw e;
            location = e.location;
        }

        expect(location).toBe(appPath('/'));
        expect(mockAdminExists).not.toHaveBeenCalled();
        // The install overview is part of the wizard: never built for a redirect.
        expect(buildSetupEnvironment).not.toHaveBeenCalled();
    });
});
