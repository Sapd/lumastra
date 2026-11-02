// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the image-serving domain defs.
 *
 * Covers the routing/auth/validation logic in each def; the underlying
 * service calls are mocked. Integration-level image proxy behaviour is
 * tested separately in src/routes/api/image/catalog/image-access-repro.
 */

import { requireImageProviderBudget } from '$lib/server/services/image-proxy/work-budget.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { EndpointDef } from '$lib/server/api/define.js';
import {
    adminSession,
    adminOwnersDeviceToken,
} from '$lib/server/api/principal-locals.test-helpers.js';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/middleware/valkey-rate-limit.js', async (original) => ({
    ...(await original<typeof import('$lib/server/middleware/valkey-rate-limit.js')>()),
    checkRateLimit: vi.fn(async () => ({
        allowed: true,
        total: 300,
        remaining: 299,
        resetAt: Math.floor(Date.now() / 1000) + 60,
    })),
}));
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { def as indexedMediaDef } from './media/[id]/images/[role]/[index].js';
import { def as indexedPeopleDef } from './people/[id]/images/[role]/[index].js';
import { def as indexedLibraryDef } from './libraries/[id]/images/[role]/[index].js';
import { def as libraryListDef } from './libraries/[id]/images/index.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

// Suppress logger output
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

// Image proxy service mock — swap out at the service level so tests don't need a DB
const mockGetImageByCatalogId = vi.fn().mockResolvedValue(null);
const mockGetImageByCompositeKey = vi.fn().mockResolvedValue(null);
const mockGetTmdbImage = vi.fn().mockResolvedValue({ buffer: Buffer.from('upstream') });
const mockGetJellyfinImage = vi.fn().mockResolvedValue({ buffer: Buffer.from('upstream') });
const mockGetPersonImage = vi.fn().mockResolvedValue(null);
const mockGetUserAvatar = vi.fn().mockResolvedValue(null);
const mockInvalidateAvatarCache = vi.fn().mockResolvedValue(undefined);

vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({
        getImageByCatalogId: mockGetImageByCatalogId,
        getTmdbImage: mockGetTmdbImage,
        getJellyfinImage: mockGetJellyfinImage,
        getImageByCompositeKey: mockGetImageByCompositeKey,
        cachedResolveMediaIdByProvider: mockResolveMediaIdByProvider,
        getPersonImage: mockGetPersonImage,
        getUserAvatar: mockGetUserAvatar,
        invalidateAvatarCache: mockInvalidateAvatarCache,
    }),
    imageResponse: (_result: unknown, _req: unknown) =>
        new Response('image-bytes', {
            headers: { 'Content-Type': 'image/webp' },
        }),
    PersonRateLimitError: class PersonRateLimitError extends Error {},
}));

// DB and access mocks
const mockGetDeniedLibraryGroups = vi.fn().mockResolvedValue(null);
vi.mock('$lib/server/cache/library-group-permissions-cache.js', async (original) => ({
    ...(await original<typeof import('$lib/server/cache/library-group-permissions-cache.js')>()),
    getDeniedLibraryGroups: (...args: unknown[]) => mockGetDeniedLibraryGroups(...args),
}));

const mockCheckMediaAccess = vi.fn().mockResolvedValue(true);
const mockGetDb = vi.fn().mockReturnValue({} as unknown);
const mockResolveMediaIdByProvider = vi.fn().mockResolvedValue(null);

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));
vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => mockGetDb(),
}));
vi.mock('$lib/server/database/queries/resolvers/media-id.resolver.js', () => ({
    resolveMediaIdByProvider: (...args: unknown[]) => mockResolveMediaIdByProvider(...args),
}));

// Signed URL mock
vi.mock('$lib/server/utils/signed-url.js', () => ({
    verifySignedUrl: vi.fn().mockReturnValue({ valid: true }),
}));

// Constants / params utilities — use real implementations
vi.mock('$lib/constants/images.js', () => ({
    FALLBACK_IMAGE: '/fallback.jpg',
}));

// Provider config for person routes
vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

// Library backdrop service
const mockIsLibraryGroup = vi.fn().mockResolvedValue(true);
const mockGetLibraryBackdrop = vi.fn().mockResolvedValue(null);
const mockGetLibraryPlaceholder = vi.fn().mockResolvedValue(null);

vi.mock('$lib/server/services/library-backdrop.service.js', () => ({
    isLibraryGroup: (...args: unknown[]) => mockIsLibraryGroup(...args),
    getLibraryBackdrop: (...args: unknown[]) => mockGetLibraryBackdrop(...args),
    getLibraryPlaceholder: (...args: unknown[]) => mockGetLibraryPlaceholder(...args),
}));

