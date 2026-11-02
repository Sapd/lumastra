// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request-gate contract for GET /api/v1/recommendations `mood` (E1 row #37).
 *
 * The gate's `mood` enum is DERIVED from `MOOD_PROFILES` (the single canonical
 * taxonomy) rather than a hand-copied list — this test pins that the gate
 * accepts exactly the MOOD_PROFILES keys and rejects anything else, so the two
 * can never drift.
 */

import { describe, it, expect } from 'vitest';
import { def } from './recommendations.js';
import { MOOD_PROFILES } from '$lib/server/services/mood-profiles.js';

const query = def.request!.query!;

describe('GET /api/v1/recommendations — mood gate', () => {
    const moodKeys = Object.keys(MOOD_PROFILES);

    it('has the full 22-value mood taxonomy', () => {
        expect(moodKeys.length).toBe(22);
    });

    it('accepts every mood defined in MOOD_PROFILES', () => {
        for (const mood of moodKeys) {
            expect(query.safeParse({ mood }).success, `mood=${mood}`).toBe(true);
        }
    });

    it('rejects a mood outside MOOD_PROFILES', () => {
        expect(query.safeParse({ mood: 'notamood' }).success).toBe(false);
        expect(query.safeParse({ mood: '' }).success).toBe(false);
    });

    it('leaves mood optional (omitted is valid)', () => {
        expect(query.safeParse({}).success).toBe(true);
    });

    it('accepts a CSV public media-type allow-list', () => {
        expect(query.safeParse({ types: 'movie,series,audiobook' }).success).toBe(true);
        // Unknown values are parsed as a string so the handler can return the
        // shared 422 vocabulary error instead of a generic Zod enum error.
        expect(query.safeParse({ types: 'movies' }).success).toBe(true);
        expect(query.safeParse({ mediaType: 'movie' }).success).toBe(false);
    });
});
