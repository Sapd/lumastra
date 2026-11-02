// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * fribb-anime-sync coverage-table behavioural tests.
 *
 * Verifies observable outcomes of the real execute() path:
 *   A) Success  — matched entry with mal_id → upsertCompletedRow called.
 *   B) No-match tombstones — upsertSkippedPermanentRow called, upsertCompletedRow NOT called.
 *   C) 6th-wedge tombstone — matched entry with neither mal_id nor anilist_id.
 *   D) Gate routing — useCoverageTable gates tombstone() but NOT upsertCompletedRow.
 *
 * Gate semantics (important):
 *   - upsertCompletedRow (success write) is UNGATED — fires on any successful enrichment
 *     regardless of useCoverageTable. The gate only controls (a) candidate-source routing
 *     and (b) the tombstone() early-return. Tests D1/D2 verify both sides of this contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import type * as StageStateQueries from '$lib/server/database/queries/stage-state.queries.js';

// ---------------------------------------------------------------------------
// Hoist-safe stage-state spy — intercepts the REAL module so the real task
// code path is observed, not a hand-called mock.
// ---------------------------------------------------------------------------

const stageState = vi.hoisted(() => ({
    upsertCompletedRow: vi
        .fn<typeof StageStateQueries.upsertCompletedRow>()
        .mockResolvedValue(undefined),
    upsertSkippedPermanentRow: vi
        .fn<typeof StageStateQueries.upsertSkippedPermanentRow>()
        .mockResolvedValue(undefined),
}));
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => stageState);

// ---------------------------------------------------------------------------
// Config mock — only the symbols fribb-anime-sync.ts reads from config.
// Avoid importActual (pulls the entire 3800-line module into the worker).
// ---------------------------------------------------------------------------

const mockGetAuthoritativeStageIds = vi.hoisted(() => vi.fn(() => new Set<string>()));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get DISABLE_FRIBB_ANIME_SYNC() {
            return false;
        },
    },
    getAuthoritativeStageIds: mockGetAuthoritativeStageIds,
}));

// ---------------------------------------------------------------------------
// Registry mock — suppress registerTask side-effect at module load time.
// Use the $lib alias so the path resolves consistently regardless of importer.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
    TaskRegistry: vi.fn(),
    getRegistry: vi.fn(),
    setTestRegistry: vi.fn(),
}));

// ---------------------------------------------------------------------------
// CatalogService mock — upsertExternalId RESOLVES TRUE so the success path sets
// wrote=true. The return value is the contract, not just the absence of a throw: it
// reports whether the row was actually written, because the convergence guard skips a
// disagreeing write silently. A mock resolving undefined models "skipped", which is
// why it must be explicit here.
// Use $lib alias so the path resolves to the real module regardless of importer.
// ---------------------------------------------------------------------------

const mockUpsertExternalId = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock('$lib/server/services/catalog.service.js', () => {
    class CatalogService {
        upsertExternalId = mockUpsertExternalId;
        constructor(_sql: unknown, _opts?: unknown) {}
    }
    // Real subclass, not a stub: fribb branches on `err instanceof
    // ExternalIdOwnedByAnotherItemError` to tell a DURABLE id conflict (tombstone)
    // apart from a transient write failure (error + retry). A mock that omitted it
    // would make every conflict look transient — the exact bug this distinguishes.
    class ExternalIdOwnedByAnotherItemError extends Error {
        readonly ownerMediaId: string;
        constructor(provider: string, externalId: string, mediaType: string, ownerMediaId: string) {
            super(
                `External ID ${provider}:${externalId} (${mediaType}) is already mapped to media item ${ownerMediaId}`,
            );
            this.name = 'ExternalIdOwnedByAnotherItemError';
            this.ownerMediaId = ownerMediaId;
        }
    }
    return { CatalogService, ExternalIdOwnedByAnotherItemError };
});

// ---------------------------------------------------------------------------
// drain-backlog mock — calls processSlice with the provided slice, mirrors the
// music-analysis-coverage-flag.test.ts pattern.
// Use $lib alias so it intercepts the dynamic import inside fribb-anime-sync.ts.
// ---------------------------------------------------------------------------

