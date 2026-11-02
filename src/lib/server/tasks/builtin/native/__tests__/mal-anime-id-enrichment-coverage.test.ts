// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * mal-anime-id-enrichment behavioural coverage tests.
 *
 * Asserts OUTCOMES, not source text:
 *
 * A) Success path: the REAL upsertCompletedRow is called with the correct
 *    arguments (mediaItemId, stageId, processingVersion) inside the
 *    transaction — a test that would still pass if upsertCompletedRow were
 *    deleted is not acceptable here.
 *
 * B) Gate routing — authoritative: when getAuthoritativeStageIds() includes
 *    'mal-anime-id-enrichment', fetchSlice calls findCoverageTableBacklog
 *    and NOT getEnrichmentCandidates.
 *
 * C) Gate routing — legacy: when the stage is NOT authoritative, fetchSlice
 *    calls getEnrichmentCandidates and NOT findCoverageTableBacklog.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as StageStateQueries from '$lib/server/database/queries/stage-state.queries.js';
import type * as DrainBacklogModule from '$lib/server/plugins/runtime/drain-backlog.js';
import type { EnrichmentCandidate } from '$lib/server/database/queries/media-external-groupings.queries.js';
import type postgres from 'postgres';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';

// Keep the real retry/rate-limit paths, with a 1 ms test-only wait per attempt.
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        ...[callback, _delay, ...args]: Parameters<typeof setTimeout>
    ) => realSetTimeout(callback, 1, ...args)) as typeof setTimeout);
});
afterEach(() => {
    vi.restoreAllMocks();
    configMock.config.MAL_CLIENT_ID = '';
    configMock.config.MAL_CLIENT_SECRET = '';
});

// ---------------------------------------------------------------------------
// Stage-state spy — hoisted ABOVE imports per verified hoist-safe convention
// ---------------------------------------------------------------------------

