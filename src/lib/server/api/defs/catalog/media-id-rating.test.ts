// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/catalog/media-id-rating.ts (GET/PUT media/{id}/rating).
 *
 * Covers a tvOS contract mismatch: the registered response schema
 * (MediaRatingResponseSchema, api-content-responses.ts) declares `rating` as
 * `.optional()` — per this codebase's nullability convention (CLAUDE.md:
 * prefer `.optional()` at service boundaries unless the DB genuinely returns
 * null), but the handler sent an explicit `rating: null` whenever no rating
 * row existed. A strict decoder expecting an absent/optional key chokes on
 * an explicit `null`. The fix omits the key (`?? undefined`, dropped by
 * JSON.stringify) instead of sending `null`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { RatingBody } from './media-id-rating.schemas.js';

const mockGetSql = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

const { def } = await import('./media-id-rating.js');

function makeEvent(withUser = true): RequestEvent {
    return {
        params: { id: '00000000-0000-0000-0000-000000000001' },
        locals: withUser
            ? {
                  user: {
                      userId: 'usr_00000000-0000-0000-0000-000000000001',
                      username: 'alice',
                      userGroups: [],
                      isAdmin: false,
                      maxAgeRating: null,
                  },
              }
            : { user: undefined },
    } as unknown as RequestEvent;
}

const CTX = { surface: 'internal' as const };

