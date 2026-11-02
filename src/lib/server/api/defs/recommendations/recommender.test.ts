// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the recommender strategy interface.
 *
 * Tests `runRecommender` — the shared single entry point for all
 * recommendation flavours — and the `RecommenderStrategy` contract.
 * Does NOT test DB-backed strategies (those are integration tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import {
    runRecommender,
    getRailItems,
    UnknownRailError,
    type AccessContext,
    type RecommenderOptions,
    type RecommenderResult,
    type RecommenderStrategy,
    type RecommendationItem,
} from './recommender.js';
import { DependencyUnavailableError, isDependencyUnavailable } from '$lib/server/api/problem.js';

// ── Module mock for strategy registry (C2 tests only) ────────────────────────
//
// vi.mock is hoisted to module top; the default mock returns undefined for any
// id. Individual tests override via mockGetStrategy.mockReturnValue(…).

const mockGetStrategy = vi.hoisted(() => vi.fn<(id: string) => RecommenderStrategy | undefined>());

vi.mock('./strategies/index.js', () => ({
    getStrategy: (...args: Parameters<typeof mockGetStrategy>) => mockGetStrategy(...args),
}));

// ── Module mocks for the metadata-language overlay ───────────────────────────
//
// `runRecommender` dynamically imports both of these. Mocking them lets the
// overlay tests below assert which setters get wired without a live DB.

const { mockApplyOverlay, mockGetDb } = vi.hoisted(() => ({
    mockApplyOverlay: vi.fn().mockResolvedValue(undefined),
    mockGetDb: vi.fn(() => ({}) as unknown),
}));

vi.mock('$lib/server/utils/translation-overlay.js', () => ({
    applyTranslationOverlay: mockApplyOverlay,
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: mockGetDb,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    // Default: getStrategy returns undefined (unknown id).
    mockGetStrategy.mockReturnValue(undefined);
});

function makeAccessContext(partial?: Partial<AccessContext>): AccessContext {
    return {
        userId: 'usr_00000000-0000-0000-0000-000000000001' as UserId,
        username: 'alice',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: true,
        isAgeRestricted: false,
        ...partial,
    };
}

function makeOptions(partial?: Partial<RecommenderOptions>): RecommenderOptions {
    return {
        surface: 'internal',
        limit: 10,
        offset: 0,
        ...partial,
    };
}

const EMPTY_RESULT: RecommenderResult = { items: [], hasMore: false };

function makeStrategy(result: RecommenderResult | Error): RecommenderStrategy {
    return {
        id: 'test-strategy',
        label: () => 'Test',
        fetch:
            result instanceof Error
                ? vi.fn().mockRejectedValue(result)
                : vi.fn().mockResolvedValue(result),
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runRecommender()', () => {
    it('returns the result from the strategy when it succeeds', async () => {
        const expected: RecommenderResult = {
            items: [
                {
                    media: {
                        id: 'media-uuid-1',
                        type: 'movie',
                        title: 'Dawn: Part Two',
                        year: 2024,
                        ids: { tmdb: '693134' },
                    },
                    score: 0.9,
                    reason: { kind: 'trending' },
                },
            ],
            hasMore: false,
            total: 1,
        };

        const strategy = makeStrategy(expected);
        const result = await runRecommender(strategy, makeAccessContext(), makeOptions());

        expect(result).toEqual(expected);
        expect(strategy.fetch).toHaveBeenCalledOnce();
    });

    it('filters before offset pagination and returns a full page with filtered hasMore', async () => {
        const all: RecommendationItem[] = [
            { media: { id: 'series-1', type: 'series', title: 'S1', ids: {} } },
            { media: { id: 'series-2', type: 'series', title: 'S2', ids: {} } },
            { media: { id: 'movie-1', type: 'movie', title: 'M1', ids: {} } },
            { media: { id: 'series-3', type: 'series', title: 'S3', ids: {} } },
            { media: { id: 'movie-2', type: 'movie', title: 'M2', ids: {} } },
            { media: { id: 'movie-3', type: 'movie', title: 'M3', ids: {} } },
            { media: { id: 'movie-4', type: 'movie', title: 'M4', ids: {} } },
            { media: { id: 'movie-5', type: 'movie', title: 'M5', ids: {} } },
        ];
        const fetch = vi.fn(async (_ctx: AccessContext, opts: RecommenderOptions) => ({
            items: all.slice(0, opts.limit),
            hasMore: all.length > opts.limit,
            total: all.length,
        }));
        const strategy: RecommenderStrategy = {
            id: 'mixed',
            label: () => 'Mixed',
            fetch,
        };

        const result = await runRecommender(
            strategy,
            makeAccessContext(),
            makeOptions({ limit: 2, offset: 2, mediaTypes: new Set(['movie']) }),
        );

        expect(result.items.map((item) => item.media.id)).toEqual(['movie-3', 'movie-4']);
        expect(result.hasMore).toBe(true);
        expect(result.total).toBe(5);
        expect(fetch.mock.calls.map(([, opts]) => opts.limit)).toEqual([5, 10]);
        expect(fetch).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ offset: 0, mediaTypes: null }),
        );
    });

    it('fails closed when a strategy claims more data but its prefix stops growing', async () => {
        const strategy = makeStrategy({
            items: [{ media: { id: 'series-only', type: 'series', title: 'S', ids: {} } }],
            hasMore: true,
        });

        const result = await runRecommender(
            strategy,
            makeAccessContext(),
            makeOptions({ limit: 2, mediaTypes: new Set(['movie']) }),
        );

        expect(result).toEqual(EMPTY_RESULT);
        expect(strategy.fetch).toHaveBeenCalledTimes(2);
    });

    it('delegates media filtering to native strategies without unstable prefix expansion', async () => {
        const fetch = vi.fn().mockResolvedValue({
            items: [{ media: { id: 'movie-1', type: 'movie', title: 'M1', ids: {} } }],
            hasMore: false,
        });
        const strategy: RecommenderStrategy = {
            id: 'random-like',
            label: () => 'Random',
            mediaTypeFiltering: 'native',
            fetch,
        };
        const opts = makeOptions({
            limit: 1,
            offset: 7,
            mediaTypes: new Set(['movie']),
        });

        await runRecommender(strategy, makeAccessContext(), opts);

        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledWith(expect.anything(), opts);
    });

    it('forbids combining the offset-only mediaTypes filter with a cursor', async () => {
        const strategy = makeStrategy(EMPTY_RESULT);

        await expect(
            runRecommender(
                strategy,
                makeAccessContext(),
                makeOptions({ cursor: 'cursor-1', mediaTypes: new Set(['movie']) }),
            ),
        ).rejects.toThrow('cannot be combined with cursor pagination');
        expect(strategy.fetch).not.toHaveBeenCalled();
    });

    it('passes AccessContext and RecommenderOptions to the strategy fetch', async () => {
        const ctx = makeAccessContext({ username: 'bob', maxAgeRating: 16 });
        const opts = makeOptions({ limit: 5, hideWatched: true, genre: 'sci-fi' });

        const strategy = makeStrategy(EMPTY_RESULT);
        await runRecommender(strategy, ctx, opts);

        expect(strategy.fetch).toHaveBeenCalledWith(ctx, opts);
    });

    it('returns empty result (not an error) when the strategy throws', async () => {
        const strategy = makeStrategy(new Error('AI service unavailable'));
        const result = await runRecommender(strategy, makeAccessContext(), makeOptions());

        expect(result).toEqual(EMPTY_RESULT);
    });

    it('PROPAGATES a DependencyUnavailableError (does NOT swallow to empty)', async () => {
        // Regression: dependency-down must be signalled, never conflated with a
        // genuine-empty result. Tier-2 endpoints map this to 503; /feed drops
        // the section.
        const strategy = makeStrategy(
            new DependencyUnavailableError('Database unavailable', 'postgres'),
        );

        await expect(
            runRecommender(strategy, makeAccessContext(), makeOptions()),
        ).rejects.toSatisfy(isDependencyUnavailable);
    });

    it('returns empty result when the strategy rejects with a non-Error value', async () => {
        const strategy: RecommenderStrategy = {
            id: 'flaky',
            label: () => 'Flaky Strategy',
            fetch: vi.fn().mockRejectedValue('string rejection'),
        };

        const result = await runRecommender(strategy, makeAccessContext(), makeOptions());
        expect(result).toEqual(EMPTY_RESULT);
    });

    it('returns the full result shape including nextCursor', async () => {
        const expected: RecommenderResult = {
            items: [],
            hasMore: true,
            nextCursor: 'cursor-abc-xyz',
        };
        const strategy = makeStrategy(expected);
        const result = await runRecommender(strategy, makeAccessContext(), makeOptions());

        expect(result.hasMore).toBe(true);
        expect(result.nextCursor).toBe('cursor-abc-xyz');
    });

    it('correctly forwards limit + offset from options to strategy', async () => {
        const opts = makeOptions({ limit: 20, offset: 40 });
        const strategy = makeStrategy(EMPTY_RESULT);

        await runRecommender(strategy, makeAccessContext(), opts);

        expect(strategy.fetch).toHaveBeenCalledWith(
            expect.objectContaining({}),
            expect.objectContaining({ limit: 20, offset: 40 }),
        );
    });

    it('does not mutate the options object passed to the strategy', async () => {
        const opts = makeOptions({ limit: 10 });
        const originalLimit = opts.limit;
        const strategy = makeStrategy(EMPTY_RESULT);

        await runRecommender(strategy, makeAccessContext(), opts);

        expect(opts.limit).toBe(originalLimit);
    });
});

