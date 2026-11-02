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
    rows.mockResolvedValue([row('one'), row('two', 'bob')]);
});
describe('all media kinds share the list', () => {
    it.each([
        ['tv', 'video', 'series'],
        ['track', 'music', 'track'],
        ['music', 'music', 'music'],
        ['audiobook', 'audiobook', 'audiobook'],
        ['tvchannel', 'live', 'tvchannel'],
    ])('projects %s', async (type, kind, mediaType) => {
        rows.mockResolvedValue([row('one', 'alice', type)]);
        const payload = PagedSessionsResponseSchema.parse(await (await get()).json());
        expect(payload.items[0]).toMatchObject({ kind, mediaType });
    });
    it('keeps video, music and audiobook rows in one result', async () => {
        rows.mockResolvedValue(
            ['movie', 'track', 'audiobook'].map((type) => row(type, 'alice', type)),
        );
        expect((await (await get()).json()).items.map((s: { kind: string }) => s.kind)).toEqual([
            'video',
            'music',
            'audiobook',
        ]);
    });
});
