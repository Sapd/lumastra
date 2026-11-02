// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the error-fingerprint normalizer (Slice 3 §4.1, §9).
 *
 * Pure tests over a fixture corpus — no DB, no Valkey. The contract: the same
 * failure with varying ids/timestamps/paths/counts → ONE fingerprint; genuinely
 * different failures → distinct fingerprints; truncation + whitespace collapse;
 * empty/null handling.
 */

import { describe, it, expect } from 'vitest';
import { normalizeError, fingerprintError } from './error-fingerprint.js';

describe('normalizeError', () => {
    it('lowercases', () => {
        expect(normalizeError('Timeout Connecting')).toBe('timeout connecting');
    });

    it('strips UUIDs to <id>', () => {
        expect(normalizeError('run 550e8400-e29b-41d4-a716-446655440000 failed')).toBe(
            'run <id> failed',
        );
    });

    it('strips bare run ids to <id> (whole run_… token)', () => {
        expect(normalizeError('run_01HX2Y3Z4 not found')).toBe('<id> not found');
        expect(normalizeError('reclaimed run-abc123 cleanly')).toBe('reclaimed <id> cleanly');
    });

    it('strips long hex runs to <id>', () => {
        expect(normalizeError('digest deadbeefcafef00d1234 mismatch')).toBe('digest <id> mismatch');
    });

    it('strips ISO-8601 timestamps to <ts>', () => {
        expect(normalizeError('failed at 2026-06-02T14:32:01.123Z again')).toBe(
            'failed at <ts> again',
        );
        expect(normalizeError('at 2026-06-02 14:32:01')).toBe('at <ts>');
    });

    it('strips epoch-ms integers to <ts>', () => {
        expect(normalizeError('ts 1780000000000 expired')).toBe('ts <ts> expired');
    });

    it('keeps the host of a URL and drops the path', () => {
        expect(normalizeError('timeout connecting to https://api.tmdb.org/3/movie/550')).toBe(
            'timeout connecting to <url:api.tmdb.org>',
        );
    });

    it('strips absolute paths to <path>', () => {
        expect(normalizeError('cannot read /var/lib/lumastra/cache/abc.json')).toBe(
            'cannot read <path>',
        );
    });

    it('collapses standalone integers >= 3 digits to <n>', () => {
        expect(normalizeError('retry 1500 of 2000')).toBe('retry <n> of <n>');
    });

    it('does not collapse small integers', () => {
        expect(normalizeError('attempt 5 of 7')).toBe('attempt 5 of 7');
    });

    it('collapses whitespace and trims', () => {
        expect(normalizeError('  too    many\n\tspaces  ')).toBe('too many spaces');
    });

    it('truncates to 200 chars', () => {
        const long = 'x'.repeat(500);
        expect(normalizeError(long)).toHaveLength(200);
    });

    it('handles null / undefined / empty', () => {
        expect(normalizeError(null)).toBe('');
        expect(normalizeError(undefined)).toBe('');
        expect(normalizeError('')).toBe('');
    });
});

describe('fingerprintError', () => {
    it('collapses the same error with different ids/timestamps/paths/counts', () => {
        const a = fingerprintError(
            'Timeout connecting to https://api.tmdb.org/3/movie/550 at 2026-06-02T14:32:01Z (attempt 1500)',
        );
        const b = fingerprintError(
            'Timeout connecting to https://api.tmdb.org/3/tv/1429 at 2026-06-03T09:00:00Z (attempt 2750)',
        );
        expect(a).toBe(b);
    });

    it('keeps genuinely different errors distinct', () => {
        const timeout = fingerprintError('Timeout connecting to https://api.tmdb.org/x');
        const auth = fingerprintError('Unauthorized: invalid API key');
        expect(timeout).not.toBe(auth);
    });

    it('is a 16-char hex string', () => {
        const fp = fingerprintError('some error');
        expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });

    it('empty and null produce the same (empty-normalized) fingerprint', () => {
        expect(fingerprintError(null)).toBe(fingerprintError(''));
    });

    it('different hosts do not collapse', () => {
        const tmdb = fingerprintError('timeout connecting to https://api.tmdb.org/x');
        const mb = fingerprintError('timeout connecting to https://musicbrainz.org/x');
        expect(tmdb).not.toBe(mb);
    });
});
