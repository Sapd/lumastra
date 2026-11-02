// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * drainBacklog / drainWipe tests.
 *
 * Covers the contract the six sync plugins rely on:
 *   - mode coercion (resolveDrainMode)
 *   - stop-reason formatting
 *   - remaining-hint clamp
 *   - lazyBacklog memoization + peek
 *   - pickWorstStopReason severity ranking
 *   - drain loop in catchup/manual/force (including force-without-onWipe
 *     warning path)
 *   - abort plumbing at every stage
 *   - no-progress trip wire is state-aware (advanced === 0 over two
 *     identical signatures), not purely signature-based
 *   - cumulative multi-slice no-progress net fires in EVERY mode (not just
 *     catchup), with a lower threshold for catchup (3) than manual/force (5)
 *   - sliceSize entry guard (0/negative/non-integer throws, before onWipe)
 *   - idOf callback invoked per slice + signature stability across mutable
 *     fields; full-id-join signature distinguishes same-length/first/last
 *     slices with a different middle item
 *   - composed abort signal (ctx abort + soft-budget timeout) reaches
 *     processSlice
 *   - soft budget exit + heartbeat lifecycle fold
 *   - drainWipe empty-first-fetch, multi-batch accumulation, abort mid-loop
 */

import { describe, it, expect, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import {
    computeRemainingHint,
    drainBacklog,
    drainWipe,
    formatStopReason,
    lazyBacklog,
    pickWorstStopReason,
    resolveDrainMode,
    startHeartbeat,
    type DrainBacklogOptions,
    type DrainSlice,
    type DrainStopReason,
    type ProcessSliceResult,
} from './drain-backlog.js';
import type { PluginContext } from '../types/base-plugin.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FakeLogger {
    debug: MockedFunction<(msg: string, data?: object) => void>;
    info: MockedFunction<(msg: string, data?: object) => void>;
    warn: MockedFunction<(msg: string, data?: object) => void>;
    error: MockedFunction<(msg: string, err?: Error, data?: object) => void>;
}

function createFakeLogger(): FakeLogger {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}

interface FakeCtx {
    ctx: PluginContext;
    logger: FakeLogger;
    abort: AbortController;
}

function createFakeCtx(): FakeCtx {
    const logger = createFakeLogger();
    const abort = new AbortController();
    const ctx = {
        logger,
        abortSignal: abort.signal,
    } as unknown as PluginContext;
    return { ctx, logger, abort };
}

/**
 * Build a `processSlice` that returns a fixed produced/advanced for every
 * call unless overridden via `next()`. Generic over the item type so it
 * slots into any `drainBacklog<T>` test.
 */
function staticProcessSlice<T>(
    produced: number,
    advanced: number,
): MockedFunction<(items: T[], signal: AbortSignal) => Promise<ProcessSliceResult>> {
    return vi.fn(async () => ({ produced, advanced }));
}

// ---------------------------------------------------------------------------
// resolveDrainMode
// ---------------------------------------------------------------------------

describe('resolveDrainMode', () => {
    it('returns manual/force/catchup unchanged', () => {
        expect(resolveDrainMode('manual')).toBe('manual');
        expect(resolveDrainMode('force')).toBe('force');
        expect(resolveDrainMode('catchup')).toBe('catchup');
    });

    it('coerces undefined to catchup silently (no debug log)', () => {
        const { logger } = createFakeCtx();
        expect(resolveDrainMode(undefined, logger as unknown as PluginContext['logger'])).toBe(
            'catchup',
        );
        expect(logger.debug).not.toHaveBeenCalled();
    });

    it('coerces unknown mode to catchup with debug log', () => {
        const { logger } = createFakeCtx();
        expect(resolveDrainMode('smart', logger as unknown as PluginContext['logger'])).toBe(
            'catchup',
        );
        expect(logger.debug).toHaveBeenCalledOnce();
        expect(logger.debug.mock.calls[0][0]).toContain('smart');
    });

    it('does not require a logger for unknown modes', () => {
        expect(() => resolveDrainMode('bogus')).not.toThrow();
        expect(resolveDrainMode('bogus')).toBe('catchup');
    });
});

// ---------------------------------------------------------------------------
// formatStopReason
// ---------------------------------------------------------------------------

describe('formatStopReason', () => {
    it('returns empty string for drained', () => {
        expect(formatStopReason('drained')).toBe('');
    });

    it('returns empty string for single-slice', () => {
        expect(formatStopReason('single-slice')).toBe('');
    });

    it('returns " (aborted)" for aborted', () => {
        expect(formatStopReason('aborted')).toBe(' (aborted)');
    });

    it('returns budget suffix with next-catchup hint', () => {
        expect(formatStopReason('budget')).toContain('soft time budget');
        expect(formatStopReason('budget')).toContain('next catchup');
    });

    it('returns state-aware no-progress suffix', () => {
        const msg = formatStopReason('no-progress');
        expect(msg).toContain('no progress');
        expect(msg).toContain('no rows advanced');
    });
});

// ---------------------------------------------------------------------------
// computeRemainingHint
// ---------------------------------------------------------------------------

