// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/catalog/series-id.ts (GET series/{id}).
 *
 * Covers the same two bug classes fixed in media-id.ts (series-id.ts shares
 * the identical handler pattern — same base traversal node, same broken
 * ID-resolution fallback):
 *   1. The real response (id/ids/title/images + always-present
 *      seasons/episodes/nextEpisode/watchStatus links + optional user) never
 *      matched the registered OpenAPI schema (SeriesInfoResponseSchema — a
 *      stale Jellyfin-shaped contract with name/communityRating/genres/etc.,
 *      causing a live tvOS `keyNotFound "name"` decode failure). SeriesNodeSchema
 *      (api-series-responses.ts) is the accurate replacement.
 *   2. The ID-resolution fallback (no locals.resolvedIds) only accepted bare
 *      UUIDs and unconditionally 422'd composite/external ids instead of
 *      calling mediaIdResolver.resolveAnyMediaId() like withIdResolution does.
 */

import { resolveImageSet } from '$lib/server/services/image-descriptor/index.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { SeriesNodeSchema } from '$lib/schemas/api-series-responses.js';

vi.mock('$lib/server/services/image-descriptor/index.js', async () => {
    const { buildImageSet } = await import('$lib/shared/image-descriptor.js');
    const imageSet = (surface: 'internal' | 'v1', id: string, mediaType?: string) =>
        buildImageSet(
            surface,
            mediaType === 'episode'
                ? { thumb: { ownerId: id } }
                : { poster: { ownerId: id }, backdrop: { ownerId: id } },
        );
    return {
        resolveImageSet: vi.fn(
            async (_sql: unknown, surface: 'internal' | 'v1', id: string, mediaType?: string) =>
                imageSet(surface, id, mediaType),
        ),
        resolveImageSets: vi.fn(
            async (
                _sql: unknown,
                surface: 'internal' | 'v1',
                items: { id: string; mediaType?: string }[],
            ) =>
                new Map(items.map((item) => [item.id, imageSet(surface, item.id, item.mediaType)])),
        ),
    };
});

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

const mockGetDb = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockGetMediaDetailsById = vi.fn();
const mockGetExternalIdsByMediaId = vi.fn();
const mockBuildExternalIdsObject = vi.fn();
const mockResolveAnyMediaId = vi.fn();
const mockGetMediaDetailByUuid = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaDetailsById: (...args: unknown[]) => mockGetMediaDetailsById(...args),
    getExternalIdsByMediaId: (...args: unknown[]) => mockGetExternalIdsByMediaId(...args),
    buildExternalIdsObject: (...args: unknown[]) => mockBuildExternalIdsObject(...args),
}));

// buildMediaDetail enriches ?include=details with audio/subtitle language
// facts. It is a query module like the ones above, so stub it rather than
// making the fake `sql` object callable — the tests here assert response
// SHAPE, not stream aggregation (that has its own unit + integration tests).
vi.mock('$lib/server/database/queries/media-stream-summary.queries.js', () => ({
    getMediaStreamSummary: vi.fn().mockResolvedValue({
        audioLanguages: [],
        subtitleLanguages: [],
        hasClosedCaptions: false,
        hasSDH: false,
        hasAudioDescription: false,
        bestAudio: null,
    }),
}));

vi.mock('$lib/server/database/queries/media-details.queries.js', () => ({
    getMediaDetailByUuid: (...args: unknown[]) => mockGetMediaDetailByUuid(...args),
}));

vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: {
        resolveAnyMediaId: (...args: unknown[]) => mockResolveAnyMediaId(...args),
    },
}));

