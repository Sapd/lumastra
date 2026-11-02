// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    budgetCandidate,
    cutToBudget,
    exactSizeIndex,
    MAX_ROWS_RETURNED,
    SERIES_GRADUATION_POLICY,
} from './candidates.js';
import type { SeriesCandidateRow } from '$lib/server/database/queries/series-downloads.queries.js';

function row(overrides: Partial<SeriesCandidateRow> = {}): SeriesCandidateRow {
    return {
        media_id: 'ep-1',
        file_id: 'file-1',
        series_id: 'series-1',
        series_title: 'A Show',
        season_number: 1,
        episode_number: 2,
        duration_ms: String(45 * 60 * 1000),
        source_height: 1080,
        distance: 0,
        series_rank: 1,
        covers_media_ids: ['ep-1'],
        ...overrides,
    };
}

describe('budgetCandidate — the rung clamp', () => {
    it('estimates off the rung the ENCODER will use, not the one requested', () => {
        // THE BUG THAT SHIPPED IN MUSIC, in its video form. A 720p source
        // cannot produce a 1080p encode; budgeting 1080p bytes for it
        // overshoots the device budget on every item, and eviction then fires
        // against files the user wanted.
        const at1080 = budgetCandidate(row({ source_height: 1080 }), '1080p', new Map())!;
        const clamped = budgetCandidate(row({ source_height: 720 }), '1080p', new Map())!;

        expect(clamped.rung.id).toBe('720p');
        expect(clamped.estBytes).toBeLessThan(at1080.estBytes);
    });

    it('returns the clamped rung id so the client POSTs exactly what was budgeted', () => {
        const budgeted = budgetCandidate(row({ source_height: 540 }), '1080p', new Map())!;
        expect(budgeted.rung.id).toBe('540p');
    });

    it('passes the request through unclamped when the source height is unknown', () => {
        const budgeted = budgetCandidate(row({ source_height: null }), '1080p', new Map())!;
        expect(budgeted.rung.id).toBe('1080p');
    });

    it('returns null for an unknown rung rather than substituting one', () => {
        expect(budgetCandidate(row(), 'nonsense', new Map())).toBeNull();
    });
});

describe('budgetCandidate — the byte estimate', () => {
    it('is bitrate x duration for a 720p hour, within the documented ballpark', () => {
        // 720p is 2.5 Mbps video + 128 kbps audio; one hour is ~1.18 GB with
        // the 2% container overhead. Independent of how the SOURCE was encoded
        // — we never download the source.
        const budgeted = budgetCandidate(
            row({ duration_ms: String(60 * 60 * 1000), source_height: 1080 }),
            '720p',
            new Map(),
        )!;
        expect(budgeted.estBytes).toBeGreaterThan(1.1e9);
        expect(budgeted.estBytes).toBeLessThan(1.25e9);
        expect(budgeted.estBytesExact).toBe(false);
    });

    it("prefers a finished artifact's exact size over the estimate", () => {
        const exact = exactSizeIndex([
            { file_id: 'file-1', size_bytes: '1234567890', ready_count: 1 },
        ]);
        const budgeted = budgetCandidate(row(), '720p', exact)!;

        expect(budgeted.estBytes).toBe(1_234_567_890);
        expect(budgeted.estBytesExact).toBe(true);
    });

    it('reports a multi-audio exact size as NOT exact', () => {
        // Several ready rows for one (file, rung) mean we cannot know which
        // audio track the client's POST will resolve to. Largest, flagged
        // inexact.
        const exact = exactSizeIndex([{ file_id: 'file-1', size_bytes: '300', ready_count: 2 }]);
        const budgeted = budgetCandidate(row(), '720p', exact)!;

        expect(budgeted.estBytes).toBe(300);
        expect(budgeted.estBytesExact).toBe(false);
    });

    it('keys the exact-size lookup by (file, clamped rung), not by media id', () => {
        // One artifact, several episodes: the key must be the FILE.
        const exact = exactSizeIndex([{ file_id: 'file-9', size_bytes: '42', ready_count: 1 }]);
        expect(budgetCandidate(row({ file_id: 'file-9' }), '720p', exact)!.estBytes).toBe(42);
        expect(budgetCandidate(row({ file_id: 'file-1' }), '720p', exact)!.estBytesExact).toBe(
            false,
        );
    });

    it('DROPS a candidate whose duration is unknown', () => {
        // A null estimate is affordable for a 4 MB track and not for a 1-3 GB
        // episode: a candidate we cannot budget is a candidate that breaks the
        // budget. The caller counts these into `unbudgetableCount` so the
        // data-quality gap is loud rather than silent.
        expect(budgetCandidate(row({ duration_ms: null }), '720p', new Map())).toBeNull();
        expect(budgetCandidate(row({ duration_ms: '0' }), '720p', new Map())).toBeNull();
    });

    it('keeps an unknown-duration candidate when an exact size exists', () => {
        const exact = exactSizeIndex([{ file_id: 'file-1', size_bytes: '777', ready_count: 1 }]);
        const budgeted = budgetCandidate(row({ duration_ms: null }), '720p', exact)!;
        expect(budgeted.estBytes).toBe(777);
    });
});