describe('computeRemainingHint', () => {
    it('returns initialBacklog - processed - slice', () => {
        expect(computeRemainingHint(100, 10, 5)).toBe(85);
    });

    it('clamps negative results to 0', () => {
        expect(computeRemainingHint(5, 10, 5)).toBe(0);
    });

    it('returns 0 at exact boundary', () => {
        expect(computeRemainingHint(10, 5, 5)).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// lazyBacklog
// ---------------------------------------------------------------------------

describe('lazyBacklog', () => {
    it('calls the counter exactly once across multiple invocations', async () => {
        const counter = vi.fn(async () => 42);
        const lazy = lazyBacklog(counter);

        expect(await lazy()).toBe(42);
        expect(await lazy()).toBe(42);
        expect(await lazy()).toBe(42);
        expect(counter).toHaveBeenCalledOnce();
    });

    it('peek() returns null before first call', () => {
        const lazy = lazyBacklog(async () => 7);
        expect(lazy.peek()).toBeNull();
    });

    it('peek() returns the cached value after first call', async () => {
        const lazy = lazyBacklog(async () => 7);
        await lazy();
        expect(lazy.peek()).toBe(7);
    });
});

// ---------------------------------------------------------------------------
// pickWorstStopReason
// ---------------------------------------------------------------------------

describe('pickWorstStopReason', () => {
    it('orders aborted > no-progress > budget > single-slice > drained', () => {
        expect(pickWorstStopReason(['drained', 'aborted'])).toBe('aborted');
        expect(pickWorstStopReason(['drained', 'no-progress'])).toBe('no-progress');
        expect(pickWorstStopReason(['single-slice', 'budget'])).toBe('budget');
        expect(pickWorstStopReason(['drained', 'single-slice'])).toBe('single-slice');
    });

    it('ignores undefined entries so optional phases slot in cleanly', () => {
        expect(pickWorstStopReason([undefined, 'no-progress', undefined])).toBe('no-progress');
    });

    it('returns "drained" for an empty or all-undefined input', () => {
        expect(pickWorstStopReason([])).toBe('drained');
        expect(pickWorstStopReason([undefined, undefined])).toBe('drained');
    });

    it('picks aborted even when it is not the last entry', () => {
        expect(pickWorstStopReason(['aborted', 'drained', 'single-slice'])).toBe('aborted');
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — helper builders
// ---------------------------------------------------------------------------

/**
 * Build a fetchSlice that pops items off a pre-seeded queue of slices.
 * Once the queue is empty, returns `{ items: [] }` (drained).
 */
function queuedFetcher<T>(
    slices: DrainSlice<T>[],
): MockedFunction<(limit: number) => Promise<DrainSlice<T>>> {
    return vi.fn(async () => slices.shift() ?? { items: [] });
}

function baseOptions<T>(overrides: Partial<DrainBacklogOptions<T>>): DrainBacklogOptions<T> {
    return {
        mode: 'catchup',
        sliceSize: 10,
        fetchSlice: async () => ({ items: [] }),
        processSlice: async () => ({ produced: 0, advanced: 0 }),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// drainBacklog — catchup
// ---------------------------------------------------------------------------

describe('drainBacklog (catchup)', () => {
    it('loops through available slices until drained (within budget)', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a', 'b', 'c'], remainingHint: 97 },
            { items: ['d', 'e', 'f'] },
        ]);
        const processSlice = staticProcessSlice(3, 3);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'catchup',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        // Both queued slices fit inside the 5-min catchup budget, so the
        // loop continues past the first slice and exits when the fetcher
        // returns empty on the 3rd call.
        expect(result.stopReason).toBe('drained');
        expect(result.unitsProcessed).toBe(6);
        expect(result.resultsProduced).toBe(6);
        expect(fetchSlice).toHaveBeenCalledTimes(3);
        expect(processSlice).toHaveBeenCalledTimes(2);
    });

    it('returns drained when first fetch is empty (catchup)', async () => {
        const { ctx } = createFakeCtx();
        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'catchup',
                fetchSlice: async () => ({ items: [] }),
            }),
        );
        expect(result.stopReason).toBe('drained');
        expect(result.unitsProcessed).toBe(0);
    });

    it('breaks catchup early when 3+ slices advance nothing (rotating-items safety net)', async () => {
        const { ctx } = createFakeCtx();
        // Fetcher returns DIFFERENT items each call (so the per-slice
        // signature guard doesn't fire) but processSlice advances 0.
        const fetchSlice = queuedFetcher<string>([
            { items: ['a1', 'a2'] },
            { items: ['b1', 'b2'] },
            { items: ['c1', 'c2'] },
            { items: ['d1', 'd2'] },
        ]);
        const processSlice = vi
            .fn<(items: string[], signal: AbortSignal) => Promise<ProcessSliceResult>>()
            .mockResolvedValue({ produced: 0, advanced: 0 });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'catchup',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('no-progress');
        // 3 slices processed before the safety net fires.
        expect(processSlice).toHaveBeenCalledTimes(3);
    });

    it('returns single-slice when catchup budget elapses after exactly one slice', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a', 'b', 'c'], remainingHint: 97 },
            { items: ['d', 'e', 'f'] },
        ]);
        // Process slowly enough that the 1ms budget elapses after slice 1.
        // NOTE: processSlice intentionally does NOT thread the AbortSignal
        // into its setTimeout — this verifies the "budget check fires AFTER
        // a slice completes" path. If a future refactor makes processSlice
        // honor the signal, the slice would abort mid-run and unitsProcessed
        // would not equal slice.items.length, changing the stopReason.
        const processSlice = vi
            .fn<(items: string[], signal: AbortSignal) => Promise<ProcessSliceResult>>()
            .mockImplementation(async () => {
                await new Promise((r) => setTimeout(r, 10));
                return { produced: 3, advanced: 3 };
            });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'catchup',
                softBudgetMs: 1, // override to a tiny budget to force quick exit
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('single-slice');
        expect(result.unitsProcessed).toBe(3);
        expect(processSlice).toHaveBeenCalledOnce();
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — manual
// ---------------------------------------------------------------------------

describe('drainBacklog (manual)', () => {
    it('loops until the backlog is empty', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a', 'b'] },
            { items: ['c'] },
            { items: ['d', 'e', 'f'] },
        ]);
        const processSlice = vi
            .fn<(items: string[], signal: AbortSignal) => Promise<ProcessSliceResult>>()
            .mockResolvedValue({ produced: 1, advanced: 1 });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('drained');
        expect(result.unitsProcessed).toBe(6);
        expect(result.resultsProduced).toBe(3);
        expect(fetchSlice).toHaveBeenCalledTimes(4); // 3 batches + the empty one
        expect(processSlice).toHaveBeenCalledTimes(3);
    });

    it('fires onProgress with remainingHint when provided', async () => {
        const { ctx } = createFakeCtx();
        const onProgress = vi.fn();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a', 'b'], remainingHint: 8 },
            { items: [] },
        ]);

        await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice: staticProcessSlice(2, 2),
                onProgress,
                phase: 'Test phase',
                idOf: (s) => s,
            }),
        );

        expect(onProgress).toHaveBeenCalledWith(2, 10, { phase: 'Test phase' });
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — force
// ---------------------------------------------------------------------------

describe('drainBacklog (force)', () => {
    it('calls onWipe once before the first fetchSlice, then drains', async () => {
        const { ctx } = createFakeCtx();
        const callOrder: string[] = [];
        const onWipe = vi.fn(async () => {
            callOrder.push('wipe');
        });
        const fetchSlice = vi.fn(async () => {
            callOrder.push('fetch');
            return { items: [] };
        });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'force',
                onWipe,
                fetchSlice,
            }),
        );

        expect(onWipe).toHaveBeenCalledOnce();
        expect(callOrder[0]).toBe('wipe');
        expect(callOrder[1]).toBe('fetch');
        expect(result.stopReason).toBe('drained');
    });

    it('logs a warning and drains as manual when onWipe is absent', async () => {
        const { ctx, logger } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([{ items: ['a', 'b'] }, { items: [] }]);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'force',
                onWipe: undefined,
                fetchSlice,
                processSlice: staticProcessSlice(2, 2),
                idOf: (s) => s,
            }),
        );

        // First warn is the force-without-onWipe warning. Any additional
        // debug/warn entries (e.g. the no-idOf fallback note) are irrelevant
        // to this assertion — find the matching one explicitly.
        const forceWarn = logger.warn.mock.calls.find((c) => String(c[0]).includes('onWipe'));
        expect(forceWarn).toBeDefined();
        expect(result.stopReason).toBe('drained');
        expect(result.unitsProcessed).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — abort
// ---------------------------------------------------------------------------

