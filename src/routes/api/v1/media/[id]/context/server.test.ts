// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for GET /api/v1/media/{id}/context — mounts the same def as the
 * internal route on the public/native (Bearer) surface, so a tvOS client can
 * fetch detail + social in one round trip. Named `server.test.ts` (never
 * `+server.test.ts` — the `+` name is reserved and only `vite build` catches
 * it).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { SimilarMediaResponse } from '$lib/schemas/api-content-responses.js';

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

const mockGetDb = vi.fn();
const mockResolveCatalogInternalId = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockBuildMediaDetail = vi.fn();
const mockBuildWatchActivity = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/api/defs/catalog/resolve-id.js', () => ({
    resolveCatalogInternalId: (...args: unknown[]) => mockResolveCatalogInternalId(...args),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

vi.mock('$lib/server/api/defs/catalog/media-id.js', () => ({
    buildMediaDetail: (...args: unknown[]) => mockBuildMediaDetail(...args),
}));

vi.mock('$lib/server/api/defs/integrations/social-watch-activity.js', () => ({
    buildWatchActivity: (...args: unknown[]) => mockBuildWatchActivity(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const SIMILAR_UUID = '00000000-0000-4000-8000-000000000002';
const SIMILAR_RESPONSE = {
    items: [
        {
            id: SIMILAR_UUID,
            catalogId: SIMILAR_UUID,
            type: 'movie',
            ids: { internal: SIMILAR_UUID },
            title: 'Another Movie',
            images: {},
            score: 0.9,
            availability: { isAvailable: true, canRequest: false },
        },
    ],
    truncated: false,
} satisfies SimilarMediaResponse;

function makeBearerEvent(query: string): RequestEvent {
    const url = new URL(`http://localhost/api/v1/media/${VALID_UUID}/context${query}`);
    return {
        url,
        params: { id: VALID_UUID },
        route: { id: '/api/v1/media/[id]/context' as const },
        request: new Request(url.toString(), {
            headers: { authorization: 'Bearer pat_abc' },
        }),
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
        fetch: vi.fn(async () => Response.json(SIMILAR_RESPONSE)),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

/**
 * The REAL buildMediaDetail payload (a MediaNode), not a four-field stub. The
 * stub that used to stand here happened to be an exact subset of the too-narrow
 * response schema this def once declared, so it satisfied mount()'s contract
 * gate no matter how much the schema under-declared.
 */
const FULL_DETAIL = {
    id: VALID_UUID,
    type: 'movie',
    ids: { internal: VALID_UUID },
    title: 'Some Movie',
    year: 1999,
    images: {
        poster: {
            href: `/api/v1/media/${VALID_UUID}/images/poster`,
            revision: '0',
            source: 'self',
        },
    },
    isAvailable: true,
    canRequest: false,
};

/** A real SocialActivityItem — an EMPTY activities array satisfies any item schema. */
const REAL_ACTIVITY = {
    author: {
        userId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Bob',
        images: {
            primary: {
                href: '/api/v1/users/00000000-0000-4000-8000-000000000002/images/avatar',
                variants: { thumb: '/api/v1/users/00000000-0000-4000-8000-000000000002/images/avatar?quality=50' },
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

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockResolveCatalogInternalId.mockResolvedValue(VALID_UUID);
    mockCheckMediaAccess.mockResolvedValue(true);
    mockBuildMediaDetail.mockResolvedValue(FULL_DETAIL);
    mockBuildWatchActivity.mockResolvedValue({ ok: true, body: { activities: [REAL_ACTIVITY] } });
});

describe('GET /api/v1/media/{id}/context', () => {
    it('serves all requested sections for a bearer client', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET!(makeBearerEvent('?include=details,social,similar'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.included).toEqual(expect.arrayContaining(['details', 'social', 'similar']));
        expect(body.similar).toEqual(SIMILAR_RESPONSE);
    });

    it('serves a NON-EMPTY social section without tripping the response contract', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET!(makeBearerEvent('?include=social'));
        const body = await res.json();

        // Reaching here at all means mount()'s gate accepted the body — the
        // published spec carries additionalProperties:false, so a generated
        // Swift decoder sees exactly these fields.
        expect(body.social.activities).toEqual([REAL_ACTIVITY]);
    });
});