const { def } = await import('./series-id.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(opts: {
    id: string;
    resolvedInternalId?: string;
    include?: string;
    inherit?: 'none';
}): RequestEvent {
    const url = new URL(`http://localhost/api/v1/series/${opts.id}`);
    if (opts.include) url.searchParams.set('include', opts.include);
    if (opts.inherit) url.searchParams.set('inherit', opts.inherit);
    return {
        url,
        params: { id: opts.id },
        route: { id: '/api/v1/series/[id]' as const },
        request: new Request(url.toString()),
        locals: {
            resolvedIds: opts.resolvedInternalId
                ? { internalId: opts.resolvedInternalId, source: 'uuid' }
                : undefined,
            user: {
                userId: 'usr_00000000-0000-0000-0000-000000000001',
                username: 'alice',
                userGroups: [],
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const CTX = { surface: 'internal' as const };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockCheckMediaAccess.mockResolvedValue(true);
    mockGetExternalIdsByMediaId.mockResolvedValue([]);
    mockBuildExternalIdsObject.mockReturnValue({});
    mockGetMediaDetailsById.mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        media_type: 'tv',
        title: 'Starhaven',
        overview: 'A team at Lumon.',
        premiere_date: '2022-02-18',
    });
    mockGetMediaDetailByUuid.mockResolvedValue(null);
});

// ── Response shape → SeriesNodeSchema conformance ───────────────────────────

describe('GET /series/{id} response shape — validates against SeriesNodeSchema', () => {
    it('always includes seasons/episodes/nextEpisode/watchStatus links and validates', async () => {
        const res = await def.handlers.GET!(
            makeEvent({
                id: '11111111-1111-4111-8111-111111111111',
                resolvedInternalId: '11111111-1111-4111-8111-111111111111',
            }),
            CTX,
        );
        expect(res.status).toBe(200);
        const body = await res.json();

        // Before SeriesNodeSchema existed, the registered SeriesInfoResponseSchema
        // required `name`/`communityRating`/`genres`/etc. and would reject this
        // real payload outright.
        const parsed = SeriesNodeSchema.parse(body);
        expect(parsed.type).toBe('series');
        // CTX mounts this def on the INTERNAL surface, so every traversal link must
        // be an /api/... link. It used to assert /api/v1/... here — the def hardcoded
        // the v1 prefix, so a session client following the link got a 401.
        expect(parsed.seasons.href).toBe(
            '/api/series/11111111-1111-4111-8111-111111111111/seasons',
        );
        expect(parsed.episodes.href).toBe(
            '/api/series/11111111-1111-4111-8111-111111111111/episodes',
        );
        expect(parsed.nextEpisode.href).toBe(
            '/api/series/11111111-1111-4111-8111-111111111111/next-episode',
        );
        expect(parsed.watchStatus.href).toBe(
            '/api/series/11111111-1111-4111-8111-111111111111/watch-status',
        );
    });

    it('emits v1 traversal links for the SAME series when mounted on v1', async () => {
        const res = await def.handlers.GET!(
            makeEvent({
                id: '11111111-1111-4111-8111-111111111111',
                resolvedInternalId: '11111111-1111-4111-8111-111111111111',
            }),
            { surface: 'v1' as const },
        );
        expect(res.status).toBe(200);
        const parsed = SeriesNodeSchema.parse(await res.json());

        expect(parsed.seasons.href).toBe(
            '/api/v1/series/11111111-1111-4111-8111-111111111111/seasons',
        );
        expect(parsed.episodes.href).toBe(
            '/api/v1/series/11111111-1111-4111-8111-111111111111/episodes',
        );
        expect(parsed.nextEpisode.href).toBe(
            '/api/v1/series/11111111-1111-4111-8111-111111111111/next-episode',
        );
        expect(parsed.watchStatus.href).toBe(
            '/api/v1/series/11111111-1111-4111-8111-111111111111/watch-status',
        );
    });

    it('adds `details` (cast/genres/ratings/trailer) when ?include=details', async () => {
        mockGetMediaDetailByUuid.mockResolvedValue({
            media_id: '11111111-1111-4111-8111-111111111111',
            media_type: 'tv',
            title: 'Starhaven',
            overview: 'A team at Lumon.',
            release_date: '2022-02-18',
            genres: ['Drama', 'Mystery'],
            imdb_rating: 8.7,
            first_air_date: '2022-02-18',
            status: 'Continuing',
            season_count: 2,
            is_available: true,
            can_request: false,
        });

        const res = await def.handlers.GET!(
            makeEvent({
                id: '11111111-1111-4111-8111-111111111111',
                resolvedInternalId: '11111111-1111-4111-8111-111111111111',
                include: 'details',
            }),
            CTX,
        );
        expect(mockGetMediaDetailByUuid).toHaveBeenCalledWith(
            expect.anything(),
            '11111111-1111-4111-8111-111111111111',
        );

        const body = await res.json();
        const parsed = SeriesNodeSchema.parse(body);
        expect(parsed.details?.genres).toEqual(['Drama', 'Mystery']);
        expect(parsed.details?.status).toBe('Continuing');
        expect(parsed.details?.seasonCount).toBe(2);
        expect(parsed.details).not.toHaveProperty('id');
        expect(parsed.details).not.toHaveProperty('title');
    });

    it('omits `details` when ?include=details is absent', async () => {
        const res = await def.handlers.GET!(
            makeEvent({
                id: '11111111-1111-4111-8111-111111111111',
                resolvedInternalId: '11111111-1111-4111-8111-111111111111',
            }),
            CTX,
        );
        expect(mockGetMediaDetailByUuid).not.toHaveBeenCalled();
        const body = await res.json();
        expect(body).not.toHaveProperty('details');
    });
});