function makeCtxWithBody(rating: number, ratingStyle?: 'quick' | 'stars') {
    return {
        ...CTX,
        input: { body: { rating, ratingStyle }, query: undefined, params: undefined },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('RatingBody schema — ratingStyle', () => {
    it('accepts "quick"', () => {
        const result = RatingBody.safeParse({ rating: 8, ratingStyle: 'quick' });
        expect(result.success).toBe(true);
    });

    it('accepts "stars"', () => {
        const result = RatingBody.safeParse({ rating: 8, ratingStyle: 'stars' });
        expect(result.success).toBe(true);
    });

    it('accepts a body without ratingStyle (optional)', () => {
        const result = RatingBody.safeParse({ rating: 8 });
        expect(result.success).toBe(true);
    });

    it('rejects an invalid ratingStyle value — request contract (422 upstream)', () => {
        const result = RatingBody.safeParse({ rating: 8, ratingStyle: 'thumbs' });
        expect(result.success).toBe(false);
    });
});

describe('GET /media/{id}/rating — rating: optional (no explicit null)', () => {
    it('omits `rating` from the JSON body when the user has no rating (undefined, not null)', async () => {
        const sqlTag = vi.fn().mockResolvedValue([]);
        mockGetSql.mockResolvedValue(sqlTag);

        const res = await def.handlers.GET!(makeEvent(), CTX);
        expect(res.status).toBe(200);

        const raw = await res.text();
        // Prove the key is absent from the wire payload, not present as null.
        expect(raw).not.toContain('"rating"');
        const body = JSON.parse(raw) as Record<string, unknown>;
        expect('rating' in body).toBe(false);
        expect(body.canRate).toBe(true);
    });

    it('returns the numeric rating unchanged when one exists', async () => {
        const sqlTag = vi.fn().mockResolvedValue([{ rating: 8 }]);
        mockGetSql.mockResolvedValue(sqlTag);

        const res = await def.handlers.GET!(makeEvent(), CTX);
        const body = (await res.json()) as { rating?: number; canRate?: boolean };
        expect(body.rating).toBe(8);
        expect(body.canRate).toBe(true);
    });

    it('returns the stored ratingStyle', async () => {
        const sqlTag = vi.fn().mockResolvedValue([{ rating: 8, rating_style: 'stars' }]);
        mockGetSql.mockResolvedValue(sqlTag);

        const res = await def.handlers.GET!(makeEvent(), CTX);
        const body = (await res.json()) as { rating?: number; ratingStyle?: string };
        expect(body.ratingStyle).toBe('stars');
    });

    it('omits ratingStyle (undefined, not null) when the column is NULL', async () => {
        const sqlTag = vi.fn().mockResolvedValue([{ rating: 8, rating_style: null }]);
        mockGetSql.mockResolvedValue(sqlTag);

        const res = await def.handlers.GET!(makeEvent(), CTX);
        const raw = await res.text();
        expect(raw).not.toContain('"ratingStyle"');
    });

    it('omits `rating` (not null) when the database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);

        const res = await def.handlers.GET!(makeEvent(), CTX);
        const raw = await res.text();
        expect(raw).not.toContain('"rating"');
    });
});

describe('PUT /media/{id}/rating — rating: optional (no explicit null on clear)', () => {
    it('omits `rating` when clearing (rating: 0) instead of sending null', async () => {
        const sqlTag = vi.fn();
        mockGetSql.mockResolvedValue(sqlTag);

        vi.doMock('$lib/server/database/queries/user-ratings.queries.js', () => ({
            deleteUserRating: { execute: vi.fn().mockResolvedValue(undefined) },
            upsertUserRating: { execute: vi.fn().mockResolvedValue(undefined) },
        }));

        const event = makeEvent();
        const ctx = makeCtxWithBody(0);
        const res = await def.handlers.PUT!(event, ctx);

        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain('"rating"');
    });
});

describe('PUT /media/{id}/rating — ratingStyle pass-through', () => {
    it('persists ratingStyle: "quick" through to upsertUserRating', async () => {
        const sqlTag = vi.fn();
        mockGetSql.mockResolvedValue(sqlTag);

        const upsertExecute = vi.fn().mockResolvedValue(undefined);
        vi.doMock('$lib/server/database/queries/user-ratings.queries.js', () => ({
            deleteUserRating: { execute: vi.fn().mockResolvedValue(undefined) },
            upsertUserRating: { execute: upsertExecute },
        }));

        const event = makeEvent();
        const ctx = makeCtxWithBody(7, 'quick');
        const res = await def.handlers.PUT!(event, ctx);

        expect(res.status).toBe(200);
        expect(upsertExecute).toHaveBeenCalledWith(
            sqlTag,
            expect.objectContaining({ rating: 7, ratingStyle: 'quick' }),
        );
    });

    it('stores a NULL rating_style when ratingStyle is omitted from the PUT body', async () => {
        const sqlTag = vi.fn();
        mockGetSql.mockResolvedValue(sqlTag);

        const upsertExecute = vi.fn().mockResolvedValue(undefined);
        vi.doMock('$lib/server/database/queries/user-ratings.queries.js', () => ({
            deleteUserRating: { execute: vi.fn().mockResolvedValue(undefined) },
            upsertUserRating: { execute: upsertExecute },
        }));

        const event = makeEvent();
        const ctx = makeCtxWithBody(7);
        const res = await def.handlers.PUT!(event, ctx);

        expect(res.status).toBe(200);
        expect(upsertExecute).toHaveBeenCalledWith(
            sqlTag,
            expect.objectContaining({ rating: 7, ratingStyle: undefined }),
        );
    });

    // Pinned decided semantics (see upsertUserRating's `rating_style = EXCLUDED.rating_style`):
    // re-rating WITHOUT a style NULLs any previously stored style. The rating
    // VALUE may have changed, so a style recorded against the old value is
    // stale — recording "unknown" is more honest than asserting a style we
    // cannot know. Do NOT "fix" this with COALESCE preservation.
    it('re-rating without ratingStyle over an existing "quick" rating nulls the style', async () => {
        const sqlTag = vi.fn();
        mockGetSql.mockResolvedValue(sqlTag);

        const upsertExecute = vi.fn().mockResolvedValue(undefined);
        vi.doMock('$lib/server/database/queries/user-ratings.queries.js', () => ({
            deleteUserRating: { execute: vi.fn().mockResolvedValue(undefined) },
            upsertUserRating: { execute: upsertExecute },
        }));

        // First PUT: rate 7 with ratingStyle 'quick'.
        await def.handlers.PUT!(makeEvent(), makeCtxWithBody(7, 'quick'));
        expect(upsertExecute).toHaveBeenLastCalledWith(
            sqlTag,
            expect.objectContaining({ rating: 7, ratingStyle: 'quick' }),
        );

        // Second PUT: re-rate to 9 WITHOUT a ratingStyle — style must not be
        // preserved from the prior call.
        await def.handlers.PUT!(makeEvent(), makeCtxWithBody(9));
        expect(upsertExecute).toHaveBeenLastCalledWith(
            sqlTag,
            expect.objectContaining({ rating: 9, ratingStyle: undefined }),
        );
    });
});
