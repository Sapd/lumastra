// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { principalLocals } from '$lib/server/api/principal-locals.test-helpers.js';
import type { EndpointDef } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
const limiter = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/middleware/valkey-rate-limit.js', async (original) => ({
    ...(await original<typeof import('$lib/server/middleware/valkey-rate-limit.js')>()),
    checkRateLimit: limiter,
}));
const dispatch = vi.hoisted(() => vi.fn());
const calendar = vi.hoisted(() => vi.fn());
vi.mock('./calendar-delegate.js', () => ({ handleCalendarView: calendar }));
vi.mock('./recommender.js', () => ({
    getRailItems: dispatch,
    buildAccessContext: async () => ({ userId: 'user', isAgeRestricted: false }),
    runRecommender: vi.fn(),
    UnknownRailError: class extends Error {},
}));
vi.mock('$lib/server/services/media-preview.service.js', () => ({
    recommendationPreviews: async (_sql: unknown, _surface: unknown, items: unknown) => items,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
import { def as recommendations } from './recommendations.js';
import { def as refreshRecommendations } from './recommendations-refresh.js';
import { def as upcoming } from './upcoming.js';
import { def as refreshUpcoming } from './upcoming-refresh.js';
import { def as taste } from '../for-you/taste.js';
import { def as refreshTaste } from '../for-you/taste/refresh.js';
import {
    def as internalRecommendations,
    refreshDef as refreshInternalRecommendations,
} from '../../../../../routes/api/recommendations/handlers.js';
import {
    def as mood,
    refreshDef as refreshMood,
} from '../../../../../routes/api/mood-recommendations/handlers.js';
import {
    def as editorial,
    refreshDef as refreshEditorial,
} from '../../../../../routes/api/recommendations/holiday/handlers.js';
const event = (path: string, method = 'GET'): RequestEvent =>
    ({
        url: new URL(path, 'http://localhost'),
        request: new Request(new URL(path, 'http://localhost'), { method }),
        locals: { user: { userId: 'user' } },
    }) as RequestEvent;
beforeEach(() => {
    const counts = new Map<string, number>();
    limiter.mockReset().mockImplementation(async (key: string, limit: number) => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return {
            allowed: count <= limit,
            total: limit,
            remaining: Math.max(0, limit - count),
            resetAt: Date.now() / 1000 + 60,
        };
    });
    dispatch.mockReset().mockResolvedValue({ items: [], hasMore: false });
    calendar.mockReset().mockImplementation(async () => new Response('{}', { status: 200 }));
});
describe('explicit refresh actions', () => {
    it.each(['internal', 'v1'] as const)(
        'requires authentication for the %s refresh action',
        async (surface) => {
            const request = event('/refresh', 'POST');
            expect((await mount(refreshRecommendations, { surface }).POST!(request)).status).toBe(
                401,
            );
            expect(dispatch).not.toHaveBeenCalled();
        },
    );
    it.each([recommendations, upcoming, taste, internalRecommendations, mood, editorial])(
        'GET rejects a retired regeneration flag before dispatch',
        async (def) => {
            expect(
                (await def.handlers.GET!(event('/?refresh=true'), { surface: 'v1' } as never))
                    .status,
            ).toBe(422);
            expect(dispatch).not.toHaveBeenCalled();
        },
    );
    it('ordinary recommendations GET never forces regeneration', async () => {
        expect(
            (await recommendations.handlers.GET!(event('/'), { surface: 'v1' } as never)).status,
        ).toBe(200);
        expect(dispatch).toHaveBeenCalledWith(
            'for-you',
            expect.anything(),
            expect.objectContaining({ refresh: false }),
        );
    });
    it('POST refresh uses the same dispatch with an explicit first-page action', async () => {
        expect(
            (
                await refreshRecommendations.handlers.POST!(event('/refresh', 'POST'), {
                    surface: 'internal',
                    input: { body: { type: 'ai', limit: 5 } },
                } as never)
            ).status,
        ).toBe(200);
        expect(dispatch).toHaveBeenCalledWith(
            'ai',
            expect.anything(),
            expect.objectContaining({ refresh: true, limit: 5, offset: 0, surface: 'internal' }),
        );
    });
    it('calendar refresh reads only its body filters without requesting a synchronization', async () => {
        const body = {
            view: 'calendar',
            limit: 20,
            offset: 3,
            start: '2026-10-01',
            end: '2026-11-01',
        };
        const response = await refreshUpcoming.handlers.POST!(
            event('/refresh?offset=99&limit=1', 'POST'),
            { surface: 'v1', input: { body } } as never,
        );
        expect(response.status).toBe(200);
        const delegated = calendar.mock.calls[0][0] as RequestEvent;
        expect(Object.fromEntries(delegated.url.searchParams)).toEqual({
            limit: '20',
            offset: '3',
            start: body.start,
            end: body.end,
        });
    });

    it('refresh bodies reject retired flags and recommendation continuation', () => {
        for (const body of [{ offset: 1 }, { cursor: 'x' }, { refresh: true }])
            for (const action of [
                refreshRecommendations,
                refreshInternalRecommendations,
                refreshMood,
                refreshEditorial,
            ])
                expect(action.request!.body!.safeParse(body).success).toBe(false);
        expect(
            refreshUpcoming.request!.body!.safeParse({ view: 'calendar', offset: 2, limit: 10 })
                .success,
        ).toBe(true);
        expect(refreshUpcoming.request!.body!.safeParse({ refresh: 'true' }).success).toBe(false);
        expect(
            recommendations.docs!.GET!.query!.safeParse({ refresh: 'true' }).success,
        ).toBe(false);
    });
});

const authenticatedPost = (path: string, body: unknown = {}, otherUser = false): RequestEvent =>
    ({
        ...event(path, 'POST'),
        request: new Request(new URL(path, 'http://localhost'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        locals: principalLocals({
            kind: 'session',
            ownerIsAdmin: false,
            ...(otherUser ? { userId: toUserId('00000000-0000-4000-8000-000000000099') } : {}),
        }),
        getClientAddress: () => '127.0.0.1',
    }) as unknown as RequestEvent;
const actions = [
    ['recommendations', refreshRecommendations],
    ['upcoming', refreshUpcoming],
    ['internal recommendations', refreshInternalRecommendations],
    ['mood', refreshMood],
    ['holiday', refreshEditorial],
    ['taste', refreshTaste],
] as const;
describe.each(['internal', 'v1'] as const)('refresh limits on %s', (surface) => {
    it.each(actions)(
        'returns 429 before dispatch for exhausted %s refreshes',
        async (_name, definition) => {
            const handler = vi.fn(async () => new Response(null, { status: 204 }));
            const { POST } = mount({ ...definition, handlers: { POST: handler } } as EndpointDef, {
                surface,
            });
            const prefix = surface === 'v1' ? '/api/v1' : '/api';
            for (let i = 0; i < 30; i++)
                expect((await POST!(authenticatedPost(`${prefix}/refresh`))).status).toBe(204);
            const blocked = await POST!(authenticatedPost(`${prefix}/refresh`));
            expect(blocked.status).toBe(429);
            expect(await blocked.json()).toMatchObject({ code: 'rate_limited' });
            expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
            expect(handler).toHaveBeenCalledTimes(30);
            expect((await POST!(authenticatedPost(`${prefix}/refresh`, {}, true))).status).toBe(
                204,
            );
        },
    );
});
it('shares the refresh budget across surfaces and action paths', async () => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const internal = mount(
        { ...refreshInternalRecommendations, handlers: { POST: handler } },
        { surface: 'internal' },
    ).POST!;
    const v1 = mount({ ...refreshUpcoming, handlers: { POST: handler } }, { surface: 'v1' }).POST!;
    for (let i = 0; i < 30; i++) await internal(authenticatedPost('/api/recommendations/refresh'));
    expect((await v1(authenticatedPost('/api/v1/upcoming/refresh'))).status).toBe(429);
    expect(handler).toHaveBeenCalledTimes(30);
});
describe('JSON refresh filters and GET query strings', () => {
    it.each([true, false])(
        'passes native JSON booleans (%s) and id arrays to the recommender',
        async (flag) => {
            const id = '00000000-0000-4000-8000-000000000001';
            const response = await mount(refreshRecommendations, { surface: 'v1' }).POST!(
                authenticatedPost('/api/v1/recommendations/refresh', {
                    type: 'binge-worthy',
                    types: 'movie,series',
                    hideWatched: flag,
                    availableOnly: flag,
                    watched: [42, 99],
                    watchedIds: [id],
                }),
            );
            expect(response.status).toBe(200);
            expect(dispatch).toHaveBeenCalledWith(
                'binge-worthy',
                expect.anything(),
                expect.objectContaining({
                    hideWatched: flag,
                    availableOnly: flag,
                    mediaTypes: new Set(['movie', 'series']),
                    refresh: true,
                    extra: { watchedTmdbIds: [42, 99], watchedUuids: [id] },
                }),
            );
        },
    );
    it.each(['true', 'false'])(
        'keeps boolean strings (%s) and CSV ids working on GET',
        async (flag) => {
            const id = '00000000-0000-4000-8000-000000000001';
            const response = await recommendations.handlers.GET!(
                event(`/?hideWatched=${flag}&availableOnly=${flag}&watched=42,99&watchedIds=${id}`),
                { surface: 'v1' } as never,
            );
            expect(response.status).toBe(200);
            expect(dispatch).toHaveBeenCalledWith(
                'for-you',
                expect.anything(),
                expect.objectContaining({
                    hideWatched: flag === 'true',
                    availableOnly: flag === 'true',
                    refresh: false,
                    extra: { watchedTmdbIds: [42, 99], watchedUuids: [id] },
                }),
            );
        },
    );
    it.each(['internal', 'v1'] as const)(
        'shares strict filter validation between GET and POST refresh on %s',
        async (surface) => {
            const prefix = surface === 'v1' ? '/api/v1' : '/api';
            const invalidFilters = [
                { mediaType: 'movie' },
                { types: 'movie,podcast' },
                { limit: 101 },
                { type: 'unknown' },
            ];
            for (const filters of invalidFilters) {
                const query = new URLSearchParams(
                    Object.entries(filters).map(([key, value]) => [key, String(value)]),
                );
                expect(
                    (await recommendations.handlers.GET!(
                        event(`${prefix}/recommendations?${query}`),
                        { surface } as never,
                    )).status,
                ).toBe(422);
                expect(
                    (await mount(refreshRecommendations, { surface }).POST!(
                        authenticatedPost(`${prefix}/recommendations/refresh`, filters),
                    )).status,
                ).toBe(422);
            }
            expect(dispatch).not.toHaveBeenCalled();
        },
    );
    it('rejects query-shaped strings in a JSON refresh body', async () => {
        const response = await mount(refreshRecommendations, { surface: 'v1' }).POST!(
            authenticatedPost('/api/v1/recommendations/refresh', {
                hideWatched: 'false',
                availableOnly: 'true',
                watched: '42',
                watchedIds: 'invalid',
            }),
        );
        expect(response.status).toBe(422);
        expect(dispatch).not.toHaveBeenCalled();
    });
});
