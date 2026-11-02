// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the media/{id}/images LISTING def (§7.1).
 *
 * Covers routing/auth/validation plus the inherited-presence contract: the
 * listing must report exactly the roles the byte route serves (parent-chain
 * inheritance) and surface the inherited `source` for local artwork. The
 * underlying DB queries are mocked.
 */

import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { buildImageSet } from '$lib/shared/image-descriptor.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('$lib/server/config.js', () => ({
    config: { FEATURE_DEVICE_AUTH: true },
}));
vi.mock('$lib/server/tasks/api-auth.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/tasks/api-auth.js')>();
    return { ...actual, authenticate: vi.fn(), requireScope: vi.fn(), scopeGranted: vi.fn() };
});
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/auth.js', () => ({ isUserAdmin: () => false }));

const mockCheckMediaAccess = vi.fn().mockResolvedValue(true);
const mockGetDb = vi.fn().mockReturnValue({} as unknown);
const mockResolveMediaIdByProvider = vi.fn().mockResolvedValue(null);
const mockGetMediaDetailsById = vi.fn();
const mockResolveImageSet = vi.fn();

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));
vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => mockGetDb(),
}));
vi.mock('$lib/server/database/queries/resolvers/media-id.resolver.js', () => ({
    resolveMediaIdByProvider: (...args: unknown[]) => mockResolveMediaIdByProvider(...args),
}));
vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaDetailsById: (...args: unknown[]) => mockGetMediaDetailsById(...args),
}));
vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSet: (...args: unknown[]) => mockResolveImageSet(...args),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def } from './index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ctx = { surface: 'v1' as const };
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

const ALL_ABSENT: ImageSet = {};

