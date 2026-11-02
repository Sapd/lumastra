// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ status: vi.fn(), transition: vi.fn(), add: vi.fn(), warn: vi.fn() }));
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', () => ({
    resolveOwnerAdminStatusById: h.status,
}));
vi.mock('$lib/server/services/credential-revocation.service.js', () => ({
    applyAdminStatusTransition: h.transition,
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: async () => ({ id: 'u1' }),
}));
vi.mock('$lib/server/database/queries/access-groups.queries.js', () => ({
    getAccessGroupById: async () => ({ id: 'g1' }),
    addAccessGroupMember: h.add,
}));
vi.mock('$lib/server/cache/user-access-cache.js', () => ({ invalidateUserAccessCache: vi.fn() }));
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => ({ warn: h.warn }) } }));
import { addMember } from './access-control.service.js';
import { AuthDependencyUnavailableError } from '$lib/server/auth/dependency-unavailable.js';
beforeEach(() => {
    vi.clearAllMocks();
    h.status.mockReset().mockResolvedValueOnce({ userId: 'u1', username: 'alice', isAdmin: true });
    h.transition.mockReset().mockResolvedValue({ failedStores: [] });
});
it('never throws after a write when the admin lookup fails, and only narrows credentials', async () => {
    h.status.mockRejectedValueOnce(new AuthDependencyUnavailableError());
    await expect(addMember({} as never, 'g1', 'u1', null)).resolves.toMatchObject({ ok: true });
    expect(h.add).toHaveBeenCalled();
    expect(h.transition).toHaveBeenCalledWith(expect.anything(), 'u1', 'alice', true, false);
    expect(h.warn).toHaveBeenCalled();
});
it('logs transition failures without throwing after the membership write', async () => {
    h.status.mockResolvedValueOnce({ userId: 'u1', username: 'alice', isAdmin: false });
    h.transition.mockRejectedValueOnce(new Error('failed credential store'));
    await expect(addMember({} as never, 'g1', 'u1', null)).resolves.toMatchObject({ ok: true });
    expect(h.warn).toHaveBeenCalled();
});

it('does not restore scopes when a previously non-admin user cannot be re-resolved', async () => {
    h.status
        .mockReset()
        .mockResolvedValueOnce({ userId: 'u1', username: 'alice', isAdmin: false })
        .mockRejectedValueOnce(new AuthDependencyUnavailableError());
    await expect(addMember({} as never, 'g1', 'u1', null)).resolves.toMatchObject({ ok: true });
    expect(h.transition).toHaveBeenCalledWith(expect.anything(), 'u1', 'alice', false, false);
});
