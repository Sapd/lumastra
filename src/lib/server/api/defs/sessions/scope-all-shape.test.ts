// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PagedSessionsResponseSchema } from '$lib/schemas/api-playback-responses.js';
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
    user_id:
        user === 'alice'
            ? '11111111-1111-4111-8111-111111111111'
            : '22222222-2222-4222-8222-222222222222',
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
                user: {
                    userId: '11111111-1111-4111-8111-111111111111',
                    username: 'alice',
                    isAdmin: true,
                },
                principal: { isAdmin: admin },
            },
        } as never,
        { input: { query: { scope, itemId } }, surface: 'v1' } as never,
    );
}
beforeEach(() => {
    rows.mockReset();
    rows.mockImplementation(async (_sql, filters: { userId?: string }) =>
        [row('one'), row('two', 'bob')].filter(
            (session) => !filters.userId || session.user_id === filters.userId,
        ),
    );
});
describe('one playback list envelope', () => {
    it.each(['mine', 'all'])('%s returns the declared {items,page} contract', async (scope) => {
        const payload = PagedSessionsResponseSchema.parse(await (await get(scope, true)).json());
        expect(payload.page).toBeDefined();
        expect(payload.items[0]).toMatchObject({
            playbackSessionId: 'one',
            positionMs: 1234,
            mediaId: 'media-one',
            kind: 'video',
            device: { id: 'device-one' },
        });
        expect(payload.items[0]).not.toHaveProperty('__id');
        expect(payload.items[0]).not.toHaveProperty('sessionId');
    });
    it('all includes every owner; mine includes only the caller', async () => {
        const all = await (await get('all', true)).json();
        expect(all.items).toHaveLength(2);
        expect(all.items[1].user).toEqual({
            userId: '22222222-2222-4222-8222-222222222222',
            displayName: null,
            images: {
                primary: {
                    href: '/api/v1/users/22222222-2222-4222-8222-222222222222/images/avatar?size=card&v=0&fallback=initials',
                    variants: {
                        thumb: '/api/v1/users/22222222-2222-4222-8222-222222222222/images/avatar?size=thumb&v=0&fallback=initials',
                        card: '/api/v1/users/22222222-2222-4222-8222-222222222222/images/avatar?size=card&v=0&fallback=initials',
                        full: '/api/v1/users/22222222-2222-4222-8222-222222222222/images/avatar?size=full&v=0&fallback=initials',
                    },
                    revision: '0',
                    source: 'generated',
                },
            },
        });
        expect((await (await get()).json()).items[0].user.userId).toBe(
            '11111111-1111-4111-8111-111111111111',
        );
    });
});
