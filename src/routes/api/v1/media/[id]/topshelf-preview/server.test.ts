// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security + routing tests for GET /api/v1/media/{id}/topshelf-preview (§9.3).
 *
 * All external dependencies are mocked — no live infrastructure required.
 * Named `server.test.ts` (never `+server.test.ts` — the `+` name is reserved
 * and only `vite build` catches it).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockConfig = vi.hoisted(() => ({
    FEATURE_TOPSHELF_PREVIEWS: true,
    TOPSHELF_MINT_RATE_LIMIT: 60,
    TOPSHELF_PREVIEW_URL_TTL_SECONDS: 172800,
}));
// Partial mock: keep the REAL config object (mount.ts's task/auth machinery
// reads many unrelated FEATURE_* keys transitively) and only override the
// keys this route cares about. FEATURE_TOPSHELF_PREVIEWS stays a live getter
// so tests can flip mockConfig.FEATURE_TOPSHELF_PREVIEWS at runtime.
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            ...actual.config,
            get FEATURE_TOPSHELF_PREVIEWS() {
                return mockConfig.FEATURE_TOPSHELF_PREVIEWS;
            },
            get TOPSHELF_MINT_RATE_LIMIT() {
                return mockConfig.TOPSHELF_MINT_RATE_LIMIT;
            },
            get TOPSHELF_PREVIEW_URL_TTL_SECONDS() {
                return mockConfig.TOPSHELF_PREVIEW_URL_TTL_SECONDS;
            },
        },
    };
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const mockGetDb = vi.fn().mockReturnValue({} as unknown);
vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => mockGetDb(),
}));

const mockCheckMediaAccess = vi.fn().mockResolvedValue(true);
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

const mockCheckRateLimit = vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 59, resetAt: 0, total: 60 });
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const mockResolveMediaIdByProvider = vi.fn().mockResolvedValue(null);
vi.mock('$lib/server/database/queries/resolvers/media-id.resolver.js', () => ({
    resolveMediaIdByProvider: (...args: unknown[]) => mockResolveMediaIdByProvider(...args),
}));

const mockSignUrl = vi.fn(
    (path: string, _opts?: unknown) =>
        `${path}?expires=9999999999&purpose=topshelf-preview&sig=deadbeef`,
);
vi.mock('$lib/server/utils/signed-url.js', () => ({
    signUrl: (...args: [string, unknown]) => mockSignUrl(...args),
}));

const mockGetVariantArtifact = vi.fn();
const mockTouch = vi.fn().mockResolvedValue(undefined);
vi.mock('$lib/server/services/topshelf/topshelf-artifact.store.js', () => ({
    getTopShelfArtifactStore: () => ({
        getVariantArtifact: (...args: unknown[]) => mockGetVariantArtifact(...args),
        touch: (...args: unknown[]) => mockTouch(...args),
    }),
}));

const mockResolveAndEnqueue = vi.fn().mockResolvedValue({ state: 'pending' });
const mockSelectTopShelfSource = vi.fn().mockResolvedValue({ status: 'unavailable' });
vi.mock('$lib/server/services/topshelf/topshelf-render.service.js', () => ({
    resolveAndEnqueueTopShelfVariant: (...args: unknown[]) => mockResolveAndEnqueue(...args),
    selectTopShelfSource: (...args: unknown[]) => mockSelectTopShelfSource(...args),
}));

