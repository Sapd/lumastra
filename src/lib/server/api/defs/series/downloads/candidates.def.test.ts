// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards the published contract of the series candidates def: the gate
 * ordering (401 -> 503 -> ETag/304 -> 429 -> 422), the unknown-lane and
 * unknown-rung 422s, and the pacing fields the client's admission queue
 * depends on — observed through the actual HTTP response, not by reading the
 * handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { DOWNLOAD_RUNGS, getDownloadRung } from '$lib/shared/download-rungs.js';

const mockGetSql = vi.fn();
const mockGetCandidates = vi.fn();
const mockGetSeriesEtagInputs = vi.fn();
const mockReadySizes = vi.fn();
const mockQueueDepth = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockCheckRateLimit = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/series-downloads.queries.js', () => ({
    getSeriesNextUpCandidates: (...args: unknown[]) => mockGetCandidates(...args),
    getSeriesEtagInputs: (...args: unknown[]) => mockGetSeriesEtagInputs(...args),
    SERIES_LANE: 'series-next-up',
    SERIES_SCORE_VERSION: 2,
    DEFAULT_SERIES_FREQUENCY_MODE: 'balanced',
}));

vi.mock('$lib/server/database/queries/download-renditions.queries.js', () => ({
    readySizesForFiles: (...args: unknown[]) => mockReadySizes(...args),
    prepareQueueDepth: (...args: unknown[]) => mockQueueDepth(...args),
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const { def, QuerySchema, computeSeriesCandidatesEtag, etagMatches } =
    await import('./candidates.js');

function makeEvent(headers?: Record<string, string>): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/v1/series/downloads/candidates'),
        params: {},
        request: new Request('http://localhost/api/v1/series/downloads/candidates', {
            headers,
        }),
    } as unknown as RequestEvent;
}

function makeCtx(query: Record<string, unknown> = {}) {
    return {
        surface: 'v1',
        input: {
            query: {
                lane: 'series-next-up',
                budgetBytes: 8 * 1024 ** 3,
                rung: '720p',
                ...query,
            },
            body: undefined,
            params: undefined,
        },
    };
}

function candidateRow(overrides: Record<string, unknown> = {}) {
    return {
        media_id: randomUUID(),
        file_id: randomUUID(),
        series_id: randomUUID(),
        series_title: 'A Show',
        season_number: 1,
        episode_number: 2,
        duration_ms: String(45 * 60 * 1000),
        source_height: 1080,
        distance: 0,
        series_rank: 1,
        covers_media_ids: [],
        ...overrides,
    };
}

describe('candidates published contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        mockGetCandidates.mockResolvedValue([]);
        mockGetSeriesEtagInputs.mockResolvedValue({
            engagementMaxLastEvent: null,
            engagementResumeCount: 0,
            engagementMaxLastWatched: null,
            engagementWatchedCount: 0,
            dismissedMaxCreated: null,
            dismissedCount: 0,
        });
        mockReadySizes.mockResolvedValue([]);
        mockQueueDepth.mockResolvedValue(0);
    });

    it('returns 401 when unauthenticated', async () => {
        const event = { ...makeEvent(), locals: { user: null } } as unknown as RequestEvent;
        expect((await def.handlers.GET!(event, makeCtx() as never)).status).toBe(401);
    });

    it('checks the rate limit AFTER the DB-availability check', async () => {
        // Every request 503s while the DB is down, so checking the limit first
        // would burn the caller's budget on requests that can never succeed.
        mockGetSql.mockResolvedValue(null);
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        expect(res.status).toBe(503);
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('returns 429 with a per-(user, lane) key', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: Date.now() / 1000 + 30 });
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        expect(res.status).toBe(429);
        expect(mockCheckRateLimit.mock.calls[0]![0]).toContain('u1');
        expect(mockCheckRateLimit.mock.calls[0]![0]).toContain('series-next-up');
    });

    it('returns 422 for an unsupported lane', async () => {
        const res = await def.handlers.GET!(makeEvent(), makeCtx({ lane: 'rotation' }) as never);
        expect(res.status).toBe(422);
    });

    it('returns 422 for an unknown rung rather than silently substituting one', async () => {
        const res = await def.handlers.GET!(makeEvent(), makeCtx({ rung: '4k' }) as never);
        expect(res.status).toBe(422);
    });

    it('advertises the pacing contract the admission queue needs', async () => {
        mockQueueDepth.mockResolvedValue(7);
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.lane).toBe('series-next-up');
        expect(body.graduationPolicy).toBe('delete');
        expect(body.maxConcurrentPreparations).toBeGreaterThanOrEqual(1);
        // The load-bearing one: a queued rendition is advanced by a re-POST and
        // by nothing else.
        expect(body.prepareRePostSeconds).toBeGreaterThan(0);
        expect(body.prepareQueueDepth).toBe(7);
        expect(body.unbudgetableCount).toBe(0);
        expect(body.scoreVersion).toBe(2);
    });

    it('projects rows with contiguous ranks from 0 and the CLAMPED rung id', async () => {
        mockGetCandidates.mockResolvedValue([
            candidateRow({ source_height: 720, distance: 0 }),
            candidateRow({ source_height: 1080, distance: 1 }),
        ]);
        const res = await def.handlers.GET!(makeEvent(), makeCtx({ rung: '1080p' }) as never);
        const body = await res.json();

        expect(body.candidates.map((c: { rank: number }) => c.rank)).toEqual([0, 1]);
        expect(body.candidates[0]!.rungId).toBe('720p');
        expect(body.candidates[1]!.rungId).toBe('1080p');
    });

    it('drops an unbudgetable candidate and counts it', async () => {
        mockGetCandidates.mockResolvedValue([candidateRow({ duration_ms: null }), candidateRow()]);
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.candidates).toHaveLength(1);
        expect(body.unbudgetableCount).toBe(1);
    });

    it("always includes the row's own id in coversMediaIds, even when SQL sent none", async () => {
        // Defence in depth: the query always populates it, but a client that
        // receives an empty array would treat the item as covering nothing and
        // never graduate it.
        mockGetCandidates.mockResolvedValue([candidateRow({ covers_media_ids: [] })]);
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        expect(body.candidates[0]!.coversMediaIds).toEqual([body.candidates[0]!.mediaId]);
    });

    it('labels distance 0 differently from the rest', async () => {
        mockGetCandidates.mockResolvedValue([
            candidateRow({ distance: 0 }),
            candidateRow({ distance: 3 }),
        ]);
        const body = await (await def.handlers.GET!(makeEvent(), makeCtx() as never)).json();

        expect(body.candidates[0]!.reason).toBe('next_episode');
        expect(body.candidates[1]!.reason).toBe('upcoming_episode');
    });

    it('looks exact sizes up by the CLAMPED rung, not the requested one', async () => {
        mockGetCandidates.mockResolvedValue([candidateRow({ source_height: 540 })]);
        await def.handlers.GET!(makeEvent(), makeCtx({ rung: '1080p' }) as never);

        expect(mockReadySizes).toHaveBeenCalledWith(expect.anything(), expect.any(Array), '540p');
    });

    it('bounds budgetBytes at the schema level', async () => {
        expect(QuerySchema.safeParse({ lane: 'series-next-up', budgetBytes: -1 }).success).toBe(
            false,
        );
    });

    it('advertises exactly the rung ids getDownloadRung accepts, ladder order, even with an empty pool', async () => {
        // mockGetCandidates resolves [] by default (beforeEach) — an empty pool
        // is exactly when a client most needs to learn the ladder, so the
        // vocabulary must not depend on there being any candidates.
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const body = await res.json();

        // Derived assertion, not a duplicated literal: every id ever
        // published here must round-trip through the same accept-check the
        // handler itself uses, so a rung added to the ladder without being
        // wired into acceptance (or vice versa) fails this test.
        expect(body.rungVocabulary).toEqual(DOWNLOAD_RUNGS.map((r) => r.id));
        for (const id of body.rungVocabulary) {
            expect(getDownloadRung(id)).toBeDefined();
        }
    });

    it('is published as beta, not stable', async () => {
        // /api/v1/series is in STABLE_PREFIXES, so an omitted tier publishes
        // this as a compatibility promise the ranking semantics cannot honour.
        expect(def.docs?.GET?.stability).toBe('beta');
    });
});

