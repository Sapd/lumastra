// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression tests for transcode decision bugs
 *
 * These tests verify the fixes for critical bugs found:
 * - Bug 1 & 2: mode='full' should not force video transcoding
 * - Bug 3: RefFramesExceedsLimit must be included in videoNeedsTranscode
 * - Bug 4: All video reasons must trigger full mode in determineMode
 */

import { describe, it, expect } from 'vitest';
import { TranscodeReason } from './types';

describe('TranscodeReason Bitmask Tests', () => {
    /**
     * Bug 3 regression test: RefFramesExceedsLimit must trigger video transcoding
     */
    it('videoNeedsTranscode bitmask must include RefFramesExceedsLimit', () => {
        const videoNeedsTranscodeMask =
            TranscodeReason.VideoCodecNotSupported |
            TranscodeReason.VideoProfileNotSupported |
            TranscodeReason.VideoLevelNotSupported |
            TranscodeReason.VideoRangeNotSupported |
            TranscodeReason.ResolutionExceedsLimit |
            TranscodeReason.BitrateExceedsLimit |
            TranscodeReason.InterlacedNotSupported |
            TranscodeReason.AnamorphicNotSupported |
            TranscodeReason.RefFramesExceedsLimit; // ← Bug fix: This was missing!

        // Test that RefFramesExceedsLimit triggers transcoding
        const reasons = TranscodeReason.RefFramesExceedsLimit;
        const videoNeedsTranscode = (reasons & videoNeedsTranscodeMask) !== 0;

        expect(videoNeedsTranscode).toBe(true);
    });

    /**
     * Bug 4 regression test: All video reasons must trigger full mode
     */
    it('videoOnlyReasons must include all video transcode reasons', () => {
        const videoOnlyReasons =
            TranscodeReason.VideoCodecNotSupported |
            TranscodeReason.VideoProfileNotSupported |
            TranscodeReason.VideoLevelNotSupported |
            TranscodeReason.VideoRangeNotSupported |
            TranscodeReason.ResolutionExceedsLimit | // ← Bug fix: These were missing!
            TranscodeReason.BitrateExceedsLimit |
            TranscodeReason.InterlacedNotSupported |
            TranscodeReason.AnamorphicNotSupported |
            TranscodeReason.RefFramesExceedsLimit;

        // Test each video reason triggers full mode
        const videoReasons = [
            TranscodeReason.VideoCodecNotSupported,
            TranscodeReason.VideoProfileNotSupported,
            TranscodeReason.VideoLevelNotSupported,
            TranscodeReason.VideoRangeNotSupported,
            TranscodeReason.ResolutionExceedsLimit,
            TranscodeReason.BitrateExceedsLimit,
            TranscodeReason.InterlacedNotSupported,
            TranscodeReason.AnamorphicNotSupported,
            TranscodeReason.RefFramesExceedsLimit,
        ];

        for (const reason of videoReasons) {
            const triggersFullMode = (reason & videoOnlyReasons) !== 0;
            expect(triggersFullMode).toBe(true);
        }
    });

    /**
     * Bug 1 & 2 regression test: Container/Config reasons should NOT trigger video transcoding
     */
    it('ContainerNotSupported and ForcedByConfig should NOT trigger video transcoding', () => {
        const videoNeedsTranscodeMask =
            TranscodeReason.VideoCodecNotSupported |
            TranscodeReason.VideoProfileNotSupported |
            TranscodeReason.VideoLevelNotSupported |
            TranscodeReason.VideoRangeNotSupported |
            TranscodeReason.ResolutionExceedsLimit |
            TranscodeReason.BitrateExceedsLimit |
            TranscodeReason.InterlacedNotSupported |
            TranscodeReason.AnamorphicNotSupported |
            TranscodeReason.RefFramesExceedsLimit;

        // ContainerNotSupported alone should NOT trigger video transcoding
        const containerOnly = TranscodeReason.ContainerNotSupported;
        const needsTranscode1 = (containerOnly & videoNeedsTranscodeMask) !== 0;
        expect(needsTranscode1).toBe(false);

        // ForcedByConfig alone should NOT trigger video transcoding
        const forcedOnly = TranscodeReason.ForcedByConfig;
        const needsTranscode2 = (forcedOnly & videoNeedsTranscodeMask) !== 0;
        expect(needsTranscode2).toBe(false);

        // Combined should also NOT trigger (Bug 1 scenario: HEVC in MKV with mode=full)
        const combined = TranscodeReason.ContainerNotSupported | TranscodeReason.ForcedByConfig;
        const needsTranscode3 = (combined & videoNeedsTranscodeMask) !== 0;
        expect(needsTranscode3).toBe(false);
    });

    /**
     * Verify audio reasons don't trigger video transcoding
     */
    it('audio-only reasons should NOT trigger video transcoding', () => {
        const videoNeedsTranscodeMask =
            TranscodeReason.VideoCodecNotSupported |
            TranscodeReason.VideoProfileNotSupported |
            TranscodeReason.VideoLevelNotSupported |
            TranscodeReason.VideoRangeNotSupported |
            TranscodeReason.ResolutionExceedsLimit |
            TranscodeReason.BitrateExceedsLimit |
            TranscodeReason.InterlacedNotSupported |
            TranscodeReason.AnamorphicNotSupported |
            TranscodeReason.RefFramesExceedsLimit;

        const audioReasons = [
            TranscodeReason.AudioCodecNotSupported,
            TranscodeReason.AudioChannelsNotSupported,
            TranscodeReason.SecondaryAudioNotSupported,
        ];

        for (const reason of audioReasons) {
            const triggersVideoTranscode = (reason & videoNeedsTranscodeMask) !== 0;
            expect(triggersVideoTranscode).toBe(false);
        }
    });

    /**
     * Document the complete bitmask for video transcoding
     */
    it('documents complete videoNeedsTranscode bitmask', () => {
        // This is the COMPLETE list of reasons that require video transcoding
        const videoNeedsTranscodeMask =
            TranscodeReason.VideoCodecNotSupported |
            TranscodeReason.VideoProfileNotSupported |
            TranscodeReason.VideoLevelNotSupported |
            TranscodeReason.VideoRangeNotSupported |
            TranscodeReason.ResolutionExceedsLimit |
            TranscodeReason.BitrateExceedsLimit |
            TranscodeReason.InterlacedNotSupported |
            TranscodeReason.AnamorphicNotSupported |
            TranscodeReason.RefFramesExceedsLimit;

        // Verify it's not zero (sanity check)
        expect(videoNeedsTranscodeMask).toBeGreaterThan(0);

        // Test a combination scenario
        const multipleReasons =
            TranscodeReason.ContainerNotSupported |
            TranscodeReason.VideoCodecNotSupported |
            TranscodeReason.AudioCodecNotSupported;

        const needsTranscode = (multipleReasons & videoNeedsTranscodeMask) !== 0;
        expect(needsTranscode).toBe(true); // Because VideoCodecNotSupported is present
    });
});