// User queries (for avatar PUT/DELETE)
const mockGetUserById = vi.fn().mockResolvedValue({ id: 'user-uuid', username: 'alice' });
const mockSetUserAvatar = vi.fn().mockResolvedValue(true);
const mockDeleteUserAvatar = vi.fn().mockResolvedValue(undefined);

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
    setUserAvatar: (...args: unknown[]) => mockSetUserAvatar(...args),
    deleteUserAvatar: (...args: unknown[]) => mockDeleteUserAvatar(...args),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def as mediaDef } from './media/[id]/images/[role].js';
import { def as peopleDef } from './people/[id]/images/[role].js';
import { def as usersDef } from './users/[id]/images/[role].js';
import { def as librariesDef } from './libraries/[id]/images/[role].js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ctx = { surface: 'v1' as const };
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeEvent(
    opts: {
        params?: Record<string, string>;
        searchParams?: Record<string, string>;
        username?: string;
        anonymous?: boolean;
        userId?: string;
        isAdmin?: boolean;
        method?: string;
        body?: BodyInit | null;
        /** Populated by resolveAuth in hooks for every request that presented a
         *  credential. NOTE: never populated for /api/v1 image paths — the
         *  middleware exempts them before it reads a token — so `headers` below
         *  is the realistic way a native client arrives here. */
        authMethod?: string;
        headers?: Record<string, string>;
    } = {},
): RequestEvent {
    const url = new URL('http://localhost/test');
    for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
        url.searchParams.set(k, v);
    }
    const uid = opts.userId ?? VALID_UUID;
    const user = {
        userId: toUserId(uid),
        username: opts.username ?? 'alice',
        groups: '',
        userGroups: [] as string[],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        isAdmin: opts.isAdmin ?? false,
        isModerator: false,
        maxAgeRating: null as null | number,
        isAgeRestricted: false,
        liveTvPriority: 'low' as const,
    };

    return {
        url,
        request: new Request(url.toString(), {
            method: opts.method ?? 'GET',
            body: opts.body,
            headers: opts.headers,
        }),
        params: opts.params ?? {},
        route: { id: '/test' as const },
        locals: { user: opts.anonymous ? undefined : user, authMethod: opts.authMethod },
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

// ── media/{id}/images/{role} ──────────────────────────────────────────────────

describe('media images def', () => {
    const { GET } = mount(mediaDef, ctx);

    beforeEach(() => {
        vi.clearAllMocks();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetDb.mockReturnValue({});
        mockGetImageByCatalogId.mockResolvedValue(null);
        mockGetImageByCompositeKey.mockResolvedValue(null);
        mockResolveMediaIdByProvider.mockResolvedValue(null);
    });

    it('is marked as public auth', () => {
        expect(mediaDef.auth).toEqual({ kind: 'public' });
    });
    it('is marked as raw (Class R)', () => {
        expect(mediaDef.raw).toBe(true);
    });

    it('returns 422 when id is missing', async () => {
        const res = await GET!(makeEvent({ params: { id: '', role: 'poster' } }));
        expect(res.status).toBe(422);
        expect(await bodyCode(res)).toBe('validation_failed');
    });

    it('returns 422 when role is invalid', async () => {
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'thumbnail' } }));
        expect(res.status).toBe(422);
        expect(await bodyCode(res)).toBe('validation_failed');
    });

    it('returns 422 when composite key is malformed (2-part)', async () => {
        const res = await GET!(makeEvent({ params: { id: 'tmdb:603', role: 'poster' } }));
        expect(res.status).toBe(422);
        expect(await bodyCode(res)).toBe('validation_failed');
    });

    it('serves placeholder BYTES to a browser when the image is missing', async () => {
        // Was a 302 to /placeholders/popcorn.jpg. That path is not on the edge's
        // API passthrough, so a token-authenticated client followed it into the
        // identity provider and got an HTML login page with status 200 — a blank
        // card with a success status and nothing to log. Bytes keep the answer on
        // the API surface, and cost a browser one round trip instead of two.
        mockGetImageByCatalogId.mockResolvedValue(null);
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'poster' } }));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/jpeg');
        expect(res.headers.get('location')).toBeNull();
    });

    it('LABELS the placeholder so a misclassified client cannot mistake it for art', async () => {
        // The one direction in which misclassification is NOT harmless. A
        // browser misread as native shows a broken-image icon — obvious. A
        // native client misread as a browser decodes the popcorn fine and may
        // store it as real artwork: a wrong image that looks like success at
        // every layer, worse than the blank card this replaced.
        //
        // Reachable, not theoretical: authMethod is undefined for an anonymous
        // request AND for a `?sig=` signed URL, because the signature is checked
        // inside the route rather than by the auth middleware. A native client
        // using signed image URLs lands here.
        //
        // So the response says what it is, and refuses to be cached. Neither
        // depends on classifying the caller correctly.
        mockGetImageByCatalogId.mockResolvedValue(null);
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'poster' } }));
        expect(res.headers.get('x-lumastra-placeholder')).toBe('1');
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('labels the native 404 too, so both branches are self-describing', async () => {
        mockGetImageByCatalogId.mockResolvedValue(null);
        const res = await GET!(
            makeEvent({ params: { id: VALID_UUID, role: 'poster' }, authMethod: 'bearer' }),
        );
        expect(res.status).toBe(404);
        expect(res.headers.get('x-lumastra-placeholder')).toBe('1');
    });

    it('answers a native client with 404, matching every sibling image route', async () => {
        // A bearer/PAT caller wants to know there is no artwork so it can draw
        // its own fallback; a picture it did not ask for is not an answer.
        mockGetImageByCatalogId.mockResolvedValue(null);
        const res = await GET!(
            makeEvent({ params: { id: VALID_UUID, role: 'poster' }, authMethod: 'pat' }),
        );
        expect(res.status).toBe(404);
        expect(res.headers.get('location')).toBeNull();
    });

    it('treats a PRESENTED bearer credential as native, with authMethod unset', async () => {
        // The realistic native request, and the one the first cut got wrong.
        // handlePublicApiAuth exempts every /api/v1 path containing '/images/'
        // (the ?sig= embed carve-out) and returns BEFORE the block that reads
        // Authorization and assigns authMethod. So on the surface native clients
        // actually use, locals.authMethod is ALWAYS undefined — the earlier
        // authMethod:'bearer' tests describe a state the middleware never
        // produces here, and the native branch was dead in production.
        mockGetImageByCatalogId.mockResolvedValue(null);
        const res = await GET!(
            makeEvent({
                params: { id: VALID_UUID, role: 'poster' },
                headers: { Authorization: 'Bearer abc.def.ghi' },
            }),
        );
        expect(res.status).toBe(404);
    });

    it('treats ?api_key= as native — AVPlayer and Top Shelf cannot set headers', async () => {
        // The tvOS Top Shelf extension is a separate process with no way to add
        // an Authorization header, so its image URLs carry the token in the
        // query string. Without this it would classify as a browser.
        mockGetImageByCatalogId.mockResolvedValue(null);
        const res = await GET!(
            makeEvent({
                params: { id: VALID_UUID, role: 'poster' },
                searchParams: { api_key: 'eyJhbGciOi' },
            }),
        );
        expect(res.status).toBe(404);
    });

    it('does NOT treat ?sig= as native — a signed URL is a public embed', async () => {
        // Signed URLs appear in <img> tags, so a signature is not evidence of a
        // native caller. This request keeps getting bytes, which is precisely
        // the residual case the label exists for.
        mockGetImageByCatalogId.mockResolvedValue(null);
        const res = await GET!(
            makeEvent({
                params: { id: VALID_UUID, role: 'poster' },
                searchParams: { sig: 'valid-per-the-mock-at-the-top-of-this-file' },
            }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('x-lumastra-placeholder')).toBe('1');
    });

    it('never answers a miss with a redirect, whatever the client is', async () => {
        // THE property. The fix does not depend on classifying the caller
        // correctly: a misclassified native client gets popcorn (harmless) and a
        // misclassified browser gets a 404 (broken-image icon). Neither branch
        // can produce an HTML login page with a 200, because neither leaves the
        // API surface.
        mockGetImageByCatalogId.mockResolvedValue(null);
        for (const authMethod of [undefined, 'session', 'forward_auth', 'pat', 'bearer']) {
            const res = await GET!(
                makeEvent({ params: { id: VALID_UUID, role: 'poster' }, authMethod }),
            );
            expect({ authMethod, status: res.status }).not.toEqual({ authMethod, status: 302 });
            expect({ authMethod, loc: res.headers.get('location') }).toEqual({
                authMethod,
                loc: null,
            });
        }
    });

    it('returns 404 when fallback=none and image not found', async () => {
        mockGetImageByCatalogId.mockResolvedValue(null);
        const res = await GET!(
            makeEvent({
                params: { id: VALID_UUID, role: 'poster' },
                searchParams: { fallback: 'none' },
            }),
        );
        expect(res.status).toBe(404);
    });

    it('returns image response when UUID image is found', async () => {
        mockGetImageByCatalogId.mockResolvedValue({
            buffer: Buffer.from('img'),
            contentType: 'image/webp',
            cacheControl: 'public',
        });
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'poster' } }));
        expect(res.status).toBe(200);
    });

    it('returns 404 when media access check fails for authenticated user (existence leak guard)', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'poster' } }));
        expect(res.status).toBe(404);
        expect(await bodyCode(res)).toBe('not_found');
    });

    it('serves composite key images without access gate when item not in library', async () => {
        // resolveMediaIdByProvider returns null → no access gate → serve
        mockResolveMediaIdByProvider.mockResolvedValue(null);
        mockGetImageByCompositeKey.mockResolvedValue({
            buffer: Buffer.from('img'),
            contentType: 'image/webp',
            cacheControl: 'public',
        });
        const res = await GET!(makeEvent({ params: { id: 'tmdb:603:movie', role: 'poster' } }));
        expect(res.status).toBe(200);
    });

    it.each(['tmdb:603:movie', 'imdb:tt0133093', 'tvdb:81189:series', 'TMDB:603:episode'])(
        'denies anonymous external artwork %s before resolution',
        async (id) => {
            mockGetImageByCompositeKey.mockResolvedValue({ buffer: Buffer.from('art') });
            const res = await GET!(makeEvent({ params: { id, role: 'poster' }, anonymous: true }));
            expect(res.status).toBe(401);
            expect(mockResolveMediaIdByProvider).not.toHaveBeenCalled();
            expect(mockGetImageByCompositeKey).not.toHaveBeenCalled();
        },
    );

    it('denies the query alias and indexed external-id route anonymously', async () => {
        expect(
            (
                await GET!(
                    makeEvent({
                        params: { role: 'poster' },
                        searchParams: { externalId: 'tmdb:603:movie' },
                        anonymous: true,
                    }),
                )
            ).status,
        ).toBe(401);
        const { GET: indexed } = mount(indexedMediaDef, ctx);
        expect(
            (
                await indexed!(
                    makeEvent({
                        params: { id: 'tmdb:603:movie', role: 'poster', index: '0' },
                        anonymous: true,
                    }),
                )
            ).status,
        ).toBe(401);
    });

    it('denies unresolved discovery artwork for a kid and unresolved episode artwork for everyone', async () => {
        mockGetImageByCompositeKey.mockResolvedValue({ buffer: Buffer.from('art') });
        const event = makeEvent({ params: { id: 'tmdb:603:movie', role: 'poster' } });
        event.locals.user!.isAgeRestricted = true;
        event.locals.user!.maxAgeRating = 12;
        expect((await GET!(event)).status).toBe(404);
        expect(
            (await GET!(makeEvent({ params: { id: 'tmdb:603:episode', role: 'still' } }))).status,
        ).toBe(404);
        expect(mockGetImageByCompositeKey).not.toHaveBeenCalled();
    });

    it.each(['0550', '550junk', '+550', '550.0', '9007199254740993'])(
        'does not reinterpret TMDB %s after a local lookup miss',
        async (id) => {
            mockGetImageByCompositeKey.mockResolvedValue({ buffer: Buffer.from('art') });
            expect(
                (await GET!(makeEvent({ params: { id: `tmdb:${id}:movie`, role: 'poster' } })))
                    .status,
            ).toBe(404);
            expect(mockGetTmdbImage).not.toHaveBeenCalled();
            expect(mockGetImageByCompositeKey).not.toHaveBeenCalled();
        },
    );

    it('a library-restricted viewer cannot distinguish hidden titles from upstream discovery misses', async () => {
        mockGetDeniedLibraryGroups.mockResolvedValueOnce(['hidden-library']);
        const res = await GET!(makeEvent({ params: { id: 'tmdb:603:movie', role: 'poster' } }));
        expect(res.status).toBe(404);
        expect(mockGetTmdbImage).not.toHaveBeenCalled();
    });

    it('discovery fetches upstream directly, without a second local resolver', async () => {
        expect(
            (await GET!(makeEvent({ params: { id: 'tmdb:603:movie', role: 'poster' } }))).status,
        ).toBe(200);
        expect(mockGetTmdbImage).toHaveBeenCalledWith('603', 'movie', 'poster', expect.any(Object));
        expect(mockGetImageByCompositeKey).not.toHaveBeenCalled();
    });

    it('discovery inherit=none cannot re-resolve a stale cached mapping', async () => {
        mockGetImageByCompositeKey.mockResolvedValue({ buffer: Buffer.from('denied art') });
        const res = await GET!(
            makeEvent({
                params: { id: 'tmdb:603:movie', role: 'poster' },
                searchParams: { inherit: 'none' },
            }),
        );
        expect(res.status).toBe(404);
        expect(mockGetImageByCompositeKey).not.toHaveBeenCalled();
        expect(mockGetTmdbImage).not.toHaveBeenCalled();
    });

    it('preserves the episode-order preview direct TMDB filename without local re-resolution', async () => {
        const event = makeEvent({
            params: { id: 'tmdb:603:episode', role: 'still' },
            searchParams: { path: '/preview.jpg' },
        });
        expect((await GET!(event)).status).toBe(200);
        expect(mockGetTmdbImage).toHaveBeenCalledWith(
            '603',
            'episode',
            'still',
            expect.objectContaining({ path: '/preview.jpg' }),
        );
        expect(mockGetImageByCompositeKey).not.toHaveBeenCalled();
        event.locals.user!.isAgeRestricted = true;
        expect((await GET!(event)).status).toBe(404);
    });

    it('preserves explicit admin-only unmapped Jellyfin artwork', async () => {
        const id = `jellyfin:${VALID_UUID}:movie`;
        const event = makeEvent({ params: { id, role: 'poster' } });
        event.locals = adminSession();
        expect((await GET!(event)).status).toBe(200);
        expect(mockGetJellyfinImage).toHaveBeenCalledWith(VALID_UUID, 'poster', expect.any(Object));
        mockGetJellyfinImage.mockClear();
        event.locals = adminOwnersDeviceToken();
        expect((await GET!(event)).status).toBe(404);
        expect(mockGetJellyfinImage).not.toHaveBeenCalled();
    });

    it('a signature alone cannot authorize an external-id lookup', async () => {
        const res = await GET!(
            makeEvent({
                params: { id: 'tmdb:603:movie', role: 'poster' },
                anonymous: true,
                searchParams: { sig: 'valid' },
            }),
        );
        expect(res.status).toBe(401);
    });

    it('keeps anonymous internal UUID artwork available', async () => {
        mockGetImageByCatalogId.mockResolvedValue({ buffer: Buffer.from('art') });
        const res = await GET!(
            makeEvent({ params: { id: VALID_UUID, role: 'poster' }, anonymous: true }),
        );
        expect(res.status).toBe(200);
        expect(mockCheckMediaAccess).not.toHaveBeenCalled();
    });

    it('gates and serves the exact resolved episode, retaining its type discriminator', async () => {
        mockResolveMediaIdByProvider.mockResolvedValue(VALID_UUID);
        mockGetImageByCatalogId.mockResolvedValue({ buffer: Buffer.from('art') });
        const res = await GET!(makeEvent({ params: { id: 'tmdb:603:episode', role: 'still' } }));
        expect(res.status).toBe(200);
        expect(mockResolveMediaIdByProvider).toHaveBeenCalledWith({}, 'tmdb', '603', 'episode');
        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            {},
            VALID_UUID,
            expect.objectContaining({ username: 'alice' }),
        );
        expect(mockGetImageByCatalogId).toHaveBeenCalledWith(
            VALID_UUID,
            'still',
            expect.any(Object),
        );
        expect(mockGetImageByCompositeKey).not.toHaveBeenCalled();
    });

    it('returns 403 when ?sig= is provided but invalid', async () => {
        const { verifySignedUrl } = await import('$lib/server/utils/signed-url.js');
        vi.mocked(verifySignedUrl).mockReturnValueOnce({ valid: false, reason: 'expired' });
        const res = await GET!(
            makeEvent({
                params: { id: VALID_UUID, role: 'poster' },
                searchParams: { sig: 'bad-sig' },
            }),
        );
        expect(res.status).toBe(403);
        expect(await bodyCode(res)).toBe('forbidden');
    });
});

