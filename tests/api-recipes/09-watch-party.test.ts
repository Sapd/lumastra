// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owner: package 12. A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { client, episode, expectOk } from './client';
test('09 create private party → read → disband', async (ctx) => {
    const item = await episode();
    if (!item) return ctx.skip('Instance has no episode for a watch party');
    const { party } = expectOk(
        'POST',
        '/watch-together/parties',
        await client.POST('/api/v1/watch-together/parties', {
            body: {
                itemId: item.id,
                mediaType: 'episode',
                title: 'API recipe',
                clientId: 'api-recipes',
            },
        }),
    );
    try {
        // Private by default: a party is created unlisted unless the caller asks for `listed`.
        expect(party.visibility, 'A newly created party must be unlisted').toBe('unlisted');
        expect(party.host.userId, 'The host is a public author with a UUID').toMatch(/^[0-9a-f-]{36}$/);
        expectOk(
            'GET',
            '/watch-together/{code}',
            await client.GET('/api/v1/watch-together/{code}', {
                params: { path: { code: party.code } },
            }),
        );
    } finally {
        // `payload` is optional for commands that carry nothing (join, leave, disband).
        expectOk(
            'POST',
            '/watch-together/{code}/events disband',
            await client.POST('/api/v1/watch-together/{code}/events', {
                params: { path: { code: party.code } },
                body: { clientId: 'api-recipes', type: 'disband' },
            }),
        );
    }
});
