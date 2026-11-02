// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/catalog/media-id-viewers.ts (GET media/{id}/viewers).
 *
 * Covers H9-b: the emitted avatar href must match a route that actually exists
 * ON THE REQUESTING SURFACE. It used to emit `/api/image/user/{username}/avatar`,
 * which has no /api/v1 counterpart, so v1 clients could not resolve an avatar at
 * all. It now uses `{prefix}/users/{id}/images/avatar`, keyed by the viewer's
 * UUID — ImageProxyService.getUserAvatar resolves a GUID to its username before
 * the underlying (username-only) query runs, so it works on both surfaces.
 *
 * Also covers the login-handle removal: viewers render on a shared
 * living-room TV screen, so the response ships `displayName`, never
 * `username`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

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
const mockGetMediaViewers = vi.fn();
const mockGetCurrentUserWatchState = vi.fn();
const mockFeatures: { social: boolean } = { social: true };

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
}));

vi.mock('$lib/server/database/queries/social.queries.js', () => ({
    getMediaViewers: (...args: unknown[]) => mockGetMediaViewers(...args),
    getCurrentUserWatchState: (...args: unknown[]) => mockGetCurrentUserWatchState(...args),
}));

vi.mock('./resolve-id.js', () => ({
    resolveCatalogInternalId: (...args: unknown[]) => mockResolveCatalogInternalId(...args),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

const { def } = await import('./media-id-viewers.js');
const { mount } = await import('$lib/server/api/mount.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(username = 'alice', search = ''): RequestEvent {
    const url = new URL(
        `http://localhost/api/media/00000000-0000-0000-0000-000000000001/viewers${search}`,
    );
    return {
        url,
        params: { id: '00000000-0000-0000-0000-000000000001' },
        route: { id: '/api/media/[id]/viewers' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: `usr_${username}`,
                username,
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

beforeEach(() => {
    vi.clearAllMocks();
    mockFeatures.social = true;
    mockGetDb.mockReturnValue({});
    mockResolveCatalogInternalId.mockResolvedValue('media-uuid-1');
    mockCheckMediaAccess.mockResolvedValue(true);
    mockGetCurrentUserWatchState.mockResolvedValue({ watched: false, rating: null });
});

describe('media-id-viewers GET', () => {
    it('supports offset and preserves total on an empty page beyond the end', async () => {
        const rows = ['A', 'B', 'C'].map((name, index) => ({
            user_id: `user-${index}`,
            display_name: name,
            total_count: 3,
            last_played_at: null,
            play_count: 1,
            is_favorite: false,
            rating: null,
        }));
        mockGetMediaViewers.mockResolvedValue(rows);
        const response = await def.handlers.GET!(makeEvent('alice', '?limit=1&offset=1'), {
            surface: 'v1',
        });
        const body = await response.json();
        expect(
            body.items.map((item: { author: { displayName: string } }) => item.author.displayName),
        ).toEqual(['B']);
        expect(body.page).toEqual({ limit: 1, offset: 1, total: 3, hasMore: true });
        expect(body.me).toEqual({ watched: false });
        expect(body).not.toHaveProperty('viewers');
        const empty = await def.handlers.GET!(makeEvent('alice', '?limit=1&offset=5'), {
            surface: 'v1',
        });
        expect(await empty.json()).toMatchObject({ items: [], page: { total: 3, hasMore: false } });
    });

    it('ships displayName and never the login handle', async () => {
        mockGetMediaViewers.mockResolvedValue([
            {
                user_id: 'bbbbbbbb-0000-4000-8000-000000000002',
                display_name: 'Bob',
                play_count: 1,
                last_played_at: '2026-01-01T00:00:00.000Z',
                is_favorite: false,
                rating: null,
                total_count: 1,
            },
        ]);

        const { GET } = mount(def, { surface: 'v1' });
        const res = await GET!(makeEvent('alice') as never);
        const body = await res.json();

        expect(body.items[0].author.displayName).toBe('Bob');
        expect(body.items[0]).not.toHaveProperty('username');
        expect(JSON.stringify(body)).not.toContain('bob@');
    });

    it('ships null instead of falling back to a missing display name', async () => {
        mockGetMediaViewers.mockResolvedValue([
            {
                user_id: 'bbbbbbbb-0000-4000-8000-000000000002',
                display_name: null,
                play_count: 1,
                last_played_at: null,
                is_favorite: false,
                rating: null,
                total_count: 1,
            },
        ]);

        const { GET } = mount(def, { surface: 'v1' });
        const res = await GET!(makeEvent('alice') as never);
        const body = await res.json();

        expect(body.items[0].author.displayName).toBeNull();
        expect(body.items[0]).not.toHaveProperty('username');
    });

    it('keys the avatar href by UUID, not username', async () => {
        mockGetMediaViewers.mockResolvedValue([
            {
                user_id: 'bbbbbbbb-0000-4000-8000-000000000002',
                display_name: 'Bob',
                play_count: 1,
                last_played_at: null,
                is_favorite: false,
                rating: null,
                total_count: 1,
            },
        ]);

        const res = await def.handlers.GET!(makeEvent('alice'), { surface: 'v1' });
        const body = await res.json();

        expect(body.items[0].author.images.primary.href).toBe(
            '/api/v1/users/bbbbbbbb-0000-4000-8000-000000000002/images/avatar?size=card&v=0',
        );
    });

    it('keeps a viewer rating of 0 instead of dropping it', async () => {
        // `row.rating ? … : undefined` is falsy for 0, so the one rating that
        // says "I actively disliked this" rendered as "not rated" — while
        // currentUserRating two lines down used `??` and handled 0 correctly.
        mockGetMediaViewers.mockResolvedValue([
            {
                user_id: 'bbbbbbbb-0000-4000-8000-000000000002',
                display_name: 'Bob',
                play_count: 1,
                last_played_at: null,
                is_favorite: false,
                rating: 0,
                total_count: 1,
            },
        ]);
        mockGetCurrentUserWatchState.mockResolvedValue({ watched: true, rating: 0 });

        const res = await def.handlers.GET!(makeEvent('alice'), { surface: 'v1' });
        const body = await res.json();

        expect(body.items[0].rating).toBe(0);
        expect(body.me.rating).toBe(0);
    });

    it('carries ratingStyle for a rated viewer, omits for unrated, and drops a legacy junk value', async () => {
        mockGetMediaViewers.mockResolvedValue([
            {
                user_id: 'bbbbbbbb-0000-4000-8000-000000000002',
                display_name: 'Bob',
                play_count: 3,
                last_played_at: '2026-07-20T00:00:00.000Z',
                is_favorite: false,
                rating: 9,
                rating_style: 'quick',
                total_count: 3,
            },
            {
                user_id: 'uuid-carol',
                display_name: 'Carol',
                play_count: 1,
                last_played_at: '2026-07-19T00:00:00.000Z',
                is_favorite: false,
                rating: null,
                rating_style: null,
                total_count: 3,
            },
            {
                user_id: 'uuid-dave',
                display_name: 'Dave',
                play_count: 2,
                last_played_at: '2026-07-18T00:00:00.000Z',
                is_favorite: false,
                rating: 6,
                // Legacy row predating the 'quick'|'stars' CHECK, or written by
                // a path that stored something else — the validated narrow
                // must drop it, not pass it through.
                rating_style: 'thumbs-up',
                total_count: 3,
            },
        ]);

        const res = await def.handlers.GET!(makeEvent('alice'), { surface: 'internal' });
        const body = (await res.json()) as {
            items: { author: { userId: string }; rating?: number; ratingStyle?: string }[];
        };

        expect(body.items).toHaveLength(3);
        expect(body.items[0].ratingStyle).toBe('quick');
        expect(body.items[1].ratingStyle).toBeUndefined();
        expect(body.items[2].ratingStyle).toBeUndefined();

        const raw = await (
            await def.handlers.GET!(makeEvent('alice'), { surface: 'internal' })
        ).text();
        expect(raw).not.toContain('thumbs-up');
    });

    it('honours ?limit= and keeps totalViewers at the pre-limit total', async () => {
        mockGetMediaViewers.mockResolvedValue([
            {
                user_id: 'u1',
                display_name: 'A',
                play_count: 1,
                last_played_at: null,
                is_favorite: false,
                rating: null,
                total_count: 9,
            },
        ]);

        const res = await def.handlers.GET!(makeEvent('alice', '?limit=1'), { surface: 'v1' });
        const body = await res.json();

        expect(mockGetMediaViewers).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            1,
        );
        expect(body.page.total).toBe(9);
    });

    it('defaults to a page size of 50 when ?limit= is omitted', async () => {
        mockGetMediaViewers.mockResolvedValue([]);

        await def.handlers.GET!(makeEvent('alice'), { surface: 'v1' });

        expect(mockGetMediaViewers).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            50,
        );
    });

    it('URL-encodes viewer ids with special characters', async () => {
        mockGetMediaViewers.mockResolvedValue([
            {
                user_id: 'uuid bob',
                display_name: 'Bob',
                play_count: 1,
                last_played_at: null,
                is_favorite: false,
                rating: null,
                total_count: 1,
            },
        ]);

        const res = await def.handlers.GET!(makeEvent('alice'), { surface: 'internal' });
        const body = await res.json();

        expect(body.items[0].author.images.primary.href).toBe('/api/users/uuid%20bob/images/avatar?size=card&v=0');
    });

    it('reports me.watched/me.rating from getCurrentUserWatchState', async () => {
        mockGetMediaViewers.mockResolvedValue([]);
        mockGetCurrentUserWatchState.mockResolvedValue({ watched: true, rating: 8 });

        const res = await def.handlers.GET!(makeEvent('alice'), { surface: 'internal' });
        const body = (await res.json()) as {
            items: unknown[];
            me: { watched: boolean; rating?: number };
        };

        expect(body.items).toHaveLength(0);
        expect(body.me.watched).toBe(true);
        expect(body.me.rating).toBe(8);
    });

    it('returns forbidden when the social feature is disabled', async () => {
        mockFeatures.social = false;

        const res = await def.handlers.GET!(makeEvent('alice'), {
            surface: 'internal',
        });

        expect(res.status).toBe(403);
    });
});
