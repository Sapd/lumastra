// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    filterIdentity,
    shouldClearSelection,
    summarise,
    refreshSelection,
    SELECTION_MAX,
    type SelectedRow,
} from './selection.js';

/** Build a URLSearchParams the way `+page.svelte` would for a given view. */
function paramsFor(overrides: Record<string, string>): URLSearchParams {
    return new URLSearchParams(overrides);
}

describe('filterIdentity', () => {
    it('ignores page: paging through the same filtered view keeps the same identity', () => {
        // Revert reasoning: if `filterIdentity` started including `page`, this
        // would fail because turning the page would produce a different string.
        const page1 = paramsFor({ domain: 'video', type: 'movie', page: '1', sort: 'title' });
        const page7 = paramsFor({ domain: 'video', type: 'movie', page: '7', sort: 'title' });
        expect(filterIdentity(page1)).toBe(filterIdentity(page7));
    });

    it('ignores sort and order: re-sorting the same view keeps the same identity', () => {
        // Revert reasoning: if `sort`/`order` were folded into the identity,
        // clicking a column header would look like a real filter change.
        const asc = paramsFor({ domain: 'video', type: 'movie', sort: 'title', order: 'asc' });
        const desc = paramsFor({ domain: 'video', type: 'movie', sort: 'year', order: 'desc' });
        expect(filterIdentity(asc)).toBe(filterIdentity(desc));
    });

    it('changes with every real filter dimension', () => {
        // Revert reasoning: if any of these keys were dropped from
        // `FILTER_IDENTITY_PARAMS`, the corresponding pair would collapse to
        // an equal string and this assertion would fail.
        const base = paramsFor({
            view: 'artwork',
            domain: 'video',
            type: 'movie',
            library: 'lib-1',
            q: 'matrix',
            unavailable: '1',
            dismissed: '1',
            missing_tmdb: '1',
            missing_jf: '1',
            missing_poster: '1',
            missing_overview: '1',
            has_embedding: '1',
            locked: '1',
            local_only: '1',
            custom_poster: '1',
            added_since: '7d',
            updated_since: '7d',
            filter: 'file-issues',
        });
        const baseIdentity = filterIdentity(base);

        const variedKeys: Record<string, string> = {
            view: 'recent',
            domain: 'audiobook',
            type: 'tv',
            library: 'lib-2',
            q: 'other',
            unavailable: '0',
            dismissed: '0',
            missing_tmdb: '0',
            missing_jf: '0',
            missing_poster: '0',
            missing_overview: '0',
            has_embedding: '0',
            locked: '0',
            local_only: '0',
            custom_poster: '0',
            added_since: '30d',
            updated_since: '30d',
            filter: '',
        };

        for (const [key, newValue] of Object.entries(variedKeys)) {
            const changed = new URLSearchParams(base);
            changed.set(key, newValue);
            expect(filterIdentity(changed), `changing "${key}" must change the identity`).not.toBe(
                baseIdentity,
            );
        }
    });
});

describe('shouldClearSelection', () => {
    it('is false across a page turn', () => {
        // Revert reasoning: fails if the effect driving this were rewired to
        // clear on any `data.items` change again (the original bug) — the
        // identity itself already proves paging cannot change it, and this
        // asserts the behavioural consequence.
        const before = filterIdentity(paramsFor({ domain: 'video', type: 'movie', page: '1' }));
        const after = filterIdentity(paramsFor({ domain: 'video', type: 'movie', page: '2' }));
        expect(shouldClearSelection(before, after)).toBe(false);
    });

    it('is false across a sort change', () => {
        const before = filterIdentity(
            paramsFor({ domain: 'video', type: 'movie', sort: 'title', order: 'asc' }),
        );
        const after = filterIdentity(
            paramsFor({ domain: 'video', type: 'movie', sort: 'created_at', order: 'desc' }),
        );
        expect(shouldClearSelection(before, after)).toBe(false);
    });

    it('is true across a real filter change', () => {
        const before = filterIdentity(paramsFor({ domain: 'video', type: 'movie' }));
        const after = filterIdentity(paramsFor({ domain: 'video', type: 'tv' }));
        expect(shouldClearSelection(before, after)).toBe(true);
    });

    it('is true when an advanced filter toggles, holding page/sort fixed', () => {
        const before = filterIdentity(
            paramsFor({ domain: 'video', type: 'movie', page: '3', sort: 'title' }),
        );
        const after = filterIdentity(
            paramsFor({
                domain: 'video',
                type: 'movie',
                page: '3',
                sort: 'title',
                locked: '1',
            }),
        );
        expect(shouldClearSelection(before, after)).toBe(true);
    });
});