const mockResolveOverlay = vi.fn().mockResolvedValue({ mode: 'none' });
vi.mock('$lib/server/services/topshelf/topshelf-overlay-resolver.js', () => ({
    resolveOverlay: (...args: unknown[]) => mockResolveOverlay(...args),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/media/[id]/topshelf-preview/index.js';

const ctx = { surface: 'v1' as const };
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeEvent(
    opts: {
        params?: Record<string, string>;
        authenticated?: boolean;
        username?: string;
        query?: Record<string, string>;
    } = {},
): RequestEvent {
    const url = new URL(`http://localhost/api/v1/media/${VALID_UUID}/topshelf-preview`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const authenticated = opts.authenticated ?? true;
    const user = authenticated
        ? {
              userId: toUserId(VALID_UUID),
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
          }
        : undefined;

    return {
        url,
        request: new Request(url.toString(), { method: 'GET' }),
        params: opts.params ?? { id: VALID_UUID },
        route: { id: '/test' as const },
        locals: user ? { user } : {},
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

interface MintBody {
    status: 'ready' | 'pending' | 'unavailable';
    previewVideoUrl?: string;
    cinemagraphUrl?: string;
    previewSource?: string;
    retryAfterSeconds?: number;
}

describe('GET /api/v1/media/{id}/topshelf-preview — security', () => {
    const { GET } = mount(def, ctx);

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.FEATURE_TOPSHELF_PREVIEWS = true;
        mockGetDb.mockReturnValue({});
        mockCheckMediaAccess.mockResolvedValue(true);
        mockCheckRateLimit.mockResolvedValue({
            allowed: true,
            remaining: 59,
            resetAt: 0,
            total: 60,
        });
        mockGetVariantArtifact.mockResolvedValue({ status: 'no_entry' });
        mockResolveAndEnqueue.mockResolvedValue({ state: 'pending' });
    });

    it('mint without auth is blocked (401/redirect per hooks — the def rejects unauthenticated)', async () => {
        const res = await GET!(makeEvent({ authenticated: false }));
        expect(res.status).toBe(401);
    });

    it('mint for an inaccessible item returns 404, never 403 (existence-leak rule)', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await GET!(makeEvent());
        expect(res.status).toBe(404);
        expect(await bodyCode(res)).toBe('not_found');
    });

    it('age-restricted user vs an 18-rated item returns 404 (checkMediaAccess composes both axes)', async () => {
        // checkMediaAccess is mocked as the composed gate — false covers both
        // the library-group axis AND the age-rating axis identically (404).
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await GET!(makeEvent());
        expect(res.status).toBe(404);
    });

    it('flag off → mint 404', async () => {
        mockConfig.FEATURE_TOPSHELF_PREVIEWS = false;
        const res = await GET!(makeEvent());
        expect(res.status).toBe(404);
        expect(mockCheckMediaAccess).not.toHaveBeenCalled();
    });

    it('returns 429 when the mint rate limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetAt: Math.floor(Date.now() / 1000) + 42,
            total: 60,
        });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(429);
        expect(await bodyCode(res)).toBe('rate_limited');
    });

    it('returns 503 when the database is unavailable', async () => {
        mockGetDb.mockReturnValue(null);
        const res = await GET!(makeEvent());
        expect(res.status).toBe(503);
        expect(await bodyCode(res)).toBe('dependency_unavailable');
    });

    it('returns 202 pending with Retry-After when no artifact is ready yet', async () => {
        mockGetVariantArtifact.mockResolvedValue({ status: 'no_entry' });
        mockResolveAndEnqueue.mockResolvedValue({ state: 'pending' });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(202);
        expect(res.headers.get('retry-after')).toBe('30');
        const body = (await res.json()) as MintBody;
        expect(body.status).toBe('pending');
        expect(body.retryAfterSeconds).toBe(30);
    });

    it('returns 200 unavailable when there is no renderable source', async () => {
        mockGetVariantArtifact.mockResolvedValue({ status: 'no_entry' });
        mockResolveAndEnqueue.mockResolvedValue({ state: 'unavailable' });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        const body = (await res.json()) as MintBody;
        expect(body.status).toBe('unavailable');
        expect(body.previewVideoUrl).toBeUndefined();
    });

    it('returns 200 ready with a signed preview URL when the artifact already exists', async () => {
        mockGetVariantArtifact.mockImplementation(async (_mediaId: string, variant: string) => {
            if (variant === 'preview') {
                return {
                    status: 'ready',
                    path: '/tmp/preview.mp4',
                    entry: {
                        contentKey: 'abc',
                        source: 'trailer',
                        bytes: 1,
                        createdAt: '',
                        lastRequestedAt: '',
                    },
                };
            }
            return { status: 'no_entry' };
        });
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        const body = (await res.json()) as MintBody;
        expect(body.status).toBe('ready');
        expect(body.previewSource).toBe('trailer');
        expect(body.previewVideoUrl).toContain('/topshelf-preview/file/preview.mp4');
        // The mint response's own URLs must be signed with the topshelf-preview purpose.
        expect(mockSignUrl).toHaveBeenCalledWith(
            expect.stringContaining(
                `/api/v1/media/${VALID_UUID}/topshelf-preview/file/preview.mp4`,
            ),
            expect.objectContaining({ purpose: 'topshelf-preview' }),
        );
    });

    it('touches lastRequestedAt for every variant found on disk', async () => {
        mockGetVariantArtifact.mockResolvedValue({
            status: 'ready',
            path: '/tmp/x.mp4',
            entry: {
                contentKey: 'abc',
                source: 'snippet',
                bytes: 1,
                createdAt: '',
                lastRequestedAt: '',
            },
        });
        await GET!(makeEvent());
        expect(mockTouch).toHaveBeenCalledWith(VALID_UUID, 'preview');
        expect(mockTouch).toHaveBeenCalledWith(VALID_UUID, 'cinemagraph');
    });

    describe('composite media id resolution (no unfiltered resolve on undisambiguable types)', () => {
        it('tmdb:1429:episode → 404 without ever calling the resolver unfiltered (TMDB id collision guard)', async () => {
            const res = await GET!(makeEvent({ params: { id: 'tmdb:1429:episode' } }));
            expect(res.status).toBe(404);
            expect(await bodyCode(res)).toBe('not_found');
            // The resolver must never be invoked at all for this composite —
            // that is precisely the unfiltered cross-type-collision lookup
            // this fix removes (TMDB 1429 is a movie AND a TV show).
            expect(mockResolveMediaIdByProvider).not.toHaveBeenCalled();
            // Access is never checked either — resolution never reached the
            // point of having a mediaId to gate.
            expect(mockCheckMediaAccess).not.toHaveBeenCalled();
        });

        it('tmdb:1429:season → 404 without calling the resolver', async () => {
            const res = await GET!(makeEvent({ params: { id: 'tmdb:1429:season' } }));
            expect(res.status).toBe(404);
            expect(mockResolveMediaIdByProvider).not.toHaveBeenCalled();
        });

        it('tmdb:550:movie still resolves and mints as before (regression guard)', async () => {
            mockResolveMediaIdByProvider.mockResolvedValue(VALID_UUID);
            mockGetVariantArtifact.mockImplementation(async (_mediaId: string, variant: string) => {
                if (variant === 'preview') {
                    return {
                        status: 'ready',
                        path: '/tmp/preview.mp4',
                        entry: {
                            contentKey: 'abc',
                            source: 'trailer',
                            bytes: 1,
                            createdAt: '',
                            lastRequestedAt: '',
                        },
                    };
                }
                return { status: 'no_entry' };
            });

            const res = await GET!(makeEvent({ params: { id: 'tmdb:550:movie' } }));

            expect(mockResolveMediaIdByProvider).toHaveBeenCalledWith(
                expect.anything(),
                'tmdb',
                '550',
                'movie',
            );
            expect(res.status).toBe(200);
            const body = (await res.json()) as MintBody;
            expect(body.status).toBe('ready');
            expect(body.previewVideoUrl).toContain(
                `/media/${VALID_UUID}/topshelf-preview/file/preview.mp4`,
            );
        });

        it('tmdb:1399:tv resolves with mediaType "tv" (series composite)', async () => {
            mockResolveMediaIdByProvider.mockResolvedValue(VALID_UUID);
            mockGetVariantArtifact.mockResolvedValue({ status: 'no_entry' });
            mockResolveAndEnqueue.mockResolvedValue({ state: 'unavailable' });

            const res = await GET!(makeEvent({ params: { id: 'tmdb:1399:tv' } }));

            expect(mockResolveMediaIdByProvider).toHaveBeenCalledWith(
                expect.anything(),
                'tmdb',
                '1399',
                'tv',
            );
            expect(res.status).toBe(200);
            const body = (await res.json()) as MintBody;
            expect(body.status).toBe('unavailable');
        });

        it('tmdb:1399:series (alias) also folds to mediaType "tv"', async () => {
            mockResolveMediaIdByProvider.mockResolvedValue(VALID_UUID);
            mockGetVariantArtifact.mockResolvedValue({ status: 'no_entry' });
            mockResolveAndEnqueue.mockResolvedValue({ state: 'unavailable' });

            const res = await GET!(makeEvent({ params: { id: 'tmdb:1399:series' } }));

            expect(mockResolveMediaIdByProvider).toHaveBeenCalledWith(
                expect.anything(),
                'tmdb',
                '1399',
                'tv',
            );
            expect(res.status).toBe(200);
        });
    });
});

