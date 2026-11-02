// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test for the "false-success" bug where a per-file 'error' outcome
 * vanished from the scan tally entirely.
 *
 * Before the fix, `processItems` did `if (outcome !== 'error') countOutcome(...)`
 * with no else branch — so an 'error' outcome (e.g. a stat/hash I/O failure that
 * was classified as an error) was neither counted as a success NOR recorded in
 * `result.errors`. A partially-broken scan therefore looked completely clean in
 * run history. This test locks in that an 'error' outcome is surfaced in
 * `result.errors` without inflating any success counter.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ScanResult } from '@sapd/lumastra-plugin-sdk';
import { assertScanProducedWorkOrThrow, processItems, recordWalkErrors } from './shared.js';
import type { FileScannerContext, ScanOutcome } from './shared.js';

function emptyResult(): ScanResult {
    return {
        added: 0,
        updated: 0,
        removed: 0,
        unmatched: 0,
        skipped: 0,
        durationMs: 0,
        errors: [],
    };
}

const context = {
    sql: {} as unknown,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as FileScannerContext;

describe('processItems — error outcomes surface in result.errors (false-success fix)', () => {
    it('records an error outcome in result.errors and does not count it as a success', async () => {
        const result = emptyResult();
        const processor = async (item: string): Promise<ScanOutcome | 'error'> =>
            item === '/broken.mkv' ? 'error' : 'added';

        await processItems(['/good.mkv', '/broken.mkv'], processor, result, context, () => false);

        // The good file counted as a real success…
        expect(result.added).toBe(1);
        // …and NONE of the success counters absorbed the error.
        expect(result.updated).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.unmatched).toBe(0);
        // The error outcome is no longer silently dropped.
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('/broken.mkv');
    });

    it('leaves non-error outcomes counted exactly as before (success path unchanged)', async () => {
        const result = emptyResult();
        const outcomes: Record<string, ScanOutcome> = {
            a: 'added',
            b: 'updated',
            c: 'skipped',
            d: 'unmatched',
        };

        await processItems(
            ['a', 'b', 'c', 'd'],
            async (k) => outcomes[k],
            result,
            context,
            () => false,
        );

        expect(result.added).toBe(1);
        expect(result.updated).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.unmatched).toBe(1);
        expect(result.errors).toHaveLength(0);
    });
});

describe('assertScanProducedWorkOrThrow — run-level failure on a 100%-error scan', () => {
    it('THROWS a transient TaskError when errors > 0 and no successful outcomes', () => {
        const result = emptyResult();
        result.errors.push('/a.mkv: processing failed', '/b.mkv: processing failed');
        // added+updated+skipped+unmatched all 0 → total I/O outage.
        expect(() => assertScanProducedWorkOrThrow(result, false)).toThrowError(
            expect.objectContaining({ name: 'TaskError', kind: 'transient' }),
        );
    });

    it('does NOT throw when at least one file produced a successful outcome (partial = success)', () => {
        const result = emptyResult();
        result.added = 1;
        result.errors.push('/broken.mkv: processing failed');
        expect(() => assertScanProducedWorkOrThrow(result, false)).not.toThrow();
    });

    it('does NOT throw on a clean no-work scan (no errors, no work)', () => {
        const result = emptyResult();
        expect(() => assertScanProducedWorkOrThrow(result, false)).not.toThrow();
    });

    it('does NOT throw when aborted, even with errors and no work', () => {
        const result = emptyResult();
        result.errors.push('Scan aborted by user');
        expect(() => assertScanProducedWorkOrThrow(result, true)).not.toThrow();
    });

    it('counts skipped/unmatched as work (a scan that only skipped is not an outage)', () => {
        const result = emptyResult();
        result.skipped = 3;
        result.errors.push('/one.mkv: processing failed');
        expect(() => assertScanProducedWorkOrThrow(result, false)).not.toThrow();
    });
});

/**
 * Regression test for the "dead NFS mount" false-success bug: when
 * `walkDirectoryWithResult` fails at the top-level readdir (e.g. ESTALE /
 * ENOTCONN on a vanished NFS mount), it returns `files=[]` with
 * `hadErrors=true` — zero per-file work happens, so zero per-file errors
 * accumulate via `processItems`, and `assertScanProducedWorkOrThrow` never
 * fires because `result.errors` stays empty. `recordWalkErrors` is the fix:
 * it makes the walk failure visible in `result.errors` so the run-level guard
 * can do its job.
 */
describe('recordWalkErrors — walk-level failures surface in result.errors', () => {
    it('total outage: every library path errors → assertScanProducedWorkOrThrow throws', () => {
        const result = emptyResult();
        // Two library paths, both fully unreadable (walk.files === [] for both).
        recordWalkErrors(result, '/mnt/nfs/movies', ['/mnt/nfs/movies']);
        recordWalkErrors(result, '/mnt/nfs/tv', ['/mnt/nfs/tv']);

        expect(result.errors).toHaveLength(2);
        expect(result.errors[0]).toContain('/mnt/nfs/movies');
        expect(result.errors[0]).toContain('walk had readdir/stat errors');

        // No files were walked anywhere → zero per-file outcomes → total outage.
        expect(() => assertScanProducedWorkOrThrow(result, false)).toThrowError(
            expect.objectContaining({ name: 'TaskError', kind: 'transient' }),
        );
    });

    it('partial outage: one path errors, another produced real work → does not throw, error stays visible', () => {
        const result = emptyResult();
        recordWalkErrors(result, '/mnt/nfs/dead-share', ['/mnt/nfs/dead-share']);
        // The healthy library path processed files normally.
        result.added = 3;

        expect(result.errors).toHaveLength(1);
        expect(() => assertScanProducedWorkOrThrow(result, false)).not.toThrow();
    });

    it('includes a sample of the failing paths for diagnosability', () => {
        const result = emptyResult();
        recordWalkErrors(result, '/mnt/nfs/movies', ['/a', '/b', '/c']);
        expect(result.errors[0]).toContain('/mnt/nfs/movies');
        expect(result.errors[0]).toContain('/a, /b, /c');
    });

    it('does not disturb the abort-sentinel exclusion — aborted runs still do not throw', () => {
        const result = emptyResult();
        recordWalkErrors(result, '/mnt/nfs/movies', ['/mnt/nfs/movies']);
        result.errors.push('Scan aborted by user');
        // aborted=true short-circuits assertScanProducedWorkOrThrow regardless
        // of walk errors being present.
        expect(() => assertScanProducedWorkOrThrow(result, true)).not.toThrow();
    });
});
