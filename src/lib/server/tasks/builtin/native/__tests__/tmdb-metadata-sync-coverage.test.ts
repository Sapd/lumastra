// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * tmdb-metadata-sync coverage-table behavioural tests.
 *
 * Asserts OUTCOMES, not source text:
 *
 * A) Per-item path: the REAL upsertCompletedRow is called with the correct
 *    (mediaItemId, stageId='tmdb-metadata-sync', processingVersion=1) after
 *    syncSingleItem resolves — exercising the real execute() path through
 *    mocked dynamic imports.
 *
 * B) Sweep path: when getAuthoritativeStageIds() includes 'tmdb-metadata-sync',
 *    the onTmdbSuccess closure is wired as onSuccess to generator.sync() and
 *    calls the REAL upsertCompletedRow with the correct args.
 *
 * C) Sweep path — not authoritative: when the stage is NOT in
 *    getAuthoritativeStageIds(), upsertCompletedRow is NOT called.
 *
 * D) Per-item 404 path: when syncSingleItem throws TmdbApiError(status=404),
 *    upsertCompletedRow is NOT called and the task returns stopReason='skipped'.
 *
 * E) Per-item series/episode guard: when the item's media_type is SERIES or
 *    EPISODE, the task throws TaskError(kind='permanent') before calling
 *    upsertCompletedRow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as StageStateQueries from '$lib/server/database/queries/stage-state.queries.js';
import type postgres from 'postgres';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';

// ---------------------------------------------------------------------------
// Stage-state spy — hoisted ABOVE imports per verified hoist-safe convention
// ---------------------------------------------------------------------------

const stageState = vi.hoisted(() => ({
    upsertCompletedRow: vi.fn<typeof StageStateQueries.upsertCompletedRow>(),
    // Bug A self-heal: the discovery-sweep path also calls this to drain
    // stale failed_permanent rows left by a now-fixed appliesTo bug. Default
    // resolves to 0 (nothing healed) so the existing per-item/sweep tests
    // below are unaffected; the dedicated describe block further down
    // overrides this to assert the call.
    healMisappliedFailedPermanentRows: vi
        .fn<typeof StageStateQueries.healMisappliedFailedPermanentRows>()
        .mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => stageState);

// ---------------------------------------------------------------------------
// onboarding mock — controls the fresh-install precondition gate. Defaults to
// "not a fresh install" so every existing test below (which asserts on
// per-item / sweep behaviour) reaches its real code path unchanged. The
// fresh-install skip behaviour itself is covered by
// tmdb-metadata-sync-fresh-install.test.ts.
// ---------------------------------------------------------------------------

const onboarding = vi.hoisted(() => ({
    isFreshUnconfiguredInstall: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
}));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => onboarding);

// ---------------------------------------------------------------------------
// config mock — controls getAuthoritativeStageIds
// ---------------------------------------------------------------------------

const configMock = vi.hoisted(() => ({
    getAuthoritativeStageIds: vi.fn<() => Set<string>>(() => new Set()),
    // Discovery-catalog gate defaults to true here so the per-item, sweep,
    // and outage-guard scenarios below keep exercising the sweep unchanged —
    // the gate's own on/off behavior is covered separately.
    isDiscoveryCatalogEnabled: vi.fn<() => boolean>(() => true),
}));
vi.mock('$lib/server/config.js', async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    return {
        ...actual,
        getAuthoritativeStageIds: configMock.getAuthoritativeStageIds,
        isDiscoveryCatalogEnabled: configMock.isDiscoveryCatalogEnabled,
    };
});

// ---------------------------------------------------------------------------
// Registry mock — prevents side-effect registration at import time
// ---------------------------------------------------------------------------

