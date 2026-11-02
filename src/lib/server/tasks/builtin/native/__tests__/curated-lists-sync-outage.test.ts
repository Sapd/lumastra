// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * curated-lists-sync monitoring-blindness regression.
 *
 * The task synced N curated lists; the old return computed
 *   success = !stopped && listErrors.length === 0 && successCount > 0
 * and RETURNED it. A total upstream outage (every list fetch throws) therefore
 * produced a returned result — which the runner records as a COMPLETED run that
 * reports SUCCESS to the circuit breaker, hiding the outage from alerting.
 *
 * These tests assert:
 *   A) Total outage (every configured list fails) → THROWS a transient TaskError
 *      (so the run is marked failed, retried, and the breaker can trip).
 *   B) Happy path (all lists succeed) → returns success:true, no throw.
 *   C) Partial outage (one succeeds, one fails) → returns success:false, no throw.
 *
 * IMPORTANT: `syncList` NEVER rejects — it wraps its body in try/catch and always
 * RESOLVES `{ success: false, error }` on failure. So the outage path is driven by
 * mockResolvedValue({ success: false }), NOT mockRejectedValue — the latter would
 * exercise the near-dead `listErrors` catch branch, not the real data flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks (declared before the task import) ──────────────────────────

const listSyncMock = vi.hoisted(() => ({
    syncList: vi.fn(),
    CURATED_LISTS: [] as Array<{ name: string }>,
}));
vi.mock('$lib/server/ai/list-sync.js', () => listSyncMock);

vi.mock('$lib/server/utils/abortable-sleep.js', () => ({
    sleepOrResolve: vi.fn().mockResolvedValue(undefined),
}));

const configMock = vi.hoisted(() => ({
    config: { DISABLE_CURATED_LISTS_SYNC: false },
}));
vi.mock('$lib/server/config.js', () => configMock);

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

// withApiCallSpend is a thin wrapper — pass through so no spend mock is needed.
vi.mock('$lib/server/tasks/api-call-spend.js', () => ({
    withApiCallSpend: async (_ctx: unknown, body: () => Promise<unknown>) => body(),
}));

// The task does nothing without an MDBList key (4ef75ac831). These cases drive
// the outage path, so they run with a key configured; the keyless guard has
// its own case below.
const mdblistMock = vi.hoisted(() => ({ available: true }));
vi.mock('$lib/server/services/mdblist-api.js', () => ({
    mdblistApi: { isAvailable: () => mdblistMock.available },
}));

// ─── Import real task AFTER mocks ─────────────────────────────────────────────

import { curatedListsSyncTask } from '../curated-lists-sync.js';

type CuratedCtx = Parameters<typeof curatedListsSyncTask.execute>[0];

function makeCtx(): CuratedCtx {
    const ac = new AbortController();
    return {
        sql: vi.fn() as unknown as CuratedCtx['sql'],
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run-curated',
        input: {},
        reportProgress: vi.fn(),
        spend: vi.fn(),
    } as unknown as CuratedCtx;
}

describe('curated-lists-sync: monitoring-blindness regression', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.config.DISABLE_CURATED_LISTS_SYNC = false;
        mdblistMock.available = true;
        listSyncMock.CURATED_LISTS = [{ name: 'Trending' }, { name: 'Popular' }];
    });

    it('A: every configured list fails (syncList resolves success:false) → throws transient TaskError', async () => {
        // Real behaviour: syncList RESOLVES success:false, it does not reject.
        listSyncMock.syncList.mockResolvedValue({
            success: false,
            list_id: 'x',
            items_synced: 0,
            error: 'ECONNREFUSED',
        });

        const ctx = makeCtx();
        await expect(curatedListsSyncTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
        });
    });

    it('A2: every configured list fails on MDBList rate limit → throws with a rate-limit-specific message', async () => {
        listSyncMock.syncList.mockResolvedValue({
            success: false,
            list_id: 'x',
            items_synced: 0,
            error: 'MDBList rate limit exceeded',
        });

        const ctx = makeCtx();
        await expect(curatedListsSyncTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
            message: expect.stringContaining('rate limit reached'),
        });
    });

    it('B: all lists succeed → returns success:true, no throw', async () => {
        listSyncMock.syncList.mockResolvedValue({ success: true, items_synced: 5 });

        const ctx = makeCtx();
        const result = await curatedListsSyncTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.result?.listsSynced).toBe(2);
        expect(result.result?.listsFailed).toBe(0);
        expect(result.result?.itemsSynced).toBe(10);
    });

    it('C: partial outage (one succeeds, one fails) → success:false, no throw, listsFailed=1', async () => {
        listSyncMock.syncList
            .mockResolvedValueOnce({ success: true, list_id: 'a', items_synced: 5 })
            .mockResolvedValueOnce({ success: false, list_id: 'b', items_synced: 0, error: '503' });

        const ctx = makeCtx();
        const result = await curatedListsSyncTask.execute(ctx);

        // At least one list synced → not a total outage → no throw.
        expect(result.success).toBe(false);
        expect(result.result?.listsSynced).toBe(1);
        expect(result.result?.listsFailed).toBe(1);
        expect(result.result?.itemsSynced).toBe(5);
    });

    it('without an MDBList key: no list is fetched and the run succeeds quietly', async () => {
        mdblistMock.available = false;
        const r = await curatedListsSyncTask.execute(makeCtx());
        expect(r.success).toBe(true);
        expect(listSyncMock.syncList).not.toHaveBeenCalled();
    });
});
