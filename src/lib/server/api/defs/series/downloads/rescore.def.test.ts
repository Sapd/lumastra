// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Handler-level contract for the series rescore def: the gate ordering, the
 * over-cap 422, `BodySchema`'s UUID validation (which is what makes a
 * malformed id a 422 instead of the 500 the underlying `::uuid[]` cast would
 * throw, returning NO statuses at all and freezing the pool), and the
 * every-id-comes-back invariant as observed over HTTP.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';

const mockGetSql = vi.fn();
const mockGetRescore = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockCheckRateLimit = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/series-downloads.queries.js', () => ({
    getSeriesNextUpRescore: (...args: unknown[]) => mockGetRescore(...args),
    MAX_RESCORE_IDS: 2000,
    SERIES_LANE: 'series-next-up',
    SERIES_SCORE_VERSION: 2,
    DEFAULT_SERIES_FREQUENCY_MODE: 'balanced',
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const { def, BodySchema, MAX_RESCORE_IDS } = await import('./rescore.js');

function makeEvent(): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/v1/series/downloads/rescore'),
        params: {},
        request: new Request('http://localhost/api/v1/series/downloads/rescore', {
            method: 'POST',
            body: '{}',
        }),
    } as unknown as RequestEvent;
}

function makeCtx(body: { lane?: string; mediaIds?: string[] } = {}) {
    return {
        surface: 'v1',
        input: {
            body: { lane: 'series-next-up', mediaIds: [], ...body },
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
        mockGetRescore.mockResolvedValue([]);
    });

    it('returns 401 when unauthenticated', async () => {
        const event = { ...makeEvent(), locals: { user: null } } as unknown as RequestEvent;
        expect((await def.handlers.POST!(event, makeCtx() as never)).status).toBe(401);
    });

    it('checks the rate limit AFTER the DB-availability check', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await def.handlers.POST!(makeEvent(), makeCtx() as never);
        expect(res.status).toBe(503);
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('returns 429 with a per-(user, lane) key', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: Date.now() / 1000 + 30 });
        const res = await def.handlers.POST!(makeEvent(), makeCtx() as never);
        expect(res.status).toBe(429);
        expect(mockCheckRateLimit.mock.calls[0]![0]).toContain('series-next-up');
    });

    it('returns 422 for an unsupported lane', async () => {
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ lane: 'rotation' }) as never);
        expect(res.status).toBe(422);
    });

    it('returns a structured 422 over the cap, naming the overage', async () => {
        // A client whose lane grew past the cap needs to know how many members
        // to shed, not a generic "array too long".
        const ids = Array.from({ length: MAX_RESCORE_IDS + 1 }, () => randomUUID());
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ mediaIds: ids }) as never);
        expect(res.status).toBe(422);
        expect(mockGetRescore).not.toHaveBeenCalled();

        const body = await res.json();
        const byField = Object.fromEntries(
            (body.details as { field: string; value: unknown }[]).map((d) => [d.field, d.value]),
        );
        expect(byField.submitted).toBe(MAX_RESCORE_IDS + 1);
        expect(byField.cap).toBe(MAX_RESCORE_IDS);
        expect(byField.shedRequired).toBe(1);
    });

    /**
     * Directed addition (A): the 422 used to say HOW MANY to shed but not
     * WHICH — leaving every client to invent its own heuristic at exactly the
     * moment it has no valid ranking to choose by (any stored rank is from a
     * prior, non-comparable generation). Pin the machine-readable `shedOrder`
     * hint so it can't be silently dropped, mirroring music's rescore.ts.
     */
    it('names admitted_desc (LIFO) as the shedOrder in the 422 details', async () => {
        const ids = Array.from({ length: MAX_RESCORE_IDS + 3 }, () => randomUUID());

        const res = await def.handlers.POST!(makeEvent(), makeCtx({ mediaIds: ids }) as never);
        const body = await res.json();

        const shedOrder = (
            body.details as { field: string; value: unknown; message: string }[]
        ).find((d) => d.field === 'shedOrder');
        expect(shedOrder).toBeDefined();
        expect(shedOrder!.value).toBe('admitted_desc');
        expect(shedOrder!.message).toMatch(/most-recently-admitted/i);
    });

    it('rejects a non-UUID id at the schema, before it reaches ::uuid[]', async () => {
        // Otherwise one malformed id aborts the whole statement with a 500 that
        // returns NO statuses, which the client must treat as an error and
        // which freezes the lane.
        expect(
            BodySchema.safeParse({ lane: 'series-next-up', mediaIds: ['not-a-uuid'] }).success,
        ).toBe(false);
    });

    it('every submitted id comes back with an explicit status, at the HTTP level', async () => {
        const a = randomUUID();
        const b = randomUUID();
        const c = randomUUID();
        mockGetRescore.mockResolvedValue([
            { media_id: b, status: 'ranked', rank: 0 },
            { media_id: c, status: 'graduated', rank: null },
        ]);

        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ mediaIds: [a, b, c] }) as never,
        );
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.results.map((r: { mediaId: string }) => r.mediaId).sort()).toEqual(
            [a, b, c].sort(),
        );
        const byId = (id: string) =>
            body.results.find((r: { mediaId: string }) => r.mediaId === id);
        expect(byId(a).status).toBe('gone');
        expect(byId(b).status).toBe('ranked');
        expect(byId(c).status).toBe('graduated');
        expect(byId(c).toLane).toBeNull();
    });

    it('stamps a generation and echoes the status vocabulary', async () => {
        const body = await (await def.handlers.POST!(makeEvent(), makeCtx() as never)).json();
        expect(typeof body.generation).toBe('string');
        expect(body.generation).toContain('series-next-up');
        expect(body.statusVocabulary).toEqual(['ranked', 'graduated', 'gone']);
        expect(body.scoreVersion).toBe(2);
    });

    it('is published as beta, not stable', async () => {
        expect(def.docs?.POST?.stability).toBe('beta');
    });
});

