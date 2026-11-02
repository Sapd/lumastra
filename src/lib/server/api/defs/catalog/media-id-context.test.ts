// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/catalog/media-id-context.ts (GET media/{id}/context).
 *
 * `social` used to fan out over `event.fetch` to the internal `/api/*`
 * surface, which rejects bearer tokens by design — a tvOS client calling
 * `context` got a 200 with `social` silently absent, indistinguishable from
 * "nobody watched this". `social` now calls Task 1's `buildWatchActivity` in
 * process. `similar` still goes over HTTP but must resolve on the calling
 * surface, not the hardcoded internal one. `included` makes an unavailable
 * section distinguishable from a genuinely empty one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { MediaContextResponseSchema as WebMediaContextResponseSchema } from '$lib/schemas/api-media-context-response';

vi.mock('$lib/server/services/image-descriptor/avatars.js', async () => {
    const { userAvatarSet } = await import('$lib/server/services/image-descriptor/resolver.js');
    return {
        userImageSets: async (_sql: unknown, surface: 'internal' | 'v1', ids: string[]) =>
            new Map(
                ids.map((userId) => [userId, userAvatarSet(surface, { userId, version: '0' })]),
            ),
    };
});

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

const mockGetDb = vi.fn();
const mockResolveCatalogInternalId = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockBuildMediaDetail = vi.fn();
const mockBuildWatchActivity = vi.fn();
const mockGetNextUpForSeries = vi.fn();

vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        getNextUpForSeries: (...args: unknown[]) => mockGetNextUpForSeries(...args),
        getWatchState: vi.fn(async () => null),
    },
}));

vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    findEffectiveRuntimeSeconds: vi.fn(async () => null),
    findPlaybackDurationMs: vi.fn(async () => null),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('./resolve-id.js', () => ({
    resolveCatalogInternalId: (...args: unknown[]) => mockResolveCatalogInternalId(...args),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

vi.mock('./media-id.js', () => ({
    buildMediaDetail: (...args: unknown[]) => mockBuildMediaDetail(...args),
}));

vi.mock('../integrations/social-watch-activity.js', () => ({
    buildWatchActivity: (...args: unknown[]) => mockBuildWatchActivity(...args),
}));

const { def, MediaContextResponseSchema } = await import('./media-id-context.js');
const { mount } = await import('$lib/server/api/mount.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(query = ''): RequestEvent {
    const url = new URL(
        `http://localhost/api/media/00000000-0000-0000-0000-000000000001/context${query}`,
    );
    return {
        url,
        params: { id: '00000000-0000-0000-0000-000000000001' },
        route: { id: '/api/media/[id]/context' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: 'usr_00000000-0000-0000-0000-000000000001',
                username: 'alice',
                userGroups: [],
                ownerIsAdmin: false,
                isAgeRestricted: false,
                maxAgeRating: null,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockResolveCatalogInternalId.mockResolvedValue('media-uuid-1');
    mockCheckMediaAccess.mockResolvedValue(true);
    mockBuildMediaDetail.mockResolvedValue({
        id: 'media-uuid-1',
        type: 'movie',
        ids: {},
        title: 'Some Movie',
    });
    mockBuildWatchActivity.mockResolvedValue({ ok: true, body: { activities: [] } });
});

describe('media-id-context — the audiobook series rail boundary', () => {
    it('accepts the mounted audiobook context with the browser strict schema', async () => {
        mockBuildMediaDetail.mockResolvedValue({
            id: 'book-1',
            type: 'audiobook',
            ids: {},
            title: 'The Copper Moon',
            isAvailable: true,
            canRequest: false,
            images: {},
            durationMs: null,
            chapters: [],
            authors: [],
            narrators: [],
            series: null,
        });
        const { GET } = mount(def, { surface: 'internal' });
        const response = await GET!(makeEvent('?include=details') as never);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.included).toEqual(['details']);
        expect(WebMediaContextResponseSchema.strict().safeParse(body).success).toBe(true);
    });

    // The modal reads its audiobook block from THIS endpoint, not from
    // GET /media/{id}. `buildMediaDetail` drops the series rail when the access
    // thunk is absent — a deliberate fail-closed default — so forgetting to pass
    // it here does not error or warn. The rail simply never renders, on the one
    // surface that renders it.
    it('passes an access-boundary thunk through to buildMediaDetail', async () => {
        await def.handlers.GET!(makeEvent('?include=details'), { surface: 'v1' });

        expect(mockBuildMediaDetail).toHaveBeenCalled();
        const getAccess = mockBuildMediaDetail.mock.calls[0]?.[5];
        expect(typeof getAccess).toBe('function');
    });

    it('passes no thunk for an anonymous request', async () => {
        const event = makeEvent('?include=details');
        (event as unknown as { locals: { user?: unknown } }).locals.user = undefined;

        await def.handlers.GET!(event, { surface: 'v1' });

        expect(mockBuildMediaDetail).toHaveBeenCalled();
        expect(mockBuildMediaDetail.mock.calls[0]?.[5]).toBeUndefined();
    });
});

describe('media-id-context — bearer-safe sections', () => {
    it('calls buildWatchActivity in-process rather than fetching', async () => {
        mockBuildWatchActivity.mockResolvedValue({ ok: true, body: { activities: [] } });
        const event = makeEvent('?include=social');

        await def.handlers.GET!(event, { surface: 'v1' });

        expect(mockBuildWatchActivity).toHaveBeenCalled();
        expect(event.fetch).not.toHaveBeenCalled();
    });

    it('requests similar on the surface it was called on', async () => {
        const event = makeEvent('?include=similar');
        await def.handlers.GET!(event, { surface: 'v1' });

        expect(event.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/v1/media/'),
            expect.anything(),
        );
    });

    it('omits social from included when the feature is unavailable', async () => {
        mockBuildWatchActivity.mockResolvedValue({ ok: false, reason: 'unavailable' });
        const res = await def.handlers.GET!(makeEvent('?include=details,social'), {
            surface: 'v1',
        });
        const body = await res.json();

        expect(body.social).toBeUndefined();
        expect(body.included).not.toContain('social');
        expect(body.included).toContain('details');
    });

    it('rejects an include= that names only unknown sections', async () => {
        // `?include=bogus` used to filter down to an EMPTY section set and
        // return 200 {included: []} — bit-identical to "everything you asked
        // for was unavailable". The mechanism this endpoint ships to
        // disambiguate could not tell a client typo apart from a real outage.
        const res = await def.handlers.GET!(makeEvent('?include=bogus,alsoBogus'), {
            surface: 'v1',
        });

        expect(res.status).toBe(422); // problem type `validation_failed`
        const body = await res.json();
        expect(JSON.stringify(body)).toContain('bogus');
    });

    it('tolerates an include= that names at least one known section', async () => {
        const res = await def.handlers.GET!(makeEvent('?include=details,bogus'), {
            surface: 'v1',
        });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.included).toContain('details');
    });

    it('defaults to every section for a present-but-empty include=', async () => {
        const res = await def.handlers.GET!(makeEvent('?include='), { surface: 'v1' });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.included).toContain('details');
    });

    it.each([
        ['a single space', '?include=%20'],
        ['only separators', '?include=,%20,'],
    ])('defaults to every section for an include= that is %s', async (_label, query) => {
        // Whitespace is truthy, so this used to take the validation branch,
        // trim to zero tokens, and 422 with "Unknown section(s): (none)" —
        // naming nothing the client could fix and contradicting this
        // endpoint's own absent-or-empty-means-everything contract.
        const res = await def.handlers.GET!(makeEvent(query), { surface: 'v1' });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.included).toContain('details');
    });

    it('omits social from included when the id never resolved', async () => {
        // `included[]` means "requested, honored, and turned up nothing". A
        // failed lookup is not that, and must not be reported as such.
        mockBuildWatchActivity.mockResolvedValue({ ok: false, reason: 'unresolved' });
        const res = await def.handlers.GET!(makeEvent('?include=details,social'), {
            surface: 'v1',
        });
        const body = await res.json();

        expect(body.social).toBeUndefined();
        expect(body.included).not.toContain('social');
    });

    it('lists social in included when it succeeded but is empty', async () => {
        mockBuildWatchActivity.mockResolvedValue({ ok: true, body: { activities: [] } });
        const res = await def.handlers.GET!(makeEvent('?include=social'), { surface: 'v1' });
        const body = await res.json();

        expect(body.included).toContain('social');
        expect(body.social).toEqual({ activities: [] });
    });
});

