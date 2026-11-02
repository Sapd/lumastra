// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    computeFrameWindow,
    candidateOffsets,
    seedFromEpisodeId,
    snapToKeyframe,
    introPad,
    noEvidenceFloor,
    tailGuard,
} from './frame-window.js';

// Real prod values: Star Harbor: NG S3 episodes are 2765s and the shipped
// default seeks to 10% => 276.5s = 4:36, which is inside the superimposed
// act-one production credits. That frame must become unreachable.
const TNG = 2765;
const TNG_CURRENT_OFFSET = 0.1 * TNG;

describe('computeFrameWindow — the TNG case', () => {
    it('makes the reported 4:36 frame structurally unreachable', () => {
        const w = computeFrameWindow(TNG);
        expect(Math.round(w.floor)).toBe(415); // clamp(0.15*2765,120,600)
        expect(Math.round(w.ceiling)).toBe(2267); // 2765 - clamp(0.18*2765,120,900)
        expect(w.collapsed).toBe(false);
        expect(TNG_CURRENT_OFFSET).toBeLessThan(w.floor);
    });

    it('pads past superimposed credits when intro evidence exists', () => {
        // Intro ENDS at 90s, but TNG keeps rolling credits over act one. Using
        // evidence raw would put the floor back at ~90s.
        const w = computeFrameWindow(TNG, 90);
        expect(Math.round(introPad(TNG))).toBe(138); // clamp(0.05*2765,45,150)
        expect(Math.round(w.floor)).toBe(228); // 90 + 138
        expect(w.floor).toBeGreaterThan(90);
    });

    it('clamps absurd evidence to a quarter of the episode', () => {
        // A mis-detected 40-minute "Opening" chapter must not push the floor
        // past the ceiling.
        const w = computeFrameWindow(TNG, 2400);
        expect(w.floor).toBeLessThanOrEqual(0.4 * TNG);
        expect(w.ceiling).toBeGreaterThan(w.floor);
    });
});

describe('computeFrameWindow — guards', () => {
    it('collapses an inverted window for short-form content', () => {
        // 3-minute short: floor 120, tail 120 => ceiling 60. Inverted.
        expect(noEvidenceFloor(180)).toBe(120);
        expect(tailGuard(180)).toBe(120);

        const w = computeFrameWindow(180);
        expect(w.collapsed).toBe(true);
        expect(w.floor).toBeCloseTo(36, 5); // 0.20 * 180
        expect(w.ceiling).toBeCloseTo(144, 5); // 0.80 * 180
        expect(w.ceiling).toBeGreaterThan(w.floor);
    });

    it('never produces an inverted window at any plausible duration', () => {
        for (let d = 30; d <= 7200; d += 30) {
            const w = computeFrameWindow(d);
            expect(w.ceiling).toBeGreaterThan(w.floor);
            expect(w.floor).toBeGreaterThanOrEqual(0);
            expect(w.ceiling).toBeLessThanOrEqual(d);
        }
    });

    it('keeps a 12-minute anime episode sampleable without collapsing', () => {
        const w = computeFrameWindow(720);
        expect(w.ceiling).toBeGreaterThan(w.floor);
    });
});

describe('candidateOffsets — siblings must not collide', () => {
    const w = computeFrameWindow(TNG);
    // Real TNG S3 episode UUIDs from prod.
    const IDS = [
        'f9cc8894-7c44-49c2-a74a-a12ea7951390',
        '61442919-1e13-4f26-a8e8-340f33c0d3f4',
        '4420ea4b-d9c3-490a-a805-fe1c43b5bfee',
        '558af3d9-26f8-4eba-a989-77739b4b01ef',
        'fe798cfe-e3d3-4099-8b95-2b2099001c82',
        '756c1b26-8cbb-485e-bb62-b31957e25dda',
    ];

    it('keeps every candidate inside the window', () => {
        for (const id of IDS) {
            for (const t of candidateOffsets(w, id, 4)) {
                expect(t).toBeGreaterThanOrEqual(w.floor);
                expect(t).toBeLessThanOrEqual(w.ceiling);
            }
        }
    });

    it('gives different episodes different first candidates', () => {
        const firsts = IDS.map((id) => Math.round(candidateOffsets(w, id, 4)[0]));
        // The old ladder handed every episode the same offsets; this is the
        // property that regression would violate.
        expect(new Set(firsts).size).toBe(IDS.length);
    });

    it('is deterministic — same id, same offsets', () => {
        const a = candidateOffsets(w, IDS[0], 4);
        const b = candidateOffsets(w, IDS[0], 4);
        expect(a).toEqual(b);
    });

    it('stratifies: one candidate per 1/N slice of the window', () => {
        const n = 4;
        const span = w.ceiling - w.floor;
        for (const id of IDS) {
            const slices = candidateOffsets(w, id, n).map((t) =>
                Math.floor(((t - w.floor) / span) * n),
            );
            expect(new Set(slices).size).toBe(n);
        }
    });

    it('returns nothing for a degenerate window or zero count', () => {
        expect(candidateOffsets({ floor: 10, ceiling: 10, collapsed: false }, IDS[0], 4)).toEqual(
            [],
        );
        expect(candidateOffsets(w, IDS[0], 0)).toEqual([]);
    });
});

describe('seedFromEpisodeId', () => {
    it('is stable and within [0,1)', () => {
        const s = seedFromEpisodeId('f9cc8894-7c44-49c2-a74a-a12ea7951390');
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(1);
        expect(seedFromEpisodeId('f9cc8894-7c44-49c2-a74a-a12ea7951390')).toBe(s);
    });

    it('degrades safely on a malformed id', () => {
        expect(seedFromEpisodeId('abc')).toBe(0);
    });
});

describe('snapToKeyframe', () => {
    const keyframes = [0, 100, 200, 300, 400, 500];

    it('snaps back to the keyframe at or before the target', () => {
        expect(snapToKeyframe(250, 0, 100, keyframes)).toBe(200);
    });

    it('refuses to snap below the floor', () => {
        // Target 210 with floor 200 would snap to 200 (ok), but a target just
        // above the floor must not be dragged under it by a long GOP — that is
        // how candidate 0 walked back into the credits.
        expect(snapToKeyframe(205, 0, 205, keyframes)).toBe(205);
    });

    it('passes through when no keyframes are known', () => {
        expect(snapToKeyframe(250, 0, 100)).toBe(250);
        expect(snapToKeyframe(250, 0, 100, [])).toBe(250);
    });

    it('honours a combined-file base offset', () => {
        // Episode starts 1000s into the physical file; keyframes are absolute.
        const abs = [1000, 1100, 1200];
        expect(snapToKeyframe(150, 1000, 100, abs)).toBe(100); // 1150 -> 1100 -> rel 100
    });
});
