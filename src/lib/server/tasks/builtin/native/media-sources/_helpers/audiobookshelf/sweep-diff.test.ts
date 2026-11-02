// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    planAudiobookSweep,
    normalizeDismissalRatio,
    DEFAULT_MAX_DISMISSAL_RATIO,
    DEFAULT_MIN_DISMISSAL_ALLOWANCE,
    type LocalAudiobookState,
    type RemoteAudiobookState,
} from './sweep-diff.js';

function remote(overrides: Partial<RemoteAudiobookState> & { id: string }): RemoteAudiobookState {
    return {
        updatedAt: 1_000,
        mtimeMs: 2_000,
        isMissing: false,
        ...overrides,
    };
}

function local(
    overrides: Partial<LocalAudiobookState> & { absItemId: string },
): LocalAudiobookState {
    return {
        mediaId: `media-${overrides.absItemId}`,
        status: 'active',
        hasFiles: true,
        isDismissed: false,
        absUpdatedAt: 1_000,
        absMtimeMs: 2_000,
        ...overrides,
    };
}

/** A library of `count` books that are perfectly in sync on both sides. */
function inSyncLibrary(count: number): {
    remote: RemoteAudiobookState[];
    local: LocalAudiobookState[];
} {
    const ids = Array.from({ length: count }, (_, i) => `book-${i}`);
    return {
        remote: ids.map((id) => remote({ id })),
        local: ids.map((absItemId) => local({ absItemId })),
    };
}