// ---------------------------------------------------------------------------
// Response contract — through mount(), which is where the gate lives
// ---------------------------------------------------------------------------
//
// The tests above call `def.handlers.GET` directly, so `finalizeResponse` never
// runs and the declared 200 schema is never applied. That is exactly why a
// too-narrow `docs.GET.responses[200].schema` went unnoticed: `def.docs`
// governs EVERY mount of the def, including the pre-existing internal
// `/api/media/[id]/context` the web modal calls, and in dev+prod a SUCCESSFUL
// parse makes mount emit the strip-parsed body. Anything the schema fails to
// declare is silently deleted from the wire.
//
// Each test therefore does both halves:
//   1. goes through `mount()` (so the test-only drift gate fires), and
//   2. runs the published schema over the body itself, which is what dev/prod
//      would put on the wire after the conformance strip.

/** What buildMediaDetail actually returns for a movie (MediaNode shape). */
const FULL_DETAIL = {
    id: 'media-uuid-1',
    type: 'movie',
    ids: { internal: 'media-uuid-1', tmdb: '550' },
    title: 'Some Movie',
    year: 1999,
    overview: 'A movie.',
    images: {
        poster: { href: '/api/media/media-uuid-1/images/poster', revision: '0', source: 'self' },
    },
    isAvailable: true,
    canRequest: false,
};

/** What buildWatchActivity actually emits (SocialActivityItem shape). */
const REAL_ACTIVITY = {
    author: {
        userId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Bob',
        images: {
            primary: {
                href: '/api/v1/users/00000000-0000-4000-8000-000000000002/images/avatar',
                variants: {
                    thumb: '/api/v1/users/00000000-0000-4000-8000-000000000002/images/avatar?quality=50',
                },
                revision: '0',
                source: 'self',
            },
        },
    },
    description: 'Bob loved this',
    rating: 9,
    ratingStyle: 'stars' as const,
    ratedAt: '2026-07-28T10:00:00.000Z',
};

describe('media-id-context — published 200 contract (through mount)', () => {
    it('does not strip details fields on the mounted INTERNAL route', async () => {
        mockBuildMediaDetail.mockResolvedValue(FULL_DETAIL);
        const { GET } = mount(def, { surface: 'internal' });

        const res = await GET!(makeEvent('?include=details') as never);
        const body: unknown = await res.json();

        // What dev/prod actually put on the wire after the conformance strip.
        const onTheWire = MediaContextResponseSchema.parse(body);
        expect(onTheWire.details).toMatchObject({
            id: 'media-uuid-1',
            isAvailable: true,
            canRequest: false,
            images: {
                poster: {
                    href: '/api/media/media-uuid-1/images/poster',
                    revision: '0',
                    source: 'self',
                },
            },
        });
    });

    it('declares the social activity shape the runtime actually emits', async () => {
        mockBuildWatchActivity.mockResolvedValue({
            ok: true,
            body: { activities: [REAL_ACTIVITY] },
        });
        const { GET } = mount(def, { surface: 'v1' });

        const res = await GET!(makeEvent('?include=social') as never);
        const body: unknown = await res.json();

        const onTheWire = MediaContextResponseSchema.parse(body);
        expect(onTheWire.social?.activities).toEqual([REAL_ACTIVITY]);
    });

    /**
     * The audiobook listening fields (design doc §4.1) are the documented
     * docs-schema-activates-mount-gate hazard in its purest form: `finalizeResponse`
     * re-emits the PARSE RESULT of the declared 200 schema in dev AND prod, so any
     * field the schema omits is deleted from the wire. A schema-level test would
     * pass while the mounted route silently dropped every one of them.
     *
     * Asserted on the RAW body first, so a failure says "mount stripped it" rather
     * than "the schema I asserted with stripped it".
     */
    it('does not strip the audiobook listening fields on either surface', async () => {
        const LISTENING_ACTIVITY = {
            author: {
                userId: '44444444-4444-4444-8444-444444444444',
                displayName: 'Anna',
                images: {
                    primary: {
                        href: '/api/users/44444444-4444-4444-8444-444444444444/images/avatar',
                        variants: {
                            thumb: '/api/users/44444444-4444-4444-8444-444444444444/images/avatar?quality=50',
                        },
                        revision: '0',
                        source: 'self',
                    },
                },
            },
            description: 'Anna ist bei Kapitel 2 (39 %)',
            watchedOnly: true,
            positionMs: 700_000,
            durationMs: 1_800_000,
            chapterTitle: 'Kapitel 2',
            chapterIndex: 1,
            chapterCount: 3,
            finished: true,
            timesFinished: 2,
            sharedListen: true,
            chapterDelta: 1,
            positionDeltaMs: 600_000,
        };
        mockBuildWatchActivity.mockResolvedValue({
            ok: true,
            body: { activities: [LISTENING_ACTIVITY] },
        });

        for (const surface of ['internal', 'v1'] as const) {
            const { GET } = mount(def, { surface });
            const res = await GET!(makeEvent('?include=social') as never);
            const body = (await res.json()) as {
                social?: { activities?: Record<string, unknown>[] };
            };

            expect(body.social?.activities?.[0], surface).toEqual(LISTENING_ACTIVITY);
            expect(MediaContextResponseSchema.parse(body).social?.activities[0], surface).toEqual(
                LISTENING_ACTIVITY,
            );
        }
    });
});

