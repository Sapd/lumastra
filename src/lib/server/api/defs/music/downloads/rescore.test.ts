// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
    buildRescoreResults,
    MAX_RESCORE_IDS,
    SCHEMA_SAFETY_MAX_IDS,
    BodySchema,
    RESCORE_STATUS_VOCABULARY,
} from './rescore.js';

describe('buildRescoreResults', () => {
    it('returns EVERY submitted id, so absence is never a signal', () => {
        // This is the invariant that keeps a truncated or partially-failed
        // response from being read as "your whole pool was deleted".
        const ids = ['a', 'b', 'c'];
        const results = buildRescoreResults(ids, [{ media_id: 'b', rank: 0 }]);

        expect(results.map((r) => r.mediaId).sort()).toEqual(['a', 'b', 'c']);
    });

    it('marks an unranked id gone, with a null rank', () => {
        const results = buildRescoreResults(['a'], []);

        expect(results[0]).toEqual({ mediaId: 'a', status: 'gone', rank: null, toLane: null });
    });

    it('carries the rank through for a ranked id', () => {
        const results = buildRescoreResults(['a'], [{ media_id: 'a', rank: 7 }]);

        expect(results[0]).toEqual({ mediaId: 'a', status: 'ranked', rank: 7, toLane: null });
    });

    it('preserves submission order, so the client can zip without a lookup', () => {
        const results = buildRescoreResults(
            ['c', 'a', 'b'],
            [
                { media_id: 'a', rank: 0 },
                { media_id: 'b', rank: 1 },
                { media_id: 'c', rank: 2 },
            ],
        );

        expect(results.map((r) => r.mediaId)).toEqual(['c', 'a', 'b']);
    });

    it('deduplicates a repeated id rather than emitting it twice', () => {
        const results = buildRescoreResults(['a', 'a'], [{ media_id: 'a', rank: 0 }]);

        expect(results).toHaveLength(1);
    });
});

/**
 * Change 1 (iOS-feedback round 3): `RESCORE_STATUS_VOCABULARY` is published
 * on the wire as `statusVocabulary` so a client can detect a stale allow-list
 * as a leading indicator instead of a lagging one. The whole point is that it
 * cannot drift from what `buildRescoreResults` actually emits — pin both the
 * published set AND the runtime output against each other here, so adding a
 * new status to `buildRescoreResults` without adding it to the constant
 * fails a test (in addition to the TypeScript compile error `RescoreStatus`
 * already produces for that same mistake).
 */
describe('RESCORE_STATUS_VOCABULARY', () => {
    it('is exactly the published set — ranked, gone, graduated', () => {
        expect(RESCORE_STATUS_VOCABULARY).toEqual(['ranked', 'gone', 'graduated']);
    });

    it('contains every status buildRescoreResults actually produces', () => {
        const results = buildRescoreResults(['a', 'b', 'c'], [{ media_id: 'a', rank: 0 }]);
        const produced = new Set(results.map((r) => r.status));

        expect(produced.size).toBeGreaterThan(0);
        for (const status of produced) {
            expect(RESCORE_STATUS_VOCABULARY).toContain(status);
        }
    });

    it('rotation never emits `graduated` — nothing graduates out of it', () => {
        // graduated stays in the published vocabulary for a future lane (e.g.
        // continue_watching) that DOES have a leave-while-still-valid concept.
        const results = buildRescoreResults(['a', 'b'], [{ media_id: 'a', rank: 0 }]);

        expect(results.map((r) => r.status)).not.toContain('graduated');
    });
});

describe('MAX_RESCORE_IDS', () => {
    it('matches the lane membership cap, so one call always covers a whole lane', () => {
        // Rescore is never chunked: two chunks would be two orderings, which is
        // exactly the incomparability the ordinal model exists to prevent.
        expect(MAX_RESCORE_IDS).toBe(5000);
    });
});

describe('BodySchema mediaIds cap', () => {
    // Change 5 (iOS-feedback round 2): the lane-membership cap
    // (MAX_RESCORE_IDS) is enforced by hand in the handler now, NOT by a
    // schema-level `.max()`, so that exceeding it returns a structured 422
    // naming `submitted`/`cap`/`shedRequired` instead of a generic Zod
    // "array too long" error (see rescore.def.test.ts for that coverage) —
    // a client whose lane grew slightly past cap needs to know exactly how
    // many members to shed, not just that the request was rejected. The
    // schema itself only enforces a much higher SCHEMA_SAFETY_MAX_IDS
    // backstop against a pathological payload.
    it('accepts a cohort well over MAX_RESCORE_IDS at the schema level — the real cap is a handler concern now', () => {
        const mediaIds = Array.from({ length: MAX_RESCORE_IDS + 1 }, () => randomUUID());
        const result = BodySchema.safeParse({ lane: 'rotation', mediaIds });

        expect(result.success).toBe(true);
    });

    it('accepts exactly the cap', () => {
        const mediaIds = Array.from({ length: MAX_RESCORE_IDS }, () => randomUUID());
        const result = BodySchema.safeParse({ lane: 'rotation', mediaIds });

        expect(result.success).toBe(true);
    });

    it('rejects a payload over the schema-level safety ceiling', () => {
        const mediaIds = Array.from({ length: SCHEMA_SAFETY_MAX_IDS + 1 }, () => randomUUID());
        const result = BodySchema.safeParse({ lane: 'rotation', mediaIds });

        expect(result.success).toBe(false);
    });

    it('accepts exactly the schema-level safety ceiling', () => {
        const mediaIds = Array.from({ length: SCHEMA_SAFETY_MAX_IDS }, () => randomUUID());
        const result = BodySchema.safeParse({ lane: 'rotation', mediaIds });

        expect(result.success).toBe(true);
    });
});
