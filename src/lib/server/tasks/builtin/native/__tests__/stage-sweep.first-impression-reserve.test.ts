// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The first-impression budget reservation.
 *
 * On a cold library every stage is eligible at once and artwork competes for
 * one 500-enqueue budget against trickplay previews (one job per FILE) and
 * embeddings. The visible result is grey placeholder cards for an hour.
 *
 * The fix must NOT be a priority sort: `sweepStartOffset` rotation (D1) exists
 * because a fixed order starved the tail for the whole ingest window. A
 * reservation gives artwork a floor without giving anything else a ceiling
 * below its old share of a rotation turn — so both properties are asserted
 * here, as arithmetic over the two caps.
 */

import { describe, it, expect, vi } from 'vitest';

// stage-sweep.ts calls registry.registerTask() at module load; the constants
// under test need none of that machinery.
vi.mock('../../../registry.js', () => ({
    registry: { registerTask: vi.fn(), getAllTasks: () => [] },
}));

import {
    FIRST_IMPRESSION_STAGES,
    FIRST_IMPRESSION_RESERVE,
    MAX_ENQUEUES_PER_TICK,
    stageEnqueueCap,
} from '../stage-sweep.js';

// Import the REAL cap function rather than mirroring its arithmetic — a
// mirrored copy cannot fail when the rule it copies changes.
const capFor = stageEnqueueCap;

describe('stage-sweep first-impression reserve', () => {
    it('covers both artwork paths — Jellyfin-sourced and provider-sourced', () => {
        // Either one lands the same visible poster; reserving only one leaves
        // half of installs looking exactly as grey as before.
        expect(FIRST_IMPRESSION_STAGES.has('image-sync')).toBe(true);
        expect(FIRST_IMPRESSION_STAGES.has('provider-artwork-poster')).toBe(true);
    });

    it('reserves strictly less than the whole budget', () => {
        // A reserve >= the cap would starve every non-artwork stage outright —
        // the inverse of the bug, and worse.
        expect(FIRST_IMPRESSION_RESERVE).toBeGreaterThan(0);
        expect(FIRST_IMPRESSION_RESERVE).toBeLessThan(MAX_ENQUEUES_PER_TICK);
    });

    it('leaves non-reserved stages a substantial majority of the budget', () => {
        // Guards a future "just bump the reserve" from quietly inverting the
        // priority: previews/embeddings must still be the bulk of the tick.
        const others = MAX_ENQUEUES_PER_TICK - FIRST_IMPRESSION_RESERVE;
        expect(others).toBeGreaterThanOrEqual(MAX_ENQUEUES_PER_TICK / 2);
    });

    it('never raises the total a tick can enqueue', () => {
        // The 500 cap is an OOM backstop from a real preprod incident
        // (~135k jobs burst-enqueued). The reservation may only LOWER what the
        // non-reserved majority spends.
        for (const id of ['image-sync', 'trickplay-generation', 'library-embeddings']) {
            expect(capFor(id, true)).toBeLessThanOrEqual(MAX_ENQUEUES_PER_TICK);
            expect(capFor(id, false)).toBeLessThanOrEqual(MAX_ENQUEUES_PER_TICK);
        }
    });

    it('RELEASES the reserve when no artwork stage has work', () => {
        // The regression this replaces: with artwork backfilled, the four
        // reserved stages found no candidates, every other stage stopped at
        // 350, and 150 of 500 went unspent every tick forever — a permanent
        // ~30% throughput cut that never tripped the cap-hit warning, because
        // `enqueued` never reached the cap that logs it.
        expect(capFor('trickplay-generation', false)).toBe(MAX_ENQUEUES_PER_TICK);
        expect(capFor('library-embeddings', false)).toBe(MAX_ENQUEUES_PER_TICK);
    });

    it('applies the reserve only while artwork actually has work', () => {
        expect(capFor('trickplay-generation', true)).toBe(
            MAX_ENQUEUES_PER_TICK - FIRST_IMPRESSION_RESERVE,
        );
        // A first-impression stage is never capped below the global limit.
        expect(capFor('provider-artwork-poster', true)).toBe(MAX_ENQUEUES_PER_TICK);
    });

    it('gives artwork headroom exactly where a preview backlog would crowd it out', () => {
        // At the moment the tick has spent its non-reserved allowance, a preview
        // stage is done enqueueing and an artwork stage is not.
        const spent = MAX_ENQUEUES_PER_TICK - FIRST_IMPRESSION_RESERVE;
        expect(spent >= capFor('trickplay-generation', true)).toBe(true);
        expect(spent >= capFor('provider-artwork-poster', true)).toBe(false);
    });
});