// d86fbf5841: the `similar` sub-request carries the forward-auth identity
// headers only when THIS request was signed in by them. Otherwise a client's
// own copies would be re-emitted onto the sub-request.
const { config } = await import('$lib/server/config.js');

describe('media-id-context — identity headers on the similar sub-request', () => {
    function eventWithIdentityHeaders(authMethod: string): RequestEvent {
        const event = makeEvent('?include=similar');
        const headers = new Headers({
            [config.USERHEADER]: 'admin',
            [config.GROUPHEADER]: 'admin',
            cookie: 'lumastra_session=abc',
        });
        (event as unknown as { request: Request }).request = new Request(event.url, { headers });
        (event.locals as { authMethod?: string }).authMethod = authMethod;
        return event;
    }

    function subRequestHeaders(event: RequestEvent): Record<string, string> {
        const call = vi.mocked(event.fetch).mock.calls[0];
        return ((call?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
    }

    it('drops client-sent identity headers on a session-cookie request', async () => {
        const event = eventWithIdentityHeaders('session');
        await def.handlers.GET!(event, { surface: 'v1' });

        const headers = subRequestHeaders(event);
        expect(headers[config.USERHEADER]).toBeUndefined();
        expect(headers[config.GROUPHEADER]).toBeUndefined();
        expect(headers.cookie).toBe('lumastra_session=abc');
    });

    it('keeps them on a request signed in by forward auth', async () => {
        const event = eventWithIdentityHeaders('forward_auth');
        await def.handlers.GET!(event, { surface: 'v1' });

        const headers = subRequestHeaders(event);
        expect(headers[config.USERHEADER]).toBe('admin');
        expect(headers[config.GROUPHEADER]).toBe('admin');
    });
});

describe('media-id-context — web next-episode decoder', () => {
    it.each([
        { title: 'The next episode', season_number: 2, episode_number: 3 },
        { title: null, season_number: null, episode_number: null },
    ])('decodes the mounted canonical episode fields: $title', async (episode) => {
        mockGetNextUpForSeries.mockResolvedValue({
            media_id: 'next-episode-id',
            ...episode,
        });
        const { GET } = mount(def, { surface: 'internal' });
        const response = await GET!(makeEvent('?include=nextEpisode') as never);
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        const decoded = WebMediaContextResponseSchema.parse(body);
        expect(decoded.nextEpisode).toEqual({
            id: 'next-episode-id',
            title: episode.title,
            seasonNumber: episode.season_number,
            episodeNumber: episode.episode_number,
            durationMs: null,
        });
    });
});
