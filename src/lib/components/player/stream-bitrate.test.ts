// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { StreamBitrateMeter, decodedResolution, formatStreamBitrate } from './stream-bitrate';

describe('StreamBitrateMeter', () => {
    it('measures media bitrate, not transfer speed', () => {
        // A 4 Mbps stream: 6 s segments of 3 MB, however fast they download.
        const meter = new StreamBitrateMeter();
        expect(meter.add({ bytes: 3_000_000, mediaSec: 6 })).toBe(4_000_000);
    });

    it('averages over the window and forgets the oldest segments', () => {
        const meter = new StreamBitrateMeter();
        meter.add({ bytes: 30_000_000, mediaSec: 6 }); // 40 Mbps (old 1080p)
        for (let i = 0; i < 6; i++) meter.add({ bytes: 3_000_000, mediaSec: 6 });
        expect(meter.current()).toBe(4_000_000);
    });

    it('ignores empty or malformed samples', () => {
        const meter = new StreamBitrateMeter();
        expect(meter.add({ bytes: 0, mediaSec: 6 })).toBeNull();
        expect(meter.add({ bytes: 1000, mediaSec: 0 })).toBeNull();
        expect(meter.add({ bytes: Number.NaN, mediaSec: 6 })).toBeNull();
    });

    it('reset starts over for a new stream', () => {
        const meter = new StreamBitrateMeter();
        meter.add({ bytes: 30_000_000, mediaSec: 6 });
        meter.reset();
        expect(meter.current()).toBeNull();
    });
});

describe('formatStreamBitrate', () => {
    it('formats Mbps and kbps', () => {
        expect(formatStreamBitrate(4_100_000)).toBe('4.1 Mbps');
        expect(formatStreamBitrate(123_400_000)).toBe('123 Mbps');
        expect(formatStreamBitrate(850_000)).toBe('850 kbps');
    });
});

describe('decodedResolution', () => {
    it('reads the element dimensions', () => {
        expect(decodedResolution({ videoWidth: 1280, videoHeight: 720 })).toBe('1280x720');
    });

    it('is null before metadata or for audio-only', () => {
        expect(decodedResolution({ videoWidth: 0, videoHeight: 0 })).toBeNull();
        expect(decodedResolution(null)).toBeNull();
    });
});