describe('planAudiobookSweep — per-item classification', () => {
    it('queues an addition for an upstream id with no local row', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'new-book' })],
            local: [],
            snapshotComplete: true,
        });

        expect(plan.additions.map((a) => a.id)).toEqual(['new-book']);
        expect(plan.changes).toEqual([]);
        expect(plan.dismissals).toEqual([]);
        expect(plan.dismissalSkip).toBeNull();
    });

    it('leaves an unchanged book alone', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'a', updatedAt: 10, mtimeMs: 20 })],
            local: [local({ absItemId: 'a', absUpdatedAt: 10, absMtimeMs: 20 })],
            snapshotComplete: true,
        });

        expect(plan.additions).toEqual([]);
        expect(plan.changes).toEqual([]);
        expect(plan.unchanged.map((u) => u.absItemId)).toEqual(['a']);
    });

    it('requests a refetch when updatedAt moved', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'a', updatedAt: 11, mtimeMs: 20 })],
            local: [local({ absItemId: 'a', absUpdatedAt: 10, absMtimeMs: 20 })],
            snapshotComplete: true,
        });

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0].needsRefetch).toBe(true);
        expect(plan.changes[0].hasFiles).toBe(true);
        expect(plan.changes[0].clearsDismissal).toBe(false);
    });

    it('requests a refetch when ONLY mtimeMs moved (file replaced, metadata untouched)', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'a', updatedAt: 10, mtimeMs: 99 })],
            local: [local({ absItemId: 'a', absUpdatedAt: 10, absMtimeMs: 20 })],
            snapshotComplete: true,
        });

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0].needsRefetch).toBe(true);
    });

    it('requests a refetch when a revision key was never recorded', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'a' })],
            local: [local({ absItemId: 'a', absUpdatedAt: null, absMtimeMs: null })],
            snapshotComplete: true,
        });

        expect(plan.changes[0].needsRefetch).toBe(true);
    });

    it('maps isMissing to has_files=false without any delete or dismissal', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'a', isMissing: true })],
            local: [local({ absItemId: 'a', hasFiles: true })],
            snapshotComplete: true,
        });

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0].hasFiles).toBe(false);
        // No revision moved — the file just vanished, so no expanded fetch.
        expect(plan.changes[0].needsRefetch).toBe(false);
        expect(plan.dismissals).toEqual([]);
        expect(plan.absentUpstream).toEqual([]);
    });

    it('restores has_files when a previously missing book comes back', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'a', isMissing: false })],
            local: [local({ absItemId: 'a', hasFiles: false })],
            snapshotComplete: true,
        });

        expect(plan.changes[0].hasFiles).toBe(true);
        expect(plan.changes[0].needsRefetch).toBe(false);
    });

    it('clears a dismissal when the id reappears upstream', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'a' })],
            local: [local({ absItemId: 'a', isDismissed: true, hasFiles: false })],
            snapshotComplete: true,
        });

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0].clearsDismissal).toBe(true);
        expect(plan.changes[0].hasFiles).toBe(true);
    });

    it('dismisses a book that is absent upstream', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'a' })],
            local: [local({ absItemId: 'a' }), local({ absItemId: 'gone' })],
            snapshotComplete: true,
        });

        expect(plan.dismissals.map((d) => d.absItemId)).toEqual(['gone']);
        expect(plan.absentUpstream.map((d) => d.absItemId)).toEqual(['gone']);
        expect(plan.dismissalSkip).toBeNull();
    });

    it('never touches a row an operator moved out of status=active', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'a', updatedAt: 999 })],
            local: [local({ absItemId: 'a', status: 'deleted' })],
            snapshotComplete: true,
        });

        expect(plan.skippedInactive.map((r) => r.absItemId)).toEqual(['a']);
        expect(plan.changes).toEqual([]);
        expect(plan.dismissals).toEqual([]);
        // Critically: the id is NOT re-added, or the insert would collide with
        // the surviving external_ids row.
        expect(plan.additions).toEqual([]);
    });

    it('ignores duplicate upstream entries for the same id', () => {
        const plan = planAudiobookSweep({
            remote: [
                remote({ id: 'a', updatedAt: 10, mtimeMs: 20 }),
                remote({ id: 'a', updatedAt: 77, mtimeMs: 88 }),
            ],
            local: [local({ absItemId: 'a', absUpdatedAt: 10, absMtimeMs: 20 })],
            snapshotComplete: true,
        });

        expect(plan.duplicateRemoteIds).toBe(1);
        // First occurrence wins, so the in-sync row stays in sync.
        expect(plan.changes).toEqual([]);
        expect(plan.unchanged).toHaveLength(1);
    });

    it('classifies a mixed library correctly in one pass', () => {
        const plan = planAudiobookSweep({
            remote: [
                remote({ id: 'same', updatedAt: 1, mtimeMs: 1 }),
                remote({ id: 'edited', updatedAt: 2, mtimeMs: 1 }),
                remote({ id: 'missing', isMissing: true, updatedAt: 1, mtimeMs: 1 }),
                remote({ id: 'brand-new' }),
            ],
            local: [
                local({ absItemId: 'same', absUpdatedAt: 1, absMtimeMs: 1 }),
                local({ absItemId: 'edited', absUpdatedAt: 1, absMtimeMs: 1 }),
                local({ absItemId: 'missing', absUpdatedAt: 1, absMtimeMs: 1 }),
                local({ absItemId: 'vanished' }),
                local({ absItemId: 'vanished-2' }),
            ],
            snapshotComplete: true,
            // 2 of 5 = 40%, so raise the cap to keep this test about
            // classification rather than the rail.
            thresholds: { maxDismissalRatio: 1 },
        });

        expect(plan.additions.map((a) => a.id)).toEqual(['brand-new']);
        expect(plan.unchanged.map((u) => u.absItemId)).toEqual(['same']);
        expect(
            plan.changes.map((c) => ({
                id: c.remote.id,
                refetch: c.needsRefetch,
                hasFiles: c.hasFiles,
            })),
        ).toEqual([
            { id: 'edited', refetch: true, hasFiles: true },
            { id: 'missing', refetch: false, hasFiles: false },
        ]);
        expect(plan.dismissals.map((d) => d.absItemId)).toEqual(['vanished', 'vanished-2']);
    });
});