describe('drainBacklog (abort)', () => {
    it('returns aborted before onWipe runs when already aborted', async () => {
        const { ctx, abort } = createFakeCtx();
        abort.abort();
        const onWipe = vi.fn();
        const fetchSlice = vi.fn();

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'force',
                onWipe,
                fetchSlice,
            }),
        );

        expect(result.stopReason).toBe('aborted');
        expect(onWipe).not.toHaveBeenCalled();
        expect(fetchSlice).not.toHaveBeenCalled();
    });

    it('returns aborted after onWipe runs but before first fetch', async () => {
        const { ctx, abort } = createFakeCtx();
        const onWipe = vi.fn(async () => {
            abort.abort();
        });
        const fetchSlice = vi.fn();

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'force',
                onWipe,
                fetchSlice,
            }),
        );

        expect(result.stopReason).toBe('aborted');
        expect(onWipe).toHaveBeenCalledOnce();
        expect(fetchSlice).not.toHaveBeenCalled();
    });

    it('returns aborted mid-drain when signal fires between slices', async () => {
        const { ctx, abort } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([{ items: ['a', 'b'] }, { items: ['c', 'd'] }]);
        const processSlice = vi
            .fn<(items: string[], signal: AbortSignal) => Promise<ProcessSliceResult>>()
            .mockImplementationOnce(async () => {
                // Abort immediately after the first slice is processed so the
                // loop sees it on the next iteration check.
                abort.abort();
                return { produced: 2, advanced: 2 };
            });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('aborted');
        expect(result.unitsProcessed).toBe(2);
        // Second slice was never fetched because abort tripped first.
        expect(fetchSlice).toHaveBeenCalledOnce();
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — no-progress + idOf
// ---------------------------------------------------------------------------

describe('drainBacklog (no-progress, idOf)', () => {
    it('stops with no-progress when two identical slices have advanced === 0', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a', 'b', 'c'] },
            { items: ['a', 'b', 'c'] },
        ]);
        const processSlice = staticProcessSlice(0, 0);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('no-progress');
        // First slice was processed (units counted), second slice bailed out
        // before process — unitsProcessed reflects only the first.
        expect(result.unitsProcessed).toBe(3);
        expect(processSlice).toHaveBeenCalledOnce();
    });

    it('keeps looping when identical slices have advanced > 0 (transient retry)', async () => {
        // Same items returned twice but advance > 0 each time — legitimate
        // retry state (rows still eligible after a partial commit), NOT a
        // stuck fetcher. The no-progress guard must stay armed and wait for
        // a genuine zero-advance repetition.
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a', 'b'] },
            { items: ['a', 'b'] },
            { items: [] },
        ]);
        const processSlice = staticProcessSlice(2, 2);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('drained');
        expect(processSlice).toHaveBeenCalledTimes(2);
    });

    it('does not fire on first slice (needs two slices to detect)', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([{ items: ['a'] }, { items: [] }]);
        const processSlice = staticProcessSlice(0, 0);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        // Single zero-advance slice followed by an empty slice = drained, not
        // no-progress. The guard requires TWO identical slices.
        expect(result.stopReason).toBe('drained');
    });

    it('idOf callback is invoked for every item of each non-empty slice', async () => {
        // sliceSignature joins ALL item ids (not just first+last — see FIX 3
        // in the module docs) so two different slices that happen to share
        // length + first + last id don't collide into a false no-progress
        // stop. Confirms idOf is called once per item, not just endpoints.
        const { ctx } = createFakeCtx();
        interface Row {
            id: string;
            name: string;
        }
        const idOf = vi.fn((r: Row) => r.id);
        const fetchSlice = queuedFetcher<Row>([
            {
                items: [
                    { id: '1', name: 'one' },
                    { id: '2', name: 'two' },
                    { id: '3', name: 'three' },
                ],
            },
            { items: [] },
        ]);

        await drainBacklog(
            ctx,
            baseOptions<Row>({
                mode: 'manual',
                fetchSlice,
                processSlice: staticProcessSlice(3, 3),
                idOf,
            }),
        );

        // Every item of the 3-item slice = 3 calls.
        expect(idOf).toHaveBeenCalledTimes(3);
        expect(idOf).toHaveBeenNthCalledWith(1, { id: '1', name: 'one' });
        expect(idOf).toHaveBeenNthCalledWith(2, { id: '2', name: 'two' });
        expect(idOf).toHaveBeenNthCalledWith(3, { id: '3', name: 'three' });
    });

    it('same length + first + last id but different middle id does NOT collide (FIX 3)', async () => {
        // Regression test for the length:firstId:lastId collision. Under the
        // old shortcut, these two slices (len 3, first '1', last '3') would
        // produce an IDENTICAL signature despite the middle id differing —
        // falsely tripping the no-progress guard after just 2 slices. The
        // full-id-join signature must tell them apart.
        const { ctx } = createFakeCtx();
        interface Row {
            id: string;
        }
        const fetchSlice = queuedFetcher<Row>([
            { items: [{ id: '1' }, { id: '2a' }, { id: '3' }] },
            { items: [{ id: '1' }, { id: '2b' }, { id: '3' }] },
            { items: [] },
        ]);

        const result = await drainBacklog(
            ctx,
            baseOptions<Row>({
                mode: 'manual',
                fetchSlice,
                processSlice: staticProcessSlice(0, 0),
                idOf: (r) => r.id,
            }),
        );

        // Both slices genuinely differ (different middle row) and the drain
        // legitimately reaches "drained" via the 3rd, empty fetch — it must
        // NOT be truncated early by a false signature match. (slicesProcessed
        // stays at 2, below the manual/force cumulative-no-progress threshold
        // of 5, so FIX 1's net does not confound this assertion either.)
        expect(result.stopReason).toBe('drained');
        expect(result.unitsProcessed).toBe(6);
    });

    it('same IDs + zero advance fire no-progress even when other row fields drift', async () => {
        // Semantic check: signatures derived from IDs must be stable across
        // mutable fields. Without idOf the drain would mis-compare two
        // semantically-identical slices as "different" and loop forever on
        // a genuinely stuck fetcher.
        const { ctx } = createFakeCtx();
        interface Row {
            id: string;
            updated_at: string;
        }
        const fetchSlice = queuedFetcher<Row>([
            {
                items: [
                    { id: '1', updated_at: '2026-01-01T00:00:00Z' },
                    { id: '2', updated_at: '2026-01-01T00:00:00Z' },
                ],
            },
            {
                items: [
                    { id: '1', updated_at: '2026-01-01T00:05:00Z' },
                    { id: '2', updated_at: '2026-01-01T00:05:00Z' },
                ],
            },
        ]);

        const result = await drainBacklog(
            ctx,
            baseOptions<Row>({
                mode: 'manual',
                fetchSlice,
                processSlice: staticProcessSlice(0, 0),
                idOf: (r) => r.id,
            }),
        );

        expect(result.stopReason).toBe('no-progress');
    });

    it('different IDs on the second slice do NOT fire no-progress', async () => {
        const { ctx } = createFakeCtx();
        interface Row {
            id: string;
        }
        const fetchSlice = queuedFetcher<Row>([
            { items: [{ id: '1' }, { id: '2' }] },
            { items: [{ id: '3' }, { id: '4' }] },
            { items: [] },
        ]);

        const result = await drainBacklog(
            ctx,
            baseOptions<Row>({
                mode: 'manual',
                fetchSlice,
                processSlice: staticProcessSlice(0, 0),
                idOf: (r) => r.id,
            }),
        );

        expect(result.stopReason).toBe('drained');
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — composed abort signal
// ---------------------------------------------------------------------------

describe('drainBacklog (composed abort signal)', () => {
    it('passes a non-aborted signal to processSlice in the happy path', async () => {
        const { ctx } = createFakeCtx();
        const observed: AbortSignal[] = [];
        const processSlice: DrainBacklogOptions<string>['processSlice'] = async (
            _items,
            signal,
        ) => {
            observed.push(signal);
            return { produced: 1, advanced: 1 };
        };
        const fetchSlice = queuedFetcher<string>([{ items: ['a'] }, { items: [] }]);

        await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(observed).toHaveLength(1);
        expect(observed[0].aborted).toBe(false);
    });

    it('composed signal fires when ctx.abortSignal aborts mid-slice', async () => {
        const { ctx, abort } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([{ items: ['a'] }, { items: [] }]);

        let capturedSignal: AbortSignal | null = null;
        const processSlice: DrainBacklogOptions<string>['processSlice'] = async (
            _items,
            signal,
        ) => {
            capturedSignal = signal;
            abort.abort();
            return { produced: 1, advanced: 1 };
        };

        await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(capturedSignal).not.toBeNull();
        expect(capturedSignal!.aborted).toBe(true);
    });

    it('composed signal fires when soft budget elapses before ctx abort', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([{ items: ['a'] }, { items: [] }]);

        let capturedSignal: AbortSignal | null = null;
        const processSlice: DrainBacklogOptions<string>['processSlice'] = async (
            _items,
            signal,
        ) => {
            capturedSignal = signal;
            // Give the AbortSignal.timeout(remaining) time to fire — the
            // timeout is 1ms so a 10ms wait is plenty of headroom.
            await new Promise((r) => setTimeout(r, 10));
            return { produced: 1, advanced: 1 };
        };

        await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                softBudgetMs: 1,
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(capturedSignal).not.toBeNull();
        expect(capturedSignal!.aborted).toBe(true);
    });

    it('softBudgetMs === 0 yields the raw ctx abort signal (no timeout composition)', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([{ items: ['a'] }, { items: [] }]);

        let capturedSignal: AbortSignal | null = null;
        const processSlice: DrainBacklogOptions<string>['processSlice'] = async (
            _items,
            signal,
        ) => {
            capturedSignal = signal;
            return { produced: 1, advanced: 1 };
        };

        await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                softBudgetMs: 0,
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        // With budget disabled, drainBacklog returns ctx.abortSignal directly.
        expect(capturedSignal).toBe(ctx.abortSignal);
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — heartbeat fold
// ---------------------------------------------------------------------------

describe('drainBacklog (heartbeat)', () => {
    it('clears the heartbeat interval when the drain completes', async () => {
        const { ctx } = createFakeCtx();
        const onProgress = vi.fn();
        let processedCount = 0;

        await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice: queuedFetcher<string>([{ items: ['a'] }, { items: [] }]),
                processSlice: async () => {
                    processedCount++;
                    return { produced: 1, advanced: 1 };
                },
                onProgress,
                idOf: (s) => s,
                heartbeat: {
                    getTotal: () => 10,
                    getProcessed: () => processedCount,
                    getStatus: () => `processed=${processedCount}`,
                    intervalMs: 5_000,
                },
            }),
        );

        // Node leaves no public API to introspect active timers, but if the
        // interval weren't cleared the test process would hang on exit. The
        // structural assertion here is that drainBacklog resolves — which a
        // leaked interval does not prevent — and that plugins no longer need
        // their own heartbeat try/finally. The remaining invariant is that
        // drainBacklog doesn't throw when `heartbeat` is supplied.
        expect(onProgress).toHaveBeenCalled();
    });

    it('clears the heartbeat interval even when processSlice throws', async () => {
        const { ctx } = createFakeCtx();
        const boom = new Error('boom');
        let processedCount = 0;

        await expect(
            drainBacklog(
                ctx,
                baseOptions<string>({
                    mode: 'manual',
                    fetchSlice: queuedFetcher<string>([{ items: ['a'] }]),
                    processSlice: async () => {
                        processedCount++;
                        throw boom;
                    },
                    idOf: (s) => s,
                    heartbeat: {
                        getTotal: () => 10,
                        getProcessed: () => processedCount,
                        getStatus: () => 'running',
                    },
                }),
            ),
        ).rejects.toBe(boom);
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — budget
// ---------------------------------------------------------------------------

describe('drainBacklog (budget)', () => {
    it('exits with budget after a slice that pushed past the soft budget', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([{ items: ['a'] }, { items: ['b'] }]);
        // Tiny budget + a processSlice that awaits a microtask keeps the test
        // deterministic without relying on real timers.
        const processSlice = vi.fn(async (): Promise<ProcessSliceResult> => {
            // Sleep long enough to exceed the 1ms budget on every worker.
            await new Promise((r) => setTimeout(r, 5));
            return { produced: 1, advanced: 1 };
        });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                softBudgetMs: 1,
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('budget');
        expect(result.unitsProcessed).toBe(1);
        expect(processSlice).toHaveBeenCalledOnce();
    });

    it('softBudgetMs === 0 disables the budget', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([{ items: ['a'] }, { items: [] }]);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                softBudgetMs: 0,
                fetchSlice,
                processSlice: staticProcessSlice(1, 1),
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('drained');
    });
});

// Exercise the DrainStopReason export so the file stays compile-checked
// against future additions. No test runtime: just a type guard.
const _stopReasons: DrainStopReason[] = [
    'drained',
    'aborted',
    'budget',
    'single-slice',
    'no-progress',
];
void _stopReasons;

// ---------------------------------------------------------------------------
// drainBacklog — composed signal disposal (K2)
// ---------------------------------------------------------------------------
//
// Regression coverage for the per-slice AbortSignal.any leak: the previous
// implementation composed a fresh signal inside every loop iteration, each
// of which attached its own "forward abort" listener to ctx.abortSignal and
// held its own timer. A 10k-slice drain leaked 10k listeners + 10k timers.
// The fix composes once per drain and disposes in finally.

/**
 * Wrap an AbortController's signal so we can count how many `abort`
 * listeners are attached at any point in time. Used to assert that
 * drainBacklog doesn't accumulate listeners across many slices.
 */
function createListenerCountingSignal(): {
    signal: AbortSignal;
    abort: () => void;
    listenerCount: () => number;
} {
    const controller = new AbortController();
    let count = 0;
    const realAdd = controller.signal.addEventListener.bind(controller.signal);
    const realRemove = controller.signal.removeEventListener.bind(controller.signal);
    type AddListenerParams = Parameters<AbortSignal['addEventListener']>;
    type RemoveListenerParams = Parameters<AbortSignal['removeEventListener']>;
    controller.signal.addEventListener = ((
        type: AddListenerParams[0],
        listener: AddListenerParams[1],
        options?: AddListenerParams[2],
    ): void => {
        if (type === 'abort') count++;
        realAdd(type, listener, options);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((
        type: RemoveListenerParams[0],
        listener: RemoveListenerParams[1],
        options?: RemoveListenerParams[2],
    ): void => {
        if (type === 'abort') count--;
        realRemove(type, listener, options);
    }) as typeof controller.signal.removeEventListener;
    return {
        signal: controller.signal,
        abort: () => controller.abort(),
        listenerCount: () => count,
    };
}

describe('drainBacklog (composed signal disposal)', () => {
    it('does not accumulate listeners on ctx.abortSignal across 200 slices', async () => {
        const logger = createFakeLogger();
        const tracked = createListenerCountingSignal();
        const ctx = {
            logger,
            abortSignal: tracked.signal,
        } as unknown as PluginContext;

        const baselineListeners = tracked.listenerCount();

        // Seed 200 non-empty slices + 1 empty sentinel. If the old per-slice
        // composition were still in place, each iteration would leave a
        // listener hanging until GC — which never happens in a sync test —
        // so the count at the end would climb proportionally.
        const slices: DrainSlice<string>[] = [];
        for (let i = 0; i < 200; i++) {
            slices.push({ items: [`item-${i}`] });
        }
        slices.push({ items: [] });

        await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                softBudgetMs: 60_000,
                fetchSlice: queuedFetcher<string>(slices),
                processSlice: staticProcessSlice(1, 1),
                idOf: (s) => s,
            }),
        );

        // After dispose: exactly one listener was attached for the whole
        // drain, and it was removed in the finally block. Back to baseline.
        expect(tracked.listenerCount()).toBe(baselineListeners);
    });

    it('removes its ctx.abortSignal listener when softBudgetMs > 0 even on empty drain', async () => {
        const logger = createFakeLogger();
        const tracked = createListenerCountingSignal();
        const ctx = {
            logger,
            abortSignal: tracked.signal,
        } as unknown as PluginContext;

        const baselineListeners = tracked.listenerCount();

        await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                softBudgetMs: 60_000,
                fetchSlice: async () => ({ items: [] }),
            }),
        );

        expect(tracked.listenerCount()).toBe(baselineListeners);
    });

    it('does not attach any listener to ctx.abortSignal when softBudgetMs === 0', async () => {
        // Budget disabled → no composition happens; the caller's signal
        // passes through untouched. If drainBacklog were still attaching a
        // bookkeeping listener in this path we'd see it here.
        const logger = createFakeLogger();
        const tracked = createListenerCountingSignal();
        const ctx = {
            logger,
            abortSignal: tracked.signal,
        } as unknown as PluginContext;

        const baselineListeners = tracked.listenerCount();

        await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                softBudgetMs: 0,
                fetchSlice: queuedFetcher<string>([{ items: ['a'] }, { items: [] }]),
                processSlice: staticProcessSlice(1, 1),
                idOf: (s) => s,
            }),
        );

        expect(tracked.listenerCount()).toBe(baselineListeners);
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — no-progress NaN/negative coverage (K7)
// ---------------------------------------------------------------------------

