// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const rows = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/config.js', () => ({ features: { watchTogether: false } }));
vi.mock('$lib/server/services/image-descriptor/avatars.js', () => ({
    userImageSets: async () => new Map(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getAllActiveSessionsWithMedia: rows,
}));
import { def } from '../play-sessions/list.js';
const row = (id: string, user = 'alice', type = 'movie') => ({
    id,
    user_id: user,
    media_id: `media-${id}`,
    media_type: type,
    status: 'ACTIVE',
    position_ms: 1234,
    runtime_ms: 5000,
    media_title: id,
    device_id: `device-${id}`,
    client_name: 'Test',
    owner_username: user,
    owner_display_name: null,
});
async function get(scope = 'mine', admin = false, itemId?: string) {
    return def.handlers.GET!(
        {
            locals: {
                user: { userId: 'alice', username: 'alice', isAdmin: true },
                principal: { isAdmin: admin },
            },
        } as never,
        { input: { query: { scope, itemId } }, surface: 'v1' } as never,
    );
}
beforeEach(() => {
    rows.mockReset();
    rows.mockResolvedValue([row('one'), row('two', 'bob')]);
});
describe('scope=all uses principal administration rights', () => {
    it('denies a device token whose owner is admin', async () => {
        expect((await get('all', false)).status).toBe(403);
        expect(rows).not.toHaveBeenCalled();
    });
    it('allows an admin principal', async () => {
        expect((await get('all', true)).status).toBe(200);
        expect(rows).toHaveBeenCalledOnce();
    });
    it('denies a principal-less request even if locals.user is admin', async () => {
        const response = await def.handlers.GET!(
            { locals: { user: { userId: 'alice', isAdmin: true } } } as never,
            { input: { query: { scope: 'all' } } } as never,
        );
        expect(response.status).toBe(403);
        expect(rows).not.toHaveBeenCalled();
    });
});
