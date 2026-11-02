// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards the published contract of the quick-picks def: a per-user rate
 * limit (new — this endpoint was unlimited while dashboard-only), and that
 * the SAME def emits surface-correct image URLs on both its internal mount
 * (/api/music/quick-picks) and its new v1 mount (/api/v1/music/quick-picks).
 *
 * The def declares `request: { body: BodySchema }`, so mount() validates and
 * defaults the body BEFORE the handler runs and hands the parsed result to
 * the handler via `ctx.input.body` — the handler itself never re-parses
 * `event.request.json()`. These tests therefore construct `ctx.input.body`
 * directly, the same way mount() would have produced it (see
 * defs/catalog/media-id-rating.test.ts's `makeCtxWithBody` for the established
 * pattern). The "would mount() 422 a bad body" question is answered by
 * unit-testing `BodySchema` itself directly (below) — the shared 422/
 * validation_failed behavior of mount()'s request-schema gate is exercised
 * generically elsewhere, not per-def.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { BodySchema } from './quick-picks.js';

const mockGetSql = vi.fn();
const mockGetRecentlyPlayed = vi.fn();
const mockGetQuickPicks = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockCheckRateLimit = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getRecentlyPlayed: (...args: unknown[]) => mockGetRecentlyPlayed(...args),
}));

vi.mock('$lib/server/services/music/quick-picks.service.js', () => ({
    getQuickPicks: (...args: unknown[]) => mockGetQuickPicks(...args),
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

const { def } = await import('./quick-picks.js');

function makeEvent(): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/music/quick-picks'),
        params: {},
        request: new Request('http://localhost/api/music/quick-picks', {
            method: 'POST',
            body: JSON.stringify({}),
        }),
    } as unknown as RequestEvent;
}

/** ctx as mount() would build it from a body of `{}` — limit/excludeIds defaulted. */
function makeCtx(surface: 'internal' | 'v1', body: { limit?: number; excludeIds?: string[] } = {}) {
    return {
        surface,
        input: {
            body: { limit: 24, excludeIds: [], ...body },
            query: undefined,
            params: undefined,
        },
    };
}

describe('quick-picks published contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockGetRecentlyPlayed.mockResolvedValue([]);
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        mockGetQuickPicks.mockResolvedValue([
            {
                id: 't1',
                title: 'Track One',
                artist_title: 'Artist',
                artist_id: 'ar1',
                album_id: 'al1',
                bucket: 'heavy-rotation',
            },
        ]);
    });

    it('returns 401 when unauthenticated', async () => {
        const event = { ...makeEvent(), locals: { user: null } } as unknown as RequestEvent;
        const res = await def.handlers.POST!(event, makeCtx('internal') as never);
        expect(res.status).toBe(401);
    });

    it('returns 429 when the per-user limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: Date.now() / 1000 + 30 });
        const res = await def.handlers.POST!(makeEvent(), makeCtx('internal') as never);
        expect(res.status).toBe(429);
        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            expect.stringContaining('u1'),
            expect.any(Number),
            expect.any(Number),
        );
    });

    it('checks the rate limit AFTER the DB-availability check', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await def.handlers.POST!(makeEvent(), makeCtx('internal') as never);
        expect(res.status).toBe(503);
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('the internal mount (ctx.surface="internal") returns internal-surface image URLs', async () => {
        const res = await def.handlers.POST!(makeEvent(), makeCtx('internal') as never);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.items[0].image).toContain('/api/media/t1/images/poster');
        expect(body.items[0].image).not.toContain('/api/v1/');
    });

    it('the v1 mount (ctx.surface="v1") returns v1-surface image URLs', async () => {
        const res = await def.handlers.POST!(makeEvent(), makeCtx('v1') as never);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.items[0].image).toContain('/api/v1/media/t1/images/poster');
    });

    it('forwards ctx.input.body.excludeIds (already validated by mount()) into the exclude list', async () => {
        await def.handlers.POST!(
            makeEvent(),
            makeCtx('internal', { excludeIds: ['already-seen-1', 'already-seen-2'] }) as never,
        );
        expect(mockGetQuickPicks).toHaveBeenCalledWith(
            expect.anything(),
            'u1',
            24,
            expect.arrayContaining(['already-seen-1', 'already-seen-2']),
            expect.anything(),
        );
    });

    it('forwards ctx.input.body.limit into getQuickPicks', async () => {
        await def.handlers.POST!(makeEvent(), makeCtx('internal', { limit: 5 }) as never);
        expect(mockGetQuickPicks).toHaveBeenCalledWith(
            expect.anything(),
            'u1',
            5,
            expect.anything(),
            expect.anything(),
        );
    });
});

describe('BodySchema — request contract enforced by mount() (Finding 1 fix)', () => {
    // The def now declares `request: { body: BodySchema }`, so mount() runs
    // this schema against the incoming JSON body BEFORE the handler is
    // invoked, and rejects a failing body with 422 validation_failed — the
    // handler is never reached and never falls back to silently-defaulted
    // values. mount() itself is exercised generically elsewhere (it is
    // shared infrastructure, not per-def logic); what's specific to THIS def
    // is that BodySchema actually enforces the documented `excludeIds` cap,
    // which is what these tests prove ("422 upstream" — the same convention
    // used by defs/catalog/media-id-rating.test.ts for RatingBody).
    it('rejects an excludeIds array with 1001 entries — request contract (422 upstream)', () => {
        const tooMany = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
        const result = BodySchema.safeParse({ excludeIds: tooMany });
        expect(result.success).toBe(false);
    });

    it('accepts an excludeIds array with exactly 1000 entries (the documented cap)', () => {
        const atCap = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
        const result = BodySchema.safeParse({ excludeIds: atCap });
        expect(result.success).toBe(true);
    });

    it('does NOT silently drop limit when excludeIds alone is invalid — whole body fails together', () => {
        // Before the fix, a per-field manual parse meant an invalid excludeIds
        // caused BOTH limit and excludeIds to fall back to defaults with a 200.
        // Now mount() rejects the whole request before any handler code runs,
        // so there is no partial-default state to assert on the handler side —
        // the absence of a success path IS the fix. This asserts the schema
        // itself never produces a partially-valid parse.
        const tooMany = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
        const result = BodySchema.safeParse({ limit: 10, excludeIds: tooMany });
        expect(result.success).toBe(false);
    });
});
