// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A user that claims admin without a principal means a credential builder
 * forgot its principal: logged once per auth method, never for real principals
 * or non-admin users.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const warn = vi.fn();
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

describe('localsIsAdmin: missing-principal warning', () => {
    beforeEach(() => {
        vi.resetModules();
        warn.mockReset();
    });

    it('warns once per auth method', async () => {
        const { localsIsAdmin } = await import('./locals-admin.js');
        localsIsAdmin({ user: { ownerIsAdmin: true }, authMethod: 'x' });
        localsIsAdmin({ user: { ownerIsAdmin: true }, authMethod: 'x' });
        expect(warn).toHaveBeenCalledTimes(1);
        localsIsAdmin({ user: { ownerIsAdmin: true }, authMethod: 'y' });
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenLastCalledWith(expect.any(String), { authMethod: 'y' });
    });

    it('stays quiet for non-admin users and for requests with a principal', async () => {
        const { localsIsAdmin } = await import('./locals-admin.js');
        localsIsAdmin({ user: { ownerIsAdmin: false }, authMethod: 'x' });
        localsIsAdmin({
            user: { ownerIsAdmin: true },
            principal: { isAdmin: false },
            authMethod: 'x',
        });
        expect(warn).not.toHaveBeenCalled();
    });
});