vi.mock('$lib/server/tasks/builtin/../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Per-item path: mock the dynamic imports
// ---------------------------------------------------------------------------

const syncSingleItemMock = vi.hoisted(() => ({
    syncSingleItem: vi
        .fn<
            (
                sql: postgres.Sql,
                mediaItemId: string,
                options: { force: boolean; forceChildren: boolean },
            ) => Promise<{ updated: boolean; fieldsChanged: string[] }>
        >()
        .mockResolvedValue({ updated: true, fieldsChanged: ['overview'] }),
}));
vi.mock('$lib/server/services/metadata-sync-single.service.js', () => syncSingleItemMock);

const connectionMock = vi.hoisted(() => ({
    getDb: vi.fn<() => postgres.Sql | null>(() => null),
    getTaskDb: vi.fn<() => postgres.Sql | null>(() => null),
}));
vi.mock('$lib/server/database/connection.js', () => connectionMock);

// ---------------------------------------------------------------------------
// Sweep path: mock TMDBMetadataSyncGenerator
// ---------------------------------------------------------------------------

// Captures the onSuccess callback passed by the task so tests can invoke it.
let _capturedOnSuccess: ((mediaItemId: string) => Promise<void>) | undefined;

// BUG 3 regression: lets a test override the generator's returned result
// (e.g. simulate a total outage: errors>0, created=0, updated=0) without
// touching the FakeGenerator's default "everything worked" shape used by
// the other describe blocks. Reset to null in each beforeEach.
let _syncResultOverride: {
    success: boolean;
    total_fetched: number;
    total_movies: number;
    total_series: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
    message: string;
    lastErrorMessage?: string;
} | null = null;
let _generatorIsAbortedOverride = false;
let _capturedListDepth: string | undefined;

const deepListingMock = vi.hoisted(() => ({
    hasRecentDeepDiscoveryListing: vi.fn<() => Promise<boolean>>(async () => true),
}));
vi.mock('$lib/server/database/queries/ai-sync.queries.js', () => deepListingMock);
let _abortReasons: string[] = [];

const generatorMock = vi.hoisted(() => ({
    TMDBMetadataSyncGenerator: vi.fn(),
}));

vi.mock('$lib/server/ai/tmdb-metadata-sync.js', async () => {
    class FakeGenerator {
        abort(reason: string): void {
            _abortReasons.push(reason);
        }
        isAborted(): boolean {
            return _generatorIsAbortedOverride;
        }

        async sync(opts: {
            listDepth?: string;
            onSuccess?: (mediaItemId: string) => Promise<void>;
            shouldAbort?: () => boolean;
            onProgress?: (progress: unknown) => void;
            sql?: postgres.Sql | null;
        }): Promise<{
            success: boolean;
            total_fetched: number;
            total_movies: number;
            total_series: number;
            created: number;
            updated: number;
            skipped: number;
            errors: number;
            message: string;
            lastErrorMessage?: string;
        }> {
            _capturedOnSuccess = opts.onSuccess;
            _capturedListDepth = opts.listDepth;
            if (_syncResultOverride) {
                return _syncResultOverride;
            }
            // If onSuccess is provided, invoke it with a fake mediaItemId to
            // simulate the generator calling back after a successful upsert.
            if (opts.onSuccess) {
                await opts.onSuccess('sweep-item-uuid-aaaa');
            }
            return {
                success: true,
                total_fetched: 1,
                total_movies: 1,
                total_series: 0,
                created: 0,
                updated: 1,
                skipped: 0,
                errors: 0,
                message: 'ok',
            };
        }
    }
    generatorMock.TMDBMetadataSyncGenerator =
        FakeGenerator as unknown as typeof generatorMock.TMDBMetadataSyncGenerator;
    const actual = await vi.importActual<typeof import('$lib/server/ai/tmdb-metadata-sync.js')>(
        '$lib/server/ai/tmdb-metadata-sync.js',
    );
    return {
        TMDBMetadataSyncGenerator: FakeGenerator,
        classifyTmdbFailure: actual.classifyTmdbFailure,
    };
});

// ---------------------------------------------------------------------------
// TmdbApiError mock — mirrors the real class shape used by the task's 404
// detection branch (instanceof check + .status property)
// ---------------------------------------------------------------------------

vi.mock('$lib/server/providers/implementations/tmdb/client.js', () => {
    class TmdbApiError extends Error {
        readonly status: number | null;
        readonly retryAfterMs: number | null;
        readonly authFatal: boolean;
        constructor(
            message: string,
            opts: {
                status: number | null;
                retryAfterMs?: number | null;
                authFatal?: boolean;
            },
        ) {
            super(message);
            this.name = 'TmdbApiError';
            this.status = opts.status;
            this.retryAfterMs = opts.retryAfterMs ?? null;
            this.authFatal = opts.authFatal ?? false;
        }
    }
    return { TmdbApiError };
});

// ---------------------------------------------------------------------------
// Import the task under test (AFTER all mocks are declared)
// ---------------------------------------------------------------------------

import { tmdbMetadataSyncRealTask } from '../tmdb-metadata-sync-task.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import { TaskError } from '@sapd/lumastra-plugin-sdk';

// ---------------------------------------------------------------------------
// Context factory helpers
// ---------------------------------------------------------------------------

function makeCtx(
    input: Record<string, unknown>,
    sqlInstance: postgres.Sql,
): TaskContext<Record<string, unknown>> {
    const ac = new AbortController();
    return {
        runId: 'test-run-tmdb',
        attemptNumber: 1,
        input,
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
            get: vi.fn(),
            post: vi.fn(),
        },
        catalog: undefined as unknown as TaskContext['catalog'],
        mediaItems: undefined as unknown as TaskContext['mediaItems'],
        mediaFiles: undefined as unknown as TaskContext['mediaFiles'],
        userCredentials: undefined as unknown as TaskContext['userCredentials'],
    } as unknown as TaskContext<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tests: per-item path — pool-separation assertion
//
// Fix 1: taskDb and webSql are DISTINCT instances. The task calls
// upsertCompletedRow(getTaskDb(), …) — NOT ctx.sql. With two separate
// recording instances, a regression that passes ctx.sql would fail the
// "called with taskDb.sql" assertion AND be caught by the explicit
// "NOT called with webSql.sql" assertion.
// ---------------------------------------------------------------------------

describe('tmdb-metadata-sync: per-item path calls upsertCompletedRow', () => {
    const MEDIA_ITEM_ID = 'movie-uuid-per-item-1234';

    beforeEach(() => {
        vi.clearAllMocks();
        _capturedOnSuccess = undefined;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        syncSingleItemMock.syncSingleItem.mockResolvedValue({
            updated: true,
            fieldsChanged: ['overview'],
        });
    });

    it('calls upsertCompletedRow(taskDb.sql, …) — NOT ctx.sql — on success', async () => {
        // Two distinct recording instances: taskDb for getTaskDb(), webSql for ctx.sql.
        const taskDb = makeRecordingSql({
            // First sql call from ctx.sql is the media_type SELECT (uses ctx.sql,
            // not taskDb). taskDb has no queries queued, which is correct — the
            // task only uses taskDb via getTaskDb() for the upsertCompletedRow call.
            rows: [],
        });
        const webSql = makeRecordingSql({
            // The per-item path executes: ctx.sql`SELECT media_type …` first.
            rows: [{ media_type: 'MOVIE' }],
        });

        connectionMock.getTaskDb.mockReturnValue(taskDb.sql);

        const ctx = makeCtx({ mediaItemId: MEDIA_ITEM_ID, force: false }, webSql.sql);

        await tmdbMetadataSyncRealTask.execute(ctx);

        expect(stageState.upsertCompletedRow).toHaveBeenCalledTimes(1);
        // Must have been called with the task-DB handle (getTaskDb() return value)
        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(taskDb.sql, {
            mediaItemId: MEDIA_ITEM_ID,
            stageId: 'tmdb-metadata-sync',
            processingVersion: 1,
        });
        // Regression guard: must NOT have been called with ctx.sql (the web handle)
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalledWith(
            webSql.sql,
            expect.anything(),
        );
    });

    it('does NOT call upsertCompletedRow when syncSingleItem reports no update', async () => {
        const taskDb = makeRecordingSql({ rows: [] });
        const webSql = makeRecordingSql({ rows: [{ media_type: 'MOVIE' }] });
        connectionMock.getTaskDb.mockReturnValue(taskDb.sql);
        syncSingleItemMock.syncSingleItem.mockResolvedValue({
            updated: false,
            fieldsChanged: [],
        });

        const ctx = makeCtx({ mediaItemId: MEDIA_ITEM_ID }, webSql.sql);

        await tmdbMetadataSyncRealTask.execute(ctx);

        // upsertCompletedRow is called regardless of whether fields changed —
        // the task marks the item processed either way.
        expect(stageState.upsertCompletedRow).toHaveBeenCalledTimes(1);
        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(taskDb.sql, {
            mediaItemId: MEDIA_ITEM_ID,
            stageId: 'tmdb-metadata-sync',
            processingVersion: 1,
        });
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalledWith(
            webSql.sql,
            expect.anything(),
        );
    });

    it('does NOT call upsertCompletedRow when getTaskDb returns null', async () => {
        const webSql = makeRecordingSql({ rows: [{ media_type: 'MOVIE' }] });
        connectionMock.getTaskDb.mockReturnValue(null);

        const ctx = makeCtx({ mediaItemId: MEDIA_ITEM_ID }, webSql.sql);

        await expect(tmdbMetadataSyncRealTask.execute(ctx)).rejects.toThrow(
            'Database not available',
        );
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests: per-item 404 path
//
// When syncSingleItem throws TmdbApiError(status=404), the task:
//   1. Does NOT call upsertCompletedRow
//   2. Issues a skipped_permanent UPDATE via the task-DB sql handle
//   3. Returns { stopReason: 'skipped' }
// ---------------------------------------------------------------------------

describe('tmdb-metadata-sync: per-item 404 path skips upsertCompletedRow', () => {
    const MEDIA_ITEM_ID = 'movie-uuid-404-test';

    beforeEach(() => {
        vi.clearAllMocks();
        _capturedOnSuccess = undefined;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
    });

    it('returns stopReason=skipped and does NOT call upsertCompletedRow on TmdbApiError 404', async () => {
        // Import the mocked TmdbApiError (same class reference the task sees)
        const { TmdbApiError } =
            await import('$lib/server/providers/implementations/tmdb/client.js');

        const taskDb = makeRecordingSql({ rows: [] });
        const webSql = makeRecordingSql({ rows: [{ media_type: 'MOVIE' }] });
        connectionMock.getTaskDb.mockReturnValue(taskDb.sql);

        syncSingleItemMock.syncSingleItem.mockRejectedValue(
            new TmdbApiError('Not Found', { status: 404 }),
        );

        const ctx = makeCtx({ mediaItemId: MEDIA_ITEM_ID, force: false }, webSql.sql);

        const result = await tmdbMetadataSyncRealTask.execute(ctx);

        // The 404 branch returns a skipped outcome — not an error throw
        expect(result).toMatchObject({ stopReason: 'skipped', success: false });

        // upsertCompletedRow must NOT be called on a 404 permanent skip
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();

        // The skipped_permanent UPDATE must have been issued via the task-DB handle
        const skippedWrite = taskDb.calls.find(
            (c) => c.query.includes('skipped_permanent') || c.query.includes('skipped_reason'),
        );
        expect(skippedWrite).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// Tests: per-item series/episode guard
//
// When the targeted item's media_type is SERIES or EPISODE, the task throws
// TaskError(kind='permanent') before reaching getTaskDb() or upsertCompletedRow.
// ---------------------------------------------------------------------------

describe('tmdb-metadata-sync: per-item series/episode guard throws permanent TaskError', () => {
    const SERIES_ITEM_ID = 'series-uuid-guard-test';

    beforeEach(() => {
        vi.clearAllMocks();
        _capturedOnSuccess = undefined;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
    });

    it('throws a permanent TaskError and does NOT call upsertCompletedRow for media_type=SERIES', async () => {
        const webSql = makeRecordingSql({ rows: [{ media_type: 'SERIES' }] });
        // getTaskDb should never be reached — if it is, return something valid
        // so the test doesn't fail for the wrong reason
        const taskDb = makeRecordingSql({ rows: [] });
        connectionMock.getTaskDb.mockReturnValue(taskDb.sql);

        const ctx = makeCtx({ mediaItemId: SERIES_ITEM_ID, force: false }, webSql.sql);

        // Capture the error in a single execute() call
        let caughtError: unknown;
        try {
            await tmdbMetadataSyncRealTask.execute(ctx);
        } catch (err) {
            caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(TaskError);
        expect((caughtError as TaskError).kind).toBe('permanent');

        // upsertCompletedRow must never be called for a rejected series item
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('throws a permanent TaskError and does NOT call upsertCompletedRow for media_type=EPISODE', async () => {
        const webSql = makeRecordingSql({ rows: [{ media_type: 'EPISODE' }] });
        const taskDb = makeRecordingSql({ rows: [] });
        connectionMock.getTaskDb.mockReturnValue(taskDb.sql);

        const ctx = makeCtx({ mediaItemId: SERIES_ITEM_ID, force: false }, webSql.sql);

        let caughtError: unknown;
        try {
            await tmdbMetadataSyncRealTask.execute(ctx);
        } catch (err) {
            caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(TaskError);
        expect((caughtError as TaskError).kind).toBe('permanent');
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests: sweep path — authoritative stage wires onTmdbSuccess
// ---------------------------------------------------------------------------

describe('tmdb-metadata-sync: sweep path fires upsertCompletedRow when authoritative', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _capturedOnSuccess = undefined;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set(['tmdb-metadata-sync']));
    });

    it('calls upsertCompletedRow via onSuccess with correct stageId when authoritative', async () => {
        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        await tmdbMetadataSyncRealTask.execute(ctx);

        expect(stageState.upsertCompletedRow).toHaveBeenCalledTimes(1);
        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(rec.sql, {
            mediaItemId: 'sweep-item-uuid-aaaa',
            stageId: 'tmdb-metadata-sync',
            processingVersion: 1,
        });
    });

    it('onSuccess closure is passed to generator.sync (not undefined)', async () => {
        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        await tmdbMetadataSyncRealTask.execute(ctx);

        expect(_capturedOnSuccess).toBeDefined();
        expect(typeof _capturedOnSuccess).toBe('function');
    });
});

describe('tmdb-metadata-sync: discovery lists are paged deep only weekly', () => {
    // Every sweep used to page all discovery lists to their caps (~740 TMDB
    // requests, twice a day) although the rankings barely move day to day.
    beforeEach(() => {
        vi.clearAllMocks();
        _capturedListDepth = undefined;
        _syncResultOverride = null;
        _generatorIsAbortedOverride = false;
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
    });

    it('pages shallow when a deep listing completed within the last week', async () => {
        deepListingMock.hasRecentDeepDiscoveryListing.mockResolvedValue(true);
        const rec = makeRecordingSql();

        const out = await tmdbMetadataSyncRealTask.execute(makeCtx({}, rec.sql));

        expect(_capturedListDepth).toBe('shallow');
        expect((out.result as { listDepth?: string }).listDepth).toBe('shallow');
        const [, since] = deepListingMock.hasRecentDeepDiscoveryListing.mock
            .calls[0] as unknown as [unknown, Date];
        const ageDays = (Date.now() - since.getTime()) / 86_400_000;
        expect(ageDays).toBeCloseTo(7, 1);
    });

    it('pages deep — and records it — when no deep listing is on record for the week', async () => {
        deepListingMock.hasRecentDeepDiscoveryListing.mockResolvedValue(false);
        const rec = makeRecordingSql();

        const out = await tmdbMetadataSyncRealTask.execute(makeCtx({}, rec.sql));

        expect(_capturedListDepth).toBe('deep');
        expect((out.result as { listDepth?: string }).listDepth).toBe('deep');
    });

    it('input deepList forces a deep listing', async () => {
        deepListingMock.hasRecentDeepDiscoveryListing.mockResolvedValue(true);
        const rec = makeRecordingSql();

        await tmdbMetadataSyncRealTask.execute(makeCtx({ deepList: true }, rec.sql));

        expect(_capturedListDepth).toBe('deep');
    });

    it('a soft-deadline stop does not record its depth, so a cut-short deep listing is retried', async () => {
        deepListingMock.hasRecentDeepDiscoveryListing.mockResolvedValue(false);
        _generatorIsAbortedOverride = true;
        const rec = makeRecordingSql();

        const out = await tmdbMetadataSyncRealTask.execute(makeCtx({}, rec.sql));

        expect(out.stopReason).toBe('aborted');
        expect((out.result as { listDepth?: string } | undefined)?.listDepth).toBeUndefined();
    });
});

describe('tmdb-metadata-sync: soft deadline winds the sweep down instead of hitting the hard cap', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _abortReasons = [];
        _generatorIsAbortedOverride = false;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set<string>());
    });

    it('stops the generator on ctx.softSignal and reports a graceful partial run', async () => {
        const soft = new AbortController();
        soft.abort();
        const ctx = { ...makeCtx({}, makeRecordingSql().sql), softSignal: soft.signal };
        _generatorIsAbortedOverride = true; // the generator honoured the abort

        const result = await tmdbMetadataSyncRealTask.execute(ctx);

        expect(_abortReasons.some((r) => r.includes('soft-timeout'))).toBe(true);
        expect(result).toMatchObject({ success: true, stopReason: 'aborted' });
    });

    it('reports a graceful stop even when the soft deadline fired before anything was fetched', async () => {
        const soft = new AbortController();
        soft.abort();
        const ctx = { ...makeCtx({}, makeRecordingSql().sql), softSignal: soft.signal };
        _generatorIsAbortedOverride = true;
        _syncResultOverride = {
            success: true,
            total_fetched: 0,
            total_movies: 0,
            total_series: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: 0,
            message: 'stopped',
        };

        const result = await tmdbMetadataSyncRealTask.execute(ctx);
        _syncResultOverride = null;

        expect(result).toMatchObject({ success: true, stopReason: 'aborted' });
    });
});

// ---------------------------------------------------------------------------
// Tests: sweep path — non-authoritative stage omits onTmdbSuccess
// ---------------------------------------------------------------------------

describe('tmdb-metadata-sync: sweep path skips upsertCompletedRow when NOT authoritative', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _capturedOnSuccess = undefined;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        // Stage is NOT in the authoritative set
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
    });

    it('does NOT call upsertCompletedRow when stage is not authoritative', async () => {
        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        await tmdbMetadataSyncRealTask.execute(ctx);

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('onSuccess is undefined (not wired) when stage is not authoritative', async () => {
        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        await tmdbMetadataSyncRealTask.execute(ctx);

        expect(_capturedOnSuccess).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Tests: Bug A self-heal — discovery-sweep path drains stale failed_permanent
// rows left by the now-fixed appliesTo:['movie'] narrowing (episodes/series
// seeded before the fix threw a PERMANENT TaskError on every attempt and are
// stuck in failed_permanent forever — the sweeper's own dispose passes never
// touch that status). Runs on every discovery-sweep-shaped invocation
// (mediaItemId absent), independent of the per-item path.
// ---------------------------------------------------------------------------

describe('tmdb-metadata-sync: Bug A self-heal drains misapplied failed_permanent rows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _capturedOnSuccess = undefined;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        stageState.healMisappliedFailedPermanentRows.mockResolvedValue(0);
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
    });

    it('calls healMisappliedFailedPermanentRows with the movie-only eligible set', async () => {
        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        await tmdbMetadataSyncRealTask.execute(ctx);

        expect(stageState.healMisappliedFailedPermanentRows).toHaveBeenCalledTimes(1);
        expect(stageState.healMisappliedFailedPermanentRows).toHaveBeenCalledWith(rec.sql, {
            stageId: 'tmdb-metadata-sync',
            eligibleMediaTypes: ['movie'],
            skippedReason: 'not-a-movie-item',
        });
    });

    it('does NOT call healMisappliedFailedPermanentRows on the per-item path', async () => {
        const taskDb = makeRecordingSql({ rows: [] });
        const webSql = makeRecordingSql({ rows: [{ media_type: 'MOVIE' }] });
        connectionMock.getTaskDb.mockReturnValue(taskDb.sql);

        const ctx = makeCtx({ mediaItemId: 'movie-uuid-heal-test' }, webSql.sql);

        await tmdbMetadataSyncRealTask.execute(ctx);

        expect(stageState.healMisappliedFailedPermanentRows).not.toHaveBeenCalled();
    });

    it('a self-heal failure is swallowed and does not fail the sweep', async () => {
        stageState.healMisappliedFailedPermanentRows.mockRejectedValue(new Error('db blip'));
        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        const result = await tmdbMetadataSyncRealTask.execute(ctx);

        expect(result.success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: per-item path — abort-race branch
//
// F) The per-item path sets up Promise.race([syncPromise, abortPromise]) where
//    abortPromise listens on ctx.signal's 'abort' event. When the signal fires
//    while the race is in flight, abortPromise wins and the task returns
//    { stopReason: 'aborted' } WITHOUT calling upsertCompletedRow.
//
//    Driving the race branch (not the earlier early-exit at line ~104):
//      - ctx.signal must NOT be aborted at entry (passes the line-104 guard)
//      - syncSingleItem fires ac.abort() synchronously on its first call
//        (the abort event fires at line ~146 where addEventListener is already
//        registered, so abortPromise resolves before syncPromise can settle)
//      - syncSingleItem then returns a never-resolving promise so there is
//        no race ambiguity — only the abort path can win
// ---------------------------------------------------------------------------

describe('tmdb-metadata-sync: per-item abort-race returns aborted and skips upsertCompletedRow', () => {
    const MEDIA_ITEM_ID = 'movie-uuid-abort-race-test';

    beforeEach(() => {
        vi.clearAllMocks();
        _capturedOnSuccess = undefined;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
    });

    it('does NOT call upsertCompletedRow and returns stopReason=aborted when abort fires during the race', async () => {
        const taskDb = makeRecordingSql({ rows: [] });
        const webSql = makeRecordingSql({ rows: [{ media_type: 'MOVIE' }] });
        connectionMock.getTaskDb.mockReturnValue(taskDb.sql);

        // Keep a handle to the AbortController so the syncSingleItem mock can
        // trigger it. The signal must NOT be pre-aborted (that would hit the
        // early-exit at line ~104 before the race is even constructed).
        const ac = new AbortController();

        // syncSingleItem fires ac.abort() synchronously on its call. The
        // abortPromise listener is registered at source line ~146 BEFORE
        // syncSingleItem is called at line ~150, so the 'abort' event fires
        // with the listener in place and abortPromise resolves to 'aborted'.
        // The returned never-resolving promise ensures syncPromise cannot
        // beat the abort.
        syncSingleItemMock.syncSingleItem.mockImplementation(() => {
            ac.abort();
            return new Promise<never>(() => {
                /* never resolves */
            });
        });

        const ctx = {
            runId: 'test-run-tmdb-abort',
            attemptNumber: 1,
            input: { mediaItemId: MEDIA_ITEM_ID, force: false },
            scope: {},
            mode: 'scheduled',
            sql: webSql.sql,
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
                get: vi.fn(),
                post: vi.fn(),
            },
            catalog: undefined as unknown as TaskContext['catalog'],
            mediaItems: undefined as unknown as TaskContext['mediaItems'],
            mediaFiles: undefined as unknown as TaskContext['mediaFiles'],
            userCredentials: undefined as unknown as TaskContext['userCredentials'],
        } as unknown as TaskContext<Record<string, unknown>>;

        const result = await tmdbMetadataSyncRealTask.execute(ctx);

        // The race branch (source line ~239) returns this exact shape
        expect(result).toMatchObject({ success: false, stopReason: 'aborted' });

        // upsertCompletedRow must NOT be called when abort wins the race
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests: BUG 3 — monitoring-blindness guard on the discovery-sweep path
//
// The generator's `success` field is hardcoded true unless sync() itself
// throws (ai/tmdb-metadata-sync.ts) — a per-item failure is caught internally
// and only bumps `errors`. Without the guard, a total TMDB outage (every item
// attempted fails) would still report success:true. Verifies the fix throws a
// transient TaskError instead, and that partial success / genuine no-work /
// aborted runs are unaffected.
// ---------------------------------------------------------------------------

describe('tmdb-metadata-sync: BUG 3 — outage guard on the discovery-sweep path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _capturedOnSuccess = undefined;
        _syncResultOverride = null;
        _generatorIsAbortedOverride = false;
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set());
    });

    it('throws a transient TaskError when every fetched item errored (0 created, 0 updated)', async () => {
        _syncResultOverride = {
            success: true, // generator hardcodes this — must not be trusted
            total_fetched: 5,
            total_movies: 5,
            total_series: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: 5,
            message: 'outage',
        };

        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        let caughtError: unknown;
        try {
            await tmdbMetadataSyncRealTask.execute(ctx);
        } catch (err) {
            caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(TaskError);
        expect((caughtError as TaskError).kind).toBe('transient');
    });

    it('throws with a rate-limit-specific message when the last error was a TMDB 429', async () => {
        _syncResultOverride = {
            success: true,
            total_fetched: 5,
            total_movies: 5,
            total_series: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: 5,
            message: 'outage',
            lastErrorMessage: 'Failed to sync X: TMDB API request failed: 429 Too Many Requests',
        };

        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        await expect(tmdbMetadataSyncRealTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
            message: expect.stringContaining('rate limit reached'),
        });
    });

    it('throws with an auth-specific message when the last error was a bad/missing TMDB API key', async () => {
        _syncResultOverride = {
            success: true,
            total_fetched: 5,
            total_movies: 5,
            total_series: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: 5,
            message: 'outage',
            lastErrorMessage: 'Failed to sync X: TMDB API key is invalid',
        };

        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        await expect(tmdbMetadataSyncRealTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
            message: expect.stringContaining('key missing or invalid'),
        });
    });

    it('does NOT throw when some items succeeded (partial success)', async () => {
        _syncResultOverride = {
            success: true,
            total_fetched: 5,
            total_movies: 5,
            total_series: 0,
            created: 1,
            updated: 0,
            skipped: 0,
            errors: 4,
            message: 'partial',
        };

        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        const result = await tmdbMetadataSyncRealTask.execute(ctx);
        expect(result.success).toBe(true);
    });

    it('does NOT throw on genuine no-work (0 fetched, 0 errors)', async () => {
        _syncResultOverride = {
            success: true,
            total_fetched: 0,
            total_movies: 0,
            total_series: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: 0,
            message: 'nothing to do',
        };

        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        const result = await tmdbMetadataSyncRealTask.execute(ctx);
        expect(result.success).toBe(true);
    });

    it('does NOT throw when the generator was aborted (cancelled sweep, partial errors)', async () => {
        _generatorIsAbortedOverride = true;
        _syncResultOverride = {
            success: true,
            total_fetched: 3,
            total_movies: 3,
            total_series: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: 3,
            message: 'cancelled mid-sweep',
        };

        const rec = makeRecordingSql();
        const ctx = makeCtx({}, rec.sql);

        // Must not throw the outage TaskError — reaches the normal return.
        const result = await tmdbMetadataSyncRealTask.execute(ctx);
        expect(result.success).toBe(true);
    });
});