// ── people/{id}/images/{role} ─────────────────────────────────────────────────

describe('people images def', () => {
    const { GET } = mount(peopleDef, ctx);

    beforeEach(() => vi.clearAllMocks());

    it('auth is user-gated', () => {
        expect(peopleDef.auth).toEqual({ kind: 'user' });
    });
    it('is marked as raw (Class R)', () => {
        expect(peopleDef.raw).toBe(true);
    });

    it('returns 401 for unauthenticated request', async () => {
        const event = makeEvent({ params: { id: '12345', role: 'profile' }, username: '' });
        (event.locals as unknown as Record<string, unknown>).user = { username: '' };
        const res = await GET!(event);
        expect(res.status).toBe(401);
    });

    it('returns 404 for any role other than profile', async () => {
        const res = await GET!(makeEvent({ params: { id: '12345', role: 'poster' } }));
        expect(res.status).toBe(404);
    });

    it('returns 422 for non-numeric person ID', async () => {
        const res = await GET!(makeEvent({ params: { id: 'not-a-number', role: 'profile' } }));
        expect(res.status).toBe(422);
    });

    it('returns 422 for unsupported provider prefix', async () => {
        const res = await GET!(makeEvent({ params: { id: 'tmdb:not-a-number', role: 'profile' } }));
        expect(res.status).toBe(422);
    });

    it('returns 404 when person image is not found', async () => {
        mockGetPersonImage.mockResolvedValue(null);
        const res = await GET!(makeEvent({ params: { id: '12345', role: 'profile' } }));
        expect(res.status).toBe(404);
    });

    it('returns image when found', async () => {
        mockGetPersonImage.mockResolvedValue({
            buffer: Buffer.from('person'),
            contentType: 'image/jpeg',
            cacheControl: 'public',
        });
        const res = await GET!(makeEvent({ params: { id: '12345', role: 'profile' } }));
        expect(res.status).toBe(200);
    });

    it('accepts tmdb: prefixed person ID', async () => {
        mockGetPersonImage.mockResolvedValue({
            buffer: Buffer.from('person'),
            contentType: 'image/jpeg',
            cacheControl: 'public',
        });
        const res = await GET!(makeEvent({ params: { id: 'tmdb:12345', role: 'profile' } }));
        expect(res.status).toBe(200);
        expect(mockGetPersonImage).toHaveBeenCalledWith('12345', expect.any(Object));
    });
});

