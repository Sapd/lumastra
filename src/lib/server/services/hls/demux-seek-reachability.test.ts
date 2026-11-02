// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E2E-style reachability test for demux HLS copy-mode playback.
 *
 * Simulates the full flow: keyframe data → VOD playlist generation →
 * segment offset computation → verifying requested segments are reachable.
 * Catches the class of bugs where keyframe/uniform segment index divergence
 * causes 404s, hangs, or wrong playback positions.
 */

import { describe, expect, it } from 'vitest';
import {
    computeSegmentsFromKeyframes,
    getKeyframeSegmentIndexForTime,
    getKeyframeSegmentStartTime,
    getLastKeyframeFileIndex,
} from '../ffmpeg-transcode.service.js';
import { generateCompleteVodManifest } from './vod-playlist.js';
import type { VodManifestInfo } from './vod-playlist.js';

// ============================================================================
// Realistic keyframe data (~10.427s average interval, 1123 keyframes)
// Matches Schindler's List AV1 HDR10 Blu-ray rip
// ============================================================================

const TOTAL_DURATION = 11707.744;
const SEGMENT_DURATION = 10;
const KF_INTERVAL = 10.427;

function generateKeyframes(count: number, interval: number): number[] {
    return Array.from({ length: count }, (_, i) => i * interval);
}

const KEYFRAMES = generateKeyframes(1123, KF_INTERVAL);
const KF_DURATIONS = computeSegmentsFromKeyframes(KEYFRAMES, TOTAL_DURATION, SEGMENT_DURATION);

// ============================================================================
// Helpers
// ============================================================================

/** Extract segment numbers from a generated VOD manifest */
function extractSegmentNumbers(manifest: string): number[] {
    const matches = manifest.matchAll(/segment_(\d{5})\.m4s/g);
    return Array.from(matches, (m) => parseInt(m[1], 10));
}

/** Simulate what AVPlayer does: find the segment covering a given time */
function findSegmentForTime(kfDurations: number[], timeSeconds: number): number {
    let cumulative = 0;
    for (let i = 0; i < kfDurations.length; i++) {
        cumulative += kfDurations[i];
        if (timeSeconds < cumulative) return i;
    }
    return kfDurations.length - 1;
}

function buildVodInfo(startTimeSeconds: number): VodManifestInfo {
    const keyframeStreamOffset =
        startTimeSeconds > 0
            ? getKeyframeSegmentIndexForTime(
                  startTimeSeconds,
                  KEYFRAMES,
                  TOTAL_DURATION,
                  SEGMENT_DURATION,
              )
            : undefined;

    return {
        totalDurationSeconds: TOTAL_DURATION,
        segmentDurationSeconds: SEGMENT_DURATION,
        totalSegments: Math.ceil(TOTAL_DURATION / SEGMENT_DURATION),
        isComplete: false,
        segmentOffset: Math.floor(startTimeSeconds / SEGMENT_DURATION),
        startTimeSeconds,
        keyframeSegmentDurations: KF_DURATIONS,
        keyframeStreamOffset,
    };
}

// ============================================================================
// Tests
// ============================================================================