const stageState = vi.hoisted(() => ({
    upsertCompletedRow: vi.fn<typeof StageStateQueries.upsertCompletedRow>(),
    upsertSkippedPermanentRow: vi.fn<typeof StageStateQueries.upsertSkippedPermanentRow>(),
    markAllPendingSkippedTransientForStage: vi
        .fn<typeof StageStateQueries.markAllPendingSkippedTransientForStage>()
        .mockResolvedValue(0),
    markSkippedTransientBatch: vi
        .fn<typeof StageStateQueries.markSkippedTransientBatch>()
        .mockResolvedValue(0),
    deferTransientRetryBatch: vi
        .fn<typeof StageStateQueries.deferTransientRetryBatch>()
        .mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => stageState);

// ---------------------------------------------------------------------------
// config mock — controls getAuthoritativeStageIds + DISABLE flag
// ---------------------------------------------------------------------------

const configMock = vi.hoisted(() => ({
    getAuthoritativeStageIds: vi.fn<() => Set<string>>(() => new Set()),
    config: { DISABLE_MAL_ANIME_ENRICHMENT: false, MAL_CLIENT_ID: '', MAL_CLIENT_SECRET: '' },
}));
vi.mock('$lib/server/config.js', async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    return {
        ...actual,
        getAuthoritativeStageIds: configMock.getAuthoritativeStageIds,
        config: configMock.config,
    };
});

// ---------------------------------------------------------------------------
// Registry mock — prevents side-effect registration at import time
// ---------------------------------------------------------------------------

vi.mock('$lib/server/tasks/builtin/../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

// ---------------------------------------------------------------------------
// mal-credentials mock — makes getBorrowerAuth succeed without HTTP
// ---------------------------------------------------------------------------

const malCredentialsMock = vi.hoisted(() => ({
    listMalBorrowerCredentials: vi.fn().mockResolvedValue([
        {
            userId: 'aaaaaaaa-0000-4000-a000-000000000001',
            accessToken: 'tok-access',
            refreshToken: 'tok-refresh',
        },
    ]),
    updateMalTokens: vi.fn().mockResolvedValue(undefined),
    markMalAuthFailed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock(
    '$lib/server/tasks/builtin/native/../../../database/queries/mal-credentials.queries.js',
    () => malCredentialsMock,
);

// ---------------------------------------------------------------------------
// media-hierarchy mock — flattenSeriesEpisodesRaw returns fixed episodes
// ---------------------------------------------------------------------------

const mediaHierarchyMock = vi.hoisted(() => ({
    flattenSeriesEpisodesRaw: vi.fn().mockResolvedValue([
        { episode_id: 'ep-uuid-001', season_number: 1, episode_number: 1 },
        { episode_id: 'ep-uuid-002', season_number: 1, episode_number: 2 },
    ]),
}));
vi.mock(
    '$lib/server/tasks/builtin/native/../../../database/queries/media-hierarchy.queries.js',
    () => mediaHierarchyMock,
);

// ---------------------------------------------------------------------------
// media-external-groupings mock — spy on fetchSlice routing fns + side-effects
// ---------------------------------------------------------------------------

const groupingsMock = vi.hoisted(() => ({
    getEnrichmentCandidates: vi
        .fn<
            (
                sql: postgres.Sql,
                provider: string,
                source: string,
                limit: number,
                afterId?: string,
            ) => Promise<EnrichmentCandidate[]>
        >()
        .mockResolvedValue([]),
    countEnrichmentBacklog: vi.fn().mockResolvedValue({ remaining: 0, ineligible: 0 }),
    wipeEnrichmentRows: vi.fn().mockResolvedValue(undefined),
    findCoverageTableBacklog: vi
        .fn<
            (
                sql: postgres.Sql,
                stageId: string,
                provider: string,
                limit: number,
            ) => Promise<EnrichmentCandidate[]>
        >()
        .mockResolvedValue([]),
    upsertGroupings: vi.fn().mockResolvedValue(undefined),
    deleteStaleGroupings: vi.fn().mockResolvedValue(0),
    upsertSeriesGroupingState: vi.fn().mockResolvedValue(undefined),
    getSeriesGroupingState: vi.fn().mockResolvedValue(null),
}));
vi.mock(
    '$lib/server/tasks/builtin/native/../../../database/queries/media-external-groupings.queries.js',
    () => groupingsMock,
);

// ---------------------------------------------------------------------------
// with-tx mock — invokes callback with the recording-sql tx double
// ---------------------------------------------------------------------------

// Captured at test setup so each test can pass its own tx handle.
let _txDouble: postgres.Sql | null = null;

vi.mock('$lib/server/tasks/builtin/native/../../../database/with-tx.js', () => ({
    withTx: vi.fn(
        async (
            _sql: postgres.Sql,
            cb: (tx: postgres.Sql) => Promise<unknown>,
        ): Promise<unknown> => {
            if (_txDouble === null) throw new Error('withTx: _txDouble not set');
            return cb(_txDouble);
        },
    ),
}));

// ---------------------------------------------------------------------------
// drain-backlog mock — drives processSlice with a controlled slice
// ---------------------------------------------------------------------------

let _sliceToProcess: EnrichmentCandidate[] = [];

vi.mock('$lib/server/plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return {
        ...actual,
        drainBacklog: vi.fn(
            async <T>(
                _ctx: unknown,
                opts: {
                    processSlice: (slice: T[], signal: AbortSignal) => Promise<unknown>;
                    fetchSlice: (limit: number) => Promise<{ items: T[]; remainingHint?: number }>;
                    onWipe?: () => Promise<void>;
                },
            ) => {
                const { items } = await opts.fetchSlice(1000);
                if (items.length > 0) {
                    await opts.processSlice(items, new AbortController().signal);
                }
                return { stopReason: 'drained' as const };
            },
        ),
        resolveDrainMode: vi.fn().mockReturnValue('catchup'),
        lazyBacklog: actual.lazyBacklog,
        computeRemainingHint: actual.computeRemainingHint,
        formatStopReason: actual.formatStopReason,
        isAbortedStop: actual.isAbortedStop,
    };
});

// ---------------------------------------------------------------------------
// Import the task under test (AFTER all mocks are declared)
// ---------------------------------------------------------------------------

import { malAnimeIdEnrichmentTask } from '../mal-anime-id-enrichment.js';
import { drainBacklog as drainBacklogFn } from '$lib/server/plugins/runtime/drain-backlog.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

// ---------------------------------------------------------------------------
// Test context factory
// ---------------------------------------------------------------------------

function makeCtx(sqlInstance: postgres.Sql): TaskContext<Record<string, unknown>> {
    const ac = new AbortController();
    return {
        runId: 'test-run-mal',
        attemptNumber: 1,
        input: {},
        scope: {},
        mode: 'scheduled',
        sql: sqlInstance,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        reportProgress: vi.fn(),
        dep: vi.fn(),
        settings: vi.fn(),
        spend: vi.fn(),
        http: {
            get: vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({}),
            }),
            post: vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({}),
            }),
        },
        catalog: undefined as unknown as TaskContext['catalog'],
        mediaItems: undefined as unknown as TaskContext['mediaItems'],
        mediaFiles: undefined as unknown as TaskContext['mediaFiles'],
        userCredentials: undefined as unknown as TaskContext['userCredentials'],
    } as unknown as TaskContext<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mal-anime-id-enrichment: success path writes upsertCompletedRow', () => {
    const SERIES_ID = 'series-uuid-aaaa-bbbb-cccc';
    const MAL_ID = '40028';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        // Default: NOT authoritative → uses getEnrichmentCandidates path
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
    });

    it('calls upsertCompletedRow(tx, { mediaItemId, stageId, processingVersion }) on success', async () => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;

        // MAL HTTP: probe /users/@me succeeds so getBorrowerAuth returns auth
        const httpGet = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/users/@me')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({}),
                });
            }
            if (url.includes(`/anime/${MAL_ID}`)) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: Number(MAL_ID),
                        num_episodes: 2,
                        media_type: 'tv',
                        related_anime: [],
                    }),
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({}),
            });
        });

        const candidate: EnrichmentCandidate = {
            seriesId: SERIES_ID,
            seriesMalId: MAL_ID,
        };
        // Inject candidate into the drain-backlog driven fetchSlice
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([candidate]);
        groupingsMock.deleteStaleGroupings.mockResolvedValue(0);

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: typeof httpGet }).get = httpGet;

        await malAnimeIdEnrichmentTask.execute(ctx);

        expect(stageState.upsertCompletedRow).toHaveBeenCalledTimes(1);
        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(_txDouble, {
            mediaItemId: SERIES_ID,
            stageId: 'mal-anime-id-enrichment',
            processingVersion: 1,
        });
    });
});

