// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Access-control regression for GET media/{id}/context?include=social.
 *
 * `context` resolves its subject id through `resolveCatalogInternalId`, whose
 * precedence puts `?externalId=` AHEAD of the path param (the `withIdResolution`
 * middleware that would outrank both is a per-route wrapper `mount()` does not
 * apply). So `?externalId=A` on path id `B` makes the endpoint access-check A —
 * while the `social` section is handed the RAW path id, B.
 *
 * While `buildWatchActivity` took an `accessAlreadyChecked` opt-out, that flag
 * suppressed B's only access check, and B's viewer activity ("who watched/rated
 * this") was returned to a caller with no access to B — another library's items,
 * or age-restricted ones. The fix is that `buildWatchActivity` ALWAYS checks the
 * row it actually resolved; the opt-out is gone.
 *
 * This suite therefore runs the REAL `buildWatchActivity` behind the REAL def —
 * mocking it out, as the sibling `media-id-context.test.ts` does, is exactly
 * what let the two halves disagree.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

/** The item the caller CAN see — what `?externalId=` resolves to. */
const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** The item in the PATH, in a library this caller has no access to. */
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const {
    mockResolveCatalogInternalId,
    mockCheckMediaAccess,
    mockGetMediaTypeAndParent,
    mockGetRatedActivities,
    mockGetWatchedActivities,
    mockGetAnnotations,
    mockBuildMediaDetail,
} = vi.hoisted(() => ({
    mockResolveCatalogInternalId: vi.fn(),
    mockCheckMediaAccess: vi.fn(),
    mockGetMediaTypeAndParent: vi.fn(),
    mockGetRatedActivities: vi.fn(),
    mockGetWatchedActivities: vi.fn(),
    mockGetAnnotations: vi.fn(),
    mockBuildMediaDetail: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('./resolve-id.js', () => ({
    resolveCatalogInternalId: (...args: unknown[]) => mockResolveCatalogInternalId(...args),
}));
vi.mock('./media-id.js', () => ({
    buildMediaDetail: (...args: unknown[]) => mockBuildMediaDetail(...args),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));
vi.mock('$lib/server/database/queries/social-activity.queries.js', () => ({
    getMediaTypeAndParent: (...args: unknown[]) => mockGetMediaTypeAndParent(...args),
    getRatedActivities: (...args: unknown[]) => mockGetRatedActivities(...args),
    getWatchedActivities: (...args: unknown[]) => mockGetWatchedActivities(...args),
    resolveExternalIdToMediaId: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/database/queries/media-annotations.queries.js', () => ({
    getAnnotations: (...args: unknown[]) => mockGetAnnotations(...args),
}));
vi.mock('$lib/server/database/queries/media-queries.js', () => ({
    resolveMediaIdByProvider: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: { resolveAnyMediaId: vi.fn().mockResolvedValue({ internalId: null }) },
}));
vi.mock('$lib/server/services/image-descriptor/avatars.js', () => ({
    userImageSets: async () => new Map(),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserDisplayInfoByIds: vi.fn(async (_sql: unknown, ids: string[]) =>
        ids.map((id) => ({ id, display_name: 'Public Bob' })),
    ),
}));

const { def } = await import('./media-id-context.js');

function makeEvent(query: string): RequestEvent {
    const url = new URL(`http://localhost/api/v1/media/${ITEM_B}/context${query}`);
    return {
        url,
        params: { id: ITEM_B },
        route: { id: '/api/v1/media/[id]/context' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: '00000000-0000-0000-0000-000000000099',
                username: 'mallory',
                userGroups: [],
                ownerIsAdmin: false,
                isAgeRestricted: false,
                maxAgeRating: null,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

/** One watcher on ITEM_B — the data that must not leak. */
function bobWatchedIt(): Array<{
    user_id: string;
    username: string;
    episodes_watched: number | null;
    total_episodes: number | null;
}> {
    return [
        {
            user_id: '00000000-0000-0000-0000-0000000000bb',
            username: 'bob',
            episodes_watched: null,
            total_episodes: null,
        },
    ];
}

describe('media/{id}/context — social section is access-checked against the PATH id', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // `?externalId=` wins in resolveCatalogInternalId, so the endpoint's own
        // gate is applied to A.
        mockResolveCatalogInternalId.mockResolvedValue(ITEM_A);
        // The caller can see A and nothing else.
        mockCheckMediaAccess.mockImplementation(async (_sql: unknown, id: string) => id === ITEM_A);
        mockGetMediaTypeAndParent.mockResolvedValue({
            id: ITEM_B,
            media_type: 'movie',
            parent_id: null,
        });
        mockGetRatedActivities.mockResolvedValue([]);
        mockGetWatchedActivities.mockResolvedValue(bobWatchedIt());
        mockGetAnnotations.mockResolvedValue([]);
        mockBuildMediaDetail.mockResolvedValue(null);
    });

    it('does not return activity for a path item the caller cannot access', async () => {
        const res = await def.handlers.GET!(makeEvent(`?include=social&externalId=${ITEM_A}`), {
            surface: 'v1',
        });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.social).toBeUndefined();
        expect(body.included).not.toContain('social');
    });

    it('checks the PATH item, not only the externalId the caller supplied', async () => {
        await def.handlers.GET!(makeEvent(`?include=social&externalId=${ITEM_A}`), {
            surface: 'v1',
        });

        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            ITEM_B,
            expect.anything(),
        );
    });

    it('still serves the section when the caller CAN access the path item', async () => {
        // Positive control: the plumbing above really does produce activities,
        // so the denial assertions are not passing for an unrelated reason.
        mockCheckMediaAccess.mockResolvedValue(true);

        const res = await def.handlers.GET!(makeEvent(`?include=social&externalId=${ITEM_A}`), {
            surface: 'v1',
        });
        const body = await res.json();

        expect(body.included).toContain('social');
        expect(body.social.activities).toHaveLength(1);
        expect(body.social.activities[0].author.displayName).toBe('Public Bob');
        expect(body.social.activities[0]).not.toHaveProperty('username');
    });
});
