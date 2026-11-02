// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import {
    clearHlsSegmentRequestTrackersForTests,
    clearRepeatedSegmentRequest,
    noteRepeatedSegmentRequest,
    shouldLogStaleAudioRequestWarning,
} from './segment-request-tracker.js';

describe('hls segment request tracker', () => {
    afterEach(() => {
        clearHlsSegmentRequestTrackersForTests();
    });

    it('counts repeated segment requests within the window', () => {
        const options = {
            playSessionId: 'play',
            streamDir: 'stream_0',
            requestedSegmentNum: 10,
            windowMs: 1000,
        };

        expect(noteRepeatedSegmentRequest({ ...options, now: 1000 })).toBe(1);
        expect(noteRepeatedSegmentRequest({ ...options, now: 1500 })).toBe(2);
        expect(noteRepeatedSegmentRequest({ ...options, now: 3000 })).toBe(1);
    });

    it('clears repeated segment request entries', () => {
        const options = {
            playSessionId: 'play',
            streamDir: 'stream_0',
            requestedSegmentNum: 10,
            windowMs: 1000,
            now: 1000,
        };

        expect(noteRepeatedSegmentRequest(options)).toBe(1);
        clearRepeatedSegmentRequest('play', 'stream_0', 10);
        expect(noteRepeatedSegmentRequest({ ...options, now: 1100 })).toBe(1);
    });

    it('rate-limits stale audio warnings per request offset key', () => {
        const options = {
            playSessionId: 'play',
            streamDir: 'stream_0',
            requestedSegmentNum: 10,
            segmentOffset: 100,
            cooldownMs: 1000,
        };

        expect(shouldLogStaleAudioRequestWarning({ ...options, now: 1000 })).toBe(true);
        expect(shouldLogStaleAudioRequestWarning({ ...options, now: 1500 })).toBe(false);
        expect(shouldLogStaleAudioRequestWarning({ ...options, now: 2500 })).toBe(true);
    });
});