describe('mal-anime-id-enrichment: monitoring-blindness regression', () => {
    const SERIES_ID = 'series-uuid-outage-0001';
    const MAL_ID = '40028';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        // Restore borrower creds (a prior describe may have overridden to []).
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([
            {
                userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                accessToken: 'tok-access',
                refreshToken: 'tok-refresh',
            },
        ]);
        mediaHierarchyMock.flattenSeriesEpisodesRaw.mockResolvedValue([
            { episode_id: 'ep-uuid-001', season_number: 1, episode_number: 1 },
            { episode_id: 'ep-uuid-002', season_number: 1, episode_number: 2 },
        ]);
        groupingsMock.getSeriesGroupingState.mockResolvedValue(null);
    });

    it('total MAL API outage (every enrichSeries throws → enriched=0, errors>0) → throws transient TaskError', async () => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;

        // Borrower auth probe (/users/@me) succeeds so getBorrowerAuth resolves,
        // but the anime lookup returns a NON-5xx, non-404, non-401 error (403).
        // malGetForUser throws on !resp.ok → getAnimeInfo rethrows (not 404) →
        // enrichSeries throws → processSlice catch bumps `errors`; enriched stays 0.
        // (403 avoids the real 5xx-retry backoff delays, keeping the test fast.)
        const httpGet = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/users/@me')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            }
            return Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' });
        });

        const candidate: EnrichmentCandidate = {
            seriesId: SERIES_ID,
            seriesMalId: MAL_ID,
        };
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([candidate]);

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: typeof httpGet }).get = httpGet;

        await expect(malAnimeIdEnrichmentTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
        });

        // Nothing enriched → no success coverage row written.
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('total MAL rate limit (429 exhausts retry budget) → throws with a rate-limit-specific message', async () => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;

        // Every /anime call 429s with Retry-After: 0 (no real delay) — the
        // per-request retry budget (MAX_429_RETRIES=3) exhausts and the error
        // propagates up through enrichSeries as an "MAL API ...: 429 Too Many
        // Requests" message.
        const httpGet = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/users/@me')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            }
            return Promise.resolve({
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                headers: { get: (name: string) => (name === 'retry-after' ? '0' : null) },
            });
        });

        const candidate: EnrichmentCandidate = { seriesId: SERIES_ID, seriesMalId: MAL_ID };
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([candidate]);

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: typeof httpGet }).get = httpGet;

        await expect(malAnimeIdEnrichmentTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
            message: expect.stringContaining('rate limit reached'),
        });
    });

    it.each([
        [
            'outage',
            () => Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 503 })),
        ],
        ['network', () => Promise.reject(new Error('offline'))],
        [
            'client secret',
            () => Promise.resolve(Response.json({ error: 'invalid_client' }, { status: 401 })),
        ],
    ])('borrowed MAL auth: %s cannot mark a connection as revoked', async (_kind, refresh) => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;
        configMock.config.MAL_CLIENT_ID = 'id';
        configMock.config.MAL_CLIENT_SECRET = 'secret';
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([
            { seriesId: SERIES_ID, seriesMalId: MAL_ID },
        ]);
        const ctx = makeCtx(rec.sql);
        ctx.http!.get = vi.fn(async (url: string) =>
            url.includes('/users/@me') ? Response.json({}) : new Response('', { status: 401 }),
        );
        ctx.http!.post = vi.fn(refresh);
        await expect(malAnimeIdEnrichmentTask.execute(ctx)).rejects.toMatchObject({
            kind: 'transient',
        });
        expect(ctx.http!.post).toHaveBeenCalled();
        expect(malCredentialsMock.markMalAuthFailed).not.toHaveBeenCalled();
    });

    it('total MAL auth failure (401 on every attempt) → throws with a re-link-specific message', async () => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;

        const httpGet = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/users/@me')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            }
            return Promise.resolve({ ok: false, status: 401, statusText: 'Unauthorized' });
        });

        const candidate: EnrichmentCandidate = { seriesId: SERIES_ID, seriesMalId: MAL_ID };
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([candidate]);

        configMock.config.MAL_CLIENT_ID = 'id';
        configMock.config.MAL_CLIENT_SECRET = 'secret';
        const ctx = makeCtx(rec.sql);
        ctx.http!.post = vi.fn(async () =>
            Response.json({ error: 'invalid_grant' }, { status: 400 }),
        );
        (ctx.http as unknown as { get: typeof httpGet }).get = httpGet;

        await expect(malAnimeIdEnrichmentTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
            message: expect.stringContaining('re-link MAL'),
        });
        expect(malCredentialsMock.markMalAuthFailed).toHaveBeenCalled();
    });
});

