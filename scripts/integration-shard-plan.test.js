// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the duration-balanced integration shard plan.
 *
 * The property that matters is safety, not speed: the shards must be a PARTITION of the
 * candidate list (no file dropped, none run twice), and every shard must compute the same
 * plan. Balance is checked against the shape that motivated the plan (a few very long files
 * among many short ones).
 *
 * Run: npx vitest run scripts/integration-shard-plan.test.js
 */

import { describe, it, expect } from 'vitest';
import { planShards, timingsFromLogs } from './integration-shard-plan.mjs';

const files = Array.from(
    { length: 60 },
    (_, i) => `src/a/f${String(i).padStart(2, '0')}.integration.test.ts`,
);
const timings = {
    defaultSeconds: 1,
    perFileOverheadSeconds: 1.5,
    files: { [files[3]]: 220, [files[7]]: 100, [files[11]]: 62, [files[20]]: 40, [files[21]]: 40 },
};

describe('planShards', () => {
    it('partitions the candidates: nothing dropped, nothing duplicated', () => {
        for (const total of [1, 2, 7, 8, 12, 60, 80]) {
            const { plan } = planShards(files, timings, total);
            expect(plan).toHaveLength(total);
            expect(plan.flat().sort()).toEqual([...files].sort());
        }
    });

    it('is deterministic and independent of the input order', () => {
        const a = planShards(files, timings, 8).plan;
        const b = planShards([...files].reverse(), timings, 8).plan;
        expect(b).toEqual(a);
    });

    it('keeps the heaviest shard within one file of the lower bound', () => {
        const { load } = planShards(files, timings, 8);
        const cost = (f) => (timings.files[f] ?? 1) + 1.5;
        const sum = files.reduce((a, f) => a + cost(f), 0);
        const longest = Math.max(...files.map(cost));
        expect(Math.max(...load)).toBeLessThanOrEqual(
            Math.max(sum / 8 + longest / 2, longest) + 1e-9,
        );
        // Count-based sharding would put the 220 s file together with ~7 others: the plan must not.
        expect(Math.max(...load) - Math.min(...load)).toBeLessThan(longest);
    });

    it('falls back to even counts without timings', () => {
        const { plan } = planShards(files, {}, 8);
        const sizes = plan.map((p) => p.length);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    });

    it('leaves surplus shards empty instead of inventing files', () => {
        const { plan } = planShards(files.slice(0, 3), timings, 5);
        expect(plan.filter((p) => p.length === 0)).toHaveLength(2);
    });

    it('rejects an invalid shard count', () => {
        expect(() => planShards(files, timings, 0)).toThrow();
        expect(() => planShards(files, timings, 2.5)).toThrow();
    });
});

describe('timingsFromLogs', () => {
    it('averages per-file durations over logs, with or without shard prefixes and colours', () => {
        const a =
            ' \u001b[32m✓\u001b[39m src/x.integration.test.ts \u001b[2m(3 tests)\u001b[22m \u001b[33m2000ms\u001b[39m\n';
        const b =
            '[s2/4]  ✓ src/x.integration.test.ts (3 tests) 4000ms\n❯ src/y.integration.test.ts (2 tests | 1 failed) 500ms\nnoise\n';
        expect(timingsFromLogs([a, b])).toEqual({
            'src/x.integration.test.ts': 3,
            'src/y.integration.test.ts': 0.5,
        });
    });
});
