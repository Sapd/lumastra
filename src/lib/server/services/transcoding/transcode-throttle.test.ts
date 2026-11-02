// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    bufferAheadSeconds,
    decideThrottle,
    producedMediaSeconds,
    requestedMediaSeconds,
} from './transcode-throttle.js';

describe('producedMediaSeconds', () => {
    it('counts from the seek point: offset plus segments made since', () => {
        expect(
            producedMediaSeconds({
                segmentOffset: 50,
                segmentsReady: 10,
                segmentDurationSeconds: 6,
            }),
        ).toBe(360);
    });
});

describe('requestedMediaSeconds / bufferAheadSeconds', () => {
    const base = { segmentOffset: 0, segmentsReady: 50, segmentDurationSeconds: 6 };

    it('is undefined until the player requested a segment', () => {
        expect(requestedMediaSeconds({ requestedMediaSeconds: new Map() })).toBeUndefined();
        expect(bufferAheadSeconds({ ...base, requestedMediaSeconds: undefined })).toBeUndefined();
    });

    it('takes the stream furthest along', () => {
        const perStream = new Map([
            ['stream_0', 120],
            ['stream_1', 60],
        ]);
        expect(requestedMediaSeconds({ requestedMediaSeconds: perStream })).toBe(120);
        expect(bufferAheadSeconds({ ...base, requestedMediaSeconds: perStream })).toBe(180);
    });

    it('goes negative when the player is past the encoder (forward seek in flight)', () => {
        const perStream = new Map([['stream_0', 400]]);
        expect(bufferAheadSeconds({ ...base, requestedMediaSeconds: perStream })).toBe(-100);
    });
});

describe('decideThrottle', () => {
    const at = (aheadSeconds: number | undefined, throttled: boolean, enabled = true) =>
        decideThrottle({ enabled, throttled, aheadSeconds, pauseAfterSeconds: 120 });

    it('pauses strictly above the threshold', () => {
        expect(at(120, false)).toBe('none');
        expect(at(121, false)).toBe('pause');
    });

    it('resumes strictly below half the threshold', () => {
        expect(at(60, true)).toBe('none');
        expect(at(59, true)).toBe('resume');
        expect(at(-30, true)).toBe('resume');
    });

    it('holds its state between the two thresholds', () => {
        expect(at(90, false)).toBe('none');
        expect(at(90, true)).toBe('none');
    });

    it('never pauses without a known player position', () => {
        expect(at(undefined, false)).toBe('none');
        expect(at(undefined, true)).toBe('resume');
    });

    it('never pauses on a non-finite lead or threshold, and releases a paused one', () => {
        expect(at(Number.NaN, false)).toBe('none');
        expect(at(Number.NaN, true)).toBe('resume');
        expect(
            decideThrottle({
                enabled: true,
                throttled: true,
                aheadSeconds: 500,
                pauseAfterSeconds: Number.NaN,
            }),
        ).toBe('resume');
    });

    it('releases a paused process when disabled or ineligible', () => {
        expect(at(500, true, false)).toBe('resume');
        expect(at(500, false, false)).toBe('none');
    });
});
