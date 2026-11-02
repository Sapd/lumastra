// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * mdblist-sync monitoring-blindness regression.
 *
 * The old success gate was `syncResult.errors.length <= 10` (absolute), which
 * ignored the processed count. The naive replacement `processed === 0 &&
 * errors > 0` was UNREACHABLE: when `invokeProviderBatchLookup` throws, the
 * batch-catch marks EVERY item in the failed batch `processed++`/`skipped++`,
 * so a total outage reports `processed = N`, never 0. The old test papered over
 * this by hand-mocking `{ processed: 0, errors: [...] }` — a shape the generator
 * can NEVER produce on an outage.
 *
 * The real signal is `processedViaFallback`: items counted ONLY because their
 * whole batch threw. When `processedViaFallback === processed && updated === 0`
 * with errors, every attempted batch failed → genuine outage.
 *
 * These tests assert:
 *   REAL-PATH) Driving the REAL `syncMDBListRatings` with a throwing
 *     `invokeProviderBatchLookup` produces `processed === processedViaFallback`,
 *     `updated === 0`, errors > 0 — i.e. the exact shape the guard keys on. This
 *     locks in that the outage shape is producible, not a test fiction.
 *   A) Task gate: a producible outage result → THROWS a transient TaskError.
 *   B) Partial success (updated > 0 with some errors) → returns success:true.
 *   C) Genuine no-work (processed === 0, errors === 0) → returns success:true.
 *   D) Upstream had no data (processed > 0, all skipped, no errors, no fallback)
 *      → returns success:true (NOT an outage).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks (declared before the task import) ──────────────────────────

const configMock = vi.hoisted(() => ({
    config: { MDBLIST_API_KEY: 'test-key' },
    getAuthoritativeStageIds: vi.fn(() => new Set<string>()),
}));
vi.mock('$lib/server/config.js', () => configMock);

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

vi.mock('$lib/server/tasks/api-call-spend.js', () => ({
    withApiCallSpend: async (_ctx: unknown, body: () => Promise<unknown>) => body(),
}));

vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: vi.fn().mockResolvedValue(undefined),
    upsertSkippedPermanentRow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/database/queries/embeddings.queries.js', () => ({
    findEmbeddingCoverageTableBacklog: vi.fn().mockResolvedValue([]),
}));

// Controllable generator double — sync() returns whatever the test queues.
// Used only for the task-gate tests (A–D); the REAL-PATH test drives the real
// syncMDBListRatings directly and never touches this double.
const genMock = vi.hoisted(() => ({
    sync: vi.fn(),
}));
vi.mock('$lib/server/ai/mdblist-sync-generator.js', () => ({
    MDBListSyncGenerator: class {
        constructor(_opts: unknown) {}
        sync(): Promise<unknown> {
            return genMock.sync();
        }
        abort(): Promise<void> {
            return Promise.resolve();
        }
        getProgress(): { processedItems: number; totalItems: number; currentItem: undefined } {
            return { processedItems: 0, totalItems: 0, currentItem: undefined };
        }
    },
}));

// ─── Mocks for the REAL syncMDBListRatings path ───────────────────────────────
// syncMDBListRatings (in ai/mdblist-sync.ts) is NOT mocked — we run it for real
// to prove the outage shape is producible. Its collaborators are stubbed to the
// minimum so the movie query returns one item and the batch lookup throws.

const providerBatchMock = vi.hoisted(() => ({ invokeProviderBatchLookup: vi.fn() }));
vi.mock('$lib/server/tasks/plugin-context.js', () => providerBatchMock);

const mdblistApiMock = vi.hoisted(() => ({
    mdblistApi: { isAvailable: vi.fn(() => true) },
}));
vi.mock('$lib/server/services/mdblist-api.js', () => mdblistApiMock);

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: vi.fn(() => 'tmdb'),
}));

// The Database class is constructed with `options.sql` and its getSql() is used
// for every query. Return a query-shape-aware sql double: the real movie query
// carries nested `sql``` fragments (candidateIds / LIMIT branches) that each hit
// the tag, so a positional row-queue is fragile — instead answer by matching the
// outer movie SELECT and return `[]` for everything else (fragments included).
const dbMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('$lib/server/database/connection.js', () => ({
    Database: class {
        constructor(_sql: unknown) {}
        getSql(): unknown {
            return dbMock.current;
        }
    },
}));

function makeMovieOnlySql(rows: unknown[]): unknown {
    const tag = (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
        const q = strings.join(' ');
        // Only the outer movie SELECT carries both markers; nested `sql``` /
        // `sql`LIMIT ?`` fragments and any other query fall through to [].
        if (q.includes('primary_ext_id') && q.includes("media_type = 'movie'")) {
            return Promise.resolve(rows);
        }
        return Promise.resolve([]);
    };
    return Object.assign(tag, {
        json: (v: unknown): unknown => v,
        unsafe: (): Promise<unknown[]> => Promise.resolve([]),
        begin: (fn: (s: unknown) => unknown): Promise<unknown> => Promise.resolve(fn(tag)),
    });
}