type DrainBacklogOpts<T> = {
    fetchSlice: (limit: number) => Promise<{ items: T[]; remainingHint?: number }>;
    processSlice: (slice: T[], signal: AbortSignal) => Promise<unknown>;
    mode?: string;
    sliceSize?: number;
    onWipe?: () => Promise<void>;
    idOf?: (row: T) => string;
    onProgress?: (...args: unknown[]) => void;
    phase?: string;
    heartbeat?: unknown;
};

const mockDrainBacklog = vi.fn(async (_ctx: unknown, opts: DrainBacklogOpts<unknown>) => {
    const { items } = await opts.fetchSlice(2000);
    if (items.length > 0) {
        await opts.processSlice(items, new AbortController().signal);
    }
    return { stopReason: 'drained' };
});

vi.mock('$lib/server/plugins/runtime/drain-backlog.js', () => ({
    drainBacklog: mockDrainBacklog,
    resolveDrainMode: vi.fn().mockReturnValue('catchup'),
    formatStopReason: vi.fn().mockReturnValue(''),
    computeRemainingHint: vi.fn().mockReturnValue(0),
    isAbortedStop: vi.fn().mockReturnValue(false),
    lazyBacklog: vi.fn((fn: () => unknown) => {
        const memo = { value: undefined as unknown, called: false };
        const getter = async (): Promise<unknown> => {
            if (!memo.called) {
                memo.value = await fn();
                memo.called = true;
            }
            return memo.value;
        };
        (getter as unknown as { peek: () => unknown }).peek = () => memo.value;
        return getter;
    }),
}));

// ---------------------------------------------------------------------------
// Import task under test AFTER all vi.mock() calls.
// ---------------------------------------------------------------------------

import { fribbAnimeSyncTask } from '../fribb-anime-sync.js';

// ---------------------------------------------------------------------------
// Shared Fribb dataset — used across all tests so the module-level cache in
// fribb-anime-sync.ts (24h TTL, primed on first http.get call) stays valid for
// the whole suite without needing per-test cache invalidation.
//
// Entries use the CURRENT upstream shape: `themoviedb_id` is a per-media-type
// object with array buckets, and `type` is UPPERCASE. buildTmdbLookup keys by
// (side, id), so a tv-bucket entry only matches media_type 'tv'.
//
// TMDB IDs chosen to avoid collisions across tests:
//   9001 → tv-bucket entry, mal_id=42 + anilist_id=100  (success path)
//   9002 → absent                                        (not-in-fribb-dataset)
//   9003 → tv-bucket entry, no mal/anilist               (6th-wedge)
//   9004 → tv-bucket entry, mal_id=77                    (gate-off test)
//   9005 → TWO movie-bucket entries, same id             (ambiguous → disambiguate null)
// ---------------------------------------------------------------------------