// ── Database-fault reclassification (error-swallowing fix) ───────────────────
//
// `runRecommender`'s catch-all used to downgrade EVERY uncaught strategy
// error — including a genuine Postgres fault — to a status-less
// `{ items: [], hasMore: false }`. `getTasteRailPage` (for-you/taste.ts) then
// defaults a missing `status` to `'ready'`, so a hard DB failure rendered as
// a legitimately-empty rail with nothing retriable. This mirrors the fix
// already shipped for `ai.strategy.ts` (94688ec18), applied as a backstop at
// the shared `runRecommender` entry point for any strategy that doesn't
// classify its own DB faults.

describe('runRecommender() — database-fault reclassification', () => {
    it('reports a genuine Postgres query fault as dependency-unavailable, not a status-less empty result', async () => {
        const strategy = makeStrategy(
            Object.assign(
                new postgres.PostgresError('op ANY/ALL (array) requires array on right side'),
                { code: '42883', severity: 'ERROR' },
            ),
        );

        let caught: unknown;
        try {
            await runRecommender(strategy, makeAccessContext(), makeOptions());
            expect.unreachable('runRecommender should have thrown');
        } catch (err) {
            caught = err;
        }

        expect(isDependencyUnavailable(caught)).toBe(true);
    });

    it('reports a Postgres connection fault (e.g. a cold pool timing out) as dependency-unavailable', async () => {
        const strategy = makeStrategy(
            Object.assign(new Error('write CONNECT_TIMEOUT'), { code: 'CONNECT_TIMEOUT' }),
        );

        let caught: unknown;
        try {
            await runRecommender(strategy, makeAccessContext(), makeOptions());
            expect.unreachable('runRecommender should have thrown');
        } catch (err) {
            caught = err;
        }

        expect(isDependencyUnavailable(caught)).toBe(true);
    });

    it('still isolates a truly unexpected non-DB error (TypeError) to an empty result, NOT a 503', async () => {
        // A TypeError is a programming-error shape, not a Postgres fault — it
        // must keep degrading to an empty result so one buggy strategy can't
        // fail the whole request. This is the line `isGenuineDbFault` draws:
        // only real infrastructure faults escalate, never a plain bug.
        const strategy = makeStrategy(new TypeError('Cannot read properties of undefined'));

        const result = await runRecommender(strategy, makeAccessContext(), makeOptions());

        expect(result).toEqual(EMPTY_RESULT);
    });

    it('/feed-style per-section isolation: a DB fault in one section does not affect a sibling section', async () => {
        // Mirrors the try/catch-per-section pattern in recommendations/feed.ts:
        // each section's `getRailItems`/`runRecommender` call is wrapped
        // individually, and a dependency-down error drops ONLY that section
        // while siblings still resolve normally.
        const failingStrategy = makeStrategy(
            Object.assign(new postgres.PostgresError('connection reset'), { code: '08006' }),
        );
        const okItems: RecommendationItem[] = [
            { media: { id: 'movie-ok', type: 'movie', title: 'Still Fine', ids: {} } },
        ];
        const healthyStrategy = makeStrategy({ items: okItems, hasMore: false });

        async function runSection(
            strategy: RecommenderStrategy,
        ): Promise<RecommenderResult | null> {
            try {
                return await runRecommender(strategy, makeAccessContext(), makeOptions());
            } catch (err) {
                if (isDependencyUnavailable(err)) return null; // dropped section
                throw err; // a real bug should NOT be swallowed silently here
            }
        }

        const [failingSection, healthySection] = await Promise.all([
            runSection(failingStrategy),
            runSection(healthyStrategy),
        ]);

        expect(failingSection).toBeNull();
        expect(healthySection).not.toBeNull();
        expect(healthySection?.items).toEqual(okItems);
    });
});