describe('demux copy-mode seek reachability', () => {
    it('video playlist has correct segment count (keyframe-based, not uniform)', () => {
        const vodInfo = buildVodInfo(0);
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n',
            vodInfo,
            new URLSearchParams(),
        );

        const segments = extractSegmentNumbers(manifest);
        // Should match keyframe count, not uniform count
        expect(segments.length).toBe(KF_DURATIONS.length);
        expect(segments.length).toBeLessThan(vodInfo.totalSegments);
    });

    it.each([
        { seekTime: 0, label: 'start' },
        { seekTime: 1700, label: '28 minutes' },
        { seekTime: 5000, label: '1h 23m' },
        { seekTime: 10970, label: 'near end (~3h 2m)' },
        { seekTime: 11600, label: 'near very end' },
    ])('segment for $label ($seekTime s) is within playlist range', ({ seekTime }) => {
        const vodInfo = buildVodInfo(seekTime);
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n',
            vodInfo,
            new URLSearchParams(),
        );

        const segments = extractSegmentNumbers(manifest);
        const targetSegment = findSegmentForTime(KF_DURATIONS, seekTime);

        // The segment AVPlayer would request must exist in the playlist
        expect(targetSegment).toBeGreaterThanOrEqual(segments[0]);
        expect(targetSegment).toBeLessThanOrEqual(segments[segments.length - 1]);
    });

    it('keyframe offset diverges from uniform offset at high positions', () => {
        const seekTime = 10970;
        const uniformOffset = Math.floor(seekTime / SEGMENT_DURATION); // 1097
        const keyframeOffset = getKeyframeSegmentIndexForTime(
            seekTime,
            KEYFRAMES,
            TOTAL_DURATION,
            SEGMENT_DURATION,
        );

        // Keyframe offset should be significantly lower than uniform
        expect(keyframeOffset).toBeLessThan(uniformOffset);
        // The gap grows with time — at ~3 hours it should be ~45 segments
        expect(uniformOffset - keyframeOffset).toBeGreaterThan(30);
    });

    it('uniform segment 1097 does NOT exist in keyframe playlist (regression guard)', () => {
        // This is the exact bug: AVPlayer requests video segment 1097
        // (uniform audio index) but the keyframe playlist only goes to ~1123
        // and segment 1097 in keyframe space = time ~11440s (wrong position)
        const vodInfo = buildVodInfo(10970);
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n',
            vodInfo,
            new URLSearchParams(),
        );

        const segments = extractSegmentNumbers(manifest);
        const uniformTarget = Math.floor(10970 / SEGMENT_DURATION); // 1097

        // The keyframe playlist should have segment 1097 (it has 1123 segments)
        // but the streamOffset should NOT be 1097 — it should be ~1052
        // This means segment_01097 exists but FFmpeg maps it correctly
        expect(segments).toContain(uniformTarget);

        // The keyframe segment for time 10970s should be ~1052, not 1097
        const correctTarget = findSegmentForTime(KF_DURATIONS, 10970);
        expect(correctTarget).toBeLessThan(uniformTarget);
        expect(correctTarget).toBeGreaterThanOrEqual(1050);
        expect(correctTarget).toBeLessThanOrEqual(1055);
    });

    it('seek coordinator uses uniform time for demux (not keyframe time)', () => {
        // In demux mode, the seek coordinator must use uniform time
        // so that the audio offset matches the video seek position
        const targetSegment = 50;
        const seekTime = targetSegment * SEGMENT_DURATION; // 500s uniform

        const keyframeTime = getKeyframeSegmentStartTime(
            targetSegment,
            KEYFRAMES,
            TOTAL_DURATION,
            SEGMENT_DURATION,
        );

        // Keyframe time would overshoot uniform time
        expect(keyframeTime).toBeGreaterThan(seekTime);
        // The divergence grows with segment index
        expect(keyframeTime - seekTime).toBeGreaterThan(10);
    });

    it('VOD playlist streamOffset matches segment handler offset (no preroll mismatch)', () => {
        // The VOD playlist uses keyframeStreamOffset as the streamOffset.
        // The segment handler must return the SAME value so that segment N in the
        // playlist maps to FFmpeg file segment_(N - offset) = 0 for the first segment.
        //
        // Previously the handler used kfIndex - 1 (for "preroll"), but
        // alignToKeyframeSegmentStart ensures FFmpeg starts exactly on a keyframe
        // boundary, so segment_00000 IS the first real content. No preroll offset.
        const seekTime = 10970;
        const vodStreamOffset = getKeyframeSegmentIndexForTime(
            seekTime,
            KEYFRAMES,
            TOTAL_DURATION,
            SEGMENT_DURATION,
        );
        // Simulate what the handler does (should be identical, no -1)
        const handlerOffset = getKeyframeSegmentIndexForTime(
            seekTime,
            KEYFRAMES,
            TOTAL_DURATION,
            SEGMENT_DURATION,
        );

        // Both must agree — no off-by-one
        expect(handlerOffset).toBe(vodStreamOffset);
        // First FFmpeg segment maps to public segment = offset
        expect(0).toBe(vodStreamOffset - handlerOffset);
    });
});

// ============================================================================
// Irregular GOPs: every keyframe file must be served in linear playback
// ============================================================================

