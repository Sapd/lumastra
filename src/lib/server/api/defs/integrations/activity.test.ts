// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { malActivityDef } from './mal/activity.js';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));

describe('mal activity def', () => {
    it('401s without a user', async () => {
        const res = await malActivityDef.handlers.GET!({ locals: {} } as never, {} as never);
        expect(res.status).toBe(401);
    });
    it('returns {items:[]} when DB unavailable', async () => {
        const res = await malActivityDef.handlers.GET!(
            { locals: { user: { username: 'u', userId: 'x' } } } as never,
            {} as never,
        );
        expect(await res.json()).toEqual({ items: [] });
    });
});