describe('mal-anime-id-enrichment: BUG 7 — sporadic per-item errors amid real skip-fresh progress must not be classified as an outage', () => {
    // Prod false-positive (2026-07-14): a run where most candidates are
    // already up to date (skip-fresh — which itself requires a successful
    // MAL round-trip to rebuild the chain and compare the signature) and
    // only a couple of unrelated items hit a one-off per-item error (e.g. a
    // client-side timeout) must NOT be classified as "every MAL API attempt
    // failed". The old `enriched === 0 && errors > 0` gate fired here purely
    // because steady-state runs legitimately enrich nothing new, tripping
    // the circuit breaker on a task that was working fine.
    const SERIES_FRESH_1 = 'series-uuid-fresh-0001';
    const SERIES_FRESH_2 = 'series-uuid-fresh-0002';
    const SERIES_ERR = 'series-uuid-err-0001';
    const MAL_FRESH_1 = '80001';
    const MAL_FRESH_2 = '80002';
    const MAL_ERR = '80003';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([
            {
                userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                accessToken: 'tok-access',
                refreshToken: 'tok-refresh',
            },
        ]);
        mediaHierarchyMock.flattenSeriesEpisodesRaw.mockResolvedValue([
            { episode_id: 'ep-uuid-001', season_number: 1, episode_number: 1 },
            { episode_id: 'ep-uuid-002', season_number: 1, episode_number: 2 },
        ]);
        groupingsMock.getSeriesGroupingState.mockImplementation(
            async (_sql: postgres.Sql, seriesId: string) => {
                if (seriesId === SERIES_FRESH_1) {
                    return {
                        seriesId,
                        provider: 'mal',
                        source: 'mal-anime-id-enrichment',
                        lastEnrichedAt: new Date(Date.now() - 60_000),
                        chainSignature: `[["${MAL_FRESH_1}",2]]`,
                        flattenedEpisodeCount: 2,
                        enrichedEpisodeCount: 2,
                    };
                }
                if (seriesId === SERIES_FRESH_2) {
                    return {
                        seriesId,
                        provider: 'mal',
                        source: 'mal-anime-id-enrichment',
                        lastEnrichedAt: new Date(Date.now() - 60_000),
                        chainSignature: `[["${MAL_FRESH_2}",2]]`,
                        flattenedEpisodeCount: 2,
                        enrichedEpisodeCount: 2,
                    };
                }
                return null;
            },
        );
    });

    it('returns success:true with no throw when skip-fresh items outnumber a single per-item error', async () => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;

        const httpGet = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/users/@me')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            }
            if (url.includes(`/anime/${MAL_FRESH_1}`)) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: Number(MAL_FRESH_1),
                        num_episodes: 2,
                        media_type: 'tv',
                        related_anime: [],
                    }),
                });
            }
            if (url.includes(`/anime/${MAL_FRESH_2}`)) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: Number(MAL_FRESH_2),
                        num_episodes: 2,
                        media_type: 'tv',
                        related_anime: [],
                    }),
                });
            }
            if (url.includes(`/anime/${MAL_ERR}`)) {
                return Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' });
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        });

        groupingsMock.getEnrichmentCandidates.mockResolvedValue([
            { seriesId: SERIES_FRESH_1, seriesMalId: MAL_FRESH_1 },
            { seriesId: SERIES_FRESH_2, seriesMalId: MAL_FRESH_2 },
            { seriesId: SERIES_ERR, seriesMalId: MAL_ERR },
        ]);

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: typeof httpGet }).get = httpGet;

        const result = await malAnimeIdEnrichmentTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.result).toMatchObject({ enriched: 0, skipped: 2, errors: 1 });
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });
});

describe('mal-anime-id-enrichment: BUG 8 — numeric-ID/status-code regex collisions', () => {
    // getAnimeInfo's 404-detection and execute()'s 429/401 outage-classification
    // both regex-match the raw thrown message text for a bare status number.
    // That message ALSO embeds the MAL anime id in the request path (e.g.
    // `MAL API /anime/404?fields=...: 403 Forbidden`), so a series whose MAL id
    // is literally "404"/"429"/"401" gets misclassified on ANY unrelated error —
    // a 403 on anime id 404 is currently swallowed as "not found" (permanent
    // skipped_permanent tombstone) instead of surfacing as the real error.
    const SERIES_ID = 'series-uuid-id-collision-0001';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        stageState.upsertSkippedPermanentRow.mockResolvedValue(undefined);
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([
            {
                userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                accessToken: 'tok-access',
                refreshToken: 'tok-refresh',
            },
        ]);
    });

    it('a 403 on MAL id "404" must surface as a real error, not a silent mal:no-chain tombstone', async () => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;
        const MAL_ID = '404';

        const httpGet = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/users/@me')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            }
            if (url.includes(`/anime/${MAL_ID}?`)) {
                return Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' });
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        });

        groupingsMock.getEnrichmentCandidates.mockResolvedValue([
            { seriesId: SERIES_ID, seriesMalId: MAL_ID },
        ]);

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: typeof httpGet }).get = httpGet;

        await expect(malAnimeIdEnrichmentTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
        });

        // Must NOT have been silently tombstoned as a permanent "no chain" skip —
        // this was a transient 403, not MAL confirming the id doesn't exist.
        expect(stageState.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('a 403 on MAL id "429" must not be reported as a rate-limit condition', async () => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;
        const MAL_ID = '429';

        const httpGet = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/users/@me')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            }
            if (url.includes(`/anime/${MAL_ID}?`)) {
                return Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' });
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        });

        groupingsMock.getEnrichmentCandidates.mockResolvedValue([
            { seriesId: SERIES_ID, seriesMalId: MAL_ID },
        ]);

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: typeof httpGet }).get = httpGet;

        await expect(malAnimeIdEnrichmentTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            message: expect.not.stringContaining('rate limit reached'),
        });
    });
});

