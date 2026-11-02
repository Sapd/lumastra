// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The one count shape every list-returning assistant tool emits.
 *
 * WHY: the field used to be a bare `count`, and no number of prompt rules
 * stopped the model reading it as a census — "insgesamt zehn neue Titel",
 * "wir haben 10 Tom-Hanks-Filme" — where ten was simply the limit. Three
 * instructions against it were not enough, so the fix lives in the data
 * instead: the field is named after what it actually is (rows THIS call
 * returned), and the page marker ships on EVERY list result. Emitting it only
 * on a full page made its absence read as a promise that the list was
 * complete, and the inconsistency between tools is part of why the rule never
 * stuck.
 *
 * @module server/proprietary/assistant-tools/result-counts
 */

/** Count fields spread into a tool's `summaryForModel` payload. */
export interface ResultCountFields {
    /** Rows THIS call returned — a page size, not a library total. */
    returnedCount: number;
    /** True when the page filled up, so rows may exist beyond it. */
    maybeMore: boolean;
    /** Model-facing gloss of the two fields above. */
    countNote: string;
}

const FULL_PAGE_NOTE =
    'returnedCount is the size of THIS page (it hit the requested limit) — more may exist. Never state it as a total: say "here are N", not "there are N" / "insgesamt N".';
const PARTIAL_PAGE_NOTE =
    'returnedCount is what this call returned, not a library-wide total. Say "here are N", not "there are N".';
const COMPLETE_NOTE =
    'This call returns the complete list, so returnedCount IS the total and may be stated as one.';

/**
 * Counts for a LIMITED call. `maybeMore` is deliberately conservative: a result
 * that exactly fills the page might be complete, and "may be more" is the
 * honest direction to be wrong in. An unknown limit stays a page, not a total.
 */
export function resultCounts(returnedCount: number, limit?: number): ResultCountFields {
    const maybeMore = limit !== undefined && returnedCount >= limit;
    return {
        returnedCount,
        maybeMore,
        countNote: maybeMore ? FULL_PAGE_NOTE : PARTIAL_PAGE_NOTE,
    };
}

/**
 * Counts for an EXHAUSTIVE call — one with no limit at all, where the rows
 * really are everything (the user's playlists, the accessible libraries). Only
 * here may the model state the number as a total.
 */
export function completeResultCounts(returnedCount: number): ResultCountFields {
    return { returnedCount, maybeMore: false, countNote: COMPLETE_NOTE };
}