// ─── Imports under test (after mocks) ─────────────────────────────────────────

import { mdblistSyncTask } from '../mdblist-sync.js';
import { syncMDBListRatings } from '$lib/server/ai/mdblist-sync.js';

type MdblistCtx = Parameters<typeof mdblistSyncTask.execute>[0];

function makeCtx(): MdblistCtx {
    const ac = new AbortController();
    return {
        sql: vi.fn() as unknown as MdblistCtx['sql'],
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run-mdblist',
        input: {},
        reportProgress: vi.fn(),
        spend: vi.fn(),
    } as unknown as MdblistCtx;
}

describe('mdblist-sync: monitoring-blindness regression', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.MDBLIST_API_KEY = 'test-key';
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set<string>());
        mdblistApiMock.mdblistApi.isAvailable.mockReturnValue(true);
    });

    // ── REAL PATH: prove the outage shape is producible ───────────────────────
    it('REAL-PATH: throwing invokeProviderBatchLookup → processed===processedViaFallback, updated=0', async () => {
        // Movie query returns one candidate; the batch lookup then throws (MDBList
        // down). The real processBatch catch marks the item processed/skipped AND
        // increments processedViaFallback — the exact shape the task gate keys on.
        const sql = makeMovieOnlySql([{ primary_ext_id: '123', title: 'X', media_id: 'm1' }]);
        dbMock.current = sql;

        providerBatchMock.invokeProviderBatchLookup.mockRejectedValue(new Error('MDBList 503'));

        const result = await syncMDBListRatings({
            sql: sql as never,
            mediaType: 'movie',
            onlyMissing: true,
            limit: 5,
            delayMs: 0,
        });

        expect(result.processed).toBe(1);
        expect(result.updated).toBe(0);
        expect(result.processedViaFallback).toBe(1);
        expect(result.processedViaFallback).toBe(result.processed);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    // ── A: total outage (producible shape) → throws ───────────────────────────
    it('A: total outage (processedViaFallback===processed, updated=0, errors>0) → throws transient TaskError', async () => {
        genMock.sync.mockResolvedValue({
            processed: 200,
            updated: 0,
            skipped: 200,
            processedViaFallback: 200,
            errors: [new Error('MDBList 503')],
            duration_ms: 10,
            requestCount: 1,
        });

        const ctx = makeCtx();
        await expect(mdblistSyncTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
        });
    });

    // ── A2: total outage caused by rate-limiting → throws with a distinct,
    //       operator-legible message instead of the generic "upstream outage"
    //       wording (Kritisch alert should read "rate limit reached", not a
    //       bare 'probe_failure' enum) ──────────────────────────────────────
    it('A2: rate-limited outage → throws transient TaskError with a rate-limit-specific message', async () => {
        genMock.sync.mockResolvedValue({
            processed: 3,
            updated: 0,
            skipped: 3,
            processedViaFallback: 3,
            errors: [
                'Batch 1 failed: MDBList rate-limit cool-down active (free-tier quota) — will retry in 6h 0m',
            ],
            duration_ms: 10,
            requestCount: 1,
        });

        const ctx = makeCtx();
        await expect(mdblistSyncTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
            message: expect.stringContaining('rate limit reached'),
        });
    });

    // ── B: partial success → success ──────────────────────────────────────────
    it('B: partial success (updated>0 with errors) → returns success:true', async () => {
        genMock.sync.mockResolvedValue({
            processed: 20,
            updated: 15,
            skipped: 5,
            processedViaFallback: 0,
            errors: new Array(25).fill(0).map((_, i) => new Error(`fail ${i}`)),
            duration_ms: 10,
            requestCount: 1,
        });

        const ctx = makeCtx();
        const result = await mdblistSyncTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(20);
        expect(result.result?.errors).toBe(25);
    });

    // ── C: genuine no-work → success ──────────────────────────────────────────
    it('C: genuine no-work (processed=0, errors=0) → returns success:true', async () => {
        genMock.sync.mockResolvedValue({
            processed: 0,
            updated: 0,
            skipped: 0,
            processedViaFallback: 0,
            errors: [],
            duration_ms: 10,
            requestCount: 0,
        });

        const ctx = makeCtx();
        const result = await mdblistSyncTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });

    // ── D: upstream had no data (reached upstream, no errors) → success ────────
    it('D: items reached upstream with no data (processed>0, no errors, no fallback) → success:true', async () => {
        genMock.sync.mockResolvedValue({
            processed: 50,
            updated: 0,
            skipped: 50,
            processedViaFallback: 0, // NOT via failure-fallback → not an outage
            errors: [],
            duration_ms: 10,
            requestCount: 1,
        });

        const ctx = makeCtx();
        const result = await mdblistSyncTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(50);
    });
});
