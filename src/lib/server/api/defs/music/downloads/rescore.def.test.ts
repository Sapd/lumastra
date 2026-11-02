// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards the published contract of the smart-download rescore def, which had
 * zero handler-level coverage before this suite: the unknown-lane 422, the
 * 429/401/503 gates, and the "every submitted id comes back" invariant as
 * observed through the actual HTTP response (buildRescoreResults itself is
 * already unit-tested in rescore.test.ts — this file is the wiring around
 * it, plus BodySchema's UUID validation, which is what makes a malformed id
 * a 422 instead of the 500 that the underlying `::uuid[]` cast would throw).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';

const mockGetSql = vi.fn();
const mockGetRotationRescoreRanks = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockCheckRateLimit = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/music-downloads.queries.js', () => ({
    getRotationRescoreRanks: (...args: unknown[]) => mockGetRotationRescoreRanks(...args),
    ROTATION_SCORE_VERSION: 1,
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    // Faithful stand-in for the real helper: it sets the X-RateLimit-*
    // headers on the response it is handed and returns that same response.
    withRateLimitHeaders: (
        response: Response,
        result: { total: number; remaining: number; resetAt: number },
    ) => {
        response.headers.set('X-RateLimit-Limit', String(result.total));
        response.headers.set('X-RateLimit-Remaining', String(result.remaining));
        response.headers.set('X-RateLimit-Reset', String(result.resetAt));
        return response;
    },
}));

const { def, BodySchema, MAX_RESCORE_IDS } = await import('./rescore.js');

function makeEvent(): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/v1/music/downloads/rescore'),
        params: {},
        request: new Request('http://localhost/api/v1/music/downloads/rescore', {
            method: 'POST',
            body: '{}',
        }),
    } as unknown as RequestEvent;
}

function makeCtx(body: { lane?: string; mediaIds?: string[] } = {}) {
    return {
        surface: 'v1',
        input: {
            body: { lane: 'rotation', mediaIds: [], ...body },
            query: undefined,
            params: undefined,
        },
    };
}

describe('rescore published contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        mockGetRotationRescoreRanks.mockResolvedValue([]);
    });

    it('returns 401 when unauthenticated', async () => {
        const event = { ...makeEvent(), locals: { user: null } } as unknown as RequestEvent;
        const res = await def.handlers.POST!(event, makeCtx() as never);
        expect(res.status).toBe(401);
    });

    it('checks the rate limit AFTER the DB-availability check', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await def.handlers.POST!(makeEvent(), makeCtx() as never);
        expect(res.status).toBe(503);
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('returns 429 when the per-user limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: Date.now() / 1000 + 30 });
        const res = await def.handlers.POST!(makeEvent(), makeCtx() as never);
        expect(res.status).toBe(429);
        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            expect.stringContaining('u1'),
            expect.any(Number),
            expect.any(Number),
        );
    });

    it('keys the rate limit per (user, lane) so two lanes get independent budgets', async () => {
        await def.handlers.POST!(makeEvent(), makeCtx({ lane: 'rotation' }) as never);
        await def.handlers.POST!(makeEvent(), makeCtx({ lane: 'discovery' }) as never);

        expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
        const keys = mockCheckRateLimit.mock.calls.map((call) => call[0] as string);
        expect(keys[0]).not.toBe(keys[1]);
        expect(keys[0]).toContain(':rotation');
        expect(keys[1]).toContain(':discovery');
    });

    it('returns 422 for an unsupported lane', async () => {
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ lane: 'discovery' }) as never);
        expect(res.status).toBe(422);
    });

    it('every submitted id comes back with an explicit status, at the HTTP level', async () => {
        const a = randomUUID();
        const b = randomUUID();
        const c = randomUUID();
        mockGetRotationRescoreRanks.mockResolvedValue([{ media_id: b, rank: 0 }]);

        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ mediaIds: [a, b, c] }) as never,
        );
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.results.map((r: { mediaId: string }) => r.mediaId).sort()).toEqual(
            [a, b, c].sort(),
        );
        expect(body.results.find((r: { mediaId: string }) => r.mediaId === b).status).toBe(
            'ranked',
        );
        expect(body.results.find((r: { mediaId: string }) => r.mediaId === a).status).toBe('gone');
    });

    it('stamps a generation on the response', async () => {
        const res = await def.handlers.POST!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(typeof body.generation).toBe('string');
        expect(body.generation.length).toBeGreaterThan(0);
    });

    it('mints a distinct generation across two calls with the same lane and cohort size', async () => {
        const id = randomUUID();
        const res1 = await def.handlers.POST!(makeEvent(), makeCtx({ mediaIds: [id] }) as never);
        const res2 = await def.handlers.POST!(makeEvent(), makeCtx({ mediaIds: [id] }) as never);
        const body1 = await res1.json();
        const body2 = await res2.json();

        // Regression guard for the `rot:${Date.now().toString(36)}:${count}`
        // scheme, which minted an identical token for two same-millisecond
        // calls sharing a cohort size.
        expect(body1.generation).not.toBe(body2.generation);
    });

    it('stamps scoreVersion on the response, from ROTATION_SCORE_VERSION', async () => {
        const res = await def.handlers.POST!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.scoreVersion).toBe(1);
    });
});