function makeEvent(
    opts: {
        params?: Record<string, string>;
        searchParams?: Record<string, string>;
        username?: string;
        userId?: string;
        anon?: boolean;
    } = {},
): RequestEvent {
    const url = new URL('http://localhost/test');
    for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
        url.searchParams.set(k, v);
    }
    const user = opts.anon
        ? { username: '' }
        : {
              userId: toUserId(opts.userId ?? VALID_UUID),
              username: opts.username ?? 'alice',
              groups: '',
              userGroups: [] as string[],
              hasWatchPermission: true,
              hasLiveTvPermission: false,
              hasRequestPermission: false,
              isAdmin: false,
              isModerator: false,
              maxAgeRating: null as null | number,
              isAgeRestricted: false,
              liveTvPriority: 'low' as const,
          };

    return {
        url,
        request: new Request(url.toString(), { method: 'GET' }),
        params: opts.params ?? {},
        route: { id: '/test' as const },
        locals: { user },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

async function bodyCode(res: Response): Promise<string> {
    const body = (await res.clone().json()) as { code: string };
    return body.code;
}

interface ListingBody {
    id: string;
    images: ImageSet;
}

describe('media images listing def', () => {
    const { GET } = mount(def, ctx);

    beforeEach(() => {
        vi.clearAllMocks();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetDb.mockReturnValue({});
        mockResolveMediaIdByProvider.mockResolvedValue(null);
        mockGetMediaDetailsById.mockResolvedValue({ media_type: 'movie' });
        mockResolveImageSet.mockResolvedValue(ALL_ABSENT);
    });

    it('is marked as public auth', () => {
        expect(def.auth).toEqual({ kind: 'public' });
    });

    it.each(['tmdb:603:movie', 'imdb:tt0133093', 'tvdb:81189:series'])(
        'denies anonymous external listing %s before resolution',
        async (id) => {
            mockResolveMediaIdByProvider.mockResolvedValue(VALID_UUID);
            const res = await GET!(makeEvent({ params: { id }, anon: true }));
            expect(res.status).toBe(401);
            expect(mockResolveMediaIdByProvider).not.toHaveBeenCalled();
            expect(mockResolveImageSet).not.toHaveBeenCalled();
        },
    );

    it('keeps anonymous internal UUID listings available', async () => {
        const event = makeEvent({ params: { id: VALID_UUID }, anon: true });
        event.locals = {} as RequestEvent['locals'];
        expect((await GET!(event)).status).toBe(200);
    });

    it('returns 422 when id is missing', async () => {
        const res = await GET!(makeEvent({ params: { id: '' } }));
        expect(res.status).toBe(422);
        expect(await bodyCode(res)).toBe('validation_failed');
    });

    it('returns 422 for a malformed (2-part) composite key', async () => {
        const res = await GET!(makeEvent({ params: { id: 'tmdb:603' } }));
        expect(res.status).toBe(422);
        expect(await bodyCode(res)).toBe('validation_failed');
    });

    it('returns 503 when DB is unavailable', async () => {
        mockGetDb.mockReturnValueOnce(null);
        const res = await GET!(makeEvent({ params: { id: VALID_UUID } }));
        expect(res.status).toBe(503);
        expect(await bodyCode(res)).toBe('dependency_unavailable');
    });

    it('returns 404 when the item does not exist', async () => {
        mockGetMediaDetailsById.mockResolvedValue(null);
        const res = await GET!(makeEvent({ params: { id: VALID_UUID } }));
        expect(res.status).toBe(404);
        expect(await bodyCode(res)).toBe('not_found');
    });

    it('returns 404 when authenticated user fails the access gate', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await GET!(makeEvent({ params: { id: VALID_UUID } }));
        expect(res.status).toBe(404);
        expect(await bodyCode(res)).toBe('not_found');
    });

    it('lists only roles that are present (inherited presence)', async () => {
        mockResolveImageSet.mockResolvedValue(
            buildImageSet('v1', {
                poster: { ownerId: VALID_UUID },
                backdrop: { ownerId: VALID_UUID },
            }),
        );
        const res = await GET!(makeEvent({ params: { id: VALID_UUID } }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as ListingBody;
        expect(body.id).toBe(VALID_UUID);
        expect(Object.keys(body.images).sort()).toEqual(['backdrop', 'poster']);
        // Revisioned href and advertised variants are present.
        expect(body.images.poster?.href).toBe(
            `/api/v1/media/${VALID_UUID}/images/poster?size=card&v=1`,
        );
        expect(body.images.poster).toHaveProperty('variants.full');
    });

    it('reports a role that is ONLY present via inheritance (matches byte route)', async () => {
        // The episode itself has no poster, but inherits one from its series —
        // the resolver supplies the owner descriptor, so the listing must too.
        mockResolveImageSet.mockResolvedValue(
            buildImageSet('v1', { poster: { ownerId: VALID_UUID } }),
        );
        const res = await GET!(makeEvent({ params: { id: VALID_UUID } }));
        const body = (await res.json()) as ListingBody;
        expect(body.images.poster).toBeDefined();
    });

    it('surfaces the inherited source for local artwork', async () => {
        mockResolveImageSet.mockResolvedValue(
            buildImageSet('v1', { backdrop: { ownerId: 'series-id', source: 'series' } }),
        );
        const res = await GET!(makeEvent({ params: { id: VALID_UUID } }));
        const body = (await res.json()) as ListingBody;
        expect(body.images.backdrop?.source).toBe('series');
    });

    it('reports self when the artwork belongs to the item', async () => {
        mockResolveImageSet.mockResolvedValue(
            buildImageSet('v1', { poster: { ownerId: VALID_UUID } }),
        );
        const res = await GET!(makeEvent({ params: { id: VALID_UUID } }));
        const body = (await res.json()) as ListingBody;
        expect(body.images.poster).toBeDefined();
        expect(body.images.poster?.source).toBe('self');
    });

    it('returns an empty images map when nothing is present', async () => {
        mockGetMediaDetailsById.mockResolvedValue({ media_type: 'movie' });
        mockResolveImageSet.mockResolvedValue(ALL_ABSENT);
        const res = await GET!(makeEvent({ params: { id: VALID_UUID } }));
        const body = (await res.json()) as ListingBody;
        expect(body.images).toEqual({});
    });

    it('resolves composite keys to an internal id before listing', async () => {
        mockResolveMediaIdByProvider.mockResolvedValue('resolved-uuid');
        mockResolveImageSet.mockResolvedValue(
            buildImageSet('v1', { poster: { ownerId: 'resolved-uuid' } }),
        );
        const res = await GET!(makeEvent({ params: { id: 'tmdb:603:movie' } }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as ListingBody;
        expect(body.id).toBe('resolved-uuid');
        expect(body.images.poster?.href).toBe(
            '/api/v1/media/resolved-uuid/images/poster?size=card&v=1',
        );
    });

    it('passes inherit=none to the resolver on both surfaces', async () => {
        for (const surface of ['v1', 'internal'] as const) {
            const { GET: get } = mount(def, { surface });
            const res = await get!(
                makeEvent({ params: { id: VALID_UUID }, searchParams: { inherit: 'none' } }),
            );
            expect(res.status).toBe(200);
            expect(mockResolveImageSet).toHaveBeenLastCalledWith({}, surface, VALID_UUID, 'movie', {
                inherit: 'none',
            });
        }
    });

    it('returns 404 for a composite key that does not resolve', async () => {
        mockResolveMediaIdByProvider.mockResolvedValue(null);
        const res = await GET!(makeEvent({ params: { id: 'tmdb:999999:movie' } }));
        expect(res.status).toBe(404);
        expect(await bodyCode(res)).toBe('not_found');
    });
});
