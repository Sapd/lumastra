// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    completionThresholdFor,
    engagementThresholdMs,
    applyAutoCompleteFromProgress,
    resumePositionForStart,
    fileRuntimeMsForResume,
} from './watch-constants.js';

const MIN = 60_000;

describe('engagementThresholdMs', () => {
    it.each([0, null, undefined, -1, Number.NaN])(
        'keeps 60 s for unknown runtime %s',
        (runtimeMs) => {
            expect(engagementThresholdMs(runtimeMs)).toBe(60_000);
        },
    );

    it.each([
        [72_500, 18_125],
        [145_000, 36_250],
        [240_000, 60_000],
        [7_200_000, 60_000],
    ])('requires the smaller of 60 s and 25%% of %i ms', (runtimeMs, thresholdMs) => {
        expect(engagementThresholdMs(runtimeMs)).toBe(thresholdMs);
    });
});

describe('completionThresholdFor', () => {
    it('returns runtime-tiered thresholds when runtime is known', () => {
        expect(completionThresholdFor('episode', 22 * MIN)).toBe(0.9);
        expect(completionThresholdFor('episode', 45 * MIN)).toBe(0.9);
        expect(completionThresholdFor('movie', 120 * MIN)).toBe(0.95);
        expect(completionThresholdFor('movie', 180 * MIN)).toBe(0.96);
    });

    it('falls back to media-type table for unknown runtime', () => {
        expect(completionThresholdFor('movie', null)).toBe(0.95);
        expect(completionThresholdFor('episode', undefined)).toBe(0.9);
        expect(completionThresholdFor(null, 0)).toBe(0.9);
    });

    it('treats negative or NaN runtime as unknown', () => {
        expect(completionThresholdFor('movie', -1)).toBe(0.95);
        expect(completionThresholdFor('movie', Number.NaN)).toBe(0.95);
    });

    it('gives audiobooks an absolute 2-minute window, not a percentage', () => {
        // The prod row that motivated this: 20h57m book, auto-finished at 96.45%
        // with 44m38s still to listen while AudiobookShelf still said isFinished=0.
        const runtimeMs = 75_423_791;
        const threshold = completionThresholdFor('audiobook', runtimeMs);

        // Still unfinished at the position it was wrongly completed at.
        expect(72_746_184 / runtimeMs).toBeLessThan(threshold);
        // Finished only inside the last two minutes.
        expect((runtimeMs - 119_000) / runtimeMs).toBeGreaterThan(threshold);
        expect((runtimeMs - 121_000) / runtimeMs).toBeLessThan(threshold);
    });

    it('does not let a garbage-short audiobook runtime finish at position 0', () => {
        // runtime <= the window would yield a <=0 threshold, marking an unplayed
        // book watched. Those fall back to the tier ladder instead.
        expect(completionThresholdFor('audiobook', 60_000)).toBe(0.9);
        expect(completionThresholdFor('audiobook', 120_000)).toBe(0.9);
    });

    it('leaves video untouched at the same runtimes', () => {
        // The audiobook branch must key on media type alone — a 21-hour VIDEO
        // stays on the ladder.
        expect(completionThresholdFor('movie', 75_423_791)).toBe(0.96);
        expect(completionThresholdFor('episode', 75_423_791)).toBe(0.96);
    });
});

describe('applyAutoCompleteFromProgress', () => {
    it('does not trigger when isWatched is already true', () => {
        const result = applyAutoCompleteFromProgress({
            isWatched: true,
            resumePositionMs: 100,
            runtimeMs: 1000,
        });
        expect(result.triggered).toBe(false);
        expect(result.item.isWatched).toBe(true);
    });

    it('does not trigger when runtime is unknown', () => {
        const result = applyAutoCompleteFromProgress({
            isWatched: false,
            resumePositionMs: 100,
            runtimeMs: 0,
        });
        expect(result.triggered).toBe(false);
    });

    it('triggers and zeros resume when past threshold', () => {
        const result = applyAutoCompleteFromProgress({
            isWatched: false,
            resumePositionMs: 29 * MIN, // 96.6% of 30 min (tier 0.90)
            runtimeMs: 30 * MIN,
        });
        expect(result.triggered).toBe(true);
        expect(result.item.isWatched).toBe(true);
        expect(result.item.resumePositionMs).toBe(0);
    });

    it('clamps negative resume at the sync boundary', () => {
        // Providers (or replay-attack heartbeats) can send negative values.
        // The helper normalizes them to 0 so downstream upserts don't
        // propagate garbage — even when the item doesn't auto-complete.
        const result = applyAutoCompleteFromProgress({
            isWatched: false,
            resumePositionMs: -500,
            runtimeMs: 45 * MIN,
        });
        expect(result.triggered).toBe(false);
        expect(result.item.resumePositionMs).toBe(0);
    });

    it('does not mutate the input object', () => {
        const input = {
            isWatched: false,
            resumePositionMs: 29 * MIN,
            runtimeMs: 30 * MIN,
        };
        const snapshot = { ...input };
        applyAutoCompleteFromProgress(input);
        expect(input).toEqual(snapshot);
    });
});

