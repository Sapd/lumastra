// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * hasRequestsAdmin(): decided on the PRINCIPAL only (spec
 * 2026-10-07-auth-route-policy-design §5.1). An admin owner's device token has
 * `locals.user.ownerIsAdmin === true` but a non-admin principal, and must not count.
 */

import { describe, it, expect } from 'vitest';
import {
    adminOwnersDeviceToken,
    adminOwnersReadWritePat,
    adminSession,
    adminScopedPat,
    adminUserWithoutPrincipal,
    principalLocals,
} from '$lib/server/api/principal-locals.test-helpers.js';
import { hasRequestsAdmin } from './requests-admin.js';

describe('hasRequestsAdmin', () => {
    it('is false for an admin owner’s device token', () => {
        const l = adminOwnersDeviceToken();
        expect(l.user?.ownerIsAdmin).toBe(true);
        expect(hasRequestsAdmin(l)).toBe(false);
    });

    it('is false for an admin owner’s read/write PAT', () => {
        expect(hasRequestsAdmin(adminOwnersReadWritePat())).toBe(false);
    });

    it('is false without a principal, even if locals.user.ownerIsAdmin is true', () => {
        const l = adminUserWithoutPrincipal();
        expect(l.user?.ownerIsAdmin).toBe(true);
        expect(hasRequestsAdmin(l)).toBe(false);
    });

    it('is true for an admin session', () => {
        expect(hasRequestsAdmin(adminSession())).toBe(true);
    });

    it('is true for an admin-scoped PAT', () => {
        expect(hasRequestsAdmin(adminScopedPat())).toBe(true);
    });

    it('is true for an admin owner’s PAT scoped to requests:admin only (principal not admin)', () => {
        const l = principalLocals({
            kind: 'pat',
            ownerIsAdmin: true,
            tokenScopes: ['read', 'requests:admin'],
        });
        expect(l.principal?.isAdmin).toBe(false);
        expect(hasRequestsAdmin(l)).toBe(true);
    });

    it('is false for a non-admin owner’s PAT carrying requests:admin (buildPrincipal strips it)', () => {
        const l = principalLocals({
            kind: 'pat',
            ownerIsAdmin: false,
            tokenScopes: ['read', 'requests:admin'],
        });
        expect(hasRequestsAdmin(l)).toBe(false);
    });
});