// ── Strategy contract (documentation-by-test) ────────────────────────────────

describe('RecommenderStrategy contract', () => {
    it('a strategy can return items with only required fields', async () => {
        const minimal: RecommenderResult = {
            items: [
                {
                    media: {
                        id: 'media-uuid-2',
                        type: 'series',
                        title: 'Succession',
                        ids: { tmdb: '63333' },
                    },
                },
            ],
            hasMore: false,
        };
        const strategy = makeStrategy(minimal);
        const result = await runRecommender(strategy, makeAccessContext(), makeOptions());

        const item = result.items[0];
        expect(item.media.id).toBe('media-uuid-2');
        expect(item.score).toBeUndefined();
        expect(item.reason).toBeUndefined();
    });

    it('a strategy can include a score in [0, 1]', async () => {
        const scored: RecommenderResult = {
            items: [
                {
                    media: { id: 'media-uuid-3', type: 'movie', title: 'Orionkeeper', ids: {} },
                    score: 0.75,
                },
            ],
            hasMore: false,
        };
        const strategy = makeStrategy(scored);
        const result = await runRecommender(strategy, makeAccessContext(), makeOptions());

        expect(result.items[0].score).toBe(0.75);
    });

    it('clamps an out-of-range score into [0, 1] (e.g. a 0–100 rating scaled by /10)', async () => {
        // rt_rating 85 / 10 = 8.5 — would fail RecommendationItemSchema's max(1)
        const overflow: RecommenderResult = {
            items: [
                { media: { id: 'm-hi', type: 'movie', title: 'A', ids: {} }, score: 8.5 },
                { media: { id: 'm-lo', type: 'movie', title: 'B', ids: {} }, score: -0.2 },
            ],
            hasMore: false,
        };
        const result = await runRecommender(
            makeStrategy(overflow),
            makeAccessContext(),
            makeOptions(),
        );
        expect(result.items[0].score).toBe(1);
        expect(result.items[1].score).toBe(0);
    });

    it('drops a non-finite score to undefined rather than emitting NaN', async () => {
        const nan: RecommenderResult = {
            items: [{ media: { id: 'm-nan', type: 'movie', title: 'C', ids: {} }, score: NaN }],
            hasMore: false,
        };
        const result = await runRecommender(makeStrategy(nan), makeAccessContext(), makeOptions());
        expect(result.items[0].score).toBeUndefined();
    });

    it('a strategy reason can include a seed and a label', async () => {
        const withReason: RecommenderResult = {
            items: [
                {
                    media: { id: 'media-uuid-4', type: 'movie', title: 'Intertidal', ids: {} },
                    reason: {
                        kind: 'because-you-watched',
                        seed: 'media-uuid-0',
                        label: 'Science Fiction',
                    },
                },
            ],
            hasMore: false,
        };
        const strategy = makeStrategy(withReason);
        const result = await runRecommender(strategy, makeAccessContext(), makeOptions());

        const reason = result.items[0].reason;
        expect(reason?.kind).toBe('because-you-watched');
        expect(reason?.seed).toBe('media-uuid-0');
        expect(reason?.label).toBe('Science Fiction');
    });

    it('hasMore is true when the strategy signals more pages exist', async () => {
        const paginated: RecommenderResult = {
            items: Array.from({ length: 10 }, (_, i) => ({
                media: { id: `media-${i}`, type: 'movie', title: `Movie ${i}`, ids: {} },
            })),
            hasMore: true,
        };
        const strategy = makeStrategy(paginated);
        const result = await runRecommender(
            strategy,
            makeAccessContext(),
            makeOptions({ limit: 10 }),
        );

        expect(result.hasMore).toBe(true);
        expect(result.items).toHaveLength(10);
    });
});