describe('summarise', () => {
    it('counts nothing over an empty set', () => {
        expect(summarise([])).toEqual({ total: 0, byType: {}, withChildren: 0 });
    });

    it('counts types and children over a mixed set', () => {
        // Revert reasoning: fails if `byType` stopped grouping per mediaType,
        // or if `withChildren` counted rows with `childCount === 0`.
        const rows: SelectedRow[] = [
            { id: '1', mediaType: 'tv', childCount: 12, hasFiles: true },
            { id: '2', mediaType: 'tv', childCount: 0, hasFiles: true },
            { id: '3', mediaType: 'movie', childCount: 0, hasFiles: true },
            { id: '4', mediaType: 'season', childCount: 4, hasFiles: false },
        ];
        expect(summarise(rows)).toEqual({
            total: 4,
            byType: { tv: 2, movie: 1, season: 1 },
            withChildren: 2,
        });
    });
});

describe('refreshSelection', () => {
    it("updates a selected row's snapshot when it reappears with new values (e.g. after invalidateAll())", () => {
        // Revert reasoning: this is the bulkDelete child-skip regression —
        // bulkSync(true) can grow a series' childCount server-side without
        // clearing the selection. If refreshSelection stopped overwriting a
        // matched id (e.g. returned `next` without the `next.set(row.id, row)`
        // line), this row would keep childCount: 0 forever and the assertion
        // below would fail.
        const selected = new Map<string, SelectedRow>([
            ['series-1', { id: 'series-1', mediaType: 'tv', childCount: 0, hasFiles: false }],
        ]);
        const freshRows: SelectedRow[] = [
            { id: 'series-1', mediaType: 'tv', childCount: 12, hasFiles: false },
        ];
        const refreshed = refreshSelection(selected, freshRows);
        expect(refreshed.get('series-1')).toEqual({
            id: 'series-1',
            mediaType: 'tv',
            childCount: 12,
            hasFiles: false,
        });
    });

    it('keeps a selected row absent from the fresh page untouched, and does not drop it', () => {
        // Revert reasoning: if refreshSelection were implemented by rebuilding
        // the map from `freshRows` alone (e.g. `new Map(freshRows.map(...))`)
        // instead of starting from `selected`, an off-page id would vanish —
        // silently re-breaking cross-page selection, the exact bug
        // filterIdentity/shouldClearSelection exist to prevent.
        const offPageRow: SelectedRow = {
            id: 'off-page-1',
            mediaType: 'movie',
            childCount: 0,
            hasFiles: true,
        };
        const selected = new Map<string, SelectedRow>([['off-page-1', offPageRow]]);
        const freshRows: SelectedRow[] = [
            { id: 'on-page-1', mediaType: 'movie', childCount: 0, hasFiles: true },
        ];
        const refreshed = refreshSelection(selected, freshRows);
        expect(refreshed.has('off-page-1')).toBe(true);
        expect(refreshed.get('off-page-1')).toBe(offPageRow);
    });

    it('never adds a fresh row that was not already selected', () => {
        // Revert reasoning: fails if refreshSelection started unconditionally
        // adding every fresh row instead of only updating existing keys —
        // that would turn a "refresh" into a "select everything visible".
        const selected = new Map<string, SelectedRow>();
        const freshRows: SelectedRow[] = [
            { id: 'unselected-1', mediaType: 'movie', childCount: 0, hasFiles: true },
        ];
        const refreshed = refreshSelection(selected, freshRows);
        expect(refreshed.size).toBe(0);
    });
});

describe('SELECTION_MAX', () => {
    /**
     * The value half of the select-all cap. `page.svelte.test.ts` proves the
     * page ENFORCES the cap (it mocks this constant down, because a genuine
     * 1,001-row render times out under suite load); this pins WHAT the cap is,
     * so neither half can drift without a failure.
     *
     * 1,000 is not arbitrary: it is exactly two chunks of the 500-id ceiling
     * `bulk-lock` and `bulk-sync` both enforce. Raising it means either raising
     * those caps or accepting more than two chunks per batch.
     */
    it("is 1,000 — two chunks of the endpoints' own 500-id cap", () => {
        expect(SELECTION_MAX).toBe(1000);
        expect(SELECTION_MAX % 500).toBe(0);
    });
});
