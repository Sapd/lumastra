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
import { def, SessionsQuery } from '../play-sessions/list.js';
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
    rows.mockImplementation(async (_sql, filters: { userId?: string; itemId?: string }) =>
        [row('one'), row('two', 'bob')].filter(
            (session) =>
                (filters.userId === undefined || session.user_id === filters.userId) &&
                (filters.itemId === undefined || session.media_id === filters.itemId),
        ),
    );
});
describe('playback session list scopes', () => {
    it('defaults to mine and rejects removed visible scope', () => {
        expect(SessionsQuery.parse({}).scope).toBe('mine');
        expect(SessionsQuery.safeParse({ scope: 'visible' }).success).toBe(false);
    });
    it('mine includes only rows owned by the authenticated user, even for admin', async () => {
        expect(
            (await (await get('mine', true)).json()).items.map(
                (s: { playbackSessionId: string }) => s.playbackSessionId,
            ),
        ).toEqual(['one']);
        expect(rows).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
            userId: 'alice',
            itemId: undefined,
        });
    });
    it('all includes other users for admin and leaves the user filter unset', async () => {
        expect(
            (await (await get('all', true)).json()).items.map(
                (s: { playbackSessionId: string }) => s.playbackSessionId,
            ),
        ).toEqual(['one', 'two']);
        expect(rows).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
            userId: undefined,
            itemId: undefined,
        });
    });
    it('filters by media id', async () => {
        expect((await (await get('mine', false, 'media-two')).json()).items).toEqual([]);
        expect(rows).toHaveBeenNthCalledWith(1, expect.anything(), {
            userId: 'alice',
            itemId: 'media-two',
        });
        expect((await (await get('mine', false, 'media-one')).json()).items).toHaveLength(1);
        expect(rows).toHaveBeenNthCalledWith(2, expect.anything(), {
            userId: 'alice',
            itemId: 'media-one',
        });
    });
    it('does not expose another user through scope=all without admin', async () => {
        expect((await get('all')).status).toBe(403);
        expect(rows).not.toHaveBeenCalled();
    });
});