describe('resumePositionForStart', () => {
    // Reverse-proxy e2e 2026-10-06: a movie watched to the end kept
    // resume_position_ms 420059 of a 420021 ms runtime (is_watched=true).
    // Pressing Play started the session at the very end and wedged the player.
    it('starts a finished item (resume at/after the end) from the beginning', () => {
        expect(
            resumePositionForStart({ positionMs: 420_059, runtimeMs: 420_021, mediaType: 'movie' }),
        ).toBe(0);
    });

    it('treats a resume past the completion threshold as finished', () => {
        // 7 min movie → 0.9 tier; 95% is in the credits.
        expect(
            resumePositionForStart({ positionMs: 399_000, runtimeMs: 420_000, mediaType: 'movie' }),
        ).toBe(0);
    });

    it('keeps a mid-item resume, including a re-watch in progress', () => {
        expect(
            resumePositionForStart({ positionMs: 210_000, runtimeMs: 420_000, mediaType: 'movie' }),
        ).toBe(210_000);
    });

    it('keeps the position when the runtime is unknown', () => {
        expect(
            resumePositionForStart({ positionMs: 420_059, runtimeMs: null, mediaType: 'movie' }),
        ).toBe(420_059);
    });

    it('never returns a negative or non-finite position', () => {
        for (const positionMs of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(
                resumePositionForStart({ positionMs, runtimeMs: 420_000, mediaType: 'movie' }),
            ).toBe(0);
        }
    });
});

describe('fileRuntimeMsForResume', () => {
    const alone = [{ end_offset_ms: null }];
    const combined = [{ end_offset_ms: '660000' }, { end_offset_ms: '1320000' }];

    it('prefers the probed file duration', () => {
        expect(fileRuntimeMsForResume({ fileDurationMs: 1_320_500, siblings: combined })).toBe(
            1_320_500,
        );
        expect(fileRuntimeMsForResume({ fileDurationMs: 420_021, siblings: alone })).toBe(420_021);
    });

    // The catalog runtime describes the title, not this file — never a fallback.
    it('is unknown (resume kept) for an unprobed single-item file', () => {
        expect(fileRuntimeMsForResume({ fileDurationMs: null, siblings: alone })).toBeNull();
        expect(fileRuntimeMsForResume({ fileDurationMs: null, siblings: [] })).toBeNull();
    });

    // A file-absolute 692 s in the second episode of a combined file must not be
    // judged against the first episode's 660 s runtime.
    it('uses the last episode window end for an unprobed combined file', () => {
        const runtimeMs = fileRuntimeMsForResume({ fileDurationMs: null, siblings: combined });
        expect(runtimeMs).toBe(1_320_000);
        expect(
            resumePositionForStart({ positionMs: 692_000, runtimeMs, mediaType: 'episode' }),
        ).toBe(692_000);
    });

    it('is unknown when any combined-file window is missing (a partial split understates the file)', () => {
        expect(
            fileRuntimeMsForResume({
                fileDurationMs: null,
                siblings: [{ end_offset_ms: '660000' }, { end_offset_ms: null }],
            }),
        ).toBeNull();
        expect(
            fileRuntimeMsForResume({
                fileDurationMs: null,
                siblings: [{ end_offset_ms: null }, { end_offset_ms: null }],
            }),
        ).toBeNull();
    });
});
