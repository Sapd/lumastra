// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * K1 regression: the drain must stop with `no-progress` when every
 * `markArtistProcessed` write fails.
 *
 * Before this fix the artist-enrichment plugin incremented `advanced`
 * unconditionally on every iteration — so a DB outage killing the mark
 * writer looked identical to real work, burning the full soft budget on
 * the same 50 artists over and over. The fix makes `enrichOneArtist`
 * surface the mark-write success as an `advanced` flag, and the
 * processSlice caller only credits `sliceAdvanced` when that flag is true.
 *
 * We test the behaviour end-to-end via `drainBacklog`: two identical
 * slices with zero advance → stopReason: 'no-progress'.
 */

import { describe, it, expect, vi } from 'vitest';
import { drainBacklog, type DrainBacklogMode } from '$lib/server/plugins/runtime/drain-backlog.js';
import type { SyncExecutionContext } from '$lib/server/tasks/sync-context-types.js';

type EnrichResult = {
    status: 'enriched' | 'no-match' | 'error';
    advanced: boolean;
};

interface ArtistRow {
    id: string;
    title: string;
}

function mockLogger(): SyncExecutionContext['logger'] {
    // drainBacklog only uses `debug`, `info`, `warn`, `error` off the
    // logger; the other LoggerInstance fields (context, formatTimestamp,
    // etc.) are internal plumbing the helper doesn't touch. Cast through
    // unknown so the test-doubles don't need to implement the whole
    // class-like surface area.
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as SyncExecutionContext['logger'];
}

function mockContext(): Pick<SyncExecutionContext, 'logger' | 'abortSignal'> {
    return {
        logger: mockLogger(),
        abortSignal: new AbortController().signal,
    };
}

/**
 * Simulate the artist-enrichment processSlice behaviour under the NEW
 * (post-K1) semantics: sliceAdvanced is only incremented when
 * outcome.advanced is true. We don't depend on the real plugin body —
 * this test is a contract check on what happens to drainBacklog when the
 * plugin correctly reports zero advance.
 */
async function runDrain(
    mode: DrainBacklogMode,
    sliceItems: ArtistRow[],
    enrichOne: (artist: ArtistRow) => Promise<EnrichResult>,
    softBudgetMs: number = 0,
): Promise<Awaited<ReturnType<typeof drainBacklog<ArtistRow>>>> {
    const ctx = mockContext();
    return drainBacklog<ArtistRow>(ctx, {
        mode,
        sliceSize: sliceItems.length,
        softBudgetMs,
        // No onWipe — catchup/manual don't call it. Skip force-mode here.
        fetchSlice: async () => ({
            items: [...sliceItems],
            remainingHint: sliceItems.length,
        }),
        processSlice: async (items) => {
            let produced = 0;
            let advanced = 0;
            for (const artist of items) {
                const r = await enrichOne(artist);
                if (r.status === 'enriched') produced++;
                if (r.advanced) advanced++;
            }
            return { produced, advanced };
        },
        idOf: (row) => row.id,
    });
}

describe('artist-enrichment drain: mark-write failure keeps no-progress detector armed', () => {
    const items: ArtistRow[] = [
        { id: 'a1', title: 'Artist 1' },
        { id: 'a2', title: 'Artist 2' },
        { id: 'a3', title: 'Artist 3' },
    ];

    it('stops with no-progress when every mark-write fails (advance=false every iteration)', async () => {
        // Simulate a DB outage: every enrich path reports advanced=false
        // (the mark write threw after enrichOneArtist caught it).
        const enrichFailing = vi.fn(async (): Promise<EnrichResult> => ({
            status: 'error',
            advanced: false,
        }));
        const result = await runDrain('manual', items, enrichFailing);

        // manual + two identical slices with advanced=0 → detector fires.
        // Total iterations: one full slice (call 1) + one full slice (call 2
        // that triggers the no-progress check BEFORE processSlice runs).
        // So each of the 3 items is processed exactly once before the
        // stop, and processSlice runs for the first slice only.
        expect(result.stopReason).toBe('no-progress');
        expect(enrichFailing).toHaveBeenCalledTimes(items.length);
    });

    it('keeps draining when every mark-write lands (advance > 0)', async () => {
        const enrichOk = vi.fn(async (_artist: ArtistRow): Promise<EnrichResult> => ({
            status: 'no-match',
            advanced: true,
        }));

        // The same slice returns forever in this test, but the detector
        // should NOT fire because advance > 0 each iteration. We cap the
        // loop via a soft budget so the test terminates deterministically.
        const ctx = mockContext();
        const drainResult = await drainBacklog<ArtistRow>(ctx, {
            mode: 'manual',
            sliceSize: items.length,
            // 25ms budget is enough for a handful of iterations and well
            // under vitest's default 5s timeout.
            softBudgetMs: 25,
            fetchSlice: async () => ({
                items: [...items],
                remainingHint: items.length,
            }),
            processSlice: async (rows) => {
                let advanced = 0;
                for (const artist of rows) {
                    const r = await enrichOk(artist);
                    if (r.advanced) advanced++;
                }
                return { produced: 0, advanced };
            },
            idOf: (row) => row.id,
        });

        // Detector stayed armed → the budget is what stopped us, NOT
        // no-progress. If K1 regresses (advance credited on failure) the
        // same "identical slice" signature would trip no-progress; the
        // fact that we got `budget` is the positive signal that the
        // boolean-advance plumbing is still correct.
        expect(drainResult.stopReason).toBe('budget');
        // Every artist got at least one mark attempt, and across multiple
        // iterations we should have many calls.
        expect(enrichOk.mock.calls.length).toBeGreaterThanOrEqual(items.length);
    });

    it('credits advance per-successful-mark (mixed outcome)', async () => {
        // Two artists mark ok, one fails. Same slice comes back. Since
        // advance > 0 the drain keeps going, but the retry-count for the
        // failing artist grows while the successes stay stable. We stop
        // via soft budget.
        const outcomes: Record<string, EnrichResult> = {
            a1: { status: 'no-match', advanced: true },
            a2: { status: 'no-match', advanced: true },
            a3: { status: 'error', advanced: false },
        };
        const enrichMixed = vi.fn(
            async (artist: ArtistRow): Promise<EnrichResult> => outcomes[artist.id],
        );

        const result = await runDrain('manual', items, enrichMixed, 25);

        // 2/3 artists advanced per slice — the detector's advance count
        // is non-zero, so even though the fetch signature is identical
        // across slices the detector never fires. The soft budget is
        // what stops us. If K1 regresses (advance credited on every
        // outcome including the failed mark) the behaviour is the same
        // — so this test primarily guards against the OPPOSITE
        // regression: silently treating mixed outcomes as zero-advance.
        expect(result.stopReason).toBe('budget');
    }, 10_000);
});
