// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { denyUnlessAdmin } from './admin-action-gate.js';

describe('denyUnlessAdmin: the credential decides, not the owner flag', () => {
    it('admits an admin session', () => {
        expect(
            denyUnlessAdmin({
                user: { username: 'a', ownerIsAdmin: true },
                principal: { username: 'a', kind: 'session', isAdmin: true },
            }),
        ).toBeNull();
    });

    it("refuses an admin owner's non-admin token", () => {
        const denied = denyUnlessAdmin({
            user: { username: 'a', ownerIsAdmin: true },
            principal: { username: 'a', kind: 'pat', isAdmin: false },
        });
        expect(denied?.status).toBe(403);
    });

    it('refuses a plain user and no identity', () => {
        expect(denyUnlessAdmin({ user: { username: 'u', ownerIsAdmin: false } })?.status).toBe(403);
        expect(denyUnlessAdmin(undefined)?.status).toBe(403);
    });
});