// ── users/{id}/images/{role} ──────────────────────────────────────────────────

describe('users images def — GET (authenticated)', () => {
    const { GET } = mount(usersDef, ctx);

    beforeEach(() => vi.clearAllMocks());

    it('returns 404 for any role other than avatar', async () => {
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'poster' } }));
        expect(res.status).toBe(404);
    });

    it('returns 404 when no avatar exists', async () => {
        mockGetUserAvatar.mockResolvedValue(null);
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'avatar' } }));
        expect(res.status).toBe(404);
    });

    it('answers a miss with the initials SVG when the web client asks for ?fallback=initials', async () => {
        mockGetUserAvatar.mockResolvedValue(null);
        const res = await GET!(
            makeEvent({
                params: { id: 'denis', role: 'avatar' },
                searchParams: { fallback: 'initials', width: '96' },
            }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
        expect(res.headers.get('cache-control')).toBe('private, max-age=300');
        expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
        const svg = await res.text();
        expect(svg).toContain('<svg');
        expect(svg).toContain('DE');
    });

    it('never puts a resolved username into the fallback for a UUID handle', async () => {
        mockGetUserAvatar.mockResolvedValue(null);
        const res = await GET!(
            makeEvent({
                params: { id: VALID_UUID, role: 'avatar' },
                searchParams: { fallback: 'initials' },
            }),
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toMatch(/>\s*\?\s*<\/text>/);
    });

    it('still serves the real avatar when one exists, fallback or not', async () => {
        mockGetUserAvatar.mockResolvedValue({
            buffer: Buffer.from('avatar'),
            contentType: 'image/webp',
            cacheControl: 'public',
        });
        const res = await GET!(
            makeEvent({
                params: { id: 'denis', role: 'avatar' },
                searchParams: { fallback: 'initials' },
            }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
    });

    it('answers an unauthenticated request with 401, never the avatar (see [role].auth.test.ts)', async () => {
        mockGetUserAvatar.mockResolvedValue({
            buffer: Buffer.from('avatar'),
            contentType: 'image/webp',
            cacheControl: 'public',
        });
        // Simulate anon request by giving an empty username
        const event = makeEvent({ params: { id: VALID_UUID, role: 'avatar' }, username: '' });
        (event.locals as unknown as Record<string, unknown>).user = { username: '' };
        const res = await GET!(event);
        expect(res.status).toBe(401);
        expect(mockGetUserAvatar).not.toHaveBeenCalled();
    });
});

describe('users images def — PUT (selfOrAdmin)', () => {
    const { PUT } = mount(usersDef, ctx);

    beforeEach(() => vi.clearAllMocks());

    it('returns 401 for unauthenticated PUT', async () => {
        const event = makeEvent({
            params: { id: VALID_UUID, role: 'avatar' },
            username: '',
            method: 'PUT',
        });
        (event.locals as unknown as Record<string, unknown>).user = { username: '' };
        const res = await PUT!(event);
        expect(res.status).toBe(401);
    });

    it('returns 404 for role other than avatar (when accessing own account)', async () => {
        // user's UUID matches the target {id} → passes self-or-admin check
        // then hits the role guard → 404
        const res = await PUT!(
            makeEvent({
                params: { id: VALID_UUID, role: 'poster' },
                userId: VALID_UUID,
                method: 'PUT',
            }),
        );
        expect(res.status).toBe(404);
    });

    it('returns 403 when accessing another user as non-admin', async () => {
        const OTHER_UUID = 'aaaaaaaa-0000-0000-0000-000000000000';
        const res = await PUT!(
            makeEvent({
                params: { id: OTHER_UUID, role: 'avatar' },
                userId: VALID_UUID,
                isAdmin: false,
                method: 'PUT',
            }),
        );
        // user → passes mount auth; handler's self-or-admin check → 403
        expect(res.status).toBe(403);
    });
});

// ── libraries/{id}/images/{role} ──────────────────────────────────────────────

describe('libraries images def', () => {
    const { GET } = mount(librariesDef, ctx);

    beforeEach(() => {
        vi.clearAllMocks();
        mockIsLibraryGroup.mockResolvedValue(true);
        mockGetLibraryBackdrop.mockResolvedValue(null);
        mockGetLibraryPlaceholder.mockResolvedValue(null);
    });

    it('auth is user-gated', () => {
        expect(librariesDef.auth).toEqual({ kind: 'user' });
    });
    it('is marked as raw (Class R)', () => {
        expect(librariesDef.raw).toBe(true);
    });

    it('returns 422 for non-UUID library id', async () => {
        const res = await GET!(makeEvent({ params: { id: 'not-a-uuid', role: 'backdrop' } }));
        expect(res.status).toBe(422);
        expect(await bodyCode(res)).toBe('validation_failed');
    });

    it('returns 422 for invalid role', async () => {
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'invalid-role' } }));
        expect(res.status).toBe(422);
        expect(await bodyCode(res)).toBe('validation_failed');
    });

    it('returns 404 when library does not exist', async () => {
        mockIsLibraryGroup.mockResolvedValue(false);
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'backdrop' } }));
        expect(res.status).toBe(404);
        expect(await bodyCode(res)).toBe('not_found');
    });

    it('returns 404 when no image is available', async () => {
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'backdrop' } }));
        expect(res.status).toBe(404);
        expect(await bodyCode(res)).toBe('not_found');
    });

    it('returns image with ETag when backdrop is available', async () => {
        const mockBuffer = Buffer.from('webp-image');
        mockGetLibraryBackdrop.mockResolvedValue({
            buffer: mockBuffer,
            contentType: 'image/webp',
            contentHash: 'abc123',
        });
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'backdrop' } }));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
        // The validator is per size variant (default size = full).
        expect(res.headers.get('etag')).toBe('"abc123-full"');
    });

    it('returns 304 when ETag matches', async () => {
        mockGetLibraryBackdrop.mockResolvedValue({
            buffer: Buffer.from('webp-image'),
            contentType: 'image/webp',
            contentHash: 'abc123',
        });
        const event = makeEvent({ params: { id: VALID_UUID, role: 'backdrop' } });
        (event.request.headers as Headers).set('if-none-match', '"abc123-full"');
        const res = await GET!(event);
        expect(res.status).toBe(304);
    });

    it('returns 503 when DB is unavailable', async () => {
        mockGetDb.mockReturnValueOnce(null);
        const res = await GET!(makeEvent({ params: { id: VALID_UUID, role: 'backdrop' } }));
        expect(res.status).toBe(503);
        expect(await bodyCode(res)).toBe('dependency_unavailable');
    });
});