describe('planAudiobookSweep — rail 1: incomplete upstream listing', () => {
    it('skips the whole dismissal pass when the snapshot is not complete', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'a' })],
            local: [local({ absItemId: 'a' }), local({ absItemId: 'gone' })],
            snapshotComplete: false,
        });

        expect(plan.dismissals).toEqual([]);
        expect(plan.dismissalSkip).toEqual({
            reason: 'snapshot-incomplete',
            message: expect.stringContaining('incomplete'),
            candidates: 1,
        });
        // The candidate is still reported so telemetry does not read "0 removed".
        expect(plan.absentUpstream.map((r) => r.absItemId)).toEqual(['gone']);
    });

    it('still applies additions and updates when the snapshot is incomplete', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'new' }), remote({ id: 'edited', updatedAt: 5 })],
            local: [local({ absItemId: 'edited', absUpdatedAt: 4 }), local({ absItemId: 'gone' })],
            snapshotComplete: false,
        });

        expect(plan.additions.map((a) => a.id)).toEqual(['new']);
        expect(plan.changes.map((c) => c.remote.id)).toEqual(['edited']);
        expect(plan.dismissals).toEqual([]);
    });

    it('reports the incomplete snapshot even when the count would be under the cap', () => {
        // 1 of 200 is well under 10%; the reason must still be the real one.
        const { remote: r, local: l } = inSyncLibrary(200);
        const plan = planAudiobookSweep({
            remote: r.slice(1),
            local: l,
            snapshotComplete: false,
        });

        expect(plan.dismissalSkip?.reason).toBe('snapshot-incomplete');
    });

    it('does not flag a skip when nothing was absent upstream anyway', () => {
        const { remote: r, local: l } = inSyncLibrary(5);
        const plan = planAudiobookSweep({ remote: r, local: l, snapshotComplete: false });

        expect(plan.dismissalSkip).toBeNull();
        expect(plan.dismissals).toEqual([]);
    });
});

describe('planAudiobookSweep — rail 2: dismissal threshold', () => {
    it('aborts the pass when more than 10% of a library would be dismissed', () => {
        const { remote: r, local: l } = inSyncLibrary(100);
        // Drop 11 books upstream → 11% > 10%.
        const plan = planAudiobookSweep({
            remote: r.slice(11),
            local: l,
            snapshotComplete: true,
        });

        expect(plan.dismissals).toEqual([]);
        expect(plan.dismissalSkip?.reason).toBe('threshold-exceeded');
        expect(plan.dismissalSkip).toMatchObject({
            candidates: 11,
            total: 100,
            allowed: 10,
            thresholdRatio: DEFAULT_MAX_DISMISSAL_RATIO,
        });
        expect(plan.absentUpstream).toHaveLength(11);
    });

    it('allows a dismissal count exactly at the cap', () => {
        const { remote: r, local: l } = inSyncLibrary(100);
        const plan = planAudiobookSweep({ remote: r.slice(10), local: l, snapshotComplete: true });

        expect(plan.dismissalSkip).toBeNull();
        expect(plan.dismissals).toHaveLength(10);
    });

    it('aborts the pass ENTIRELY rather than dismissing up to the cap', () => {
        const { local: l } = inSyncLibrary(100);
        const plan = planAudiobookSweep({ remote: [], local: l, snapshotComplete: true });

        // A partial dismissal would normalise the damage and let the next cycle
        // (facing a smaller remainder) slip under the cap and finish the job.
        expect(plan.dismissals).toEqual([]);
        expect(plan.dismissalSkip).toMatchObject({ candidates: 100, ratio: 1 });
    });

    it('honours an operator-supplied cap', () => {
        const { remote: r, local: l } = inSyncLibrary(100);
        const plan = planAudiobookSweep({
            remote: r.slice(25),
            local: l,
            snapshotComplete: true,
            thresholds: { maxDismissalRatio: 0.5 },
        });

        expect(plan.dismissalSkip).toBeNull();
        expect(plan.dismissals).toHaveLength(25);
    });

    it('does not count inactive rows towards the denominator', () => {
        // 10 active + 90 soft-deleted. 2 absent upstream is 20% of the active
        // population, so the floor (3) is what permits it — not a denominator
        // inflated by rows the sweep can never dismiss.
        const active = Array.from({ length: 10 }, (_, i) => local({ absItemId: `a-${i}` }));
        const inactive = Array.from({ length: 90 }, (_, i) =>
            local({ absItemId: `d-${i}`, status: 'deleted' }),
        );
        const plan = planAudiobookSweep({
            remote: active.slice(2).map((row) => remote({ id: row.absItemId })),
            local: [...active, ...inactive],
            snapshotComplete: true,
        });

        expect(plan.dismissalSkip).toBeNull();
        expect(plan.dismissals).toHaveLength(2);
        expect(plan.skippedInactive).toHaveLength(90);
    });

    it('permits the minimum allowance so tiny libraries are not frozen forever', () => {
        // 10% of 9 books is 0.9 → floor 0. Without the allowance this library
        // could never lose a book and would raise a threshold error every cycle.
        const { remote: r, local: l } = inSyncLibrary(9);
        const plan = planAudiobookSweep({ remote: r.slice(1), local: l, snapshotComplete: true });

        expect(plan.dismissalSkip).toBeNull();
        expect(plan.dismissals).toHaveLength(1);
    });

    it('still caps a tiny library once the allowance is exceeded', () => {
        const { remote: r, local: l } = inSyncLibrary(9);
        const plan = planAudiobookSweep({
            remote: r.slice(DEFAULT_MIN_DISMISSAL_ALLOWANCE + 1),
            local: l,
            snapshotComplete: true,
        });

        expect(plan.dismissalSkip?.reason).toBe('threshold-exceeded');
        expect(plan.dismissals).toEqual([]);
    });

    it('checks the incomplete-snapshot rail before the threshold rail', () => {
        const { remote: r, local: l } = inSyncLibrary(100);
        const plan = planAudiobookSweep({ remote: r.slice(50), local: l, snapshotComplete: false });

        expect(plan.dismissalSkip?.reason).toBe('snapshot-incomplete');
    });
});

