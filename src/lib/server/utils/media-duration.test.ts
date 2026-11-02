// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    mediaEndFromStreams,
    parseStreamDurationSeconds,
    reconcileRuntimeSeconds,
} from './media-duration.js';

/** 2^32 ms — a subtitle packet with an "infinite" display time. */
const BOGUS = 4295262.295;

describe('parseStreamDurationSeconds', () => {
    it('reads stream.duration (mp4/ts)', () => {
        expect(parseStreamDurationSeconds({ duration: '300.040000' })).toBeCloseTo(300.04, 6);
    });

    it("reads mkvmerge's DURATION tag, language-suffixed or not", () => {
        expect(parseStreamDurationSeconds({ tags: { DURATION: '00:05:00.000000000' } })).toBe(300);
        expect(
            parseStreamDurationSeconds({ tags: { 'DURATION-eng': '01:02:03.500000000' } }),
        ).toBeCloseTo(3723.5, 6);
        expect(
            parseStreamDurationSeconds({ tags: { duration: '1193:07:42.295000000' } }),
        ).toBeCloseTo(BOGUS, 3);
    });

    it('ignores absent, zero and malformed values', () => {
        expect(parseStreamDurationSeconds({})).toBeUndefined();
        expect(parseStreamDurationSeconds({ duration: 'N/A' })).toBeUndefined();
        expect(parseStreamDurationSeconds({ duration: '0' })).toBeUndefined();
        expect(parseStreamDurationSeconds({ tags: { DURATION: '5 minutes' } })).toBeUndefined();
        expect(parseStreamDurationSeconds({ tags: { DURATION: '00:00:00.000' } })).toBeUndefined();
    });
});

describe('mediaEndFromStreams', () => {
    const video = (d: string) => ({ codec_type: 'video', tags: { DURATION: d } });
    const audio = (d: string) => ({ codec_type: 'audio', tags: { DURATION: d } });
    const sub = (d: string) => ({ codec_type: 'subtitle', tags: { DURATION: d } });

    it('takes the longest video/audio stream and never a subtitle', () => {
        expect(
            mediaEndFromStreams([
                video('00:05:00.000'),
                audio('00:05:00.500'),
                sub('1193:07:42.295'),
            ]),
        ).toBe(300.5);
    });

    it('skips cover art', () => {
        expect(
            mediaEndFromStreams([
                { codec_type: 'video', duration: '0.04', disposition: { attached_pic: 1 } },
                audio('00:03:30.000'),
            ]),
        ).toBe(210);
    });

    it('does not trust audio alone when the video has no duration', () => {
        expect(
            mediaEndFromStreams([{ codec_type: 'video' }, audio('00:02:00.000')]),
        ).toBeUndefined();
    });

    it('is undefined without any evidence', () => {
        expect(mediaEndFromStreams([])).toBeUndefined();
        expect(mediaEndFromStreams([sub('00:05:00.000')])).toBeUndefined();
    });
});

describe('reconcileRuntimeSeconds', () => {
    it('replaces a container duration far beyond the media end', () => {
        expect(reconcileRuntimeSeconds(BOGUS, 300)).toBe(300);
        expect(reconcileRuntimeSeconds(601, 300)).toBe(300);
    });

    it('replaces a > 24 h container that the media does not fill', () => {
        expect(reconcileRuntimeSeconds(30 * 3600, 20 * 3600)).toBe(20 * 3600);
    });

    it('keeps a plausible container duration', () => {
        // Trailing subtitles / small truncations stay with the container.
        expect(reconcileRuntimeSeconds(310, 300)).toBe(310);
        expect(reconcileRuntimeSeconds(590, 300)).toBe(590);
        // A genuinely long file whose streams agree.
        expect(reconcileRuntimeSeconds(25 * 3600, 25 * 3600 - 5)).toBe(25 * 3600);
        // Media slightly longer than the container: the container still wins.
        expect(reconcileRuntimeSeconds(300, 300.5)).toBe(300);
    });

    it('falls back to the evidence when the container has no duration', () => {
        expect(reconcileRuntimeSeconds(null, 300)).toBe(300);
        expect(reconcileRuntimeSeconds(Number.NaN, 300)).toBe(300);
        expect(reconcileRuntimeSeconds(0, 300)).toBe(300);
    });

    it('returns the container as-is without evidence', () => {
        expect(reconcileRuntimeSeconds(BOGUS, undefined)).toBe(BOGUS);
        expect(reconcileRuntimeSeconds(BOGUS, 0)).toBe(BOGUS);
        expect(reconcileRuntimeSeconds(null, null)).toBeNull();
    });
});
