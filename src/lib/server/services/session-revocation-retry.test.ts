// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
const revoke = vi.hoisted(() => vi.fn());
vi.mock('../database/connection.js', () => ({
    Database: class {
        getSql(): unknown {
            return {};
        }
    },
}));
vi.mock('../database/queries/user-sessions.queries.js', () => ({ revokeSession: revoke }));
import { SessionService } from './session.service.js';
beforeEach(() => {
    revoke.mockReset().mockResolvedValue(1);
});
it('a logout receipt revokes the same stored hash but cannot authenticate', async () => {
    const hash = 'a'.repeat(64);
    const service = new SessionService();
    expect(await service.revokeByTokenHash(hash)).toBe(true);
    expect(revoke).toHaveBeenCalledWith(expect.anything(), hash);
    expect(await service.validate(hash)).toBeNull();
});
it('rejects malformed receipts before querying', async () => {
    const service = new SessionService();
    expect(await service.revokeByTokenHash('not-a-hash')).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
});