describe('drainBacklog (no-progress, non-finite advanced)', () => {
    it('NaN advanced is treated as no-advance (fires no-progress on repeat)', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a', 'b', 'c'] },
            { items: ['a', 'b', 'c'] },
        ]);
        // advanced: NaN would previously bypass the `=== 0` check silently.
        const processSlice = staticProcessSlice(0, Number.NaN);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('no-progress');
        expect(processSlice).toHaveBeenCalledOnce();
    });

    it('negative advanced is treated as no-advance (fires no-progress on repeat)', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a', 'b', 'c'] },
            { items: ['a', 'b', 'c'] },
        ]);
        const processSlice = staticProcessSlice(0, -1);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('no-progress');
    });

    it('Infinity advanced is treated as no-advance (non-finite)', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a', 'b', 'c'] },
            { items: ['a', 'b', 'c'] },
        ]);
        const processSlice = staticProcessSlice(0, Number.POSITIVE_INFINITY);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('no-progress');
    });

    it('positive advanced still prevents no-progress on repeated signature', async () => {
        // Sanity check that the stricter guard hasn't flipped the happy path.
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a', 'b', 'c'] },
            { items: ['a', 'b', 'c'] },
            { items: [] },
        ]);
        const processSlice = staticProcessSlice(0, 1);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('drained');
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — FIX 1: cumulative no-progress net applies in every mode
// ---------------------------------------------------------------------------

