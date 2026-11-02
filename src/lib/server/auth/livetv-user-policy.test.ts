// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const { readAllowed, getDb } = vi.hoisted(() => ({ readAllowed: vi.fn(), getDb: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserLiveTvAllowed: readAllowed,
}));
import {
    applyLiveTvUserPolicy,
    liveTvRouteGate,
    userAllowsLiveTv,
    invalidateUserLiveTvPolicy,
} from './livetv-user-policy.js';

import { config } from '$lib/server/config.js';
afterEach(() => {
    vi.restoreAllMocks();
});
beforeEach(() => {
    vi.spyOn(config, 'FEATURE_LIVETV', 'get').mockReturnValue(true);
    invalidateUserLiveTvPolicy('viewer');
    getDb.mockReturnValue({});
    readAllowed.mockReset().mockResolvedValue(true);
});

describe('fresh per-user Live TV policy', () => {
    it('narrows every credential, including an admin, and takes effect on the next request', async () => {
        for (const ownerIsAdmin of [false, true]) {
            const user = { username: 'viewer', hasLiveTvPermission: true, ownerIsAdmin };
            await applyLiveTvUserPolicy(user);
            expect(user.hasLiveTvPermission).toBe(true);
            readAllowed.mockResolvedValue(false);
            invalidateUserLiveTvPolicy('viewer');
            const next = { ...user, hasLiveTvPermission: true };
            await applyLiveTvUserPolicy(next);
            expect(next.hasLiveTvPermission).toBe(false);
            readAllowed.mockResolvedValue(true);
            invalidateUserLiveTvPolicy('viewer');
        }
    });
    it('never grants access that groups/scopes denied', async () => {
        const user = { username: 'viewer', hasLiveTvPermission: false };
        await applyLiveTvUserPolicy(user);
        expect(user.hasLiveTvPermission).toBe(false);
        expect(readAllowed).not.toHaveBeenCalled();
    });
    it('fails closed on a missing database or a read failure', async () => {
        getDb.mockReturnValue(null);
        expect(await userAllowsLiveTv('viewer')).toBe(false);
        getDb.mockReturnValue({});
        readAllowed.mockRejectedValue(new Error('sensitive database detail'));
        expect(await userAllowsLiveTv('viewer')).toBe(false);
    });
    it('uses the matched route id for encoded paths and skipped layouts', () => {
        const denied = liveTvRouteGate({
            route: { id: '/livetv/guide' },
            locals: { user: { hasLiveTvPermission: false } },
        });
        expect(denied?.status).toBe(404);
    });
});
