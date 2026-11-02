// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { localsIsAdmin, localsIsAdminOrArrManager } from './locals-admin.js';

describe('localsIsAdmin', () => {
    it('the principal decides when there is one', () => {
        expect(localsIsAdmin({ user: { ownerIsAdmin: true }, principal: { isAdmin: true } })).toBe(
            true,
        );
        // Scoped token of an admin owner: owner flag true, credential not admin.
        expect(localsIsAdmin({ user: { ownerIsAdmin: true }, principal: { isAdmin: false } })).toBe(
            false,
        );
    });

    it('without a principal nothing is admin, whatever the user object claims', () => {
        expect(localsIsAdmin({ user: { ownerIsAdmin: true } })).toBe(false);
        expect(localsIsAdmin({ user: { ownerIsAdmin: true }, authMethod: 'x' })).toBe(false);
        expect(localsIsAdmin({ user: { ownerIsAdmin: false } })).toBe(false);
    });

    it('no identity is not admin', () => {
        expect(localsIsAdmin(undefined)).toBe(false);
        expect(localsIsAdmin({})).toBe(false);
    });
});

describe('localsIsAdminOrArrManager', () => {
    it('admin follows the credential; ARR manager follows groups', () => {
        // ARR_MANAGER_GROUPS defaults to "arrmanager,admin".
        expect(
            localsIsAdminOrArrManager({
                user: { ownerIsAdmin: true },
                principal: { isAdmin: true },
            }),
        ).toBe(true);
        expect(
            localsIsAdminOrArrManager({
                user: { ownerIsAdmin: true, userGroups: ['members'] },
                principal: { isAdmin: false },
            }),
        ).toBe(false);
        expect(
            localsIsAdminOrArrManager({
                user: { ownerIsAdmin: false, userGroups: ['ArrManager'] },
                principal: { isAdmin: false },
            }),
        ).toBe(true);
    });
});