describe('published endpoint description (directed addition A — shed-order guidance)', () => {
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

describe('rescore caps unique membership, not raw submission length', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        mockGetRescore.mockResolvedValue([]);
    });

    it('accepts 2000 unique ids plus one accidental duplicate', async () => {
        // A lane at exactly the cap, submitted with one duplicate id (e.g. two
        // devices' independently-admitted view of the same episode), has a
        // TRUE membership within cap. Capping on the raw array length would
        // reject this wholesale even though nothing actually needs shedding.
        const unique = Array.from({ length: MAX_RESCORE_IDS }, () => randomUUID());
        const withDuplicate = [...unique, unique[0]!];
        expect(withDuplicate).toHaveLength(MAX_RESCORE_IDS + 1);

        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ mediaIds: withDuplicate }) as never,
        );

        expect(res.status).toBe(200);
        expect(mockGetRescore).toHaveBeenCalledTimes(1);
        // The query and the response are built from the DEDUPED set.
        expect(mockGetRescore.mock.calls[0]![2]).toHaveLength(MAX_RESCORE_IDS);
        const body = await res.json();
        expect(body.results).toHaveLength(MAX_RESCORE_IDS);
    });

    it('rejects 2001 unique ids with shedRequired: 1', async () => {
        // A lane that is genuinely over cap, with no duplicates to collapse,
        // must still 422 — dedup must not become an accidental leniency.
        const ids = Array.from({ length: MAX_RESCORE_IDS + 1 }, () => randomUUID());

        const res = await def.handlers.POST!(makeEvent(), makeCtx({ mediaIds: ids }) as never);

        expect(res.status).toBe(422);
        expect(mockGetRescore).not.toHaveBeenCalled();
        const body = await res.json();
        const byField = Object.fromEntries(
            (body.details as { field: string; value: unknown }[]).map((d) => [d.field, d.value]),
        );
        expect(byField.submitted).toBe(MAX_RESCORE_IDS + 1);
        expect(byField.cap).toBe(MAX_RESCORE_IDS);
        expect(byField.shedRequired).toBe(1);
    });
});
