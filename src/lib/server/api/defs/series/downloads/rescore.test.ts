// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    buildSeriesRescoreResults,
    RESCORE_STATUS_VOCABULARY,
    MAX_RESCORE_IDS,
    SCHEMA_SAFETY_MAX_IDS,
    BodySchema,
} from './rescore.js';

describe('buildSeriesRescoreResults', () => {
    it('returns EVERY submitted id, so absence is never a signal', () => {
        // This is the invariant that keeps a truncated or partially-failed
        // response from being read as "your whole pool was deleted" — a signal
        // whose client-side consequence is mass deletion.
        const results = buildSeriesRescoreResults(
            ['a', 'b', 'c'],
            [{ media_id: 'b', status: 'ranked', rank: 0 }],
        );
        expect(results.map((r) => r.mediaId).sort()).toEqual(['a', 'b', 'c']);
    });

    it('marks an id the query did not return as gone', () => {
        const results = buildSeriesRescoreResults(['a'], []);
        expect(results[0]).toEqual({ mediaId: 'a', status: 'gone', rank: null, toLane: null });
    });

    it("matches an id whose case differs from the database's", () => {
        // Postgres renders uuid columns lowercase; a client that round-trips
        // an id through a native UUID type submits it uppercase (Swift's
        // `uuidString`). An exact-match lookup misses, and a miss is reported
        // `gone` — whose documented client response is to DELETE the
        // download. Case must never be the difference between keeping and
        // destroying a downloaded episode.
        const results = buildSeriesRescoreResults(
            ['3F2504E0-4F89-41D3-9A0C-0305E82C3301'],
            [{ media_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', status: 'ranked', rank: 3 }],
        );
        expect(results[0]?.status).toBe('ranked');
        expect(results[0]?.rank).toBe(3);
    });

    it('carries a rank through for a ranked id', () => {
        const results = buildSeriesRescoreResults(
            ['a'],
            [{ media_id: 'a', status: 'ranked', rank: 7 }],
        );
        expect(results[0]).toEqual({ mediaId: 'a', status: 'ranked', rank: 7, toLane: null });
    });

    it('emits graduated with a NULL toLane — graduation is terminal for series', () => {
        // Music's `graduated` carries `toLane: 'rotation'`. Same wire status,
        // opposite consequence, which is exactly why the consequence travels as
        // data (`graduationPolicy`) rather than being hardcoded client-side.
        const results = buildSeriesRescoreResults(
            ['a'],
            [{ media_id: 'a', status: 'graduated', rank: null }],
        );
        expect(results[0]).toEqual({
            mediaId: 'a',
            status: 'graduated',
            rank: null,
            toLane: null,
        });
    });

    it('never emits a rank alongside graduated or gone', () => {
        const results = buildSeriesRescoreResults(
            ['a', 'b'],
            [{ media_id: 'a', status: 'graduated', rank: 3 }],
        );
        expect(results.find((r) => r.mediaId === 'a')!.rank).toBeNull();
        expect(results.find((r) => r.mediaId === 'b')!.rank).toBeNull();
    });

    it('preserves submission order, so the client can zip without a lookup', () => {
        const results = buildSeriesRescoreResults(
            ['c', 'a', 'b'],
            [
                { media_id: 'a', status: 'ranked', rank: 0 },
                { media_id: 'b', status: 'ranked', rank: 1 },
                { media_id: 'c', status: 'ranked', rank: 2 },
            ],
        );
        expect(results.map((r) => r.mediaId)).toEqual(['c', 'a', 'b']);
    });

    it('deduplicates a repeated id rather than emitting it twice', () => {
        const results = buildSeriesRescoreResults(
            ['a', 'a'],
            [{ media_id: 'a', status: 'ranked', rank: 0 }],
        );
        expect(results).toHaveLength(1);
    });

    it('falls back to gone for an unrecognised status from the query layer', () => {
        // Defensive: a status this build does not know must not reach the wire
        // as `ranked`, which would keep a dead item in the pool forever.
        const results = buildSeriesRescoreResults(
            ['a'],
            [{ media_id: 'a', status: 'something_new', rank: null }],
        );
        expect(results[0]!.status).toBe('gone');
    });
});

describe('the wire vocabulary', () => {
    it('is exactly the three statuses the client is told to expect', () => {
        expect([...RESCORE_STATUS_VOCABULARY]).toEqual(['ranked', 'graduated', 'gone']);
    });

    it("caps a cohort at 2000, lower than music's 5000", () => {
        // 2000 episodes at 720p is ~2.4 TB; a larger cap describes no reachable
        // pool. Also the lane membership cap — rescore is never chunked,
        // because two chunks are two orderings.
        expect(MAX_RESCORE_IDS).toBe(2000);
    });
});

describe('the maxItems / cap discrepancy is a deliberate, documented gap', () => {
    // Two different numbers are visible to a client here: the published
    // schema `maxItems` (SCHEMA_SAFETY_MAX_IDS) and the real lane cap
    // enforced by the handler (MAX_RESCORE_IDS). Both are intentional — the
    // former is an absurd-payload guard, the latter the authoritative cap —
    // but read together they look like a contradiction unless the gap
    // between them is pinned as a decision, not an accident that a future
    // edit could quietly collapse.

    it('publishes a schema ceiling strictly larger than the enforced cap', () => {
        expect(SCHEMA_SAFETY_MAX_IDS).toBeGreaterThan(MAX_RESCORE_IDS);
    });

    it('sets the schema ceiling at exactly 10x the enforced cap', () => {
        // Pins the MULTIPLE, not just "larger than" — a collapse toward 1x
        // (making the two numbers equal, erasing the guard/cap distinction)
        // or an accidental widening both fail this test rather than shipping
        // silently.
        expect(SCHEMA_SAFETY_MAX_IDS).toBe(MAX_RESCORE_IDS * 10);
    });

    it("documents the gap on the wire so a client doesn't read it as a bug", () => {
        const description = BodySchema.shape.mediaIds.description ?? '';
        // Must explain that maxItems is a payload-shape guard, not the real
        // cap, and must point at the 422's `details` as the authoritative
        // source for the actual limit -- otherwise a client sees maxItems:
        // 20000 in the prose alongside "the cap is 2000" and reasonably
        // concludes the API contradicts itself.
        expect(description).toContain(String(MAX_RESCORE_IDS));
        expect(description).toContain(String(SCHEMA_SAFETY_MAX_IDS));
        expect(description.toLowerCase()).toContain('absurd');
        expect(description).toContain('422');
    });
});
