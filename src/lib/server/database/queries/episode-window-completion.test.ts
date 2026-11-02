// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Completion maths for episodes inside a combined file.
 *
 * A combined file (Hafentage S02E24E25) is ONE video: 1354.602s holding episode 24
 * ([0, 692.275s)) and episode 25 ([692.275s, 1354.602s)). It plays straight
 * through and positions stay file-absolute, so:
 *
 *   - an episode's completion is judged against ITS window, not a raw position
 *     compared against its provider runtime
 *   - one session plays through SEVERAL episodes, but the player only reports the
 *     one that was opened — the rest must be completed from the same position
 *   - a window BEFORE the opened episode's was skipped past, never watched
 *
 * This pins the arithmetic watch-manager.reportProgress applies; the query is
 * covered by file-segments.queries.integration.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { crossedCompletionThreshold } from '../../utils/watch-constants.js';

interface Window {
    mediaItemId: string;
    startMs: number;
    endMs: number;
}

const E24: Window = { mediaItemId: 'ep24', startMs: 0, endMs: 692_275 };
const E25: Window = { mediaItemId: 'ep25', startMs: 692_275, endMs: 1_354_602 };
const WINDOWS = [E24, E25];

/**
 * The REAL rule, not a copy of it.
 *
 * This was a local re-implementation of watch-manager.reportProgress's
 * threshold branch — and a test that re-derives the logic it checks cannot
 * fail when the real logic changes. The rule decides whether an episode is
 * marked watched, so a silent drift here is directly user-visible.
 */
function crossedThreshold(positionMs: number, window: Window | null, runtimeMs: number | null) {
    return crossedCompletionThreshold({
        positionMs,
        window,
        runtimeMs,
        mediaType: 'episode',
    });
}

/**
 * Mirrors the fan-out: which episodes does a session that OPENED `opened` and
 * reached `positionMs` mark watched?
 */
function completedBy(opened: Window, positionMs: number): string[] {
    return WINDOWS.filter((w) => {
        if (w.startMs < opened.startMs) return false; // skipped past, not watched
        return crossedThreshold(positionMs, w, null);
    }).map((w) => w.mediaItemId);
}

describe('completion inside a combined file', () => {
    it('does not mark episode 25 watched the moment you enter its window', () => {
        // The regression the entry-point seek would otherwise introduce: opening E25
        // jumps to 692.275s, which is already 105% of its own 660s provider runtime.
        expect(crossedThreshold(E25.startMs, null, 660_000)).toBe(true); // the bug
        expect(crossedThreshold(E25.startMs, E25, 660_000)).toBe(false); // window-aware
    });

    it('marks episode 25 watched once its own window is 90% done', () => {
        const windowMs = E25.endMs - E25.startMs; // 662_327
        const ninetyPercent = E25.startMs + windowMs * 0.9;

        expect(crossedThreshold(ninetyPercent - 1_000, E25, 660_000)).toBe(false);
        expect(crossedThreshold(ninetyPercent + 1_000, E25, 660_000)).toBe(true);
    });

    it('leaves ordinary single-episode files on the existing maths', () => {
        expect(crossedThreshold(100_000, null, 660_000)).toBe(false);
        expect(crossedThreshold(620_000, null, 660_000)).toBe(true);
    });
});

describe('one session, several episodes', () => {
    it('watching the file through from episode 24 completes BOTH', () => {
        // This is what frees Next Up: nothing on the file is outstanding, so the
        // next candidate is E26 rather than E25 again.
        expect(completedBy(E24, E25.endMs)).toEqual(['ep24', 'ep25']);
    });

    it('stopping just past the marker completes only episode 24', () => {
        // ~2 minutes into episode 25 — it has barely started.
        expect(completedBy(E24, 800_000)).toEqual(['ep24']);
    });

    it('stopping at the marker completes only episode 24', () => {
        expect(completedBy(E24, E24.endMs)).toEqual(['ep24']);
    });

    it('stopping before episode 24 is done completes nothing', () => {
        expect(completedBy(E24, 300_000)).toEqual([]);
    });

    it('completes episode 25 only once ITS window is 90% done, not the file’s', () => {
        const windowMs = E25.endMs - E25.startMs;
        const ninetyOfE25 = E25.startMs + windowMs * 0.9; // ~1_288_369

        expect(completedBy(E24, ninetyOfE25 - 1_000)).toEqual(['ep24']);
        expect(completedBy(E24, ninetyOfE25 + 1_000)).toEqual(['ep24', 'ep25']);
    });

    it('entering at episode 25 never marks episode 24 — it was skipped, not watched', () => {
        // Position 1354602 is far past E24's window, but this session never played it.
        expect(completedBy(E25, E25.endMs)).toEqual(['ep25']);
        expect(completedBy(E25, 1_000_000)).toEqual([]);
    });
});