describe('planAudiobookSweep — already-dismissed rows do not ratchet the rail shut', () => {
    /** `count` books absent upstream that the sweep already dismissed. */
    function dismissedRows(count: number, prefix = 'gone'): LocalAudiobookState[] {
        return Array.from({ length: count }, (_, i) =>
            local({ absItemId: `${prefix}-${i}`, isDismissed: true, hasFiles: false }),
        );
    }

    it('does not re-count a row that already carries the dismissal state', () => {
        const plan = planAudiobookSweep({
            remote: [],
            local: dismissedRows(1),
            snapshotComplete: true,
        });

        expect(plan.absentUpstream).toEqual([]);
        expect(plan.alreadyDismissed.map((r) => r.absItemId)).toEqual(['gone-0']);
        expect(plan.dismissals).toEqual([]);
        expect(plan.dismissalSkip).toBeNull();
    });

    it('keeps dismissing new absences after accumulated dismissals pass the cap', () => {
        // 100-book library: 20 dismissed on earlier cycles (double the 10% cap)
        // plus one that vanished just now. Counting the old ones would return
        // 'threshold-exceeded' forever and permanently freeze the rail.
        const present = Array.from({ length: 79 }, (_, i) => local({ absItemId: `here-${i}` }));
        const newlyGone = local({ absItemId: 'newly-gone' });
        const plan = planAudiobookSweep({
            remote: present.map((row) => remote({ id: row.absItemId })),
            local: [...present, newlyGone, ...dismissedRows(20)],
            snapshotComplete: true,
        });

        expect(plan.dismissalSkip).toBeNull();
        expect(plan.dismissals.map((r) => r.absItemId)).toEqual(['newly-gone']);
        expect(plan.alreadyDismissed).toHaveLength(20);
    });

    it('still treats a half-dismissed row as a candidate', () => {
        // `is_dismissed` without `has_files = false` leaves a live Listen button
        // (only admin/cleanup queries read is_dismissed), so the write is still
        // owed and the row must stay a candidate.
        const plan = planAudiobookSweep({
            remote: [],
            local: [local({ absItemId: 'half', isDismissed: true, hasFiles: true })],
            snapshotComplete: true,
        });

        expect(plan.alreadyDismissed).toEqual([]);
        expect(plan.dismissals.map((r) => r.absItemId)).toEqual(['half']);
    });

    it('resurrects an already-dismissed row the moment its id returns upstream', () => {
        const plan = planAudiobookSweep({
            remote: [remote({ id: 'gone-0' })],
            local: dismissedRows(1),
            snapshotComplete: true,
        });

        expect(plan.alreadyDismissed).toEqual([]);
        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]).toMatchObject({ clearsDismissal: true, hasFiles: true });
    });

    it('counts already-dismissed rows in the denominator but never as candidates', () => {
        // 50 present + 50 long-dismissed. 5 newly gone is 10% of the 100 rows
        // the connector owns — at the cap, so it proceeds.
        const present = Array.from({ length: 45 }, (_, i) => local({ absItemId: `here-${i}` }));
        const newlyGone = Array.from({ length: 5 }, (_, i) => local({ absItemId: `new-${i}` }));
        const plan = planAudiobookSweep({
            remote: present.map((row) => remote({ id: row.absItemId })),
            local: [...present, ...newlyGone, ...dismissedRows(50)],
            snapshotComplete: true,
        });

        expect(plan.dismissalSkip).toBeNull();
        expect(plan.dismissals).toHaveLength(5);
    });
});

