// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for RATE_LIMIT_ERROR_PATTERN — the CLASSIFIER pattern that decides
 * whether a provider error is retried (via `isTransientInfrastructureError` in
 * tasks/runner.ts), as opposed to EXPECTED_RUN_ERROR_PATTERN which only decides
 * a badge colour.
 *
 * The "must NOT match" block is the load-bearing half: a false positive here
 * makes a genuine permanent failure retry forever while reading as self-healing.
 *
 * Run with: npx vitest run src/lib/shared/run-error-severity.test.ts
 */

import { describe, it, expect } from 'vitest';
import { RATE_LIMIT_ERROR_PATTERN, EXPECTED_RUN_ERROR_PATTERN } from './run-error-severity.js';

describe('RATE_LIMIT_ERROR_PATTERN — matches real rate-limit messages', () => {
    const cases = [
        // providers/mdblist.ts:265
        'mdblist rate limit exceeded (HTTP 429)',
        // providers/mdblist.ts cool-down throw
        'MDBList rate-limit cool-down active (free-tier quota) — will retry in 42s',
        // tmdb/client.ts legacy message format
        'TMDB API request failed: 429 Too Many Requests',
        // mal-anime-id-enrichment.ts:1286 detects this shape
        'MAL request failed status=429',
        // hand-wrapped transient TaskErrors (mdblist-sync, curated-lists-sync, mal)
        'mdblist-sync: rate limit reached (mdblist.com free-tier quota) — resumes automatically once the quota window resets',
        'mal-anime-id-enrichment: rate limit reached (MyAnimeList API) — resumes automatically once the quota window resets',
        // Retry-After surfaced verbatim
        'upstream asked us to back off, retry-after: 8',
        'Rate Limited by provider',
        'ratelimit hit on discogs',
    ];

    for (const msg of cases) {
        it(`matches "${msg.slice(0, 60)}"`, () => {
            expect(RATE_LIMIT_ERROR_PATTERN.test(msg)).toBe(true);
        });
    }
});

describe('RATE_LIMIT_ERROR_PATTERN — must NOT match', () => {
    const cases: Array<[string, string]> = [
        // The exact trap mal-anime-id-enrichment.ts:1282 documents: 429 is a
        // real, low MyAnimeList anime id.
        ['a bare 429 that is an upstream id', 'MAL lookup failed for /anime/429'],
        ['a bare 429 as a count', 'processed 429 items before aborting'],
        // Bare `quota` is deliberately excluded: EDQUOT is operator-actionable.
        ['a disk quota error', 'ENOSPC: disk quota exceeded writing trickplay tile'],
        ['a user storage quota error', 'storage quota exceeded for library group'],
        // Ordinary permanent failures must stay permanent.
        ['a TMDB 404', 'TMDB API request failed: 404 Not Found'],
        ['an auth failure', 'TMDB API key is invalid'],
        ['a decode failure', 'Invalid NAL unit size (-1852 > 143)'],
        ['a constraint violation', 'violates foreign key constraint (23503)'],
    ];

    for (const [label, msg] of cases) {
        it(`does not match ${label}`, () => {
            expect(RATE_LIMIT_ERROR_PATTERN.test(msg)).toBe(false);
        });
    }
});

describe('relationship to EXPECTED_RUN_ERROR_PATTERN', () => {
    it('is strictly narrower — everything it matches is also display-expected', () => {
        const matched = [
            'mdblist rate limit exceeded (HTTP 429)',
            'TMDB API request failed: 429 Too Many Requests',
            'MAL request failed status=429',
            'upstream asked us to back off, retry-after: 8',
        ];
        for (const msg of matched) {
            expect(RATE_LIMIT_ERROR_PATTERN.test(msg)).toBe(true);
            expect(EXPECTED_RUN_ERROR_PATTERN.test(msg)).toBe(true);
        }
    });

    it('declines cases the broader display pattern accepts', () => {
        // These are why the two patterns are separate: fine for a badge colour,
        // unacceptable as a licence to retry forever.
        for (const msg of ['ENOSPC: disk quota exceeded', 'MAL lookup failed for /anime/429']) {
            expect(EXPECTED_RUN_ERROR_PATTERN.test(msg)).toBe(true);
            expect(RATE_LIMIT_ERROR_PATTERN.test(msg)).toBe(false);
        }
    });
});
