// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    TAIL_RUN_REACH_MARGIN_SECONDS,
    endSegmentEntryIndex,
    lastExtinfSeconds,
    lookupEndSegment,
    storeEndSegment,
    tailRunEntries,
    type EndSegmentCache,
    type EndSegmentCacheEntry,
} from './end-segment-cache';

// 40 s at 6 s: entries 0..6, the last [36, 40].
const GRID = { totalSeconds: 40, segmentSeconds: 6 };

const segment = (segmentIndex: number, bytes = `seg-${segmentIndex}`): EndSegmentCacheEntry => ({
    kind: 'segment',
    segmentIndex,
    buffer: Buffer.from(bytes),
});
const tailRun = (mediaEndSeconds: number, bytes = 'tail-run'): EndSegmentCacheEntry => ({
    kind: 'tail_run',
    mediaEndSeconds,
    buffer: Buffer.from(bytes),
});

describe('lookupEndSegment', () => {
    it('a segment entry answers its own index and no other', () => {
        const cache: EndSegmentCache = new Map([['stream_0', segment(5)]]);
        expect(lookupEndSegment(cache, 'stream_0', 5, GRID)?.toString()).toBe('seg-5');
        // The bug: index 6 (a phantom for this stream) got index 5's bytes.
        expect(lookupEndSegment(cache, 'stream_0', 6, GRID)).toBeUndefined();
        expect(lookupEndSegment(cache, 'stream_0', 4, GRID)).toBeUndefined();
        expect(lookupEndSegment(cache, 'stream_1', 5, GRID)).toBeUndefined();
    });

    it('a tail-run entry answers only the last grid entry', () => {
        const cache: EndSegmentCache = new Map([['stream_0', tailRun(40)]]);
        expect(lookupEndSegment(cache, 'stream_0', 6, GRID)?.toString()).toBe('tail-run');
        expect(lookupEndSegment(cache, 'stream_0', 5, GRID)).toBeUndefined();
        expect(lookupEndSegment(cache, 'stream_0', 4, GRID)).toBeUndefined();
    });

    it('a tail-run stream that ends before the last entry answers nothing', () => {
        // Copy audio 1.6 s short of a 40 s container still reaches [36, 40].
        expect(endSegmentEntryIndex(tailRun(38.4), GRID)).toBe(6);
        // Ending 0.1 s into the last entry is inside the estimate's error band.
        expect(endSegmentEntryIndex(tailRun(36.1), GRID)).toBe(-1);
        expect(endSegmentEntryIndex(tailRun(36 + TAIL_RUN_REACH_MARGIN_SECONDS + 0.01), GRID)).toBe(
            6,
        );
        // Ending before the last entry starts: that entry does not exist for it.
        expect(endSegmentEntryIndex(tailRun(35.2), GRID)).toBe(-1);
    });

    it('resolves a tail-run entry on the grid in force at lookup time', () => {
        // The stream's own cadence (10 s) is often learned after the worker ran.
        const cache: EndSegmentCache = new Map([['stream_1', tailRun(40)]]);
        const videoGrid = { totalSeconds: 40, segmentSeconds: 10 };
        expect(lookupEndSegment(cache, 'stream_1', 3, videoGrid)?.toString()).toBe('tail-run');
        expect(lookupEndSegment(cache, 'stream_1', 6, videoGrid)).toBeUndefined();
    });

    it('a negative index or an empty grid never hits', () => {
        const cache: EndSegmentCache = new Map([['stream_0', tailRun(40)]]);
        expect(lookupEndSegment(cache, 'stream_0', -1, GRID)).toBeUndefined();
        expect(
            lookupEndSegment(cache, 'stream_0', 0, { totalSeconds: 0, segmentSeconds: 6 }),
        ).toBeUndefined();
    });
});

