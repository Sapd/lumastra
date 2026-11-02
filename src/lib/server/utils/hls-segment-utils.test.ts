// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for HLS segment utilities
 *
 * Tests coordinate translation, seek detection, and edge cases
 * for the multi-audio HLS streaming system.
 */

import { describe, it, expect } from 'vitest';
import {
    parseSegmentPath,
    extractSegmentNumber,
    translateToActualIndex,
    shouldTriggerBackwardSeek,
    shouldTriggerForwardSeek,
    getSegmentFilename,
    calculateSeekTime,
    isSegmentDeleted,
    calculateDeletionThreshold,
    isPathSafe,
    isSeekOnCooldown,
} from './hls-segment-utils';

describe('parseSegmentPath', () => {
    describe('valid paths', () => {
        it('parses simple stream directory', () => {
            expect(parseSegmentPath('stream_0/segment_00000.m4s')).toEqual({
                streamDir: 'stream_0',
                segmentIndex: 0,
            });
        });

        it('parses segment with large index', () => {
            expect(parseSegmentPath('stream_0/segment_99999.m4s')).toEqual({
                streamDir: 'stream_0',
                segmentIndex: 99999,
            });
        });

        it('parses video stream directory', () => {
            expect(parseSegmentPath('stream_video/segment_00123.m4s')).toEqual({
                streamDir: 'stream_video',
                segmentIndex: 123,
            });
        });

        it('parses complex stream directory names', () => {
            expect(parseSegmentPath('stream_Ger_-_Dolby_Digital_-_51/segment_00050.m4s')).toEqual({
                streamDir: 'stream_Ger_-_Dolby_Digital_-_51',
                segmentIndex: 50,
            });
        });

        it('parses numeric stream index', () => {
            expect(parseSegmentPath('stream_2/segment_00001.m4s')).toEqual({
                streamDir: 'stream_2',
                segmentIndex: 1,
            });
        });

        it('handles leading zeros correctly', () => {
            expect(parseSegmentPath('stream_0/segment_00007.m4s')?.segmentIndex).toBe(7);
            expect(parseSegmentPath('stream_0/segment_00070.m4s')?.segmentIndex).toBe(70);
            expect(parseSegmentPath('stream_0/segment_00700.m4s')?.segmentIndex).toBe(700);
        });
    });

    describe('invalid paths', () => {
        it('returns null for init segments', () => {
            expect(parseSegmentPath('stream_0/init_0.mp4')).toBeNull();
        });

        it('returns null for playlists', () => {
            expect(parseSegmentPath('stream_0/index.m3u8')).toBeNull();
        });

        it('parses .ts segments', () => {
            expect(parseSegmentPath('stream_0/segment_00000.ts')).toEqual({
                streamDir: 'stream_0',
                segmentIndex: 0,
            });
        });

        it('parses muxed mode segments without stream directory', () => {
            expect(parseSegmentPath('segment_00000.m4s')).toEqual({
                streamDir: '',
                segmentIndex: 0,
            });
        });

        it('returns null for non-numeric segment index', () => {
            expect(parseSegmentPath('stream_0/segment_abc.m4s')).toBeNull();
        });

        it('returns null for empty path', () => {
            expect(parseSegmentPath('')).toBeNull();
        });

        it('returns null for path without segment prefix', () => {
            expect(parseSegmentPath('stream_0/00000.m4s')).toBeNull();
        });

        it('returns null for nested paths', () => {
            expect(parseSegmentPath('stream_0/subdir/segment_00000.m4s')).toBeNull();
        });
    });
});

describe('extractSegmentNumber', () => {
    it('extracts from standard .m4s path', () => {
        expect(extractSegmentNumber('stream_0/segment_00123.m4s')).toBe(123);
    });

    it('extracts from .ts path', () => {
        expect(extractSegmentNumber('stream_0/segment_00456.ts')).toBe(456);
    });

    it('extracts from path with just segment', () => {
        expect(extractSegmentNumber('segment_00789')).toBe(789);
    });

    it('returns -1 for paths without segment number', () => {
        expect(extractSegmentNumber('stream_0/init_0.mp4')).toBe(-1);
        expect(extractSegmentNumber('stream_0/index.m3u8')).toBe(-1);
        expect(extractSegmentNumber('')).toBe(-1);
    });

    it('extracts first segment number if multiple present', () => {
        expect(extractSegmentNumber('segment_00001_segment_00002.m4s')).toBe(1);
    });
});