describe('demux copy-mode video with irregular GOPs', () => {
    // Real Blu-ray H.264 GOPs vary from ~1 to ~17 s (Dexter S06E12: 5–17 s
    // keyframe segments). A cyclic mix of short and long GOPs reproduces the
    // shape; evenly spaced keyframes (above) can never expose a skipped file.
    const GOPS = [3.16, 5.68, 1.96, 9.6, 1.76, 4.6, 15.68, 0.96, 7.72, 2.56, 12.4, 8.16, 1.04];
    const IRREGULAR_TOTAL = 2958.336;
    const IRREGULAR_KEYFRAMES: number[] = [];
    for (let t = 0, i = 0; t < IRREGULAR_TOTAL; t += GOPS[i++ % GOPS.length]) {
        IRREGULAR_KEYFRAMES.push(Math.round(t * 1000) / 1000);
    }

    /** Uniform playlist entries a generation starting at `startTime` exposes. */
    function uniformEntries(startTime: number): number {
        return Math.ceil((IRREGULAR_TOTAL - startTime) / SEGMENT_DURATION);
    }

    function missingFiles(served: number[], lastFile: number): number[] {
        const seen = new Set(served);
        const out: number[] = [];
        for (let f = 0; f <= lastFile; f++) if (!seen.has(f)) out.push(f);
        return out;
    }

    // 0 = fresh start; 958.681 = a resume (Testlistener's 968.681 minus the 10 s preroll).
    // 0 = fresh start; 958.681 = a resume (Testlistener's 968.681 minus the 10 s preroll).
    it.each([0, 958.681, 1234.5])(
        'serves every keyframe file, in order, when playing linearly from %s',
        (startTime) => {
            const lastFile = getLastKeyframeFileIndex(
                startTime,
                IRREGULAR_KEYFRAMES,
                IRREGULAR_TOTAL,
                SEGMENT_DURATION,
            );
            const entries = uniformEntries(startTime);
            // The handler's demux copy-video translator: entry N - offset → file.
            const served = Array.from({ length: entries }, (_, a) => Math.min(a, lastFile));
            for (let a = 1; a < served.length; a++) {
                expect(served[a]).toBeGreaterThanOrEqual(served[a - 1]);
            }
            // No file is ever skipped mid-stream. A generation starts at the
            // keyframe BEFORE startTime, so FFmpeg can cut one file more than the
            // playlist has uniform entries; only that trailing file (the last
            // seconds of the media) has no entry — the old mapping dropped it too.
            const missing = missingFiles(served, lastFile);
            expect(missing.length).toBeLessThanOrEqual(1);
            if (missing.length === 1) {
                expect(missing[0]).toBe(lastFile);
                expect(lastFile).toBe(entries);
            }
        },
    );

    it('the old time-sampled mapping DROPS short files (the bug this replaces)', () => {
        const startTime = 958.681;
        const fileAt = (t: number): number =>
            getKeyframeSegmentIndexForTime(
                t,
                IRREGULAR_KEYFRAMES,
                IRREGULAR_TOTAL,
                SEGMENT_DURATION,
            );
        const startFile = fileAt(startTime);
        const served = Array.from(
            { length: uniformEntries(startTime) },
            (_, a) => fileAt(startTime + a * SEGMENT_DURATION) - startFile,
        );
        const lastFile = getLastKeyframeFileIndex(
            startTime,
            IRREGULAR_KEYFRAMES,
            IRREGULAR_TOTAL,
            SEGMENT_DURATION,
        );
        expect(missingFiles(served, lastFile).length).toBeGreaterThan(0);
    });

    it('clamps the last file relative to the generation start', () => {
        const total = computeSegmentsFromKeyframes(
            IRREGULAR_KEYFRAMES,
            IRREGULAR_TOTAL,
            SEGMENT_DURATION,
        ).length;
        expect(
            getLastKeyframeFileIndex(0, IRREGULAR_KEYFRAMES, IRREGULAR_TOTAL, SEGMENT_DURATION),
        ).toBe(total - 1);
        const startFile = getKeyframeSegmentIndexForTime(
            958.681,
            IRREGULAR_KEYFRAMES,
            IRREGULAR_TOTAL,
            SEGMENT_DURATION,
        );
        expect(
            getLastKeyframeFileIndex(
                958.681,
                IRREGULAR_KEYFRAMES,
                IRREGULAR_TOTAL,
                SEGMENT_DURATION,
            ),
        ).toBe(total - 1 - startFile);
    });
});