describe('mal-anime-id-enrichment: DISABLE_MAL_ANIME_ENRICHMENT early-return', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
    });

    it('returns early without calling upsertCompletedRow, drainBacklog, or candidate queries when flag is true', async () => {
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = true;

        const rec = makeRecordingSql();
        const ctx = makeCtx(rec.sql);

        await malAnimeIdEnrichmentTask.execute(ctx);

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        expect(stageState.markAllPendingSkippedTransientForStage).not.toHaveBeenCalled();
        expect(groupingsMock.getEnrichmentCandidates).not.toHaveBeenCalled();
        expect(groupingsMock.findCoverageTableBacklog).not.toHaveBeenCalled();
    });
});

describe('mal-anime-id-enrichment: no borrower credentials — defers draining to the global-guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        stageState.markAllPendingSkippedTransientForStage.mockResolvedValue(0);
    });

    // As of the Declarative Stage Contract migration, the inline no-auth drain
    // was removed from execute(). The stage's `global-guard` terminalDisposition
    // (`mal-borrower-auth-linked`) now owns draining pending rows to
    // skipped_transient at stage-sweep time. execute() must NOT re-drain (two
    // writers racing the same rows). It no-ops the run instead. The guard's
    // drain behaviour is covered by the disposition integration test.
    it('no-ops the run without draining inline or calling upsertCompletedRow', async () => {
        // No linked borrower credentials → getBorrowerAuth returns null
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([]);

        const rec = makeRecordingSql();
        const ctx = makeCtx(rec.sql);

        const result = await malAnimeIdEnrichmentTask.execute(ctx);

        // The drain moved to the global-guard disposition — execute() no longer
        // calls it (no double-drain).
        expect(stageState.markAllPendingSkippedTransientForStage).not.toHaveBeenCalled();
        // No candidates processed; run reports success with zero work.
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });
});

describe('mal-anime-id-enrichment: gate routing — authoritative stage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        // Restore credential mock in case a prior test overrode it to []
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([
            {
                userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                accessToken: 'tok-access',
                refreshToken: 'tok-refresh',
            },
        ]);
    });

    it('routes fetchSlice to findCoverageTableBacklog when stage is authoritative', async () => {
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set(['mal-anime-id-enrichment']));
        // Coverage table returns empty → task finishes with nothing to do
        groupingsMock.findCoverageTableBacklog.mockResolvedValue([]);
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([]);

        const rec = makeRecordingSql();
        _txDouble = rec.sql;
        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: ReturnType<typeof vi.fn> }).get = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({}),
        });

        await malAnimeIdEnrichmentTask.execute(ctx);

        expect(groupingsMock.findCoverageTableBacklog).toHaveBeenCalledTimes(1);
        expect(groupingsMock.getEnrichmentCandidates).not.toHaveBeenCalled();
    });
});

describe('mal-anime-id-enrichment: gate routing — legacy (non-authoritative)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        // Restore credential mock in case a prior test overrode it to []
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([
            {
                userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                accessToken: 'tok-access',
                refreshToken: 'tok-refresh',
            },
        ]);
    });

    it('routes fetchSlice to getEnrichmentCandidates when stage is NOT authoritative', async () => {
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([]);
        groupingsMock.findCoverageTableBacklog.mockResolvedValue([]);

        const rec = makeRecordingSql();
        _txDouble = rec.sql;
        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: ReturnType<typeof vi.fn> }).get = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({}),
        });

        await malAnimeIdEnrichmentTask.execute(ctx);

        expect(groupingsMock.getEnrichmentCandidates).toHaveBeenCalledTimes(1);
        expect(groupingsMock.findCoverageTableBacklog).not.toHaveBeenCalled();
    });
});

describe('mal-anime-id-enrichment: skip-fresh guard suppresses upsertCompletedRow', () => {
    // The enrichSeries skip-fresh guard fires after the chain-walk (the chain-walk
    // itself is cheap to mock via ctx.http). When getSeriesGroupingState returns a
    // state whose chainSignature + flattenedEpisodeCount match the just-walked chain
    // AND lastEnrichedAt is within the 30-day STALE_AFTER_MS window, enrichSeries
    // returns { status: 'skip-fresh' } without entering the withTx block, so
    // upsertCompletedRow must NOT be called.
    //
    // Signature derivation:
    //   - flattenSeriesEpisodesRaw mock returns 2 episodes → flat.length = 2
    //   - HTTP mock returns num_episodes: 2, related_anime: [] → no sequel
    //   - chain = [{ malId: '40028', numEpisodes: 2 }]
    //   - chainSignatureOf(chain) = JSON.stringify([['40028', 2]]) = '[["40028",2]]'

    const SERIES_ID = 'series-uuid-fresh-skip-test';
    const MAL_ID = '40028';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([
            {
                userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                accessToken: 'tok-access',
                refreshToken: 'tok-refresh',
            },
        ]);
    });

    it('does NOT call upsertCompletedRow when state is fresh and chain signature matches', async () => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;

        // Chain-walk HTTP: /users/@me probe succeeds, /anime/40028 returns 2 episodes, no sequel
        const httpGet = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/users/@me')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({}),
                });
            }
            if (url.includes(`/anime/${MAL_ID}`)) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: Number(MAL_ID),
                        num_episodes: 2,
                        media_type: 'tv',
                        related_anime: [],
                    }),
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({}),
            });
        });

        const candidate: EnrichmentCandidate = {
            seriesId: SERIES_ID,
            seriesMalId: MAL_ID,
        };
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([candidate]);

        // Return a fresh, signature-matching state so the skip-fresh guard fires.
        // flattenedEpisodeCount matches flat.length (2 from mediaHierarchyMock).
        // chainSignature matches chainSignatureOf([{ malId: '40028', numEpisodes: 2 }]).
        groupingsMock.getSeriesGroupingState.mockResolvedValue({
            seriesId: SERIES_ID,
            provider: 'mal',
            source: 'mal-anime-id-enrichment',
            lastEnrichedAt: new Date(Date.now() - 60_000), // 1 minute ago — well within 30 days
            chainSignature: '[["40028",2]]',
            flattenedEpisodeCount: 2,
            enrichedEpisodeCount: 2,
        });

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: typeof httpGet }).get = httpGet;

        await malAnimeIdEnrichmentTask.execute(ctx);

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });
});