describe('image abuse bounds', () => {
    beforeEach(() => {
        vi.mocked(checkRateLimit)
            .mockClear()
            .mockResolvedValue({
                allowed: true,
                total: 300,
                remaining: 299,
                resetAt: Math.floor(Date.now() / 1000) + 60,
            });
        mockGetImageByCompositeKey.mockClear().mockResolvedValue(null);
        mockGetTmdbImage.mockClear();
        mockResolveMediaIdByProvider.mockResolvedValue(null);
    });
    it.each([
        ['media', mediaDef],
        ['media index', indexedMediaDef],
        ['people', peopleDef],
        ['people index', indexedPeopleDef],
        ['library', librariesDef],
        ['library index', indexedLibraryDef],
        ['library list', libraryListDef],
    ])(
        '%s does not charge requests served without provider work on either mount',
        async (_name, def) => {
            vi.mocked(checkRateLimit).mockResolvedValue({
                allowed: false,
                total: 2000,
                remaining: 0,
                resetAt: Math.floor(Date.now() / 1000) + 60,
            });
            for (const surface of ['internal', 'v1'] as const) {
                await mount(def, { surface }).GET!(
                    makeEvent({ params: { id: VALID_UUID, role: 'poster', index: '0' } }),
                );
            }
            expect(checkRateLimit).not.toHaveBeenCalled();
        },
    );
    it.each([false, true])(
        'charges provider work with the correct budget (anonymous=%s)',
        async (anonymous) => {
            mockGetImageByCatalogId.mockImplementationOnce(async () => {
                await requireImageProviderBudget();
                await requireImageProviderBudget(); // one charge even across provider fallbacks
                return null;
            });
            const res = await mount(mediaDef, { surface: 'v1' }).GET!(
                makeEvent({ anonymous, params: { id: VALID_UUID, role: 'poster' } }),
            );
            expect(res.status).not.toBe(429);
            expect(checkRateLimit).toHaveBeenCalledExactlyOnceWith(
                expect.stringContaining(anonymous ? 'image-proxy:ip:' : 'image-proxy:user:'),
                anonymous ? 300 : 2000,
                60,
            );
        },
    );
    it.each(['internal', 'v1'] as const)(
        'rejects provider work before fetching on %s',
        async (surface) => {
            vi.mocked(checkRateLimit).mockResolvedValue({
                allowed: false,
                total: 2000,
                remaining: 0,
                resetAt: Math.floor(Date.now() / 1000) + 60,
            });
            const upstream = vi.fn();
            mockGetImageByCatalogId.mockImplementationOnce(async () => {
                try {
                    await requireImageProviderBudget();
                    upstream();
                } catch {
                    // Image providers catch failures and try another source or return null.
                }
                return null;
            });
            const res = await mount(mediaDef, { surface }).GET!(
                makeEvent({ params: { id: VALID_UUID, role: 'poster' } }),
            );
            expect(res.status).toBe(429);
            expect(res.headers.get('retry-after')).toBeTruthy();
            expect(upstream).not.toHaveBeenCalled();
        },
    );
    it('anonymous callers are keyed by IP, authenticated callers by user across routes and surfaces', async () => {
        const key = (def: EndpointDef, ev: RequestEvent): string => def.rateLimit!.keyBy!(ev);
        const first = makeEvent({ anonymous: true });
        const second = makeEvent({ anonymous: true });
        second.getClientAddress = () => '192.0.2.2';
        expect(key(mediaDef, first)).not.toBe(key(mediaDef, second));
        const anonymousKey = key(mediaDef, first);
        first.request = new Request(first.request.url, {
            headers: { 'X-Forwarded-For': '203.0.113.99' },
        });
        expect(key(mediaDef, first)).toBe(anonymousKey);
        const alice = makeEvent({ userId: '11111111-1111-4111-8111-111111111111' });
        const bob = makeEvent({ userId: '22222222-2222-4222-8222-222222222222' });
        expect(key(mediaDef, alice)).not.toBe(key(mediaDef, bob));
        expect(key(mediaDef, alice)).toBe(key(peopleDef, alice));
        alice.getClientAddress = () => '192.0.2.3';
        expect(key(mediaDef, alice)).toBe(
            key(librariesDef, makeEvent({ userId: '11111111-1111-4111-8111-111111111111' })),
        );
    });
    it.each([
        'https://evil.example/a.jpg',
        '//evil.example/a.jpg',
        '/../../secret.jpg',
        '/%2e%2e/secret.jpg',
        '/a.jpg?x=1',
        '/a.jpg#frag',
        '/tmp/a.jpg',
        'file:///etc/passwd',
        '/a\\b.jpg',
    ])('rejects unsafe provider path %s before service access', async (path) => {
        const ev = makeEvent({
            params: { id: 'tmdb:603:movie', role: 'poster', index: '0' },
            searchParams: { path },
        });
        for (const def of [mediaDef, indexedMediaDef]) {
            const res = await mount(def, { surface: 'v1' }).GET!(ev);
            expect(res.status).toBe(422);
        }
        expect(mockGetImageByCompositeKey).not.toHaveBeenCalled();
    });
    it.each(['true', 'false'])('bounds all width variants even with exact=%s', async (exact) => {
        const widths = new Set<string>();
        for (const width of [1, 2, 100, 101, 601, 602, 777, 778, 2401, 2402, 3839, 3840]) {
            await mediaDef.handlers.GET!(
                makeEvent({
                    params: { id: 'tmdb:603:movie', role: 'poster' },
                    searchParams: { width: String(width), exact },
                }),
                ctx as never,
            );
            const options = mockGetTmdbImage.mock.calls.at(-1)![3];
            widths.add(options.maxWidth ?? options.size);
        }
        expect(widths.size).toBeLessThanOrEqual(8);
    });
});
