// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Named `server.test.ts`, NOT `+server.test.ts` — the `+` prefix is reserved by
 * SvelteKit for route modules, which may export only recognised names. `vite
 * build` rejects a `+server.test.ts`; vitest, eslint, and svelte-check would all
 * happily let it through, so the mistake would only surface in a prod build.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';

/** The exact event shape this route's own GET handler expects. */
type RouteEvent = Parameters<RequestHandler>[0];

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('$lib/server/config.js', () => ({ config: {}, features: {} }));

vi.mock('$lib/server/tasks/api-auth.js', () => ({
    authenticate: vi.fn(),
    requireScope: vi.fn(),
    scopeGranted: vi.fn(),
}));

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));

vi.mock('$lib/server/auth.js', () => ({ isUserAdmin: () => false }));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
}));

const mockGetArtistSummary = vi.fn();
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getArtistSummary: (...args: unknown[]) => mockGetArtistSummary(...args),
}));

const mockCheckMediaAccess = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const ARTIST = {
    id: 'artist-uuid',
    title: 'DJ Fenwick',
    custom_poster_url: '/poster.jpg',
    album_count: 3,
    track_count: 42,
    is_various_artists: false,
};

function makeEvent(id: string): RouteEvent {
    const url = new URL('http://localhost/api/music/artists/' + id + '/summary');
    return {
        url,
        request: new Request(url.toString()),
        params: { id },
        route: { id: '/api/music/artists/[id]/summary' as const },
        locals: {
            user: {
                userId: 'user-uuid' as ReturnType<typeof import('$lib/shared/user-id.js').toUserId>,
                username: 'testuser',
                groups: '',
                userGroups: [] as string[],
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                maxAgeRating: null as null | number,
                isAgeRestricted: false,
                isModerator: false,
                liveTvPriority: 'low' as const,
            },
        } as Partial<App.Locals> as App.Locals,
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn<typeof fetch>(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn<(headers: Record<string, string>) => void>(),
    } as Partial<RouteEvent> as RouteEvent;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/music/artists/[id]/summary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the summary for an accessible artist', async () => {
        mockGetArtistSummary.mockResolvedValue(ARTIST);
        mockCheckMediaAccess.mockResolvedValue(true);

        const { GET } = await import('./+server.js');
        const response = await GET!(makeEvent('artist-uuid'));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            id: ARTIST.id,
            title: ARTIST.title,
            type: 'artist',
            albumCount: ARTIST.album_count,
            trackCount: ARTIST.track_count,
        });
    });

    it('404s for an unknown id', async () => {
        mockGetArtistSummary.mockResolvedValue(null);
        mockCheckMediaAccess.mockResolvedValue(true);

        const { GET } = await import('./+server.js');
        const response = await GET!(makeEvent('nope'));

        expect(response.status).toBe(404);
    });

    it('404s — not 403 — for an artist outside the caller library scope', async () => {
        // The artist exists, but the caller may not see it. 403 would confirm
        // existence, turning the endpoint into a probe.
        mockGetArtistSummary.mockResolvedValue(ARTIST);
        mockCheckMediaAccess.mockResolvedValue(false);

        const { GET } = await import('./+server.js');
        const response = await GET!(makeEvent('artist-uuid'));

        expect(response.status).toBe(404);
    });

    it('does not leak the artist body when access is denied', async () => {
        mockGetArtistSummary.mockResolvedValue(ARTIST);
        mockCheckMediaAccess.mockResolvedValue(false);

        const { GET } = await import('./+server.js');
        const response = await GET!(makeEvent('artist-uuid'));

        await expect(response.text()).resolves.not.toContain('DJ Fenwick');
    });

    it('gates the id the caller asked for', async () => {
        mockGetArtistSummary.mockResolvedValue(ARTIST);
        mockCheckMediaAccess.mockResolvedValue(true);

        const { GET } = await import('./+server.js');
        await GET!(makeEvent('artist-uuid'));

        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            'artist-uuid',
            expect.objectContaining({ username: 'testuser' }),
        );
    });
});