describe('storeEndSegment', () => {
    it('a later playlist index replaces an earlier one, never the reverse', () => {
        const cache: EndSegmentCache = new Map();
        expect(storeEndSegment(cache, 'stream_0', segment(4), GRID)).toBe(true);
        expect(storeEndSegment(cache, 'stream_0', segment(6), GRID)).toBe(true);
        expect(storeEndSegment(cache, 'stream_0', segment(5), GRID)).toBe(false);
        expect(cache.get('stream_0')).toEqual(segment(6));
    });

    it('a real file beats a tail-run estimate for the same entry, and replaces it', () => {
        const cache: EndSegmentCache = new Map();
        expect(storeEndSegment(cache, 'stream_0', segment(6), GRID)).toBe(true);
        expect(storeEndSegment(cache, 'stream_0', tailRun(40), GRID)).toBe(false);
        expect(cache.get('stream_0')).toEqual(segment(6));

        const other: EndSegmentCache = new Map();
        storeEndSegment(other, 'stream_0', tailRun(40), GRID);
        expect(storeEndSegment(other, 'stream_0', segment(6, 'real'), GRID)).toBe(true);
        expect(other.get('stream_0')?.buffer.toString()).toBe('real');
    });

    it('a tail-run estimate for the last entry replaces an earlier real file', () => {
        const cache: EndSegmentCache = new Map([['stream_0', segment(4)]]);
        expect(storeEndSegment(cache, 'stream_0', tailRun(40), GRID)).toBe(true);
    });

    it('keeps a tail-run entry that answers nothing on the store-time grid only for an empty stream', () => {
        // The stream's cadence may be learned later; lookups re-resolve it.
        const cache: EndSegmentCache = new Map();
        expect(storeEndSegment(cache, 'stream_0', tailRun(35), GRID)).toBe(true);
        expect(lookupEndSegment(cache, 'stream_0', 6, GRID)).toBeUndefined();
        // 35 s reaches the last entry of a 10 s grid ([30, 40]).
        expect(
            lookupEndSegment(cache, 'stream_0', 3, { totalSeconds: 40, segmentSeconds: 10 }),
        ).toBeDefined();

        const held: EndSegmentCache = new Map([['stream_0', segment(4)]]);
        expect(storeEndSegment(held, 'stream_0', tailRun(35), GRID)).toBe(false);
        expect(held.get('stream_0')).toEqual(segment(4));
        // A real file still replaces the unresolved estimate.
        expect(storeEndSegment(cache, 'stream_0', segment(5), GRID)).toBe(true);
    });
});

describe('tailRunEntries', () => {
    it('places each stream by its gap to the longest one', () => {
        // Run clock measured on real FFmpeg output (-ss 10 on a 40 s file, copy
        // audio 38.4 s): audio ends at 28.501, video at 30.083.
        const entries = tailRunEntries(
            [
                { streamDir: 'stream_0', buffer: Buffer.from('a'), runEndSeconds: 28.501 },
                { streamDir: 'stream_1', buffer: Buffer.from('v'), runEndSeconds: 30.083 },
            ],
            40,
        );
        const audio = entries.get('stream_0');
        const video = entries.get('stream_1');
        expect(audio?.kind === 'tail_run' && audio.mediaEndSeconds).toBeCloseTo(38.418, 3);
        expect(video?.kind === 'tail_run' && video.mediaEndSeconds).toBe(40);
    });

    it('returns nothing without two streams or a duration', () => {
        expect(tailRunEntries([], 40).size).toBe(0);
        // A lone stream (a video-disabled run) has nothing to be measured
        // against: its file's container may end with a longer video.
        expect(
            tailRunEntries(
                [{ streamDir: 'stream_0', buffer: Buffer.from('a'), runEndSeconds: 28 }],
                40,
            ).size,
        ).toBe(0);
        expect(
            tailRunEntries(
                [{ streamDir: 'stream_0', buffer: Buffer.from('a'), runEndSeconds: 1 }],
                0,
            ).size,
        ).toBe(0);
    });
});

describe('lastExtinfSeconds', () => {
    it('reads the last EXTINF of a playlist', () => {
        const playlist = [
            '#EXTM3U',
            '#EXTINF:6.016000,',
            'segment_00000.m4s',
            '#EXTINF:4.501333,',
            'segment_00001.m4s',
            '#EXT-X-ENDLIST',
        ].join('\n');
        expect(lastExtinfSeconds(playlist)).toBeCloseTo(4.501333, 6);
        expect(lastExtinfSeconds('#EXTM3U\n')).toBeNull();
    });
});
