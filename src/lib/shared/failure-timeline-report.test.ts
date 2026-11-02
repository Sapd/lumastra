// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { formatFailureTimelineForGithub } from './failure-timeline-report.js';

describe('formatFailureTimelineForGithub', () => {
    it('renders plugin id, item id, and every event in order with reason and timestamp', () => {
        const out = formatFailureTimelineForGithub('album-enrichment', 'album-42', [
            { reason: 'timeout contacting provider', occurredAt: '2026-08-01T10:00:00.000Z' },
            { reason: 'rate limited', occurredAt: '2026-08-02T10:00:00.000Z' },
            { reason: 'unexpected 500', occurredAt: '2026-08-03T10:00:00.000Z' },
        ]);

        expect(out).toContain('album-enrichment');
        expect(out).toContain('album-42');

        // Every reason present, and in the same order as supplied.
        const timeoutIdx = out.indexOf('timeout contacting provider');
        const rateLimitedIdx = out.indexOf('rate limited');
        const unexpectedIdx = out.indexOf('unexpected 500');
        expect(timeoutIdx).toBeGreaterThan(-1);
        expect(rateLimitedIdx).toBeGreaterThan(timeoutIdx);
        expect(unexpectedIdx).toBeGreaterThan(rateLimitedIdx);

        // Every occurred_at timestamp present.
        expect(out).toContain('2026-08-01T10:00:00.000Z');
        expect(out).toContain('2026-08-02T10:00:00.000Z');
        expect(out).toContain('2026-08-03T10:00:00.000Z');
    });

    // Path redaction happens server-side (buildFailureHistory) — the
    // formatter receives an already-redacted `reason` and no longer touches
    // library roots at all. See history.integration.test.ts for end-to-end
    // path-redaction coverage.

    it('redacts credentials embedded in a reason string', () => {
        const out = formatFailureTimelineForGithub('some-plugin', 'item-1', [
            {
                reason: 'GET https://x/y?api_key=super-secret-value failed',
                occurredAt: '2026-08-05T00:00:00.000Z',
            },
        ]);

        expect(out).not.toContain('super-secret-value');
        expect(out).toContain('api_key=<redacted>');
    });

    it('handles a missing reason and an empty event list', () => {
        const withMissingReason = formatFailureTimelineForGithub('plugin-x', 'item-y', [
            { occurredAt: '2026-08-05T00:00:00.000Z' },
        ]);
        expect(withMissingReason).toContain('(no reason recorded)');

        const empty = formatFailureTimelineForGithub('plugin-x', 'item-y', []);
        expect(empty).toContain('No recorded failures');
    });

    // A literal `|` in `reason` would otherwise split the Markdown table
    // into extra columns.
    it('escapes a pipe character in a reason so it does not split the table', () => {
        const out = formatFailureTimelineForGithub('plugin-x', 'item-y', [
            { reason: 'value | with pipe', occurredAt: '2026-08-05T00:00:00.000Z' },
        ]);

        const rows = out.split('\n').filter((l) => l.startsWith('|'));
        // Header + separator + exactly one data row — a raw pipe would produce
        // a data row with 4 columns (5 pipe chars) instead of 2 (3 pipe chars).
        expect(rows).toHaveLength(3);
        expect(out).toContain('value \\| with pipe');
    });

    // A multi-line reason (e.g. a sidecar Python traceback) would otherwise
    // terminate the table at that row and dump every subsequent event as
    // literal `| 2026-... |` text instead of a rendered table row.
    it('collapses a multi-line reason into a single table row', () => {
        const out = formatFailureTimelineForGithub('plugin-x', 'item-y', [
            {
                reason: 'Error: boom\n    at foo (/app/x.js:1:1)\n    at bar',
                occurredAt: '2026-08-05T00:00:00.000Z',
            },
            { reason: 'second event', occurredAt: '2026-08-06T00:00:00.000Z' },
        ]);

        const rows = out.split('\n').filter((l) => l.startsWith('|'));
        expect(rows).toHaveLength(4); // header + separator + 2 data rows
        expect(out).toContain('Error: boom<br>    at foo');
        expect(out).toContain('second event');
    });

    it('notes truncation when the caller reports it', () => {
        const out = formatFailureTimelineForGithub(
            'plugin-x',
            'item-y',
            [{ reason: 'r', occurredAt: '2026-08-05T00:00:00.000Z' }],
            true,
        );
        expect(out).toContain('older attempts');
    });
});