describe('normalizeDismissalRatio', () => {
    it('accepts a valid ratio', () => {
        expect(normalizeDismissalRatio(0.25)).toBe(0.25);
    });

    it('honours an explicit zero as "never dismiss on ratio alone"', () => {
        expect(normalizeDismissalRatio(0)).toBe(0);
    });

    it('clamps above 1', () => {
        expect(normalizeDismissalRatio(5)).toBe(1);
    });

    it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
        'falls back to the default for %s rather than disabling the rail',
        (value) => {
            expect(normalizeDismissalRatio(value)).toBe(DEFAULT_MAX_DISMISSAL_RATIO);
        },
    );

    it('a zero ratio disables dismissal outright, overriding the floor', () => {
        // The admin field's minimum is 0 and its help text promises nothing is
        // hidden there. Letting the small-library floor survive would leak an
        // unbounded drip — 3 per cycle, 288 a day at the 15-minute cadence.
        const { remote: r, local: l } = inSyncLibrary(100);
        const plan = planAudiobookSweep({
            remote: r.slice(1),
            local: l,
            snapshotComplete: true,
            thresholds: { maxDismissalRatio: 0 },
        });

        expect(plan.dismissals).toEqual([]);
        expect(plan.dismissalSkip).toMatchObject({
            reason: 'threshold-exceeded',
            candidates: 1,
            allowed: 0,
        });
    });

    it('keeps the floor for every non-zero ratio', () => {
        // 1% of 100 is 1, but the floor still permits DEFAULT_MIN_DISMISSAL_ALLOWANCE.
        const { remote: r, local: l } = inSyncLibrary(100);
        const plan = planAudiobookSweep({
            remote: r.slice(DEFAULT_MIN_DISMISSAL_ALLOWANCE),
            local: l,
            snapshotComplete: true,
            thresholds: { maxDismissalRatio: 0.01 },
        });

        expect(plan.dismissalSkip).toBeNull();
        expect(plan.dismissals).toHaveLength(DEFAULT_MIN_DISMISSAL_ALLOWANCE);
    });

    it('a zero allowance plus a zero ratio blocks every dismissal', () => {
        const { remote: r, local: l } = inSyncLibrary(100);
        const plan = planAudiobookSweep({
            remote: r.slice(1),
            local: l,
            snapshotComplete: true,
            thresholds: { maxDismissalRatio: 0, minDismissalAllowance: 0 },
        });

        expect(plan.dismissals).toEqual([]);
        expect(plan.dismissalSkip?.reason).toBe('threshold-exceeded');
    });
});