describe('GET /api/v1/media/{id}/topshelf-preview — overlay mint', () => {
    const { GET } = mount(def, ctx);

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.FEATURE_TOPSHELF_PREVIEWS = true;
        mockGetDb.mockReturnValue({});
        mockCheckMediaAccess.mockResolvedValue(true);
        mockCheckRateLimit.mockResolvedValue({
            allowed: true,
            remaining: 59,
            resetAt: 0,
            total: 60,
        });
        mockGetVariantArtifact.mockResolvedValue({ status: 'no_entry' });
        mockResolveAndEnqueue.mockResolvedValue({ state: 'pending' });
        // Reconcile short-circuit: no source selection ⇒ no drift re-render.
        mockSelectTopShelfSource.mockResolvedValue({ status: 'unavailable' });
        mockResolveOverlay.mockResolvedValue({ mode: 'none' });
    });

    interface OverlayMintBody {
        status: 'ready' | 'pending' | 'unavailable';
        previewVideoUrl?: string;
        cinemagraphUrl?: string;
        overlay?: 'logo' | 'text' | 'none';
    }

    const readyEntry = (source: 'trailer' | 'snippet' = 'snippet') => ({
        status: 'ready' as const,
        path: '/tmp/x.mp4',
        entry: {
            contentKey: 'abcabcabcabcabc0',
            source,
            bytes: 1,
            createdAt: '',
            lastRequestedAt: '',
        },
    });

    it('returns overlay:"logo" and a compound-token signed URL when the logo artifact is ready', async () => {
        mockResolveOverlay.mockResolvedValue({ mode: 'logo', contentHash: 'aaaaaaaaaaaaaaaa' });
        mockGetVariantArtifact.mockImplementation(async (_mediaId: string, token: string) => {
            if (token === 'preview-ov-logo-tl-s1-x40') return readyEntry('trailer');
            return { status: 'no_entry' };
        });

        const res = await GET!(makeEvent({ query: { overlay: '1' } }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as OverlayMintBody;
        expect(body.overlay).toBe('logo');
        expect(body.previewVideoUrl).toContain('/preview-ov-logo-tl-s1-x40.mp4');
        // resolveOverlay is called only after the access gate has passed.
        expect(mockCheckMediaAccess).toHaveBeenCalled();
        expect(mockResolveOverlay).toHaveBeenCalled();
        expect(mockCheckMediaAccess.mock.invocationCallOrder[0]).toBeLessThan(
            mockResolveOverlay.mock.invocationCallOrder[0],
        );
    });

    it('falls to overlay:"text" when the logo artifact is not ready but the text artifact is', async () => {
        mockResolveOverlay.mockResolvedValue({ mode: 'logo', contentHash: 'aaaaaaaaaaaaaaaa' });
        // Logo token never ready; any text token is ready.
        mockGetVariantArtifact.mockImplementation(async (_mediaId: string, token: string) => {
            if (token.includes('-ov-text-')) return readyEntry('snippet');
            return { status: 'no_entry' };
        });

        const res = await GET!(makeEvent({ query: { overlay: '1' } }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as OverlayMintBody;
        expect(body.overlay).toBe('text');
        expect(body.previewVideoUrl).toContain('-ov-text-');
        // The logo render must still have been enqueued to retry in the background.
        expect(mockResolveAndEnqueue).toHaveBeenCalled();
    });

    it('is byte-identical to the plain path (no overlay field) when overlay is not requested', async () => {
        mockGetVariantArtifact.mockImplementation(async (_mediaId: string, variant: string) => {
            if (variant === 'preview') return readyEntry('trailer');
            return { status: 'no_entry' };
        });

        const res = await GET!(makeEvent());
        const body = (await res.json()) as OverlayMintBody;
        expect(body.status).toBe('ready');
        expect(body.overlay).toBeUndefined();
        expect(body.previewVideoUrl).toContain('/topshelf-preview/file/preview.mp4');
        expect(mockResolveOverlay).not.toHaveBeenCalled();
    });
});
