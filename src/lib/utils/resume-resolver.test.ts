// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { clampStartToPlayable, resolveResumePosition } from './resume-resolver';

describe('resolveResumePosition', () => {
    it('returns server position when there is no cached entry', () => {
        const result = resolveResumePosition({
            serverPositionMs: 30_000,
            serverAnchor: 1000,
            isWatched: false,
            cached: null,
        });
        expect(result).toBe(30_000);
    });

    it('returns 0 when is_watched is true and the server has reset resume to 0', () => {
        // PlayerController clears the localStorage cache when isWatched is true,
        // so production callers pass cached=null in that case. The server's
        // resume_position_ms is the source of truth — when it is 0 (just
        // finished, not yet re-watching), the player starts from the top.
        const result = resolveResumePosition({
            serverPositionMs: 0,
            serverAnchor: 5000,
            isWatched: true,
            cached: null,
        });
        expect(result).toBe(0);
    });

    it('returns server position when is_watched is true and resume is non-zero (re-watch)', () => {
        // Re-watch case: user finished the episode previously (is_watched=true),
        // then started watching again — resume_position_ms reflects the new
        // progress. The watch-state rebuilder intentionally keeps a non-zero
        // resume on watched rows for this exact flow; the client must honor it.
        const result = resolveResumePosition({
            serverPositionMs: 384_765,
            serverAnchor: 5000,
            isWatched: true,
            cached: null,
        });
        expect(result).toBe(384_765);
    });

    it('returns server position when cached anchor is older (durable write since cache)', () => {
        const result = resolveResumePosition({
            serverPositionMs: 60_000,
            serverAnchor: 2000,
            isWatched: false,
            cached: { positionMs: 30_000, anchor: 1000 },
        });
        expect(result).toBe(60_000);
    });

    it('returns server position when cached anchor is older and the source is a fresh live session (P1 case)', () => {
        const result = resolveResumePosition({
            serverPositionMs: 90_000,
            serverAnchor: 3000,
            isWatched: false,
            cached: { positionMs: 60_000, anchor: 2000 },
        });
        expect(result).toBe(90_000);
    });

    it('returns cached position on a tie (the bug-fix case)', () => {
        const result = resolveResumePosition({
            serverPositionMs: 30_000,
            serverAnchor: 1000,
            isWatched: false,
            cached: { positionMs: 32_000, anchor: 1000 },
        });
        expect(result).toBe(32_000);
    });

    it('returns cached position when cached anchor is strictly newer', () => {
        const result = resolveResumePosition({
            serverPositionMs: 30_000,
            serverAnchor: 1000,
            isWatched: false,
            cached: { positionMs: 32_000, anchor: 1500 },
        });
        expect(result).toBe(32_000);
    });

    it('returns cached position verbatim when serverAnchor is null (server has nothing)', () => {
        const result = resolveResumePosition({
            serverPositionMs: 0,
            serverAnchor: null,
            isWatched: false,
            cached: { positionMs: 32_000, anchor: 1500 },
        });
        expect(result).toBe(32_000);
    });
});

describe('clampStartToPlayable', () => {
    // Reverse-proxy e2e 2026-10-06: the player was handed 420.08 s for a
    // 420.021 s movie and started HLS past the last segment.
    it('starts from 0 when the start position is at or past the end', () => {
        expect(clampStartToPlayable(420.08, 420.021)).toBe(0);
        expect(clampStartToPlayable(420.021, 420.021)).toBe(0);
    });

    it('starts from 0 inside the final seconds, where playback would end at once', () => {
        expect(clampStartToPlayable(417, 420.021)).toBe(0);
    });

    it('keeps an ordinary resume', () => {
        expect(clampStartToPlayable(200, 420.021)).toBe(200);
    });

    it('keeps the position when the duration is unknown', () => {
        expect(clampStartToPlayable(420.08, 0)).toBe(420.08);
        expect(clampStartToPlayable(420.08, Number.NaN)).toBe(420.08);
    });

    it('caps the end guard at 10 % of a short clip', () => {
        // 20 s clip: guard is 2 s, so a resume at 15 s is kept and 18.5 s resets.
        expect(clampStartToPlayable(15, 20)).toBe(15);
        expect(clampStartToPlayable(18.5, 20)).toBe(0);
    });

    it('turns a non-finite or negative start into 0', () => {
        expect(clampStartToPlayable(Number.NaN, 420.021)).toBe(0);
        expect(clampStartToPlayable(-3, 420.021)).toBe(0);
    });
});
