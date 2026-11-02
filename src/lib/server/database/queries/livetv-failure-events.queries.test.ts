// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Write-time contract for the Live TV failure recorder.
 *
 * Asserts the VALUES that actually reach the INSERT, not just that a call happened:
 * the secret strip is the whole reason the write goes through this function, and a
 * test that only checked "sql was called" would pass while a stream token sat in the
 * database for the entire retention window.
 */
import { describe, test, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
    recordLiveTvFailureEvent,
    type LiveTvFailureEventInput,
} from './livetv-failure-events.queries.js';

vi.mock('../../utils/logger.js', () => ({
    Logger: { for: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

/** A tagged-template stand-in that records the interpolated values of every query. */
function makeCapturingSql(): { sql: postgres.Sql; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const fn = (_strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
        calls.push(values);
        return Promise.resolve([]);
    };
    (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return { sql: fn as unknown as postgres.Sql, calls };
}

const BASE: LiveTvFailureEventInput = {
    eventUid: '11111111-2222-3333-4444-555555555555',
    channelId: 'ch-uuid',
    occurredAt: '2026-08-06T10:00:00.000Z',
    source: 'ingest',
    outcome: 'crashed',
    exitCode: 1,
    signal: null,
    rungId: null,
    stderrTail: 'nothing interesting\n',
    probe: null,
    decision: null,
};

describe('recordLiveTvFailureEvent', () => {
    test('persists the stderr tail the proxy captured', async () => {
        const { sql, calls } = makeCapturingSql();

        await recordLiveTvFailureEvent(sql, {
            ...BASE,
            stderrTail: 'Server returned 404 Not Found\nError opening input\n',
        });

        expect(calls).toHaveLength(1);
        const stderr = calls[0].find(
            (v): v is string => typeof v === 'string' && v.includes('404 Not Found'),
        );
        expect(stderr).toContain('Error opening input');
    });

    test('strips credentials out of stderr BEFORE the row exists', async () => {
        const { sql, calls } = makeCapturingSql();

        await recordLiveTvFailureEvent(sql, {
            ...BASE,
            stderrTail:
                "Opening 'http://iptv.example.com/live.ts?token=SUPERSECRET123' for reading\n" +
                'http://admin:hunter2@10.0.0.5:8989/stream\n',
        });

        const bound = JSON.stringify(calls[0]);
        expect(bound).not.toContain('SUPERSECRET123');
        expect(bound).not.toContain('hunter2');
        expect(bound).toContain('token=<redacted>');
    });

    test('an over-long stderr keeps the END — the fatal line is the last one', async () => {
        const { sql, calls } = makeCapturingSql();
        // FfmpegManager lets its buffer reach 10000 chars before rotating, so a tail
        // longer than the recorder's rail is routine, not hypothetical.
        const noise = 'x'.repeat(40_000);

        await recordLiveTvFailureEvent(sql, {
            ...BASE,
            stderrTail: `${noise}\nServer returned 404 Not Found\n`,
        });

        const stderr = calls[0].find(
            (v): v is string => typeof v === 'string' && v.includes('xxx'),
        );
        expect(stderr).toContain('Server returned 404 Not Found');
    });

    test('an oversized probe does not take the whole event down with it', async () => {
        const { sql, calls } = makeCapturingSql();
        // A truncated JSON string is not JSON: bound as `${...}::jsonb` it makes
        // Postgres reject the INSERT, and the swallow above would then discard the
        // stderr tail too — the one thing the row exists for.
        const huge = { blob: 'y'.repeat(50_000) };

        await recordLiveTvFailureEvent(sql, {
            ...BASE,
            stderrTail: 'Server returned 404 Not Found\n',
            probe: huge,
        });

        const probe = calls[0].find(
            (v): v is string => typeof v === 'string' && v.includes('truncated'),
        );
        expect(probe).toBeDefined();
        expect(() => JSON.parse(probe as string)).not.toThrow();
        // And the stderr still made it.
        const bound = JSON.stringify(calls[0]);
        expect(bound).toContain('404 Not Found');
    });

    test('returns true when a row was inserted and false when the uid already existed', async () => {
        const make = (rows: unknown[]) => {
            const fn = () => Promise.resolve(rows);
            (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
            return fn as unknown as postgres.Sql;
        };
        await expect(recordLiveTvFailureEvent(make([{ id: '1' }]), BASE)).resolves.toBe(true);
        await expect(recordLiveTvFailureEvent(make([]), BASE)).resolves.toBe(false);
    });

    test('a database error is swallowed — a live channel must never unwind here', async () => {
        const failing = (() =>
            Promise.reject(new Error('connection terminated'))) as unknown as postgres.Sql;
        (failing as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

        await expect(recordLiveTvFailureEvent(failing, BASE)).resolves.toBe(false);
    });
});