describe('computeSeriesCandidatesEtag (pure validator)', () => {
    const baseInputs = {
        engagementMaxLastEvent: new Date('2026-08-01T00:00:00Z'),
        engagementResumeCount: 3,
        engagementMaxLastWatched: new Date('2026-08-02T00:00:00Z'),
        engagementWatchedCount: 12,
        dismissedMaxCreated: new Date('2026-08-03T00:00:00Z'),
        dismissedCount: 1,
    };
    const params = {
        lane: 'series-next-up',
        budgetBytes: 8 * 1024 ** 3,
        rung: '720p',
        frequencyMode: 'balanced' as const,
    };
    const access = { deniedGroupIds: null, ageRating: null };
    const now = Date.parse('2026-08-20T10:05:00Z');

    it('is identical for identical inputs (same time bucket)', () => {
        const a = computeSeriesCandidatesEtag(baseInputs, params, access, now);
        const b = computeSeriesCandidatesEtag(baseInputs, params, access, now);
        expect(a).toBe(b);
    });

    it('changes when engagementResumeCount changes', () => {
        const a = computeSeriesCandidatesEtag(baseInputs, params, access, now);
        const b = computeSeriesCandidatesEtag(
            { ...baseInputs, engagementResumeCount: 4 },
            params,
            access,
            now,
        );
        expect(a).not.toBe(b);
    });

    it('changes when dismissedMaxCreated changes', () => {
        const a = computeSeriesCandidatesEtag(baseInputs, params, access, now);
        const b = computeSeriesCandidatesEtag(
            { ...baseInputs, dismissedMaxCreated: new Date('2026-08-04T00:00:00Z') },
            params,
            access,
            now,
        );
        expect(a).not.toBe(b);
    });

    it('changes when lane, budgetBytes or rung changes, even with identical DB state', () => {
        const a = computeSeriesCandidatesEtag(baseInputs, params, access, now);
        const b = computeSeriesCandidatesEtag(
            baseInputs,
            { ...params, budgetBytes: 1024 },
            access,
            now,
        );
        const c = computeSeriesCandidatesEtag(
            baseInputs,
            { ...params, rung: '1080p' },
            access,
            now,
        );
        expect(a).not.toBe(b);
        expect(a).not.toBe(c);
    });

    it('changes when frequencyMode changes, even with identical DB state', () => {
        // A stale ETag here would serve a 'balanced'-ordered cached list to a
        // client that just switched its picker to 'frequency_first'.
        const a = computeSeriesCandidatesEtag(baseInputs, params, access, now);
        const b = computeSeriesCandidatesEtag(
            baseInputs,
            { ...params, frequencyMode: 'frequency_first' },
            access,
            now,
        );
        expect(a).not.toBe(b);
    });

    it('changes when the resolved access context (library/age) changes', () => {
        // Unlike music, series mixes access directly in — a library-group
        // revocation or age-rating change must invalidate the cached list
        // immediately, not wait out the time bucket.
        const a = computeSeriesCandidatesEtag(baseInputs, params, access, now);
        const b = computeSeriesCandidatesEtag(
            baseInputs,
            params,
            { deniedGroupIds: ['g1'], ageRating: null },
            now,
        );
        const c = computeSeriesCandidatesEtag(
            baseInputs,
            params,
            { deniedGroupIds: null, ageRating: { maxAgeRating: 13, allowUnrated: false } },
            now,
        );
        expect(a).not.toBe(b);
        expect(a).not.toBe(c);
    });

    it('changes once the wall clock crosses into a new 15-minute bucket', () => {
        const a = computeSeriesCandidatesEtag(baseInputs, params, access, now);
        const fifteenMinutesLater = now + 15 * 60 * 1000;
        const b = computeSeriesCandidatesEtag(baseInputs, params, access, fifteenMinutesLater);
        expect(a).not.toBe(b);
    });

    it('is a strong (unquoted-prefix) validator', () => {
        const etag = computeSeriesCandidatesEtag(baseInputs, params, access, now);
        expect(etag.startsWith('"')).toBe(true);
        expect(etag.startsWith('W/')).toBe(false);
    });
});

