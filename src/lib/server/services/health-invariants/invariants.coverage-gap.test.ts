// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `stage-coverage-gap` — the invariant that measures ABSENT rows.
 *
 * 🔴 Every other invariant counts rows that exist in a bad state. This one
 * counts rows that should exist and don't, which is the only way the silent
 * failure it was written for can ever surface: a missing coverage row is not
 * `pending`, so no backlog reflects it and the owning stage reports itself
 * healthy. On prod that hid 11,186 items with no trickplay record for ten
 * weeks.
 *
 * The tests below are mostly about the two ways this invariant can LIE, both of
 * which turn it from a signal into the sort of false alarm operators learn to
 * ignore:
 *   - reading media types from anywhere but the registry (a hand-guessed
 *     `metadata-update` produced a phantom gap of 85,710 against a true 16)
 *   - forgetting that declarations say 'series' where the column stores 'tv'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const tasks = vi.hoisted(() => ({ all: [] as unknown[] }));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getAllTasks: () => tasks.all },
}));

import { INVARIANTS } from './invariants.js';

const invariant = INVARIANTS.find((i) => i.id === 'stage-coverage-gap');
if (!invariant) throw new Error('invariant not registered: stage-coverage-gap');

interface Captured {
    stageIds: string[];
    mediaTypes: string[];
}

/**
 * Tagged-template stub that captures the two parallel arrays the query
 * interpolates and replays a canned result.
 */
function sqlStub(rows: Array<{ stage_id: string; gap: number }>): {
    sql: postgres.Sql;
    captured: Captured[];
} {
    const captured: Captured[] = [];
    const fn = (_strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
        const arrays = values.filter(Array.isArray) as string[][];
        if (arrays.length >= 2) {
            captured.push({ stageIds: arrays[0], mediaTypes: arrays[1] });
        }
        return Promise.resolve(rows);
    };
    // `sql.array()` is a passthrough here — the query interpolates its result,
    // so the captured values stay the plain arrays the assertions read.
    (fn as unknown as { array: (a: unknown) => unknown }).array = (a) => a;
    return { sql: fn as unknown as postgres.Sql, captured };
}

function task(id: string, stages: Array<{ id: string; appliesTo: string[] }>): unknown {
    return { id, name: id, coversStages: stages.map((s) => ({ ...s })) };
}

beforeEach(() => {
    tasks.all = [];
});

describe("invariant 'stage-coverage-gap'", () => {
    it("translates the declared 'series' to the stored 'tv'", async () => {
        // 🔴 media_items.media_type holds the legacy 'tv'. Comparing against
        // 'series' matches no row, so the stage's entire population would be
        // reported as a gap, permanently.
        tasks.all = [
            task('metadata-sync', [{ id: 'metadata-update', appliesTo: ['movie', 'series'] }]),
        ];
        const { sql, captured } = sqlStub([]);

        await invariant.query(sql);

        expect(captured[0].mediaTypes).toEqual(['movie', 'tv']);
        expect(captured[0].mediaTypes).not.toContain('series');
        expect(captured[0].stageIds).toEqual(['metadata-update', 'metadata-update']);
    });

    it('takes the media types from the registry, not from a fixed list', async () => {
        // Guessing these is how a phantom 85,710-item gap gets reported.
        tasks.all = [task('t', [{ id: 'some-stage', appliesTo: ['episode'] }])];
        const { sql, captured } = sqlStub([]);

        await invariant.query(sql);

        expect(captured[0].mediaTypes).toEqual(['episode']);
    });

    it('deduplicates a repeated (stage, type) pair', async () => {
        // A duplicated pair joins the same item twice and doubles its gap.
        tasks.all = [
            task('t', [{ id: 'dup-stage', appliesTo: ['movie', 'series', 'movie'] }]),
            task('u', [{ id: 'dup-stage', appliesTo: ['movie'] }]),
        ];
        const { sql, captured } = sqlStub([]);

        await invariant.query(sql);

        expect(captured[0].stageIds).toEqual(['dup-stage', 'dup-stage']);
        expect(captured[0].mediaTypes).toEqual(['movie', 'tv']);
    });

    it('reports nothing when the registry is empty, rather than the whole catalogue', async () => {
        // 🔴 A process that never ran loadBuiltins has no expectations. Saying
        // "everything is missing" there would be worse than saying nothing.
        const { sql, captured } = sqlStub([{ stage_id: 'x', gap: 999 }]);

        expect(await invariant.query(sql)).toBe(0);
        expect(captured).toHaveLength(0);
    });

    it('totals the gap across stages', async () => {
        tasks.all = [task('t', [{ id: 'a', appliesTo: ['movie'] }])];
        const { sql } = sqlStub([
            { stage_id: 'a', gap: 11186 },
            { stage_id: 'b', gap: 11238 },
        ]);

        expect(await invariant.query(sql)).toBe(22424);
    });

    it('warns on a draining backfill instead of paging about it', () => {
        // 🔴 The regression this pins. Shipped at amber 500 / red 5,000 against a
        // real gap of ~358,000, it went critical instantly and stayed critical
        // for a day while repairing itself at ~146,000 rows/day — a critical
        // nobody can act on and that resolves on its own. Same cry-wolf failure
        // as the repeated-recovery alert; a self-healing backlog is a warning.
        const classify = (v: number): string =>
            v > invariant.thresholdRed ? 'red' : v > invariant.thresholdAmber ? 'amber' : 'green';

        expect(classify(0)).toBe('green');
        expect(classify(16)).toBe('green'); // the real metadata-update gap
        expect(classify(212_003)).toBe('amber'); // mid-drain, 2026-08-22
        expect(classify(358_151)).toBe('amber'); // the gap when it was found
        expect(classify(900_000)).toBe('red'); // beyond any backfill this repair makes
    });

    it('names the owning task in the breakdown', async () => {
        tasks.all = [
            task('trickplay-generation', [{ id: 'trickplay-generation', appliesTo: ['movie'] }]),
        ];
        const { sql } = sqlStub([{ stage_id: 'trickplay-generation', gap: 42 }]);

        const details = await invariant.details?.(sql);

        expect(details?.[0]).toMatchObject({ label: 'trickplay-generation', count: 42 });
    });
});
