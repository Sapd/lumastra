// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for WebVTT Parser and Segment Generator
 *
 * CRITICAL: Tests for subtitle sync bug fix (subbug)
 * Verifies that segment time ranges use ABSOLUTE timeline mapping,
 * independent of seek position, to ensure subtitles work correctly
 * when AVPlayer loads playlist once and never reloads during seeking.
 */

import { describe, it, expect } from 'vitest';
import {
    getSegmentTimeRange,
    parseVTTTimestamp,
    formatVTTTimestamp,
    parseWebVTT,
    generateSegment,
    getCuesInRange,
    type ParsedCue,
} from './webvtt-parser.js';

describe('webvtt-parser', () => {
    describe('getSegmentTimeRange - ABSOLUTE TIMELINE (subbug fix)', () => {
        const segmentDuration = 6; // 6 seconds per segment
        const totalDuration = 3600; // 1 hour

        it('should map segment 0 to 0-6s regardless of seek position', () => {
            // When transcode starts at t=0
            const range0 = getSegmentTimeRange(0, segmentDuration, totalDuration, 0);
            expect(range0.startSeconds).toBe(0);
            expect(range0.endSeconds).toBe(6);

            // When transcode starts at t=900 (15:00 seek)
            // Segment 0 should STILL map to 0-6s (absolute timeline)
            const range0WithSeek = getSegmentTimeRange(0, segmentDuration, totalDuration, 900);
            expect(range0WithSeek.startSeconds).toBe(0);
            expect(range0WithSeek.endSeconds).toBe(6);
        });

        it('should map segment 150 to 900-906s regardless of seek position', () => {
            // When transcode starts at t=0
            const range150 = getSegmentTimeRange(150, segmentDuration, totalDuration, 0);
            expect(range150.startSeconds).toBe(900);
            expect(range150.endSeconds).toBe(906);

            // When transcode starts at t=900 (15:00 seek)
            // Segment 150 should STILL map to 900-906s (absolute timeline)
            const range150WithSeek = getSegmentTimeRange(150, segmentDuration, totalDuration, 900);
            expect(range150WithSeek.startSeconds).toBe(900);
            expect(range150WithSeek.endSeconds).toBe(906);
        });

        it('should map segment N to N*duration seconds (absolute timeline)', () => {
            const testCases = [
                { segment: 0, expected: { start: 0, end: 6 } },
                { segment: 1, expected: { start: 6, end: 12 } },
                { segment: 10, expected: { start: 60, end: 66 } },
                { segment: 100, expected: { start: 600, end: 606 } },
                { segment: 150, expected: { start: 900, end: 906 } },
            ];

            for (const { segment, expected } of testCases) {
                // Test with NO seek offset
                const rangeNoSeek = getSegmentTimeRange(segment, segmentDuration, totalDuration, 0);
                expect(rangeNoSeek.startSeconds).toBe(expected.start);
                expect(rangeNoSeek.endSeconds).toBe(expected.end);

                // Test with seek offset (should be IGNORED)
                const rangeWithSeek = getSegmentTimeRange(
                    segment,
                    segmentDuration,
                    totalDuration,
                    900,
                );
                expect(rangeWithSeek.startSeconds).toBe(expected.start);
                expect(rangeWithSeek.endSeconds).toBe(expected.end);
            }
        });

        it('should clamp last segment to totalDuration', () => {
            const lastSegment = 599; // 599 * 6 = 3594s (last segment of 1-hour video)
            const range = getSegmentTimeRange(lastSegment, segmentDuration, totalDuration, 0);
            expect(range.startSeconds).toBe(3594);
            expect(range.endSeconds).toBe(3600); // Clamped to totalDuration
        });

        it('should ignore seekOffsetSeconds parameter (backward compatibility)', () => {
            // This test verifies the fix for subbug:
            // seekOffsetSeconds used to affect time range calculation
            // Now it should be ignored (kept for API compatibility)
            const segment = 50;
            const range1 = getSegmentTimeRange(segment, segmentDuration, totalDuration, 0);
            const range2 = getSegmentTimeRange(segment, segmentDuration, totalDuration, 900);
            const range3 = getSegmentTimeRange(segment, segmentDuration, totalDuration, 1800);

            expect(range1.startSeconds).toBe(range2.startSeconds);
            expect(range1.startSeconds).toBe(range3.startSeconds);
            expect(range1.endSeconds).toBe(range2.endSeconds);
            expect(range1.endSeconds).toBe(range3.endSeconds);
        });
    });

    describe('generateSegment - timestamp adjustment with seekOffset', () => {
        const segmentDuration = 6;

        it('should adjust cue timestamps relative to seekOffset', () => {
            // Cues at 900-903s and 903-906s (absolute media time)
            const cues: ParsedCue[] = [
                { startSeconds: 900, endSeconds: 903, text: 'First cue' },
                { startSeconds: 903, endSeconds: 906, text: 'Second cue' },
            ];

            // Segment 150 covers 900-906s (absolute timeline)
            const contentStart = 900;
            const contentEnd = 906;

            // When seekOffset = 900s (transcode started at 15:00)
            // Cue times should be RELATIVE to seek position:
            // 900s → 0s, 903s → 3s, 906s → 6s
            const seekOffset = 900;
            const segment = generateSegment(
                cues,
                contentStart,
                contentEnd,
                150,
                segmentDuration,
                false,
                seekOffset,
            );

            // Verify timestamps in generated WebVTT
            expect(segment).toContain('00:00:00.000 --> 00:00:03.000'); // First cue
            expect(segment).toContain('00:00:03.000 --> 00:00:06.000'); // Second cue
            expect(segment).toContain('First cue');
            expect(segment).toContain('Second cue');
        });

        it('should use absolute timestamps when seekOffset is 0', () => {
            const cues: ParsedCue[] = [{ startSeconds: 900, endSeconds: 903, text: 'Test cue' }];

            const segment = generateSegment(cues, 900, 906, 150, segmentDuration, false, 0);

            // With seekOffset=0, timestamps should be absolute
            expect(segment).toContain('00:15:00.000 --> 00:15:03.000');
        });

        it('should skip cues with invalid relative timestamps', () => {
            // Cue at 890-895s (before seek position)
            const cues: ParsedCue[] = [
                { startSeconds: 890, endSeconds: 895, text: 'Before seek' },
                { startSeconds: 900, endSeconds: 903, text: 'Valid cue' },
            ];

            // Segment 150 covers 900-906s, seekOffset = 900s
            const segment = generateSegment(cues, 900, 906, 150, segmentDuration, false, 900);

            // Should skip the cue before seek position
            expect(segment).not.toContain('Before seek');
            expect(segment).toContain('Valid cue');
        });
    });

    describe('parseVTTTimestamp', () => {
        it('should parse HH:MM:SS.mmm format', () => {
            expect(parseVTTTimestamp('00:15:00.000')).toBe(900);
            expect(parseVTTTimestamp('01:30:45.500')).toBe(5445.5);
        });

        it('should parse MM:SS.mmm format', () => {
            expect(parseVTTTimestamp('15:00.000')).toBe(900);
            expect(parseVTTTimestamp('30:45.500')).toBe(1845.5);
        });
    });

    describe('formatVTTTimestamp', () => {
        it('should format seconds to HH:MM:SS.mmm', () => {
            expect(formatVTTTimestamp(0)).toBe('00:00:00.000');
            expect(formatVTTTimestamp(900)).toBe('00:15:00.000');
            expect(formatVTTTimestamp(3665.123)).toBe('01:01:05.123');
        });

        it('should clamp negative values to 0', () => {
            expect(formatVTTTimestamp(-10)).toBe('00:00:00.000');
        });
    });

    describe('getCuesInRange', () => {
        it('should return only cues that START within the range', () => {
            const cues: ParsedCue[] = [
                { startSeconds: 895, endSeconds: 902, text: 'Before' }, // Starts before range
                { startSeconds: 900, endSeconds: 905, text: 'Start in range' }, // Starts in range
                { startSeconds: 903, endSeconds: 908, text: 'Middle' }, // Starts in range
                { startSeconds: 906, endSeconds: 910, text: 'After' }, // Starts at boundary (excluded)
            ];

            const result = getCuesInRange(cues, 900, 906);

            expect(result).toHaveLength(2);
            expect(result[0].text).toBe('Start in range');
            expect(result[1].text).toBe('Middle');
        });
    });

    describe('parseWebVTT', () => {
        it('should parse WebVTT with multiple cues', () => {
            const content = `WEBVTT

00:00:00.000 --> 00:00:03.000
First cue

00:00:03.000 --> 00:00:06.000
Second cue`;

            const result = parseWebVTT(content);

            expect(result.cues).toHaveLength(2);
            expect(result.cues[0].startSeconds).toBe(0);
            expect(result.cues[0].endSeconds).toBe(3);
            expect(result.cues[0].text).toBe('First cue');
            expect(result.cues[1].startSeconds).toBe(3);
            expect(result.cues[1].endSeconds).toBe(6);
            expect(result.cues[1].text).toBe('Second cue');
        });

        it('should sort cues by start time', () => {
            // Intentionally out-of-order cues
            const content = `WEBVTT

00:00:06.000 --> 00:00:09.000
Third cue

00:00:00.000 --> 00:00:03.000
First cue

00:00:03.000 --> 00:00:06.000
Second cue`;

            const result = parseWebVTT(content);

            expect(result.cues).toHaveLength(3);
            expect(result.cues[0].text).toBe('First cue');
            expect(result.cues[1].text).toBe('Second cue');
            expect(result.cues[2].text).toBe('Third cue');
        });
    });
});
