// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    validate: vi.fn(),
    update: vi.fn<
        (code: string, secret: string, original: string, updated: string) => Promise<boolean>
    >(async () => true),
    raw: JSON.stringify({ code: '123456', authenticated: false }),
    get: vi.fn(),
}));
vi.mock('$lib/server/cache/valkey', () => ({ cacheGet: h.get }));
vi.mock('./auth', () => ({ validateSession: h.validate }));
vi.mock('./quick-connect-store', () => ({ updateQuickConnectRequest: h.update }));
import { authorizeQuickConnectCode } from './quick-connect-authorize';
const approver = { userId: 'u1', username: 'alice', isAdmin: false, groups: [], displayName: null };
beforeEach(() => {
    vi.clearAllMocks();
    h.get.mockImplementation(async (key: string) => (key.includes(':code:') ? 'secret' : h.raw));
    h.validate.mockResolvedValue({ userId: 'u1' });
});
it('refuses an approver created by Quick Connect', async () => {
    h.validate.mockResolvedValue({ userId: 'u1', origin: 'quick_connect' });
    expect(await authorizeQuickConnectCode('123456', approver, 'session-token')).toBe('not_found');
    expect(h.update).not.toHaveBeenCalled();
});
it('records optional password-session lineage and still allows the web approver', async () => {
    expect(await authorizeQuickConnectCode('123456', approver, 'session-token')).toBe('ok');
    expect(JSON.parse(h.update.mock.calls[0][3])).toMatchObject({
        approvedBySessionToken: 'session-token',
    });
    h.update.mockClear();
    expect(await authorizeQuickConnectCode('123456', approver)).toBe('ok');
    expect(JSON.parse(h.update.mock.calls[0][3]).approvedBySessionToken).toBeUndefined();
});