describe('etagMatches', () => {
    it('matches an exact single value', () => {
        expect(etagMatches('"abc123"', '"abc123"')).toBe(true);
    });

    it('matches one entry in a comma-separated list', () => {
        expect(etagMatches('"zzz", "abc123", "yyy"', '"abc123"')).toBe(true);
    });

    it('matches the * wildcard', () => {
        expect(etagMatches('*', '"abc123"')).toBe(true);
    });

    it('does not match a different value', () => {
        expect(etagMatches('"zzz"', '"abc123"')).toBe(false);
    });
});

describe('candidates ETag / If-None-Match wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        mockGetCandidates.mockResolvedValue([]);
        mockReadySizes.mockResolvedValue([]);
        mockQueueDepth.mockResolvedValue(0);
        mockGetSeriesEtagInputs.mockResolvedValue({
            engagementMaxLastEvent: new Date('2026-08-01T00:00:00Z'),
            engagementResumeCount: 3,
            engagementMaxLastWatched: new Date('2026-08-02T00:00:00Z'),
            engagementWatchedCount: 12,
            dismissedMaxCreated: new Date('2026-08-03T00:00:00Z'),
            dismissedCount: 1,
        });
    });

    it('emits an ETag header on the 200 response', async () => {
        const res = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        expect(res.status).toBe(200);
        expect(res.headers.get('etag')).toMatch(/^".+"$/);
    });

    it('emits the same ETag across two calls with unchanged state', async () => {
        const res1 = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const res2 = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        expect(res1.headers.get('etag')).toBe(res2.headers.get('etag'));
    });

    it('emits a different ETag once the underlying state changes', async () => {
        const res1 = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        mockGetSeriesEtagInputs.mockResolvedValue({
            engagementMaxLastEvent: new Date('2026-08-10T00:00:00Z'),
            engagementResumeCount: 4,
            engagementMaxLastWatched: new Date('2026-08-02T00:00:00Z'),
            engagementWatchedCount: 12,
            dismissedMaxCreated: new Date('2026-08-03T00:00:00Z'),
            dismissedCount: 1,
        });
        const res2 = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        expect(res1.headers.get('etag')).not.toBe(res2.headers.get('etag'));
    });

    it('returns 304 with no body when If-None-Match matches, and does NOT consume rate-limit budget', async () => {
        const first = await def.handlers.GET!(makeEvent(), makeCtx() as never);
        const etag = first.headers.get('etag')!;
        mockCheckRateLimit.mockClear();

        const second = await def.handlers.GET!(
            makeEvent({ 'If-None-Match': etag }),
            makeCtx() as never,
        );

        expect(second.status).toBe(304);
        expect(await second.text()).toBe('');
        // MUTATION CHECK (see task instructions): temporarily moving the
        // rate-limit call above the ETag short-circuit in candidates.ts makes
        // this assertion fail, which is what proves it is actually guarding
        // the "304 must not burn budget" contract and not just trivially
        // green.
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('proceeds to the full query (200) when If-None-Match does not match', async () => {
        const res = await def.handlers.GET!(
            makeEvent({ 'If-None-Match': '"stale-etag"' }),
            makeCtx() as never,
        );
        expect(res.status).toBe(200);
        expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    });
});