// ── C2: getRailItems dispatch ─────────────────────────────────────────────────

describe('getRailItems()', () => {
    it('throws UnknownRailError for a type that is not in the registry', async () => {
        mockGetStrategy.mockReturnValue(undefined);

        await expect(
            getRailItems('not-a-real-type', makeAccessContext(), makeOptions()),
        ).rejects.toBeInstanceOf(UnknownRailError);
    });

    it('UnknownRailError carries the unknown railType string', async () => {
        mockGetStrategy.mockReturnValue(undefined);

        const err = await getRailItems('mystery-rail', makeAccessContext(), makeOptions()).catch(
            (e) => e,
        );

        expect(err).toBeInstanceOf(UnknownRailError);
        expect((err as UnknownRailError).railType).toBe('mystery-rail');
    });

    it('does NOT throw UnknownRailError — propagates DependencyUnavailableError from the strategy', async () => {
        // When the registry resolves a valid strategy but that strategy throws
        // DependencyUnavailableError, getRailItems must propagate it unchanged
        // (not swallow to empty, not wrap as UnknownRailError).
        const depError = new DependencyUnavailableError('DB down', 'postgres');
        const faultyStrategy: RecommenderStrategy = {
            id: 'trending',
            label: () => 'Trending',
            fetch: vi.fn().mockRejectedValue(depError),
        };
        mockGetStrategy.mockReturnValue(faultyStrategy);

        await expect(
            getRailItems('trending', makeAccessContext(), makeOptions()),
        ).rejects.toSatisfy(isDependencyUnavailable);
    });

    it('DependencyUnavailableError from a strategy is NOT downgraded to an empty result', async () => {
        const depError = new DependencyUnavailableError('Valkey unavailable', 'valkey');
        const faultyStrategy: RecommenderStrategy = {
            id: 'ai',
            label: () => 'AI',
            fetch: vi.fn().mockRejectedValue(depError),
        };
        mockGetStrategy.mockReturnValue(faultyStrategy);

        // The call must reject — it must not resolve to { items: [], hasMore: false }
        await expect(getRailItems('ai', makeAccessContext(), makeOptions())).rejects.toThrow();
    });

    it('returns the strategy result when the strategy succeeds', async () => {
        const expected: RecommenderResult = {
            items: [
                {
                    media: { id: 'media-xyz', type: 'movie', title: 'Dawn', ids: {} },
                    score: 0.8,
                },
            ],
            hasMore: false,
        };
        const successStrategy: RecommenderStrategy = {
            id: 'trending',
            label: () => 'Trending',
            fetch: vi.fn().mockResolvedValue(expected),
        };
        mockGetStrategy.mockReturnValue(successStrategy);

        const result = await getRailItems('trending', makeAccessContext(), makeOptions());

        expect(result).toEqual(expected);
    });

    it('passes AccessContext and RecommenderOptions through to the strategy', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(EMPTY_RESULT);
        mockGetStrategy.mockReturnValue({ id: 'for-you', label: () => 'For You', fetch: fetchSpy });

        const ctx = makeAccessContext({ username: 'carol', maxAgeRating: 12 });
        const opts = makeOptions({ limit: 5, hideWatched: true });

        await getRailItems('for-you', ctx, opts);

        expect(fetchSpy).toHaveBeenCalledWith(ctx, opts);
    });
});

