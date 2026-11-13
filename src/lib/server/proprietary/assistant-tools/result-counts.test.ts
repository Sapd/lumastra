// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * These assertions guard a DATA-SHAPE fix, not a formatting preference: three
 * prompt rules failed to stop the model reporting a page as a library total,
 * so the payload itself had to stop inviting it. If a refactor renames the
 * field back to `count`, or makes the marker conditional again, the class of
 * bug comes straight back.
 */

import { describe, it, expect } from 'vitest';
import { resultCounts, completeResultCounts } from './result-counts.js';
import { summarizeMediaForModel } from './media-summary.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';

const row = { media_id: 'm1', primary_ext_id: '550', media_type: 'movie', title: 'X' };

describe('resultCounts', () => {
    it('never emits a bare `count`', () => {
        expect(resultCounts(3, 10)).not.toHaveProperty('count');
        expect(resultCounts(3, 10).returnedCount).toBe(3);
    });

    it('emits the page marker even when the page is NOT full', () => {
        // The old shape only spoke up on a full page, so silence read as
        // "this is everything" — which is precisely what was relayed.
        const partial = resultCounts(3, 10);
        expect(partial.maybeMore).toBe(false);
        expect(partial.countNote).toMatch(/not a library-wide total/i);
    });

    it('flags a full page as possibly truncated', () => {
        const full = resultCounts(10, 10);
        expect(full.maybeMore).toBe(true);
        expect(full.countNote).toMatch(/insgesamt/);
    });

    it('treats an unknown limit as a page, never as a total', () => {
        expect(resultCounts(4).maybeMore).toBe(false);
        expect(resultCounts(4).countNote).toMatch(/not a library-wide total/i);
    });

    it('lets an exhaustive call say the number IS the total', () => {
        expect(completeResultCounts(2)).toEqual({
            returnedCount: 2,
            maybeMore: false,
            countNote: expect.stringMatching(/complete list/i),
        });
    });
});

describe('summarizeMediaForModel — count shape', () => {
    it('uses the shared marker for results and for the empty case alike', () => {
        const full = JSON.parse(summarizeMediaForModel([row] as unknown as AssistantMovieRow[], 1));
        expect(full).toMatchObject({ returnedCount: 1, maybeMore: true });
        expect(full).not.toHaveProperty('count');

        const empty = JSON.parse(summarizeMediaForModel([], 10));
        expect(empty).toMatchObject({ returnedCount: 0, maybeMore: false });
        expect(empty.countNote).toBeTruthy();
    });
});
