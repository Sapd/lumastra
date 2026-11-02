// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    unrestrictedAccess,
    denyAllAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';

const mocks = vi.hoisted(() => ({
    cacheGet: vi.fn(),
    image: vi.fn(),
    listComments: vi.fn(async () => []),
    listReactions: vi.fn(async () => []),
    insertComment: vi.fn(),
    upsertReaction: vi.fn(),
    deleteReaction: vi.fn(),
    softDeleteComment: vi.fn(),
    getCommentOwner: vi.fn(),
}));
vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { personDetails: {} },
    cacheManager: { for: () => ({ get: mocks.cacheGet, set: vi.fn() }) },
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/database/queries/availability.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/availability.queries.js')>()),
    batchGetAvailability: async (_sql: unknown, ids: string[]) =>
        new Map(ids.map((id) => [id, id === '00000000-0000-4000-a000-000000000001'])),
}));
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    getProvidersByPriority: () => [],
    invokeProviderGetPersonDetail: vi.fn(),
}));
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({ getPersonImage: mocks.image }),
    imageResponse: () => new Response('image'),
    PersonRateLimitError: class extends Error {},
}));
vi.mock('$lib/server/services/image-proxy', () => ({
    getImageProxyService: () => ({ getPersonImage: mocks.image }),
    imageResponse: () => new Response('image'),
    PersonRateLimitError: class extends Error {},
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
// This suite exercises person handles/access with candidate persistence mocked.
// Provenance and byte resolution have real-DB coverage in descriptor-bytes.integration.test.ts.
vi.mock('$lib/server/database/queries/image-candidates.queries.js', () => ({
    registerPersonImageCandidate: vi.fn(async () => '11111111-1111-4111-8111-111111111111'),
    getSelectedImageCandidate: vi.fn(async () => ({
        id: '11111111-1111-4111-8111-111111111111',
        provider: 'tmdb',
        provider_ref: '/profile.jpg',
        file_path: null,
        remote_url: null,
        width: null,
        height: null,
    })),
}));
vi.mock('$lib/server/database/queries/interactions.queries.js', () => mocks);
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: async () => 'user-id',
    getUserDisplayInfoByIds: async () => [],
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/middleware/valkey-rate-limit.js')>()),
    checkRateLimit: async () => ({ allowed: true }),
}));

import {
    handlePersonGet,
    toPersonResponse,
    applyLibraryAccessFilter,
    type PersonDetails,
} from '$lib/server/services/person.service.js';
import { def as detail } from '../catalog/people-id.js';
import { def as legacy } from './person-id.js';
import { def as images } from './[id]/images/index.js';
import { def as image } from './[id]/images/[role].js';
import { def as indexed } from './[id]/images/[role]/[index].js';
import { def as comments } from './[id]/comments/index.js';
import { def as comment } from './[id]/comments/[commentId].js';
import { def as reactions } from './[id]/reactions/index.js';
import { personImageHandler } from '$lib/server/services/image-proxy/person-route-handler.js';

const uuid = '00000000-0000-4000-a000-000000000001';
function payload(): PersonDetails {
    return {
        id: 123,
        name: 'Person',
        profilePath: '/profile.jpg',
        movieCredits: [
            {
                externalIds: { tmdb: '10', internal: uuid },
                mediaType: 'movie',
                title: 'Owned',
                isAvailable: true,
                canRequest: false,
                posterPath: '/poster.jpg',
                year: '2020',
                character: 'Hero',
            },
            {
                externalIds: { tmdb: '20' },
                mediaType: 'movie',
                title: 'Discovery',
                isAvailable: false,
                canRequest: true,
            },
        ],
        tvCredits: [],
    };
}
function event(id: string, method = 'GET', query = ''): RequestEvent {
    const request = new Request(`http://localhost/api/v1/people/${id}?${query}`, {
        method,
        ...(method !== 'GET' ? { body: JSON.stringify({ body: 'Hi', emoji: '👍' }) } : {}),
    });
    return {
        params: { id, personId: id, role: 'profile', index: '0', commentId: '1' },
        request,
        url: new URL(request.url),
        locals: { user: { username: 'test' } },
    } as unknown as RequestEvent;
}
const ctx = { surface: 'v1' } as never;
const deleteCtx = { surface: 'v1', input: { query: { emoji: '👍' } } } as never;
const handlers = [
    ['detail', (e: RequestEvent) => detail.handlers.GET!(e, ctx)],
    ['legacy detail', (e: RequestEvent) => legacy.handlers.GET!(e, ctx)],
    ['images', (e: RequestEvent) => images.handlers.GET!(e, ctx)],
    ['image role', (e: RequestEvent) => image.handlers.GET!(e, ctx)],
    ['image index', (e: RequestEvent) => indexed.handlers.GET!(e, ctx)],
    ['legacy image', personImageHandler],
    ['comments GET', (e: RequestEvent) => comments.handlers.GET!(e, ctx)],
    ['comments POST', (e: RequestEvent) => comments.handlers.POST!(e, ctx)],
    ['comment DELETE', (e: RequestEvent) => comment.handlers.DELETE!(e, ctx)],
    ['reactions GET', (e: RequestEvent) => reactions.handlers.GET!(e, ctx)],
    ['reactions PUT', (e: RequestEvent) => reactions.handlers.PUT!(e, ctx)],
    ['reactions DELETE', (e: RequestEvent) => reactions.handlers.DELETE!(e, deleteCtx)],
] as const;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheGet.mockResolvedValue(payload());
    mocks.image.mockResolvedValue({});
    mocks.insertComment.mockResolvedValue({
        id: '1',
        user_id: 'user-id',
        username: 'test',
        body: 'Hi',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
    });
    mocks.getCommentOwner.mockResolvedValue({ user_id: 'user-id' });
});