// ── Metadata-language overlay wiring ─────────────────────────────────────────
//
// `runRecommender` is the SINGLE place every strategy funnels through, so the
// setters it wires decide which fields a non-primary-language viewer sees
// translated. `overview` was added to RecommendedMediaRefSchema for the rail /
// hero display metadata (hydrated by getMediaRailMetadataBatch straight off
// `provider_metadata`, i.e. primary language) but no `setOverview` was wired
// here — so a German viewer got a German title over an English synopsis on the
// AI-suggestion hero slide.

describe('runRecommender() — metadata-language overlay', () => {
    function itemWithOverview(): RecommendationItem {
        return {
            media: {
                id: 'media-uuid-1',
                type: 'movie',
                title: 'Top Gun: Maverick',
                ids: {},
                overview: 'After more than thirty years of service…',
            },
            reason: { kind: 'trending' },
        };
    }

    const DE: AccessContext['langs'] = { titleLang: 'de', textLang: 'de' };

    it('wires setTitle AND setOverview so the synopsis is translated too', async () => {
        const item = itemWithOverview();
        const strategy = makeStrategy({ items: [item], hasMore: false });

        await runRecommender(strategy, makeAccessContext({ langs: DE }), makeOptions());

        expect(mockApplyOverlay).toHaveBeenCalledOnce();
        const opts = mockApplyOverlay.mock.calls[0][3] as {
            id: (it: RecommendationItem) => string | null;
            setTitle?: (it: RecommendationItem, v: string) => void;
            setOverview?: (it: RecommendationItem, v: string) => void;
        };

        expect(opts.id(item)).toBe('media-uuid-1');

        opts.setTitle?.(item, 'Top Gun: Maverick (DE)');
        opts.setOverview?.(item, 'Nach mehr als dreißig Dienstjahren…');

        expect(item.media.title).toBe('Top Gun: Maverick (DE)');
        expect(item.media.overview).toBe('Nach mehr als dreißig Dienstjahren…');
    });

    it('skips ext: placeholder ids (not resolvable to a media_items row)', async () => {
        const item = itemWithOverview();
        item.media.id = 'ext:tmdb:693134';
        const strategy = makeStrategy({ items: [item], hasMore: false });

        await runRecommender(strategy, makeAccessContext({ langs: DE }), makeOptions());

        const opts = mockApplyOverlay.mock.calls[0][3] as {
            id: (it: RecommendationItem) => string | null;
        };
        expect(opts.id(item)).toBeNull();
    });

    it('no-ops when neither title nor text language resolves', async () => {
        const strategy = makeStrategy({ items: [itemWithOverview()], hasMore: false });

        await runRecommender(
            strategy,
            makeAccessContext({ langs: { titleLang: null, textLang: null } }),
            makeOptions(),
        );

        expect(mockApplyOverlay).not.toHaveBeenCalled();
    });
});
