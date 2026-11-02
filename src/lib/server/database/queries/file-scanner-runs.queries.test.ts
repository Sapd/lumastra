// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two pure rules the scanner-run views depend on.
 *
 * Tested HERE, at the function, rather than only through the admin table:
 * the component receives `status` already derived and mocks the endpoint, so
 * a component test cannot tell a correct rule from a broken one — it would
 * only be asserting its own fixture. These are the seam.
 */

import { describe, expect, it } from 'vitest';
import {
    deriveScannerRunStatus,
    boundScannerRunErrorSamples,
    ABANDONED_RUN_ERRORS_SENTINEL,
    ABANDONED_RUN_STALE_HOURS,
    SCANNER_RUN_ERROR_SAMPLE_LIMIT,
    SCANNER_RUN_ERROR_SAMPLE_MAX_CHARS,
} from './file-scanner-runs.queries.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');

function hoursAgo(h: number): Date {
    return new Date(NOW.getTime() - h * 3_600_000);
}

describe('deriveScannerRunStatus', () => {
    it('calls a finished run completed', () => {
        expect(
            deriveScannerRunStatus(
                { started_at: hoursAgo(1), completed_at: hoursAgo(0.5), errors: 0 },
                NOW,
            ),
        ).toBe('completed');
    });

    // A finished run with per-file failures still FINISHED. Errors are the
    // RESULT column's business; conflating them with lifecycle would report
    // every scan of a library with one bad file as a failed scan.
    it('calls a finished run with errors completed, not failed', () => {
        expect(
            deriveScannerRunStatus(
                { started_at: hoursAgo(1), completed_at: hoursAgo(0.5), errors: 12 },
                NOW,
            ),
        ).toBe('completed');
    });

    // Bulk scans on large libraries legitimately run for a long time.
    // Reporting a healthy in-flight scan as abandoned is the louder mistake,
    // so "open" alone must never mean abandoned.
    it('calls a young in-flight run running', () => {
        expect(
            deriveScannerRunStatus(
                {
                    started_at: hoursAgo(ABANDONED_RUN_STALE_HOURS - 0.5),
                    completed_at: null,
                    errors: 0,
                },
                NOW,
            ),
        ).toBe('running');
    });

    // The case a `completed_at IS NOT NULL` filter cannot see at all: a
    // crashed run is only stamped by the NEXT scan's sweep, so between the
    // crash and that sweep it sits open with a `started_at` from hours ago.
    it('calls an in-flight run past the grace window abandoned', () => {
        expect(
            deriveScannerRunStatus(
                {
                    started_at: hoursAgo(ABANDONED_RUN_STALE_HOURS + 0.5),
                    completed_at: null,
                    errors: 0,
                },
                NOW,
            ),
        ).toBe('abandoned');
    });

    // The boundary belongs to "still running" — exactly at the threshold the
    // sweep has not acted yet, and this function must not accuse a run the
    // writer would still leave alone.
    it('is exclusive at the threshold: exactly at the window is still running', () => {
        expect(
            deriveScannerRunStatus(
                { started_at: hoursAgo(ABANDONED_RUN_STALE_HOURS), completed_at: null, errors: 0 },
                NOW,
            ),
        ).toBe('running');
    });

    // The sentinel must win over the stamped `completed_at` the sweep wrote
    // alongside it. If `completed_at` were checked first this returns
    // 'completed' and the UI renders the row's counters — including "-1
    // errors" — as though they came from a real pass.
    it('reads the -1 sentinel as abandoned even though completed_at is set', () => {
        expect(
            deriveScannerRunStatus(
                {
                    started_at: hoursAgo(4),
                    completed_at: hoursAgo(2),
                    errors: ABANDONED_RUN_ERRORS_SENTINEL,
                },
                NOW,
            ),
        ).toBe('abandoned');
    });
});

describe('boundScannerRunErrorSamples', () => {
    it('keeps a short list whole', () => {
        expect(boundScannerRunErrorSamples(['a: x', 'b: y'])).toEqual(['a: x', 'b: y']);
    });

    it('returns an empty array for a clean run', () => {
        expect(boundScannerRunErrorSamples([])).toEqual([]);
    });

    // A scan of a mount that has gone away produces ONE error per file. This
    // input is unbounded, and the row it lands on already has 10k+ siblings.
    it('caps the number of samples', () => {
        const many = Array.from({ length: 5_000 }, (_, i) => `file-${i}: gone`);
        const out = boundScannerRunErrorSamples(many);
        expect(out).toHaveLength(SCANNER_RUN_ERROR_SAMPLE_LIMIT);
        expect(out[0]).toBe('file-0: gone');
    });

    // Each entry embeds a full file path plus a driver message, so the cap on
    // COUNT alone does not bound the stored size.
    it('caps the length of a single sample', () => {
        const huge = `${'/very/long/path'.repeat(500)}: broke`;
        const [out] = boundScannerRunErrorSamples([huge]);
        expect(out.length).toBe(SCANNER_RUN_ERROR_SAMPLE_MAX_CHARS + 1);
        expect(out.endsWith('…')).toBe(true);
    });

    it('leaves a sample exactly at the limit untruncated', () => {
        const exact = 'x'.repeat(SCANNER_RUN_ERROR_SAMPLE_MAX_CHARS);
        expect(boundScannerRunErrorSamples([exact])).toEqual([exact]);
    });

    // The COUNT is carried separately by `errors`, so truncating here must
    // not be mistaken for the run having had fewer errors — the UI renders
    // "showing 20 of 137" from the two together.
    it('does not report the original count, which lives in errors', () => {
        const many = Array.from({ length: 137 }, (_, i) => `f${i}: x`);
        expect(boundScannerRunErrorSamples(many).length).toBeLessThan(many.length);
    });
});