describe('mal-anime-id-enrichment: skip-fresh on the coverage path re-applies the earned disposition', () => {
    // Prod 2026-09-26: 7 partial-airing series whose 7-day skipped_transient
    // backoff had expired were re-selected, re-walked on MAL and returned
    // skip-fresh WITHOUT a stage write, so they stayed due. Each run re-fetched
    // them slice after slice for its whole 5-minute budget (~130 "skipped" per
    // run, 16-21 runs/day, 4-5k MAL requests/day, zero enrichment).
    const SERIES_ID = 'series-uuid-skip-fresh-coverage';
    const MAL_ID = '40028';

    function malHttp(): ReturnType<typeof vi.fn> {
        return vi.fn().mockImplementation((url: string) =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: async () =>
                    url.includes(`/anime/${MAL_ID}`)
                        ? {
                              id: Number(MAL_ID),
                              num_episodes: 2,
                              media_type: 'tv',
                              related_anime: [],
                          }
                        : {},
            }),
        );
    }

    function freshState(enrichedEpisodeCount: number): Record<string, unknown> {
        return {
            seriesId: SERIES_ID,
            provider: 'mal',
            source: 'mal-anime-id-enrichment',
            lastEnrichedAt: new Date(Date.now() - 60_000),
            chainSignature: '[["40028",2]]',
            flattenedEpisodeCount: 2,
            enrichedEpisodeCount,
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set(['mal-anime-id-enrichment']));
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        stageState.markSkippedTransientBatch.mockResolvedValue(0);
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([
            {
                userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                accessToken: 'tok-access',
                refreshToken: 'tok-refresh',
            },
        ]);
        groupingsMock.findCoverageTableBacklog.mockResolvedValue([
            { seriesId: SERIES_ID, seriesMalId: MAL_ID },
        ]);
    });

    it('fully mapped series → marks the stage row completed', async () => {
        groupingsMock.getSeriesGroupingState.mockResolvedValue(freshState(2));
        const rec = makeRecordingSql();
        _txDouble = rec.sql;
        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: ReturnType<typeof vi.fn> }).get = malHttp();

        await malAnimeIdEnrichmentTask.execute(ctx);

        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(rec.sql, {
            mediaItemId: SERIES_ID,
            stageId: 'mal-anime-id-enrichment',
            processingVersion: 1,
        });
        expect(stageState.markSkippedTransientBatch).not.toHaveBeenCalled();
    });

    it('partially mapped (still airing) series → re-arms the weekly partial-airing backoff', async () => {
        groupingsMock.getSeriesGroupingState.mockResolvedValue(freshState(1));
        const rec = makeRecordingSql();
        _txDouble = rec.sql;
        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: ReturnType<typeof vi.fn> }).get = malHttp();

        await malAnimeIdEnrichmentTask.execute(ctx);

        expect(stageState.markSkippedTransientBatch).toHaveBeenCalledWith(rec.sql, {
            stageId: 'mal-anime-id-enrichment',
            mediaItemIds: [SERIES_ID],
            skippedReason: 'mal:partial-airing',
            retryAfterMs: 7 * 24 * 60 * 60 * 1000,
        });
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('a per-item error defers the coverage row instead of leaving it at the head of the backlog', async () => {
        groupingsMock.getSeriesGroupingState.mockResolvedValue(freshState(2));
        const rec = makeRecordingSql();
        _txDouble = rec.sql;
        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: ReturnType<typeof vi.fn> }).get = vi
            .fn()
            .mockImplementation((url: string) =>
                url.includes(`/anime/${MAL_ID}`)
                    ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
                    : Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
            );

        await malAnimeIdEnrichmentTask.execute(ctx).catch(() => undefined);

        expect(stageState.deferTransientRetryBatch).toHaveBeenCalledWith(rec.sql, {
            stageId: 'mal-anime-id-enrichment',
            mediaItemIds: [SERIES_ID],
            retryAfterMs: 6 * 60 * 60 * 1000,
        });
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('never walks the same series twice in one run, even if the backlog keeps returning it', async () => {
        // A row whose disposition did not move comes straight back in the next
        // slice; drive two fetch/process rounds and assert the second is empty.
        groupingsMock.getSeriesGroupingState.mockResolvedValue(freshState(2));
        const secondFetch: unknown[][] = [];
        vi.mocked(drainBacklogFn).mockImplementationOnce(async (_ctx, opts) => {
            const first = await opts.fetchSlice(1000);
            await opts.processSlice(first.items, new AbortController().signal);
            const second = await opts.fetchSlice(1000);
            secondFetch.push(second.items);
            return {
                unitsProcessed: first.items.length,
                resultsProduced: 0,
                stopReason: 'drained',
            };
        });
        const rec = makeRecordingSql();
        _txDouble = rec.sql;
        const ctx = makeCtx(rec.sql);
        const httpGet = malHttp();
        (ctx.http as unknown as { get: ReturnType<typeof vi.fn> }).get = httpGet;

        await malAnimeIdEnrichmentTask.execute(ctx);

        expect(groupingsMock.findCoverageTableBacklog).toHaveBeenCalledTimes(2);
        expect(secondFetch).toEqual([[]]);
        expect(
            httpGet.mock.calls.filter(([url]) => String(url).includes(`/anime/${MAL_ID}`)),
        ).toHaveLength(1);
    });
});

