// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { decideDeleteFailureAction } from './detail-actions.js';

// Applicability rules for the detail header's Play/Watch/Reorder/Unlock/
// Delete controls used to live here as `detailActionApplies`. They migrated
// to the cross-surface registry at
// `$lib/components/admin/media/media-actions.ts` (spec §4.4) — see
// media-actions.test.ts for that coverage, which is a superset of what this
// file used to test (it also proves delete applies on the selection and
// bulk-bar surfaces, which this route never had a rule for).

describe('decideDeleteFailureAction', () => {
    it('offers a cascade confirmation when a 409 reports child items', () => {
        const result = decideDeleteFailureAction(409, JSON.stringify({ childCount: 12 }));
        expect(result).toEqual({ kind: 'confirmCascade', childCount: 12 });
    });

    it('reports a generic error for a 409 with no cascade-eligible children', () => {
        expect(decideDeleteFailureAction(409, JSON.stringify({ childCount: 0 }))).toEqual({
            kind: 'reportError',
        });
        expect(decideDeleteFailureAction(409, JSON.stringify({}))).toEqual({
            kind: 'reportError',
        });
    });

    it('reports a generic error for a non-409 failure, even with a childCount-shaped body', () => {
        // A 500 (or any non-409) is never a cascade opportunity, regardless of
        // what its body happens to contain.
        expect(decideDeleteFailureAction(500, JSON.stringify({ childCount: 12 }))).toEqual({
            kind: 'reportError',
        });
    });

    it('reports the error when a cascade delete is refused, instead of asking again', () => {
        // The server answers a cascade over LUMASTRA_CASCADE_DELETE_MAX with the
        // same 409 + childCount shape; re-prompting would loop silently.
        expect(
            decideDeleteFailureAction(409, JSON.stringify({ childCount: 99_999 }), {
                cascade: true,
            }),
        ).toEqual({ kind: 'reportError' });
    });
});