describe('translateToActualIndex', () => {
    describe('no offset (sequential playback)', () => {
        it('returns same index when offset is 0', () => {
            expect(translateToActualIndex(0, 0)).toBe(0);
            expect(translateToActualIndex(50, 0)).toBe(50);
            expect(translateToActualIndex(999, 0)).toBe(999);
        });
    });

    describe('with offset (after forward seek)', () => {
        it('translates correctly after seek to segment 500', () => {
            const offset = 500;
            expect(translateToActualIndex(500, offset)).toBe(0); // First segment after seek
            expect(translateToActualIndex(501, offset)).toBe(1);
            expect(translateToActualIndex(550, offset)).toBe(50);
        });

        it('returns negative for segments before offset', () => {
            const offset = 500;
            expect(translateToActualIndex(499, offset)).toBe(-1);
            expect(translateToActualIndex(400, offset)).toBe(-100);
            expect(translateToActualIndex(0, offset)).toBe(-500);
        });
    });

    describe('edge cases', () => {
        it('handles segment exactly at offset', () => {
            expect(translateToActualIndex(100, 100)).toBe(0);
        });

        it('handles large segment numbers', () => {
            expect(translateToActualIndex(10000, 5000)).toBe(5000);
        });
    });
});

describe('shouldTriggerBackwardSeek', () => {
    describe('no offset', () => {
        it('never triggers backward seek when offset is 0', () => {
            expect(shouldTriggerBackwardSeek(0, 0)).toBe(false);
            expect(shouldTriggerBackwardSeek(100, 0)).toBe(false);
        });
    });

    describe('with offset', () => {
        it('triggers for segments before offset', () => {
            expect(shouldTriggerBackwardSeek(400, 500)).toBe(true);
            expect(shouldTriggerBackwardSeek(0, 500)).toBe(true);
            expect(shouldTriggerBackwardSeek(499, 500)).toBe(true);
        });

        it('does not trigger for segment at offset', () => {
            expect(shouldTriggerBackwardSeek(500, 500)).toBe(false);
        });

        it('does not trigger for segments after offset', () => {
            expect(shouldTriggerBackwardSeek(501, 500)).toBe(false);
            expect(shouldTriggerBackwardSeek(1000, 500)).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('does not trigger for negative segment index', () => {
            expect(shouldTriggerBackwardSeek(-1, 500)).toBe(false);
        });
    });
});

describe('shouldTriggerForwardSeek', () => {
    const FAR_SEEK_THRESHOLD = 50;

    describe('sequential playback', () => {
        it('does not trigger for next segment', () => {
            expect(shouldTriggerForwardSeek(51, 50, FAR_SEEK_THRESHOLD)).toBe(false);
        });

        it('does not trigger for small seeks', () => {
            expect(shouldTriggerForwardSeek(100, 50, FAR_SEEK_THRESHOLD)).toBe(false);
            expect(shouldTriggerForwardSeek(99, 50, FAR_SEEK_THRESHOLD)).toBe(false);
        });
    });

    describe('far seeks', () => {
        it('triggers for seeks beyond threshold', () => {
            expect(shouldTriggerForwardSeek(101, 50, FAR_SEEK_THRESHOLD)).toBe(true);
            expect(shouldTriggerForwardSeek(500, 50, FAR_SEEK_THRESHOLD)).toBe(true);
        });

        it('does not trigger at exactly threshold boundary', () => {
            // 50 segments ahead is exactly at threshold, not beyond
            expect(shouldTriggerForwardSeek(100, 50, FAR_SEEK_THRESHOLD)).toBe(false);
        });
    });

    describe('custom threshold', () => {
        it('respects custom threshold', () => {
            expect(shouldTriggerForwardSeek(60, 50, 5)).toBe(true); // 10 > 5
            expect(shouldTriggerForwardSeek(55, 50, 10)).toBe(false); // 5 <= 10
        });
    });

    describe('edge cases', () => {
        it('handles seek to same position', () => {
            expect(shouldTriggerForwardSeek(50, 50, FAR_SEEK_THRESHOLD)).toBe(false);
        });

        it('handles backward seek (negative ahead)', () => {
            expect(shouldTriggerForwardSeek(30, 50, FAR_SEEK_THRESHOLD)).toBe(false);
        });
    });
});

describe('getSegmentFilename', () => {
    it('pads to 5 digits', () => {
        expect(getSegmentFilename(0)).toBe('segment_00000.m4s');
        expect(getSegmentFilename(1)).toBe('segment_00001.m4s');
        expect(getSegmentFilename(123)).toBe('segment_00123.m4s');
        expect(getSegmentFilename(12345)).toBe('segment_12345.m4s');
    });

    it('handles large numbers', () => {
        expect(getSegmentFilename(99999)).toBe('segment_99999.m4s');
        expect(getSegmentFilename(100000)).toBe('segment_100000.m4s'); // 6 digits is fine
    });
});

describe('calculateSeekTime', () => {
    it('calculates with default 6-second segments', () => {
        expect(calculateSeekTime(0)).toBe(0);
        expect(calculateSeekTime(1)).toBe(6);
        expect(calculateSeekTime(10)).toBe(60);
        expect(calculateSeekTime(100)).toBe(600); // 10 minutes
        expect(calculateSeekTime(500)).toBe(3000); // 50 minutes
    });

    it('handles custom segment duration', () => {
        expect(calculateSeekTime(10, 4)).toBe(40);
        expect(calculateSeekTime(10, 10)).toBe(100);
    });
});

describe('isSegmentDeleted', () => {
    describe('no deletions yet', () => {
        it('returns false when deletedUpTo is -1', () => {
            expect(isSegmentDeleted(0, -1)).toBe(false);
            expect(isSegmentDeleted(100, -1)).toBe(false);
        });
    });

    describe('with deletions', () => {
        it('returns true for segments at or below threshold', () => {
            expect(isSegmentDeleted(0, 49)).toBe(true);
            expect(isSegmentDeleted(49, 49)).toBe(true);
            expect(isSegmentDeleted(25, 49)).toBe(true);
        });

        it('returns false for segments above threshold', () => {
            expect(isSegmentDeleted(50, 49)).toBe(false);
            expect(isSegmentDeleted(100, 49)).toBe(false);
        });
    });

    describe('negative actual index (backward seek case)', () => {
        it('returns false for negative indices', () => {
            // Negative indices mean segment is before offset - should trigger backward seek, not 410
            expect(isSegmentDeleted(-1, 49)).toBe(false);
            expect(isSegmentDeleted(-100, 49)).toBe(false);
            expect(isSegmentDeleted(-400, -1)).toBe(false);
        });
    });
});

describe('calculateDeletionThreshold', () => {
    it('calculates threshold correctly', () => {
        expect(calculateDeletionThreshold(100, 50)).toBe(50);
        expect(calculateDeletionThreshold(200, 100)).toBe(100);
    });

    it('can return negative (nothing to delete yet)', () => {
        expect(calculateDeletionThreshold(30, 100)).toBe(-70);
    });

    it('returns 0 when lastServed equals keepBehind', () => {
        expect(calculateDeletionThreshold(100, 100)).toBe(0);
    });
});

describe('isPathSafe', () => {
    it('allows normal paths', () => {
        expect(isPathSafe('stream_0/segment_00000.m4s')).toBe(true);
        expect(isPathSafe('stream_0/init_0.mp4')).toBe(true);
        expect(isPathSafe('stream_0/index.m3u8')).toBe(true);
    });

    it('blocks path traversal', () => {
        expect(isPathSafe('../secret.txt')).toBe(false);
        expect(isPathSafe('stream_0/../../../etc/passwd')).toBe(false);
        expect(isPathSafe('..\\windows\\system32')).toBe(false);
    });

    it('allows paths with dots that are not traversal', () => {
        expect(isPathSafe('stream.backup/segment_00000.m4s')).toBe(true);
        expect(isPathSafe('.hidden/segment_00000.m4s')).toBe(true);
    });
});

// =============================================================================
// Integration-style tests for complete seek scenarios
// =============================================================================

describe('Complete Seek Scenarios', () => {
    const FAR_SEEK_THRESHOLD = 50;
    const KEEP_BEHIND = 100;

    describe('Scenario 1: Sequential Playback', () => {
        it('plays segments 0-150 without issues', () => {
            const offset = 0;

            // Each segment request
            for (let i = 0; i <= 150; i++) {
                const actualIndex = translateToActualIndex(i, offset);
                expect(actualIndex).toBe(i);
                expect(shouldTriggerBackwardSeek(i, offset)).toBe(false);
                expect(shouldTriggerForwardSeek(i, i, FAR_SEEK_THRESHOLD)).toBe(false);
            }
        });

        it('cleanup deletes old segments correctly', () => {
            // At segment 150, cleanup should delete 0-49
            const deletedUpTo = calculateDeletionThreshold(150, KEEP_BEHIND) - 1; // 49

            // Segments 0-49 are deleted
            for (let i = 0; i <= 49; i++) {
                expect(isSegmentDeleted(i, deletedUpTo)).toBe(true);
            }

            // Segments 50+ are not deleted
            for (let i = 50; i <= 150; i++) {
                expect(isSegmentDeleted(i, deletedUpTo)).toBe(false);
            }
        });
    });

    describe('Scenario 2: Forward Seek (Far Ahead)', () => {
        it('detects far seek from segment 50 to 500', () => {
            const currentProgress = 60; // segmentsReady=60, offset=0
            const requestedSegment = 500;

            expect(
                shouldTriggerForwardSeek(requestedSegment, currentProgress, FAR_SEEK_THRESHOLD),
            ).toBe(true);
        });

        it('after seek, first segment maps to actual 0', () => {
            const offset = 500;

            expect(translateToActualIndex(500, offset)).toBe(0);
            expect(translateToActualIndex(501, offset)).toBe(1);
            expect(translateToActualIndex(510, offset)).toBe(10);
        });
    });

    describe('Scenario 3: Backward Seek After Forward Seek', () => {
        it('detects backward seek from 550 to 100', () => {
            const offset = 500;
            const requestedSegment = 100;

            expect(shouldTriggerBackwardSeek(requestedSegment, offset)).toBe(true);
        });

        it('translates to negative actual index', () => {
            const offset = 500;
            const requestedSegment = 100;

            const actualIndex = translateToActualIndex(requestedSegment, offset);
            expect(actualIndex).toBe(-400);

            // Negative indices are NOT considered deleted
            expect(isSegmentDeleted(actualIndex, 49)).toBe(false);
        });
    });

    describe('Scenario 4: Backward Seek Within Kept Window', () => {
        it('allows seek within kept window', () => {
            const offset = 0;
            const requestedSegment = 100;
            const deletedUpTo = 49; // Cleanup deleted 0-49

            const actualIndex = translateToActualIndex(requestedSegment, offset);
            expect(actualIndex).toBe(100);
            expect(isSegmentDeleted(actualIndex, deletedUpTo)).toBe(false);
            expect(shouldTriggerBackwardSeek(requestedSegment, offset)).toBe(false);
        });
    });

    describe('Scenario 5: Backward Seek Beyond Kept Window', () => {
        it('returns deleted for segments outside window', () => {
            const offset = 0;
            const requestedSegment = 30;
            const deletedUpTo = 199; // Cleanup deleted 0-199

            const actualIndex = translateToActualIndex(requestedSegment, offset);
            expect(actualIndex).toBe(30);
            expect(isSegmentDeleted(actualIndex, deletedUpTo)).toBe(true);
        });
    });

    describe('Scenario 6: Rapid Seeks (Scrubbing)', () => {
        it('each seek position is valid independently', () => {
            // Simulating: 100 -> 200 -> 300 -> 400
            const seekPositions = [100, 200, 300, 400];
            let currentOffset = 0;

            for (const seekPos of seekPositions) {
                // First seek might not trigger far seek, subsequent ones might
                const currentProgress = currentOffset + 10; // Some progress

                if (shouldTriggerForwardSeek(seekPos, currentProgress, FAR_SEEK_THRESHOLD)) {
                    currentOffset = seekPos;
                }

                // First segment after each seek should map correctly
                expect(translateToActualIndex(currentOffset, currentOffset)).toBe(0);
            }
        });
    });

    describe('Scenario 7: Edge Cases at Boundaries', () => {
        it('segment exactly at threshold boundary', () => {
            const currentProgress = 50;
            const threshold = 50;

            // Exactly 50 ahead is NOT beyond threshold
            expect(shouldTriggerForwardSeek(100, currentProgress, threshold)).toBe(false);
            // 51 ahead IS beyond threshold
            expect(shouldTriggerForwardSeek(101, currentProgress, threshold)).toBe(true);
        });

        it('segment exactly at offset', () => {
            const offset = 500;

            expect(translateToActualIndex(500, offset)).toBe(0);
            expect(shouldTriggerBackwardSeek(500, offset)).toBe(false);
        });

        it('segment one before offset', () => {
            const offset = 500;

            expect(translateToActualIndex(499, offset)).toBe(-1);
            expect(shouldTriggerBackwardSeek(499, offset)).toBe(true);
        });
    });

    describe('Scenario 8: Very Short Video', () => {
        it('short video with fewer segments than threshold', () => {
            // Video with only 30 segments total
            const totalSegments = 30;
            const currentProgress = 5;

            // Seeking to segment 25 is NOT a far seek (only 20 segments ahead)
            expect(shouldTriggerForwardSeek(25, currentProgress, FAR_SEEK_THRESHOLD)).toBe(false);

            // All segments are within normal wait range
            for (let i = 0; i < totalSegments; i++) {
                const segmentsAhead = i - currentProgress;
                expect(segmentsAhead <= FAR_SEEK_THRESHOLD).toBe(true);
            }
        });
    });
});

describe('isSeekOnCooldown', () => {
    const COOLDOWN_MS = 5000;
    const THRESHOLD = 15;

    it('returns false when no previous seek (undefined timestamp)', () => {
        expect(isSeekOnCooldown(undefined, Date.now(), COOLDOWN_MS, 100, THRESHOLD)).toBe(false);
    });

    it('returns true when within cooldown and distance exceeds threshold', () => {
        const now = Date.now();
        const lastSeek = now - 2000; // 2s ago, within 5s cooldown
        expect(isSeekOnCooldown(lastSeek, now, COOLDOWN_MS, 120, THRESHOLD)).toBe(true);
    });

    it('returns false when within cooldown but distance is below threshold (short seek)', () => {
        const now = Date.now();
        const lastSeek = now - 2000; // 2s ago
        expect(isSeekOnCooldown(lastSeek, now, COOLDOWN_MS, 5, THRESHOLD)).toBe(false);
    });

    it('returns false when cooldown has expired even with far distance', () => {
        const now = Date.now();
        const lastSeek = now - 6000; // 6s ago, past 5s cooldown
        expect(isSeekOnCooldown(lastSeek, now, COOLDOWN_MS, 120, THRESHOLD)).toBe(false);
    });

    it('returns false when distance is exactly at threshold (boundary)', () => {
        const now = Date.now();
        const lastSeek = now - 2000;
        // distance === threshold → not "exceeds" → false
        expect(isSeekOnCooldown(lastSeek, now, COOLDOWN_MS, THRESHOLD, THRESHOLD)).toBe(false);
    });

    it('returns true when distance is one beyond threshold (boundary)', () => {
        const now = Date.now();
        const lastSeek = now - 2000;
        expect(isSeekOnCooldown(lastSeek, now, COOLDOWN_MS, THRESHOLD + 1, THRESHOLD)).toBe(true);
    });

    it('returns false when elapsed is exactly at cooldown (boundary)', () => {
        const now = Date.now();
        const lastSeek = now - COOLDOWN_MS; // exactly at boundary
        expect(isSeekOnCooldown(lastSeek, now, COOLDOWN_MS, 120, THRESHOLD)).toBe(false);
    });
});