describe('mal-anime-id-enrichment: BUG 1 — empty-writes is a retryable transient skip, not a permanent tombstone', () => {
    // A series that has no episodes YET (drained before series-sync populated
    // them) must NOT be tombstoned skipped_permanent — there is no
    // invalidation event for "episodes were added", so a permanent tombstone
    // would strand it forever. It must instead be written as a retryable
    // `skipped_transient` (markSkippedTransientBatch) with a 24h backoff.
    const SERIES_ID = 'series-uuid-empty-writes-0001';
    const MAL_ID = '50000';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        // Authoritative — enrichSeries only writes coverage-table rows
        // (tombstone/transientSkip) when useCoverageTable is true.
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set(['mal-anime-id-enrichment']));
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        stageState.upsertSkippedPermanentRow.mockResolvedValue(undefined);
        stageState.markSkippedTransientBatch.mockResolvedValue(0);
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([
            {
                userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                accessToken: 'tok-access',
                refreshToken: 'tok-refresh',
            },
        ]);
        // No episodes yet — the flat.length === 0 branch.
        mediaHierarchyMock.flattenSeriesEpisodesRaw.mockResolvedValue([]);
    });

    it('writes skipped_transient(mal:empty-writes, 24h) and never writes skipped_permanent', async () => {
        const rec = makeRecordingSql();
        // The subtree-has-file probe added for the fileless case. This test is the
        // genuine BUG 1 scenario — drained BEFORE series-sync populated episodes —
        // which by definition is a series with files, so the probe answers true and
        // the retryable path is the one under test.
        rec.queueRows([{ has_file: true }]);
        _txDouble = rec.sql;

        const candidate: EnrichmentCandidate = { seriesId: SERIES_ID, seriesMalId: MAL_ID };
        groupingsMock.findCoverageTableBacklog.mockResolvedValue([candidate]);
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([]);

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: ReturnType<typeof vi.fn> }).get = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({}),
        });

        await malAnimeIdEnrichmentTask.execute(ctx);

        expect(stageState.markSkippedTransientBatch).toHaveBeenCalledTimes(1);
        expect(stageState.markSkippedTransientBatch).toHaveBeenCalledWith(rec.sql, {
            stageId: 'mal-anime-id-enrichment',
            mediaItemIds: [SERIES_ID],
            skippedReason: 'mal:empty-writes',
            retryAfterMs: 24 * 60 * 60 * 1000,
        });
        expect(stageState.upsertSkippedPermanentRow).not.toHaveBeenCalled();
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    // ...but "no episodes YET" is only true while episodes can still arrive. A
    // discovery row with no file anywhere in its subtree has none and never will,
    // so retrying it every 24h is an appointment kept forever: 270 of the 283 rows
    // parked in skipped_transient on prod were exactly this, re-walking a MAL
    // sequel chain daily. Those are tombstoned; `file.attached` revives them.
    it('tombstones instead when the series has no files anywhere in its subtree', async () => {
        const rec = makeRecordingSql();
        rec.queueRows([{ has_file: false }]);
        _txDouble = rec.sql;

        const candidate: EnrichmentCandidate = { seriesId: SERIES_ID, seriesMalId: MAL_ID };
        groupingsMock.findCoverageTableBacklog.mockResolvedValue([candidate]);
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([]);

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: ReturnType<typeof vi.fn> }).get = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({}),
        });

        await malAnimeIdEnrichmentTask.execute(ctx);

        expect(stageState.markSkippedTransientBatch).not.toHaveBeenCalled();
        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledTimes(1);
        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledWith(
            rec.sql,
            expect.objectContaining({
                stageId: 'mal-anime-id-enrichment',
                skippedReason: 'mal:no-files',
            }),
        );
    });
});