describe('rescore — over-cap cohort is a graceful stop, not a trapdoor (Change 5)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        mockGetRotationRescoreRanks.mockResolvedValue([]);
    });

    it('rejects a cohort over MAX_RESCORE_IDS with a 422 naming submitted/cap/shedRequired', async () => {
        const mediaIds = Array.from({ length: MAX_RESCORE_IDS + 7 }, () => randomUUID());

        const res = await def.handlers.POST!(makeEvent(), makeCtx({ mediaIds }) as never);
        const body = await res.json();

        expect(res.status).toBe(422);
        const byField = Object.fromEntries(
            (body.details as { field: string; value: unknown }[]).map((d) => [d.field, d.value]),
        );
        expect(byField.submitted).toBe(MAX_RESCORE_IDS + 7);
        expect(byField.cap).toBe(MAX_RESCORE_IDS);
        expect(byField.shedRequired).toBe(7);
    });

    /**
     * Change 2 (iOS-feedback round 3): the 422 used to say HOW MANY to shed
     * but not WHICH — leaving every client to invent its own heuristic at
     * exactly the moment it has no valid ranking to choose by (any stored
     * rank is from a prior, non-comparable generation). Pin the machine-
     * readable `shedOrder` hint so it can't be silently dropped, and the
     * published endpoint description so the prose rationale survives too.
     */
    it('names admitted_desc (LIFO) as the shedOrder in the 422 details', async () => {
        const mediaIds = Array.from({ length: MAX_RESCORE_IDS + 3 }, () => randomUUID());

        const res = await def.handlers.POST!(makeEvent(), makeCtx({ mediaIds }) as never);
        const body = await res.json();

        const shedOrder = (
            body.details as { field: string; value: unknown; message: string }[]
        ).find((d) => d.field === 'shedOrder');
        expect(shedOrder).toBeDefined();
        expect(shedOrder!.value).toBe('admitted_desc');
        expect(shedOrder!.message).toMatch(/most-recently-admitted/i);
    });

    it('does not call getRotationRescoreRanks for an over-cap cohort — no partial ranking', async () => {
        const mediaIds = Array.from({ length: MAX_RESCORE_IDS + 1 }, () => randomUUID());

        await def.handlers.POST!(makeEvent(), makeCtx({ mediaIds }) as never);

        expect(mockGetRotationRescoreRanks).not.toHaveBeenCalled();
    });

    it('accepts a cohort exactly AT the cap', async () => {
        const mediaIds = Array.from({ length: MAX_RESCORE_IDS }, () => randomUUID());

        const res = await def.handlers.POST!(makeEvent(), makeCtx({ mediaIds }) as never);

        expect(res.status).toBe(200);
    });
});

describe('published endpoint description (Change 2 — shed-order guidance)', () => {
    it('states the LIFO/admission-recency shed rule and its rationale in the description', () => {
        const description = def.docs!.POST!.description;

        expect(description).toBeTruthy();
        expect(description).toMatch(/most-recently-admitted/i);
        expect(description).toMatch(/LIFO/);
        expect(description).toMatch(/shedOrder/);
        // The rationale, not just the rule: dropping the newest admissions
        // returns the lane to the last membership that WAS rankable.
        expect(description).toMatch(/last membership that was still rankable/i);
    });

    it('names shedOrder in the 422 response summary too', () => {
        expect(def.docs!.POST!.responses![422]).toMatch(/shedOrder/);
    });
});

describe('every submitted id comes back with statusVocabulary on the response (Change 1)', () => {
    it('echoes RESCORE_STATUS_VOCABULARY verbatim as statusVocabulary', async () => {
        const res = await def.handlers.POST!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.statusVocabulary).toEqual(['ranked', 'gone', 'graduated']);
    });
});

describe('BodySchema — mediaIds must be UUIDs (Fix 1)', () => {
    it('rejects a non-UUID id instead of letting it reach the ::uuid[] cast', () => {
        const result = BodySchema.safeParse({ lane: 'rotation', mediaIds: ['not-a-uuid'] });
        expect(result.success).toBe(false);
    });

    it('accepts a well-formed UUID', () => {
        const result = BodySchema.safeParse({ lane: 'rotation', mediaIds: [randomUUID()] });
        expect(result.success).toBe(true);
    });
});
