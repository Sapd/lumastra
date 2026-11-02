// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which funnel drops become findings.
 *
 * These rules decide whether an operator is shown a real problem, a fabricated
 * one, or nothing at all — so they are a pure function, tested without a
 * database. The first case below is not hypothetical: it was measured on
 * production before the funnel was built, and the naive version of this logic
 * would have reported a 28,258-file problem on a healthy library.
 *
 * Lives here rather than beside the schema because the default vitest config
 * excludes `src/lib/components/**` — a test placed next to the function it
 * covers would silently never run.
 */

import { describe, it, expect } from 'vitest';
import { findingsFor, type FunnelSegment } from '$lib/components/admin/fix/ingest-funnel.schema.js';

function seg(over: Partial<FunnelSegment> = {}): FunnelSegment {
    return {
        mediaType: 'movie',
        present: 100,
        probed: 100,
        linked: 100,
        identified: 100,
        visible: 100,
        ...over,
    };
}

describe('findingsFor', () => {
    it('reports nothing when every file made it through', () => {
        expect(findingsFor([seg()])).toEqual([]);
    });

    /**
     * The production case. 28,258 of 28,258 music tracks carry no provider id,
     * because tracks are not identified through `external_ids` at all. Reporting
     * that as a drop invents the largest problem on the page out of a library
     * with nothing wrong with it — and buries the 726 episodes that ARE a real
     * finding underneath it.
     */
    it('never reports identification for a type that does not carry provider ids', () => {
        const music = seg({ mediaType: 'track', identified: null });
        expect(findingsFor([music])).toEqual([]);
    });

    it('still reports the other steps for such a type', () => {
        // Not-applicable identification must not silence unrelated failures.
        const music = seg({ mediaType: 'track', identified: null, probed: 90, visible: 95 });
        const found = findingsFor([music]);
        expect(found.map((f) => f.step).sort()).toEqual(['probed', 'visible']);
    });

    /**
     * There is no per-type "linked" step: a segment only holds files that
     * reached an active entry, so linked == present there by construction.
     * Files that reached none are the library-wide orphan / removed-entry
     * counts, and must not also surface as a per-type drop.
     */
    it('reports no linked step, even if linked lags present', () => {
        const s = seg({ present: 100, probed: 100, linked: 60, identified: 60, visible: 60 });
        expect(findingsFor([s]).map((f) => f.step)).not.toContain('linked');
    });

    it('reports identification against linked, not against present', () => {
        const s = seg({ present: 100, probed: 100, linked: 80, identified: 70, visible: 80 });
        const found = findingsFor([s]);
        const ident = found.find((f) => f.step === 'identified');
        expect(ident).toEqual({ mediaType: 'movie', step: 'identified', dropped: 10, outOf: 80 });
    });

    it('orders findings biggest first, across types', () => {
        const movies = seg({ mediaType: 'movie', probed: 93 }); // 7 dropped
        const episodes = seg({ mediaType: 'episode', identified: 26 }); // 74 dropped
        const found = findingsFor([movies, episodes]);
        expect(found.map((f) => `${f.mediaType}:${f.dropped}`)).toEqual(['episode:74', 'movie:7']);
    });

    it('treats a zero-file type as clean rather than dividing by it', () => {
        const empty = seg({ present: 0, probed: 0, linked: 0, identified: 0, visible: 0 });
        expect(findingsFor([empty])).toEqual([]);
    });

    /**
     * Guards a sign error. If a later change ever made `probed` exceed
     * `present`, a naive subtraction would emit a NEGATIVE drop, which renders
     * as a finding claiming files were gained.
     */
    it('emits no finding when a count is impossibly high rather than a negative drop', () => {
        const weird = seg({ present: 10, probed: 12, linked: 12, identified: 12, visible: 12 });
        expect(findingsFor([weird])).toEqual([]);
    });
});