describe.each(handlers)('%s handles', (_, run) => {
    it.each(['0', '-1', '123junk', 'other:123', 'tmdb:0', '9007199254740992', ''])(
        'rejects %s with a 422 problem',
        async (id) => {
            const res = await run(event(id));
            expect(res.status).toBe(422);
            expect(res.headers.get('content-type')).toContain('application/problem+json');
        },
    );
    it.each(['123', '0123', 'tmdb:123', 'tmdb:00123'])('accepts %s', async (id) => {
        const res = await run(
            event(
                id,
                _.includes('POST')
                    ? 'POST'
                    : _.includes('PUT')
                      ? 'PUT'
                      : _.includes('DELETE')
                        ? 'DELETE'
                        : 'GET',
            ),
        );
        expect(res.status).toBeLessThan(400);
    });
});

it.each(['123', '0123', 'tmdb:00123'])(
    'reads and writes interactions under one target for %s',
    async (id) => {
        await comments.handlers.GET!(event(id), ctx);
        await comments.handlers.POST!(event(id, 'POST'), ctx);
        await reactions.handlers.GET!(event(id), ctx);
        await reactions.handlers.PUT!(event(id, 'PUT'), ctx);
        await reactions.handlers.DELETE!(event(id, 'DELETE'), deleteCtx);
        await comment.handlers.DELETE!(event(id, 'DELETE'), ctx);
        for (const fn of [
            mocks.listComments,
            mocks.insertComment,
            mocks.listReactions,
            mocks.upsertReaction,
            mocks.deleteReaction,
            mocks.softDeleteComment,
        ]) {
            expect(fn).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ targetType: 'person', targetId: 'tmdb:123' }),
            );
        }
    },
);

it('maps filmography to previews with provider artwork and canonical person identity', () => {
    const out = toPersonResponse(payload());
    expect(out.id).toBe('tmdb:123');
    expect(out.ids).toEqual({ tmdb: '123' });
    expect(out.images.primary?.variants?.card).toContain(
        '/api/v1/people/tmdb%3A123/images/profile?size=w185&v=',
    );
    expect(out.movieCredits[0]).toMatchObject({
        id: uuid,
        catalogId: uuid,
        ids: { tmdb: '10' },
        type: 'movie',
        year: 2020,
        character: 'Hero',
        availability: { isAvailable: true, canRequest: false },
    });
    expect(out.movieCredits[0].images.poster).toMatchObject({ source: 'provider' });
    expect(out.movieCredits[0].images.poster?.href).toContain(
        '/media/tmdb:10:movie/images/poster?',
    );
    expect(out.movieCredits[1]).toMatchObject({ id: 'tmdb:20:movie', catalogId: null, images: {} });
    expect(out).not.toHaveProperty('profilePath');
    expect(out.movieCredits[0]).not.toHaveProperty('externalIds');
});

it('libraryOnly keeps available credits only, not any credit with a catalog id', () => {
    const base = payload();
    base.movieCredits = [
        ...base.movieCredits,
        {
            externalIds: { tmdb: '30', internal: '00000000-0000-4000-a000-000000000002' },
            mediaType: 'movie',
            title: 'Fileless catalog row',
            isAvailable: false,
            canRequest: true,
        },
    ];
    const all = toPersonResponse(base).movieCredits;
    expect(all.map((c) => c.title)).toContain('Fileless catalog row');
    expect(all.find((c) => c.title === 'Fileless catalog row')?.availability).toEqual({
        isAvailable: false,
        canRequest: true,
    });
    expect(toPersonResponse(base, 'v1', true).movieCredits.map((c) => c.title)).toEqual(['Owned']);
});

it('libraryOnly filters after access enforcement, before capping', async () => {
    const base = payload();
    base.movieCredits = [
        ...Array.from({ length: 31 }, (_, n) => ({
            ...base.movieCredits[1],
            externalIds: { tmdb: String(n + 100) },
        })),
        base.movieCredits[0],
    ];
    expect(toPersonResponse(base).creditsTruncated).toBe(true);
    expect(toPersonResponse(base, 'v1', true).movieCredits).toHaveLength(1);
    const denied = await applyLibraryAccessFilter(base, denyAllAccess());
    expect(toPersonResponse(denied, 'v1', true).movieCredits).toEqual([]);
    mocks.cacheGet.mockResolvedValue(base);
    const response = await handlePersonGet(
        event('tmdb:00123', 'GET', 'libraryOnly=true'),
        unrestrictedAccess(),
    );
    expect((await response.json()).movieCredits).toHaveLength(1);
    const deniedResponse = await handlePersonGet(
        event('123', 'GET', 'libraryOnly=true'),
        denyAllAccess(),
    );
    expect((await deniedResponse.json()).movieCredits).toEqual([]);
});