describe('mal-anime-id-enrichment: BUG 2 — still-airing chain entry defers instead of completing', () => {
    // A chain entry with num_episodes<=0 (still airing) must NOT let the
    // series get marked `completed` — there is no MAL event for "finished
    // airing", so a permanent completion would freeze the chain mid-airing.
    // The partial writes (episodes MAL has already resolved) are kept, but
    // the coverage row is written as a retryable skipped_transient with a
    // 7-day backoff instead of upsertCompletedRow.
    const SERIES_ID = 'series-uuid-airing-0001';
    const MAL_ID = '60000';
    const SEQUEL_ID = '60001';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set(['mal-anime-id-enrichment']));
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        stageState.markSkippedTransientBatch.mockResolvedValue(0);
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([
            {
                userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                accessToken: 'tok-access',
                refreshToken: 'tok-refresh',
            },
        ]);
        groupingsMock.getSeriesGroupingState.mockResolvedValue(null);
        groupingsMock.deleteStaleGroupings.mockResolvedValue(0);
        // 22 library episodes — mirrors the Voyage to Orion S3 case in the
        // module doc comment (Part 1 = 12 resolved episodes, Part 2 still
        // airing with num_episodes = 0).
        mediaHierarchyMock.flattenSeriesEpisodesRaw.mockResolvedValue(
            Array.from({ length: 22 }, (_, i) => ({
                episode_id: `ep-uuid-${String(i + 1).padStart(3, '0')}`,
                season_number: 3,
                episode_number: i + 1,
            })),
        );
    });

    it('keeps the 12 partial writes, skips upsertCompletedRow, and defers via skipped_transient(mal:partial-airing, 7d)', async () => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;

        const httpGet = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/users/@me')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            }
            if (url.includes(`/anime/${MAL_ID}`)) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: Number(MAL_ID),
                        num_episodes: 12,
                        media_type: 'tv',
                        related_anime: [
                            { relation_type: 'sequel', node: { id: Number(SEQUEL_ID) } },
                        ],
                    }),
                });
            }
            if (url.includes(`/anime/${SEQUEL_ID}`)) {
                // Still airing — MAL hasn't published a final episode count.
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: Number(SEQUEL_ID),
                        num_episodes: 0,
                        media_type: 'tv',
                        related_anime: [],
                    }),
                });
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        });

        const candidate: EnrichmentCandidate = { seriesId: SERIES_ID, seriesMalId: MAL_ID };
        groupingsMock.findCoverageTableBacklog.mockResolvedValue([candidate]);
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([]);

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: typeof httpGet }).get = httpGet;

        await malAnimeIdEnrichmentTask.execute(ctx);

        // Partial writes kept: 12 episodes mapped to the first (resolved) entry.
        expect(groupingsMock.upsertGroupings).toHaveBeenCalledTimes(1);
        expect(groupingsMock.upsertGroupings).toHaveBeenCalledWith(
            rec.sql,
            expect.arrayContaining([
                expect.objectContaining({ mediaId: 'ep-uuid-001', groupExternalId: MAL_ID }),
            ]),
        );
        expect((groupingsMock.upsertGroupings.mock.calls[0]?.[1] as unknown[]).length).toBe(12);

        // Never marked completed — the chain is incomplete while airing.
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();

        // Deferred via the transient-skip helper, in the SAME tx handle as
        // the groupings writes (atomicity with the partial write).
        expect(stageState.markSkippedTransientBatch).toHaveBeenCalledTimes(1);
        expect(stageState.markSkippedTransientBatch).toHaveBeenCalledWith(rec.sql, {
            stageId: 'mal-anime-id-enrichment',
            mediaItemIds: [SERIES_ID],
            skippedReason: 'mal:partial-airing',
            retryAfterMs: 7 * 24 * 60 * 60 * 1000,
        });
    });
});

describe('mal-anime-id-enrichment: BUG 6 — 429 honors Retry-After and retries instead of failing the item', () => {
    const SERIES_ID = 'series-uuid-429-0001';
    const MAL_ID = '70000';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_MAL_ANIME_ENRICHMENT = false;
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        malCredentialsMock.listMalBorrowerCredentials.mockResolvedValue([
            {
                userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                accessToken: 'tok-access',
                refreshToken: 'tok-refresh',
            },
        ]);
        groupingsMock.getSeriesGroupingState.mockResolvedValue(null);
        mediaHierarchyMock.flattenSeriesEpisodesRaw.mockResolvedValue([
            { episode_id: 'ep-uuid-001', season_number: 1, episode_number: 1 },
            { episode_id: 'ep-uuid-002', season_number: 1, episode_number: 2 },
        ]);
    });

    it('retries a 429 with Retry-After: 0 and succeeds on the next attempt', async () => {
        const rec = makeRecordingSql();
        _txDouble = rec.sql;

        let animeCallCount = 0;
        const httpGet = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/users/@me')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            }
            if (url.includes(`/anime/${MAL_ID}`)) {
                animeCallCount++;
                if (animeCallCount <= 2) {
                    return Promise.resolve({
                        ok: false,
                        status: 429,
                        statusText: 'Too Many Requests',
                        headers: { get: (name: string) => (name === 'retry-after' ? '0' : null) },
                    });
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: Number(MAL_ID),
                        num_episodes: 2,
                        media_type: 'tv',
                        related_anime: [],
                    }),
                });
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        });

        const candidate: EnrichmentCandidate = { seriesId: SERIES_ID, seriesMalId: MAL_ID };
        groupingsMock.getEnrichmentCandidates.mockResolvedValue([candidate]);

        const ctx = makeCtx(rec.sql);
        (ctx.http as unknown as { get: typeof httpGet }).get = httpGet;

        const result = await malAnimeIdEnrichmentTask.execute(ctx);

        // Two 429s consumed from the budget, third attempt succeeded.
        expect(animeCallCount).toBe(3);
        expect(result.success).toBe(true);
        expect(stageState.upsertCompletedRow).toHaveBeenCalledTimes(1);
    });
});