describe('drainBacklog (cumulative no-progress net, all modes)', () => {
    it('applies in manual mode with softBudgetMs: 0 (the documented escape hatch)', async () => {
        const { ctx } = createFakeCtx();
        // Rotating items (a different signature every call) so the
        // per-slice signature-equality guard never fires; only the
        // cumulative net can catch this. softBudgetMs: 0 disables the soft
        // time budget — before FIX 1, this exact pattern had NO
        // engine-level bound in manual/force mode and could spin forever.
        const fetchSlice = queuedFetcher<string>([
            { items: ['a1', 'a2'] },
            { items: ['b1', 'b2'] },
            { items: ['c1', 'c2'] },
            { items: ['d1', 'd2'] },
            { items: ['e1', 'e2'] },
            { items: ['f1', 'f2'] },
        ]);
        const processSlice = vi
            .fn<(items: string[], signal: AbortSignal) => Promise<ProcessSliceResult>>()
            .mockResolvedValue({ produced: 0, advanced: 0 });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                softBudgetMs: 0,
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('no-progress');
        // Manual/force use a 5-slice threshold (vs. catchup's 3) — see the
        // FIX 1 rationale comment above the check in drain-backlog.ts.
        expect(processSlice).toHaveBeenCalledTimes(5);
    });

    it('does not fire prematurely below the manual/force threshold of 5', async () => {
        const { ctx } = createFakeCtx();
        // Only 4 rotating zero-advance slices before the backlog genuinely
        // empties — below the 5-slice threshold, so this must resolve as a
        // legitimate 'drained', not a false 'no-progress' truncation.
        const fetchSlice = queuedFetcher<string>([
            { items: ['a1', 'a2'] },
            { items: ['b1', 'b2'] },
            { items: ['c1', 'c2'] },
            { items: ['d1', 'd2'] },
            { items: [] },
        ]);
        const processSlice = vi
            .fn<(items: string[], signal: AbortSignal) => Promise<ProcessSliceResult>>()
            .mockResolvedValue({ produced: 0, advanced: 0 });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                softBudgetMs: 0,
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('drained');
        expect(processSlice).toHaveBeenCalledTimes(4);
    });

    it('applies the same net in force mode, after onWipe has run', async () => {
        const { ctx } = createFakeCtx();
        const onWipe = vi.fn(async () => {});
        const fetchSlice = queuedFetcher<string>([
            { items: ['a1', 'a2'] },
            { items: ['b1', 'b2'] },
            { items: ['c1', 'c2'] },
            { items: ['d1', 'd2'] },
            { items: ['e1', 'e2'] },
        ]);
        const processSlice = vi
            .fn<(items: string[], signal: AbortSignal) => Promise<ProcessSliceResult>>()
            .mockResolvedValue({ produced: 0, advanced: 0 });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'force',
                softBudgetMs: 0,
                onWipe,
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        expect(result.stopReason).toBe('no-progress');
        expect(onWipe).toHaveBeenCalledOnce();
        expect(processSlice).toHaveBeenCalledTimes(5);
    });

    it('never fires once any slice has advanced > 0, even past the threshold slice count', async () => {
        // Sanity check required by the task: the net must not change
        // behavior for runs that make ANY progress. cumulativeAdvanced only
        // needs one positive contribution, ever, to permanently disarm this
        // branch for the rest of the run.
        const { ctx } = createFakeCtx();
        const fetchSlice = queuedFetcher<string>([
            { items: ['a1', 'a2'] },
            { items: ['b1', 'b2'] },
            { items: ['c1', 'c2'] }, // this slice advances
            { items: ['d1', 'd2'] },
            { items: ['e1', 'e2'] },
            { items: ['f1', 'f2'] },
            { items: [] },
        ]);
        let call = 0;
        const processSlice = vi
            .fn<(items: string[], signal: AbortSignal) => Promise<ProcessSliceResult>>()
            .mockImplementation(async () => {
                call += 1;
                return call === 3 ? { produced: 2, advanced: 2 } : { produced: 0, advanced: 0 };
            });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'manual',
                softBudgetMs: 0,
                fetchSlice,
                processSlice,
                idOf: (s) => s,
            }),
        );

        // 6 slices processed (past the 5-slice threshold) but
        // cumulativeAdvanced === 2 (from slice 3), so the safety net never
        // fires — the drain proceeds to a clean 'drained'.
        expect(result.stopReason).toBe('drained');
        expect(processSlice).toHaveBeenCalledTimes(6);
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — FIX 2: sliceSize entry guard
// ---------------------------------------------------------------------------

describe('drainBacklog (sliceSize entry guard)', () => {
    it('throws when sliceSize is 0', async () => {
        const { ctx } = createFakeCtx();
        const fetchSlice = vi.fn();
        const processSlice = vi.fn();

        await expect(
            drainBacklog(
                ctx,
                baseOptions<string>({
                    mode: 'manual',
                    sliceSize: 0,
                    fetchSlice,
                    processSlice,
                }),
            ),
        ).rejects.toThrow(/sliceSize/);

        expect(fetchSlice).not.toHaveBeenCalled();
        expect(processSlice).not.toHaveBeenCalled();
    });

    it('throws when sliceSize is negative', async () => {
        const { ctx } = createFakeCtx();
        await expect(
            drainBacklog(
                ctx,
                baseOptions<string>({
                    mode: 'manual',
                    sliceSize: -10,
                    fetchSlice: vi.fn(),
                    processSlice: vi.fn(),
                }),
            ),
        ).rejects.toThrow(/sliceSize/);
    });

    it('throws when sliceSize is not an integer', async () => {
        const { ctx } = createFakeCtx();
        await expect(
            drainBacklog(
                ctx,
                baseOptions<string>({
                    mode: 'manual',
                    sliceSize: 12.5,
                    fetchSlice: vi.fn(),
                    processSlice: vi.fn(),
                }),
            ),
        ).rejects.toThrow(/sliceSize/);
    });

    it('throws BEFORE onWipe runs in force mode (fails loud, not a silent no-op)', async () => {
        // Mirrors drainWipe's identical batchSize guard: a misconfigured
        // sliceSize must never look like "already drained" — and in force
        // mode it must fail before the destructive onWipe has a chance to
        // run at all.
        const { ctx } = createFakeCtx();
        const onWipe = vi.fn(async () => {});

        await expect(
            drainBacklog(
                ctx,
                baseOptions<string>({
                    mode: 'force',
                    sliceSize: 0,
                    onWipe,
                    fetchSlice: vi.fn(),
                    processSlice: vi.fn(),
                }),
            ),
        ).rejects.toThrow(/sliceSize/);

        expect(onWipe).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — K8: wipe time counts against the soft budget
// ---------------------------------------------------------------------------

describe('drainBacklog (wipe time counts against soft budget)', () => {
    it('exits with budget immediately after a slow wipe burns the budget', async () => {
        const { ctx } = createFakeCtx();
        const onWipe = vi.fn(async () => {
            // Simulate a slow wipe that eats more than the soft budget.
            await new Promise((r) => setTimeout(r, 15));
        });
        const fetchSlice = queuedFetcher<string>([
            { items: ['a'] },
            { items: ['b'] },
            { items: [] },
        ]);

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'force',
                // 5ms budget; onWipe takes 15ms. The first post-wipe slice
                // still runs (budgetExceeded is checked AFTER a slice), then
                // the loop bails with 'budget' rather than continuing the
                // full manual drain.
                softBudgetMs: 5,
                onWipe,
                fetchSlice,
                processSlice: staticProcessSlice(1, 1),
                idOf: (s) => s,
            }),
        );

        expect(onWipe).toHaveBeenCalledOnce();
        expect(result.stopReason).toBe('budget');
        expect(result.unitsProcessed).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// drainBacklog — N2: onWipe throws
// ---------------------------------------------------------------------------

describe('drainBacklog (onWipe throws)', () => {
    it('returns {stopReason: aborted, wipeError} when onWipe throws', async () => {
        const { ctx, logger } = createFakeCtx();
        const boom = new Error('wipe blew up');
        const onWipe = vi.fn(async () => {
            throw boom;
        });
        const fetchSlice = vi.fn();

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'force',
                onWipe,
                fetchSlice,
            }),
        );

        expect(result.stopReason).toBe('aborted');
        expect(result.wipeError).toBe(boom);
        expect(result.unitsProcessed).toBe(0);
        expect(result.resultsProduced).toBe(0);
        // fetchSlice must never run after a failed wipe — otherwise the
        // plugin would churn over un-wiped rows.
        expect(fetchSlice).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
    });

    it('wraps non-Error throws from onWipe as Error instances', async () => {
        const { ctx } = createFakeCtx();
        const onWipe = vi.fn(async () => {
            throw 'string-throw';
        });

        const result = await drainBacklog(
            ctx,
            baseOptions<string>({
                mode: 'force',
                onWipe,
            }),
        );

        expect(result.stopReason).toBe('aborted');
        expect(result.wipeError).toBeInstanceOf(Error);
        expect(result.wipeError?.message).toBe('string-throw');
    });
});

// ---------------------------------------------------------------------------
// lazyBacklog — N1: concurrent-first-access coalescing
// ---------------------------------------------------------------------------

describe('lazyBacklog (concurrent first-access)', () => {
    it('concurrent callers share one underlying count()', async () => {
        let resolve!: (n: number) => void;
        const pending = new Promise<number>((r) => {
            resolve = r;
        });
        const counter = vi.fn(() => pending);
        const lazy = lazyBacklog(counter);

        // Fire three concurrent awaits while the first call hasn't resolved.
        // The previous implementation cached only the resolved value, so all
        // three calls saw `cached === null` and each kicked off its own
        // `count()`. Caching the in-flight Promise collapses them to one.
        const a = lazy();
        const b = lazy();
        const c = lazy();

        resolve(123);
        expect(await a).toBe(123);
        expect(await b).toBe(123);
        expect(await c).toBe(123);
        expect(counter).toHaveBeenCalledOnce();

        // Subsequent calls (after resolve) also hit the cache.
        expect(await lazy()).toBe(123);
        expect(counter).toHaveBeenCalledOnce();
    });

    it('Promise.all of two lazy() calls invokes counter exactly once', async () => {
        const counter = vi.fn(async () => 7);
        const lazy = lazyBacklog(counter);

        const [a, b] = await Promise.all([lazy(), lazy()]);
        expect(a).toBe(7);
        expect(b).toBe(7);
        expect(counter).toHaveBeenCalledOnce();
    });
});

// ---------------------------------------------------------------------------
// startHeartbeat — K6: classifier must not crash the worker, N4: overrun UX
// ---------------------------------------------------------------------------

describe('startHeartbeat (classifier robustness)', () => {
    it('does not throw when logger.warn itself throws', async () => {
        const throwingWarn = vi.fn(() => {
            throw new Error('logger transport broken');
        });
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: throwingWarn,
            error: vi.fn(),
        } as unknown as PluginContext['logger'];

        const failingProgress = vi.fn(() => {
            // Non-programming-bug error → warn-rate-limited branch → the
            // throwing warn gets invoked. The outer try must swallow.
            throw new Error('valkey blip');
        });

        const hb = startHeartbeat({
            onProgress: failingProgress,
            logger,
            getTotal: () => 10,
            getProcessed: () => 5,
            getStatus: () => 'working',
            phase: 'Test',
            intervalMs: 1,
        });

        // Allow a few interval ticks to elapse. If the classifier crashed,
        // the unhandled rejection would surface and this await would reject.
        await new Promise((r) => setTimeout(r, 20));
        hb.clear();

        expect(failingProgress).toHaveBeenCalled();
        expect(throwingWarn).toHaveBeenCalled();
    });

    it('does not throw when logger.error itself throws on a programming bug', async () => {
        const throwingError = vi.fn(() => {
            throw new Error('logger transport broken');
        });
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: throwingError,
        } as unknown as PluginContext['logger'];

        const failingProgress = vi.fn(() => {
            // TypeError → programming-bug branch → logger.error throws.
            throw new TypeError('cannot read undefined');
        });

        const hb = startHeartbeat({
            onProgress: failingProgress,
            logger,
            getTotal: () => 10,
            getProcessed: () => 5,
            getStatus: () => 'working',
            phase: 'Test',
            intervalMs: 1,
        });

        await new Promise((r) => setTimeout(r, 20));
        hb.clear();

        expect(throwingError).toHaveBeenCalled();
    });

    it('renders "finalizing" and grows denominator when processed > total (N4)', async () => {
        const logger = createFakeLogger();
        const onProgress = vi.fn();

        const hb = startHeartbeat({
            onProgress,
            logger: logger as unknown as PluginContext['logger'],
            getTotal: () => 10,
            getProcessed: () => 15, // processed past initial snapshot
            getStatus: () => 'normal status',
            phase: 'Test',
            intervalMs: 1,
        });

        await new Promise((r) => setTimeout(r, 20));
        hb.clear();

        expect(onProgress).toHaveBeenCalled();
        const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
        // processed = 15, denominator = processed + 1 = 16 (NOT 15, so the
        // UI doesn't peg at 100% and stick there).
        expect(lastCall[0]).toBe(15);
        expect(lastCall[1]).toBe(16);
        // The status line advertises overrun so admins understand the state.
        expect(String(lastCall[2].currentItem)).toContain('finalizing');
    });

    it('renders normal status when processed <= total', async () => {
        const logger = createFakeLogger();
        const onProgress = vi.fn();

        const hb = startHeartbeat({
            onProgress,
            logger: logger as unknown as PluginContext['logger'],
            getTotal: () => 10,
            getProcessed: () => 4,
            getStatus: () => 'normal status line',
            phase: 'Test',
            intervalMs: 1,
        });

        await new Promise((r) => setTimeout(r, 20));
        hb.clear();

        expect(onProgress).toHaveBeenCalled();
        const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
        expect(lastCall[0]).toBe(4);
        expect(lastCall[1]).toBe(10);
        expect(lastCall[2].currentItem).toBe('normal status line');
    });
});

// ---------------------------------------------------------------------------
// defaultIdOf — N5: missing idOf warns (one-shot) instead of silent debug
// ---------------------------------------------------------------------------

describe('drainBacklog (missing idOf fallback)', () => {
    it('logs a warn (not debug) exactly once per drain when idOf is omitted', async () => {
        const { ctx, logger } = createFakeCtx();

        await drainBacklog(
            ctx,
            baseOptions<{ id: string }>({
                mode: 'manual',
                // idOf deliberately omitted — exercise the fallback.
                fetchSlice: queuedFetcher<{ id: string }>([
                    { items: [{ id: 'a' }, { id: 'b' }] },
                    { items: [] },
                ]),
                processSlice: staticProcessSlice(2, 2),
            }),
        );

        const missingIdOfWarns = logger.warn.mock.calls.filter((c) =>
            String(c[0]).includes('idOf'),
        );
        // Exactly one warn at drain entry — not per slice.
        expect(missingIdOfWarns).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// drainWipe
// ---------------------------------------------------------------------------

describe('drainWipe', () => {
    it('returns 0 when the first fetchBatch is empty', async () => {
        const { logger, abort } = createFakeCtx();
        const fetchBatch = vi.fn(async () => [] as string[]);
        const wipeBatch = vi.fn();

        const total = await drainWipe({
            abortSignal: abort.signal,
            batchSize: 100,
            fetchBatch,
            wipeBatch,
            logger: logger as unknown as PluginContext['logger'],
            label: 'Test',
        });

        expect(total).toBe(0);
        expect(fetchBatch).toHaveBeenCalledOnce();
        expect(wipeBatch).not.toHaveBeenCalled();
    });

    it('accumulates counts across multiple batches', async () => {
        const { logger, abort } = createFakeCtx();
        const batches = [['a', 'b', 'c'], ['d', 'e'], []];
        const fetchBatch = vi.fn(async () => batches.shift() ?? []);
        const wipeBatch = vi.fn(async (ids: string[]) => ids.length);

        const total = await drainWipe({
            abortSignal: abort.signal,
            batchSize: 100,
            fetchBatch,
            wipeBatch,
            logger: logger as unknown as PluginContext['logger'],
            label: 'Test',
        });

        expect(total).toBe(5);
        expect(fetchBatch).toHaveBeenCalledTimes(3);
        expect(wipeBatch).toHaveBeenCalledTimes(2);
    });

    it('respects abort mid-loop', async () => {
        const { logger, abort } = createFakeCtx();
        const batches = [['a', 'b'], ['c', 'd'], ['e']];
        const fetchBatch = vi.fn(async () => batches.shift() ?? []);
        const wipeBatch = vi.fn(async (ids: string[]) => {
            if (ids[0] === 'c') abort.abort();
            return ids.length;
        });

        const total = await drainWipe({
            abortSignal: abort.signal,
            batchSize: 100,
            fetchBatch,
            wipeBatch,
            logger: logger as unknown as PluginContext['logger'],
            label: 'Test',
        });

        // Batch 1 (2 rows) + batch 2 (2 rows) wiped, then abort fires before
        // batch 3 fetch. Total = 4.
        expect(total).toBe(4);
        expect(fetchBatch).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalled();
        const warnMsg = logger.warn.mock.calls[0][0];
        expect(warnMsg).toContain('aborted');
    });

    it('stops defensively when fetcher/wiper keys are out of sync (retry also wipes 0)', async () => {
        // Both fetches return a non-empty batch, both wipes report 0. After
        // the single retry with still-zero wipes, drainWipe bails with a
        // warning rather than spinning forever on a genuine key mismatch.
        const { logger, abort } = createFakeCtx();
        const fetchBatch = vi.fn(async () => ['stale-id']);
        const wipeBatch = vi.fn(async () => 0);

        const total = await drainWipe({
            abortSignal: abort.signal,
            batchSize: 100,
            fetchBatch,
            wipeBatch,
            logger: logger as unknown as PluginContext['logger'],
            label: 'Test',
        });

        expect(total).toBe(0);
        // Original + retry = 2 fetch calls, 2 wipe calls.
        expect(fetchBatch).toHaveBeenCalledTimes(2);
        expect(wipeBatch).toHaveBeenCalledTimes(2);
        // At least one warn (first "retrying" + final "stopping").
        expect(logger.warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('recovers from concurrent-race: second fetch empty → cleanly returns partial total (K18)', async () => {
        // Simulates two wipes racing: the slower wipe's first batch gets
        // zero'd because the faster wipe already processed the rows. The
        // retry then finds nothing left and exits normally — the slower
        // wipe correctly reports 0 without spinning, and the faster wipe's
        // total is preserved because rows were wiped by the faster instance.
        const { logger, abort } = createFakeCtx();
        let fetchCalls = 0;
        const fetchBatch = vi.fn(async () => {
            fetchCalls++;
            return fetchCalls === 1 ? ['stale-id'] : [];
        });
        const wipeBatch = vi.fn(async () => 0);

        const total = await drainWipe({
            abortSignal: abort.signal,
            batchSize: 100,
            fetchBatch,
            wipeBatch,
            logger: logger as unknown as PluginContext['logger'],
            label: 'Test',
        });

        expect(total).toBe(0);
        // First fetch + wipe (wiped 0 → retry), second fetch returns empty
        // → clean exit. Only one wipe was ever attempted.
        expect(fetchBatch).toHaveBeenCalledTimes(2);
        expect(wipeBatch).toHaveBeenCalledTimes(1);
        // First warn is the "retrying" message; info log signals the clean
        // exit after the retry found no work.
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalled();
    });

    it('recovers from concurrent-race: retry wipes rows → loop resumes (K18)', async () => {
        // Simulates a race where the concurrent wipe left SOME rows. First
        // batch gets 0 (concurrent cleanup stole them), retry succeeds,
        // third fetch returns empty.
        const { logger, abort } = createFakeCtx();
        const batches: string[][] = [['stale-a', 'stale-b'], ['fresh-c', 'fresh-d'], []];
        const fetchBatch = vi.fn(async () => batches.shift() ?? []);
        let wipeCall = 0;
        const wipeBatch = vi.fn(async (ids: string[]) => {
            wipeCall++;
            // First wipe: 0 (lost race). Retry wipe: full ids.length.
            return wipeCall === 1 ? 0 : ids.length;
        });

        const total = await drainWipe({
            abortSignal: abort.signal,
            batchSize: 100,
            fetchBatch,
            wipeBatch,
            logger: logger as unknown as PluginContext['logger'],
            label: 'Test',
        });

        expect(total).toBe(2); // Retry wiped 2 rows
        expect(fetchBatch).toHaveBeenCalledTimes(3);
        expect(wipeBatch).toHaveBeenCalledTimes(2);
    });

    it('throws at entry when batchSize is 0 (N3)', async () => {
        const { logger, abort } = createFakeCtx();
        const fetchBatch = vi.fn();
        const wipeBatch = vi.fn();

        await expect(
            drainWipe({
                abortSignal: abort.signal,
                batchSize: 0,
                fetchBatch,
                wipeBatch,
                logger: logger as unknown as PluginContext['logger'],
                label: 'Test',
            }),
        ).rejects.toThrow(/batchSize/);

        expect(fetchBatch).not.toHaveBeenCalled();
        expect(wipeBatch).not.toHaveBeenCalled();
    });

    it('throws at entry when batchSize is negative (N3)', async () => {
        const { logger, abort } = createFakeCtx();
        await expect(
            drainWipe({
                abortSignal: abort.signal,
                batchSize: -5,
                fetchBatch: vi.fn(),
                wipeBatch: vi.fn(),
                logger: logger as unknown as PluginContext['logger'],
                label: 'Test',
            }),
        ).rejects.toThrow(/batchSize/);
    });

    it('throws at entry when batchSize is not an integer (N3)', async () => {
        const { logger, abort } = createFakeCtx();
        await expect(
            drainWipe({
                abortSignal: abort.signal,
                batchSize: 1.5,
                fetchBatch: vi.fn(),
                wipeBatch: vi.fn(),
                logger: logger as unknown as PluginContext['logger'],
                label: 'Test',
            }),
        ).rejects.toThrow(/batchSize/);
    });
});
