// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./segments.ts', import.meta.url)), 'utf8');

describe('admin media-segment clear locking', () => {
    it('derives parent targets in stable ID order', () => {
        const start = source.indexOf('async function getClearTargetMediaIds(');
        // The following analysis-only helper has its own ordering; this guard
        // pins the two branches used by DELETE, including deleted descendants.
        const end = source.indexOf('\n/** Analysis never includes', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const helper = source.slice(start, end);

        expect(helper.match(/ORDER BY/g)).toHaveLength(2);
        expect(helper).toContain('ORDER BY id');
        expect(helper).toContain('ORDER BY ep.id');
    });

    it('locks every target before deleting candidates, then materialized rows', () => {
        const start = source.indexOf('DELETE: async');
        const end = source.indexOf('POST: async', start);
        const handler = source.slice(start, end);
        const lock = handler.indexOf('acquireMediaSegmentResolutionLocks');
        const generation = handler.indexOf('bumpMediaSegmentAnalysisGeneration');
        const candidates = handler.indexOf('deleteCandidatesFor');
        const segments = handler.indexOf('deleteSegmentsByMediaIds');

        expect(lock).toBeGreaterThan(-1);
        expect(lock).toBeLessThan(handler.indexOf('getClearTargetMediaIds'));
        expect(lock).toBeLessThan(generation);
        expect(generation).toBeLessThan(candidates);
        expect(lock).toBeLessThan(candidates);
        expect(candidates).toBeLessThan(segments);
    });
});
