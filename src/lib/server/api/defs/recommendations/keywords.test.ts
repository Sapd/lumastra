// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';

const mocks = vi.hoisted(() => ({ popular: vi.fn() }));
vi.mock('./recommender.js', () => ({
    buildAccessContext: vi
        .fn()
        .mockResolvedValue({ deniedGroupIds: [], maxAgeRating: null, allowUnrated: true }),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/for-you.service.js', () => ({ fetchPopularKeywords: mocks.popular }));
import { def } from './keywords.js';

const { GET } = mount(def, { surface: 'v1' });
function event(query: string): RequestEvent {
    const url = new URL(`http://localhost/api/v1/keywords${query}`);
    return {
        url,
        request: new Request(url),
        params: {},
        locals: {
            principal: buildPrincipal({
                kind: 'session',
                userId: toUserId('11111111-1111-4111-8111-111111111111'),
                username: 'reader',
                userGroups: [],
                sessionIsAdmin: false,
            }),
        },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    mocks.popular.mockReset();
});
describe('keyword contract accuracy', () => {
    it('documents the actual mounted response and paginates with one lookahead', async () => {
        mocks.popular.mockResolvedValue([
            { keyword: 'skip' },
            { keyword: 'space', count: 3 },
            { keyword: 'ocean' },
            { keyword: 'lookahead' },
        ]);
        const response = await GET!(event('?limit=2&offset=1'));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
            items: [{ keyword: 'space', count: 3 }, { keyword: 'ocean' }],
            page: { limit: 2, offset: 1, hasMore: true },
        });
        expect(def.docs!.GET!.responses[200]).toHaveProperty('schema');
        const documented = def.docs!.GET!.responses[200];
        if (typeof documented !== 'object' || !('schema' in documented))
            throw new Error('Missing schema');
        expect(documented.schema.parse(body)).toEqual(body);
        expect(mocks.popular).toHaveBeenCalledWith(expect.anything(), 4, expect.anything());
    });
    it('does not advertise mode or fabricated keyword identifiers', () => {
        expect(def.docs!.GET!.query!.parse({ mode: 'you-like' })).toEqual({});
        const documented = def.docs!.GET!.responses[200];
        if (typeof documented !== 'object' || !('schema' in documented))
            throw new Error('Missing schema');
        expect(
            documented.schema.safeParse({
                items: [{ id: 'fake', name: 'space' }],
                page: { limit: 1, offset: 0, hasMore: false },
            }).success,
        ).toBe(false);
    });
    it('still rejects invalid pagination and requires authentication', async () => {
        expect((await GET!(event('?limit=0'))).status).toBe(422);
        const anonymous = event('');
        anonymous.locals.principal = undefined;
        expect((await GET!(anonymous)).status).toBe(401);
        expect(mocks.popular).not.toHaveBeenCalled();
    });
});
