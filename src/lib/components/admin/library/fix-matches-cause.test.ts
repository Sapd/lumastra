// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { classifyBrokenMatch } from './fix-matches-cause.js';

describe('classifyBrokenMatch', () => {
    it.each([
        ['The operation was aborted due to timeout', 'temporary'],
        ['fetch failed: ECONNRESET', 'temporary'],
        ['TMDB 429 Too Many Requests', 'temporary'],
        [
            "season poster: TMDB has no series 216416 (404) — the parent's TMDB id is stale or wrong; re-identify the series",
            'stale-id',
        ],
        ['Movie not found on provider', 'stale-id'],
        ['wrong media type: matched as movie', 'wrong-type'],
        ['Task reported a permanent failure', 'unknown'],
        ['', 'unknown'],
    ] as const)('%s → %s', (errorMessage, expected) => {
        expect(classifyBrokenMatch({ errorMessage })).toBe(expected);
    });

    it('reads the error code too', () => {
        expect(classifyBrokenMatch({ errorCode: 'ETIMEDOUT', errorMessage: null })).toBe(
            'temporary',
        );
    });
});