// ── GET handler — ID resolution fallback ───────────────────────────────────

describe('GET /series/{id} — ID resolution fallback (no locals.resolvedIds)', () => {
    it('resolves a composite external id via mediaIdResolver instead of 422ing', async () => {
        mockResolveAnyMediaId.mockResolvedValue({
            internalId: '11111111-1111-4111-8111-111111111111',
            source: 'composite',
        });

        const res = await def.handlers.GET!(makeEvent({ id: 'tmdb:1396:series' }), CTX);

        expect(mockResolveAnyMediaId).toHaveBeenCalledWith('tmdb:1396:series');
        expect(res.status).toBe(200);
    });

    it('maps "Invalid media ID format" resolver errors to 422 validation_failed', async () => {
        mockResolveAnyMediaId.mockRejectedValue(
            new Error('Invalid media ID format: bogus (expected UUID or provider:id:mediaType)'),
        );

        const res = await def.handlers.GET!(makeEvent({ id: 'bogus' }), CTX);
        expect(res.status).toBe(422);
    });

    it('maps "not found" resolver errors to 404', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('Media not found: tmdb:999999:series'));

        const res = await def.handlers.GET!(makeEvent({ id: 'tmdb:999999:series' }), CTX);
        expect(res.status).toBe(404);
    });

    it('maps "Database connection not available" resolver errors to 503', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('Database connection not available'));

        const res = await def.handlers.GET!(makeEvent({ id: 'tmdb:1:series' }), CTX);
        expect(res.status).toBe(503);
    });

    it('still fast-paths a bare UUID via locals.resolvedIds without consulting the resolver', async () => {
        const res = await def.handlers.GET!(
            makeEvent({
                id: '11111111-1111-4111-8111-111111111111',
                resolvedInternalId: '11111111-1111-4111-8111-111111111111',
            }),
            CTX,
        );
        expect(res.status).toBe(200);
        expect(mockResolveAnyMediaId).not.toHaveBeenCalled();
    });
});

describe('GET /series/{id} — image inheritance', () => {
    it.each([undefined, 'none'] as const)('passes inherit=%s to the resolver', async (inherit) => {
        const event = makeEvent({ id: 'series-uuid', resolvedInternalId: 'series-uuid', inherit });
        const response = await def.handlers.GET!(event, {
            ...CTX,
            input: {
                body: undefined,
                params: undefined,
                query: def.request!.query!.parse(Object.fromEntries(event.url.searchParams)),
            },
        });
        expect(response.status).toBe(200);
        expect(resolveImageSet).toHaveBeenCalledWith(
            mockGetDb(),
            'internal',
            'series-uuid',
            'series',
            inherit === 'none' ? { inherit: 'none' } : undefined,
        );
        expect(def.docs!.GET!.query!.parse({ inherit })).toEqual({ inherit });
    });
});