const SHARED_FRIBB_ENTRIES = [
    { themoviedb_id: { tv: [9001] }, mal_id: 42, anilist_id: 100, type: 'TV' },
    { themoviedb_id: { tv: [9003] }, mal_id: null, anilist_id: null, type: 'TV' },
    { themoviedb_id: { tv: [9004] }, mal_id: 77, anilist_id: null, type: 'TV' },
    // 9005: two MOVIE entries sharing one tmdb id → after buildTmdbLookup narrows
    // to the movie side there are still 2 candidates, so disambiguate() returns null.
    { themoviedb_id: { movie: [9005] }, mal_id: 501, anilist_id: null, type: 'MOVIE' },
    { themoviedb_id: { movie: [9005] }, mal_id: 502, anilist_id: null, type: 'MOVIE' },
    // 9006: an anime MOVIE whose tmdb Fribb files under the parent TV series'
    // `tv` bucket (so a movie-bucket tmdb lookup MISSES), but it carries a
    // usable imdb_id → the IMDb fallback resolves it. mal_id=606.
    {
        themoviedb_id: { tv: [8006] },
        imdb_id: ['tt6006'],
        mal_id: 606,
        anilist_id: null,
        type: 'MOVIE',
    },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CandidateRow {
    media_id: string;
    media_type: string;
    tmdb_id: string;
}

/** Build a minimal TaskContext. sql is a recording proxy for countBacklog / findCoverageTableBacklog. */
function makeCtx(
    fetchSliceRows: CandidateRow[],
    imdbRows: { media_id: string; external_id: string }[] = [],
) {
    const ac = new AbortController();

    // sql responds to three query patterns:
    //   - query containing 'COUNT(*)'        → countBacklog (return stats row)
    //   - query containing "provider = 'imdb'" → per-slice imdb batch fetch
    //   - anything else                      → findCoverageTableBacklog (slice)
    const fakeSql = vi.fn(
        (strings: TemplateStringsArray, ..._vals: unknown[]): Promise<unknown[]> => {
            const q = strings[0] ?? '';
            if (q.includes('COUNT(*)')) {
                return Promise.resolve([
                    {
                        analyzed: 0,
                        remaining: fetchSliceRows.length,
                        ineligible: 0,
                    },
                ]);
            }
            if (q.includes("provider = 'imdb'")) {
                return Promise.resolve(imdbRows);
            }
            return Promise.resolve(fetchSliceRows);
        },
    ) as unknown as postgres.Sql;

    // Fribb dataset served via ctx.http — always return the shared dataset so the
    // module-level in-memory cache is populated on the first test and reused.
    const fakeHttp = {
        get: vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(SHARED_FRIBB_ENTRIES),
        }),
    };

    return {
        sql: fakeSql,
        http: fakeHttp,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run',
        input: {},
        reportProgress: vi.fn(),
    };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('fribb-anime-sync: behavioural coverage', () => {
    const origEnv = process.env.PIPELINE_COVERAGE_AUTHORITATIVE_STAGES;
    const origDisable = process.env.DISABLE_FRIBB_ANIME_SYNC;

    beforeEach(() => {
        vi.clearAllMocks();
        // Re-apply default implementations after clearAllMocks resets them.
        stageState.upsertCompletedRow.mockResolvedValue(undefined);
        stageState.upsertSkippedPermanentRow.mockResolvedValue(undefined);
        // TRUE = the row was written. `undefined` would model the convergence
        // guard's silent skip, which must NOT count as enrichment.
        mockUpsertExternalId.mockResolvedValue(true);
        mockDrainBacklog.mockImplementation(
            async (_ctx: unknown, opts: DrainBacklogOpts<unknown>) => {
                const { items } = await opts.fetchSlice(2000);
                if (items.length > 0) {
                    await opts.processSlice(items, new AbortController().signal);
                }
                return { stopReason: 'drained' };
            },
        );
        delete process.env.DISABLE_FRIBB_ANIME_SYNC;
        // Default: coverage table ON for fribb-anime-sync
        mockGetAuthoritativeStageIds.mockReturnValue(new Set(['fribb-anime-sync']));
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.PIPELINE_COVERAGE_AUTHORITATIVE_STAGES;
        else process.env.PIPELINE_COVERAGE_AUTHORITATIVE_STAGES = origEnv;
        if (origDisable === undefined) delete process.env.DISABLE_FRIBB_ANIME_SYNC;
        else process.env.DISABLE_FRIBB_ANIME_SYNC = origDisable;
    });

    // -----------------------------------------------------------------------
    // A. Success path
    // -----------------------------------------------------------------------

    it('success: match with mal_id calls upsertCompletedRow with exact args', async () => {
        const mediaItemId = 'aaaabbbb-cccc-dddd-eeee-111111111111';

        // TMDB 9001 → TV entry with mal_id=42 in SHARED_FRIBB_ENTRIES.
        // media_type 'tv' (lowercase) satisfies the SUPPORTED_TYPES check.
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'tv', tmdb_id: '9001' },
        ];

        const ctx = makeCtx(slice);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        expect(stageState.upsertCompletedRow).toHaveBeenCalledOnce();
        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(ctx.sql, {
            mediaItemId,
            stageId: 'fribb-anime-sync',
            processingVersion: 1,
        });
        // Skipped-permanent must NOT have been called for this item
        expect(stageState.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('imdb fallback: tmdb-bucket miss but imdb match enriches (Fribb-tv-bucketed movie)', async () => {
        const mediaItemId = 'a6a6a6a6-b6b6-c6c6-d6d6-606060606060';

        // A movie whose own tmdb (9998) is absent from any Fribb movie bucket —
        // Fribb filed entry 9006 under the parent TV series' `tv` bucket (8006).
        // The movie carries imdb tt6006, which Fribb also carries → IMDb fallback.
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'movie', tmdb_id: '9998' },
        ];
        const imdbRows = [{ media_id: mediaItemId, external_id: 'tt6006' }];

        const ctx = makeCtx(slice, imdbRows);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        // Resolved via imdb → mal_id 606 written, completed (not skipped).
        expect(mockUpsertExternalId).toHaveBeenCalledWith(
            mediaItemId,
            expect.objectContaining({ provider: 'mal', id: '606', mediaType: 'movie' }),
        );
        expect(stageState.upsertCompletedRow).toHaveBeenCalledOnce();
        expect(stageState.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // B. No-match tombstones
    // -----------------------------------------------------------------------

    it('tombstone: not-in-fribb-dataset calls upsertSkippedPermanentRow, not upsertCompletedRow', async () => {
        const mediaItemId = 'bbbbbbbb-cccc-dddd-eeee-222222222222';

        // TMDB 9002 is absent from SHARED_FRIBB_ENTRIES → not-in-fribb-dataset branch.
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'tv', tmdb_id: '9002' },
        ];

        const ctx = makeCtx(slice);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledOnce();
        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledWith(
            ctx.sql,
            expect.objectContaining({
                mediaItemId,
                stageId: 'fribb-anime-sync',
                skippedReason: 'not-in-fribb-dataset',
            }),
        );
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('tombstone: invalid-tmdb-id calls upsertSkippedPermanentRow, not upsertCompletedRow', async () => {
        const mediaItemId = 'cccccccc-dddd-eeee-ffff-333333333333';
        // Non-numeric tmdb_id → parseInt returns NaN → invalid-tmdb-id branch.
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'tv', tmdb_id: 'not-a-number' },
        ];

        const ctx = makeCtx(slice);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledOnce();
        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledWith(
            ctx.sql,
            expect.objectContaining({
                mediaItemId,
                stageId: 'fribb-anime-sync',
                skippedReason: 'invalid-tmdb-id',
            }),
        );
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // C. 6th-wedge: matched entry with neither mal_id nor anilist_id
    // -----------------------------------------------------------------------

    it('tombstone: fribb-match-no-mal-anilist-id calls upsertSkippedPermanentRow, not upsertCompletedRow', async () => {
        const mediaItemId = 'dddddddd-eeee-ffff-aaaa-444444444444';
        // TMDB 9003 → TV entry with mal_id=null AND anilist_id=null in SHARED_FRIBB_ENTRIES.
        // Disambiguates successfully (single TV entry) but has nothing to write → 6th wedge.
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'tv', tmdb_id: '9003' },
        ];

        const ctx = makeCtx(slice);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledOnce();
        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledWith(
            ctx.sql,
            expect.objectContaining({
                mediaItemId,
                stageId: 'fribb-anime-sync',
                skippedReason: 'fribb-match-no-mal-anilist-id',
            }),
        );
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // D. Gate routing — tombstone is gated; success write is NOT
    // -----------------------------------------------------------------------

    it('D1: tombstone suppressed when coverage gate is OFF (no-match item)', async () => {
        // Turn coverage table OFF for fribb-anime-sync.
        mockGetAuthoritativeStageIds.mockReturnValue(new Set<string>());

        const mediaItemId = 'eeeeeeee-ffff-aaaa-bbbb-555555555555';
        // TMDB 9003 → TV entry with no mal/anilist ids — would call tombstone() if gate ON.
        // With gate OFF, tombstone() returns early so upsertSkippedPermanentRow is never called.
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'tv', tmdb_id: '9003' },
        ];

        const ctx = makeCtx(slice);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        // The meaningful gate assertion: tombstone write suppressed when gate is OFF.
        expect(stageState.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('D2: upsertCompletedRow fires even when coverage gate is OFF (success write is ungated)', async () => {
        // upsertCompletedRow is inside the `if (wrote)` block and has no useCoverageTable
        // guard — it is intentionally ungated so coverage rows are written regardless of
        // which fetch branch sourced the candidate.
        mockGetAuthoritativeStageIds.mockReturnValue(new Set<string>());

        const mediaItemId = 'ffffffff-0000-1111-2222-666666666666';
        // TMDB 9004 → TV entry with mal_id=77 → upsertExternalId succeeds → wrote=true.
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'tv', tmdb_id: '9004' },
        ];

        const ctx = makeCtx(slice);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        // Success write fires even though the coverage gate is OFF.
        expect(stageState.upsertCompletedRow).toHaveBeenCalledOnce();
        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(ctx.sql, {
            mediaItemId,
            stageId: 'fribb-anime-sync',
            processingVersion: 1,
        });
        expect(stageState.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // E. Per-item tombstone dispositions (coverage gate ON for all)
    // -----------------------------------------------------------------------

    it('tombstone: missing-media-type calls upsertSkippedPermanentRow, not upsertCompletedRow', async () => {
        const mediaItemId = '11111111-2222-3333-4444-777777777777';
        // media_type is empty string — raw falsy check in source writes missing-media-type.
        const slice: CandidateRow[] = [{ media_id: mediaItemId, media_type: '', tmdb_id: '9001' }];

        const ctx = makeCtx(slice);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledOnce();
        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledWith(
            ctx.sql,
            expect.objectContaining({
                mediaItemId,
                stageId: 'fribb-anime-sync',
                skippedReason: 'missing-media-type',
            }),
        );
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('tombstone: unsupported-media-type calls upsertSkippedPermanentRow, not upsertCompletedRow', async () => {
        const mediaItemId = '22222222-3333-4444-5555-888888888888';
        // media_type 'music' is not 'movie' or 'tv' → unsupported-media-type branch.
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'music', tmdb_id: '9001' },
        ];

        const ctx = makeCtx(slice);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledOnce();
        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledWith(
            ctx.sql,
            expect.objectContaining({
                mediaItemId,
                stageId: 'fribb-anime-sync',
                skippedReason: 'unsupported-media-type',
            }),
        );
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('tombstone: no-fribb-match-after-disambiguation calls upsertSkippedPermanentRow, not upsertCompletedRow', async () => {
        const mediaItemId = '33333333-4444-5555-6666-999999999999';
        // TMDB 9005 has TWO movie-bucket entries. lookupFribbEntries('movie', 9005)
        // returns both; disambiguate() can't pick one → returns null → this branch.
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'movie', tmdb_id: '9005' },
        ];

        const ctx = makeCtx(slice);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledOnce();
        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledWith(
            ctx.sql,
            expect.objectContaining({
                mediaItemId,
                stageId: 'fribb-anime-sync',
                skippedReason: 'no-fribb-match-after-disambiguation',
            }),
        );
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // F. Monitoring-blindness regression — total write failure must be VISIBLE
    // -----------------------------------------------------------------------

    it('a write the convergence guard skipped does not count as enrichment', async () => {
        // upsertExternalId resolving without throwing used to be read as "written".
        // It is not: when another writer has just claimed the same
        // (media_id, provider, media_type), the guard skips silently and returns
        // false. Treating that as a write marked the stage completed and counted the
        // item in `enriched`, so the run reported coverage for an id it never stored
        // — and being completed, nothing would come back for it.
        mockUpsertExternalId.mockResolvedValue(false);

        const mediaItemId = 'a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4';
        const ctx = makeCtx([{ media_id: mediaItemId, media_type: 'tv', tmdb_id: '9001' }]);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        // The write was attempted, but nothing landed: no coverage row.
        expect(mockUpsertExternalId).toHaveBeenCalled();
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        // And it is not written off either — the row simply stays pending and is
        // retried once the rival id ages out of the guard's window.
        expect(stageState.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('durable id conflict tombstones instead of failing the whole run', async () => {
        // Contrast with the outage test below: a DB outage is transient and must
        // throw, but "this provider id belongs to another media item" can never
        // succeed — (provider, external_id, media_type) is UNIQUE. Counting it as a
        // write error kept the item a candidate, so it threw again on the next
        // slice: prod logged 413,590 errors in one five-minute run and opened the
        // circuit breaker, starving every healthy candidate behind it. Real case:
        // two chapters of one film both mapped to mal:52107.
        const { ExternalIdOwnedByAnotherItemError } =
            await import('$lib/server/services/catalog.service.js');
        mockUpsertExternalId.mockRejectedValue(
            new ExternalIdOwnedByAnotherItemError('mal', '52107', 'movie', 'other-item-uuid'),
        );

        const mediaItemId = 'a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4';
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'tv', tmdb_id: '9001' },
        ];

        const ctx = makeCtx(slice);
        // Must NOT throw — the run is healthy, the item is simply written off.
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        expect(stageState.upsertSkippedPermanentRow).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ skippedReason: 'mal:id-owned-by-another-item' }),
        );
    });

    it('a MAL conflict does not discard a FREE AniList id, and completes the item', async () => {
        // The first version of the conflict handling `continue`d, which skipped the
        // AniList upsert entirely and jumped past the completion block. An item whose
        // AniList id was free lost that enrichment AND was stamped skipped_permanent
        // despite being enrichable. Writing off real coverage is worse than the
        // wasted retry the tombstone was added to stop.
        const { ExternalIdOwnedByAnotherItemError } =
            await import('$lib/server/services/catalog.service.js');
        mockUpsertExternalId.mockImplementation(async (_id: string, ext: { provider: string }) => {
            if (ext.provider === 'mal') {
                throw new ExternalIdOwnedByAnotherItemError('mal', '52107', 'movie', 'other');
            }
            // AniList genuinely lands — that is the point of the test.
            return true;
        });

        const slice: CandidateRow[] = [
            { media_id: 'a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4', media_type: 'tv', tmdb_id: '9001' },
        ];
        const ctx = makeCtx(slice);
        await fribbAnimeSyncTask.execute(
            ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
        );

        // AniList write was still attempted despite the MAL conflict...
        expect(
            mockUpsertExternalId.mock.calls.some(
                (c: unknown[]) => (c[1] as { provider: string }).provider === 'anilist',
            ),
        ).toBe(true);
        // ...and the item completed rather than being written off.
        expect(stageState.upsertCompletedRow).toHaveBeenCalled();
        expect(stageState.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('outage: every write attempt fails (enriched=0, errors>0) → throws transient TaskError', async () => {
        // TMDB 9001 disambiguates to a Fribb entry with BOTH mal_id and anilist_id,
        // so two upsertExternalId writes are attempted. Both reject → wrote stays
        // false, errors accumulates, enriched stays 0. That's a total failure
        // (outage), NOT no-work. Returning success:false would be invisible (the
        // runner records a returned result as a COMPLETED run reporting breaker
        // SUCCESS), so the task must THROW a transient TaskError instead.
        mockUpsertExternalId.mockRejectedValue(new Error('DB write failed'));

        const mediaItemId = 'a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4';
        const slice: CandidateRow[] = [
            { media_id: mediaItemId, media_type: 'tv', tmdb_id: '9001' },
        ];

        const ctx = makeCtx(slice);
        await expect(
            fribbAnimeSyncTask.execute(
                ctx as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0],
            ),
        ).rejects.toMatchObject({ name: 'TaskError', kind: 'transient' });

        // No success coverage row written for a run that enriched nothing.
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });
});