describe('cutToBudget', () => {
    function item(id: string, bytes: number) {
        return {
            row: row({ media_id: id, file_id: `f-${id}` }),
            rung: { id: '720p', height: 720, videoBitrate: 1, audioBitrate: 1, label: '720p' },
            estBytes: bytes,
            estBytesExact: false,
        };
    }

    it('emits while the budget is not yet spent, letting the last row straddle', () => {
        // The cut is on the CUMULATIVE TOTAL BEFORE the row, so the last item
        // may cross the boundary and the client chooses whether to take it.
        // Cutting before the boundary instead would leave the budget
        // permanently under-filled for large items.
        const cut = cutToBudget([item('a', 600), item('b', 600), item('c', 600)], 1000);
        expect(cut.map((i) => i.row.media_id)).toEqual(['a', 'b']);
    });

    it('always emits at least the first item, however large', () => {
        const cut = cutToBudget([item('huge', 9_000_000_000)], 1000);
        expect(cut).toHaveLength(1);
    });

    it('preserves the input ordering', () => {
        const cut = cutToBudget([item('a', 1), item('b', 1), item('c', 1)], 1_000_000);
        expect(cut.map((i) => i.row.media_id)).toEqual(['a', 'b', 'c']);
    });

    it('charges a combined multi-episode file ONCE', () => {
        // One row per file comes out of the query (DISTINCT ON file_id), so a
        // double episode occupies one budget slot: its charge is estBytes
        // (900), not estBytes x covers_media_ids.length (1800). Charging it
        // once leaves room for `d` to also fit in the 1000 budget — charging
        // it per covered id would have pushed cumulative spend to 1800 before
        // `d` and evicted it instead. Length 2 is the proof of "once"; a
        // length of 1 here would mean the double-charge bug is back.
        const combined = {
            ...item('ep-2', 900),
            row: row({ media_id: 'ep-2', file_id: 'file-x', covers_media_ids: ['ep-2', 'ep-3'] }),
        };
        const cut = cutToBudget([combined, item('d', 900)], 1000);

        expect(cut).toHaveLength(2);
        expect(cut[0]!.row.covers_media_ids).toEqual(['ep-2', 'ep-3']);
    });

    it('returns nothing for a zero budget', () => {
        expect(cutToBudget([item('a', 1)], 0)).toEqual([]);
    });
});

describe('lane constants', () => {
    it("advertises deletion as this lane's graduation policy", () => {
        // Terminal for series: a consumed episode's bytes are released. Music's
        // lane advertises `retain`. Same wire status, opposite consequence,
        // which is exactly why the consequence travels as data.
        expect(SERIES_GRADUATION_POLICY).toBe('delete');
    });

    it('bounds the returned row count', () => {
        expect(MAX_ROWS_RETURNED).toBeLessThanOrEqual(500);
    });
});
