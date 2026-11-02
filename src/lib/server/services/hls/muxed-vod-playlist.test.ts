// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

import { buildMuxedVodPlaylist } from './muxed-vod-playlist.js';
import { keyframes, runtimeSeconds } from './__fixtures__/irregular-copy-keyframes.js';

const base = {
    segmentDuration: 6,
    segmentBase: '/api/playback/x/hls',
    segmentParams: new URLSearchParams(),
    segmentExtension: 'm4s' as const,
};

describe('buildMuxedVodPlaylist', () => {
    it.each([0, 150, 325, 700, 950, 1000, 1200])(
        'keeps the complete irregular-copy timeline when a fresh source starts at %s seconds',
        (seekStartTime) => {
            const playlist = buildMuxedVodPlaylist({
                ...base,
                segmentDuration: 10,
                runtimeSeconds,
                keyframeData: keyframes,
                seekStartTime,
            });
            const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
            expect(durations.reduce((sum, duration) => sum + duration, 0)).toBeCloseTo(
                runtimeSeconds,
                6,
            );
            expect(durations.every((duration) => duration > 0)).toBe(true);
            if (seekStartTime === 0) {
                // The old native demux path filled a uniform 134-entry list with
                // a real 113-segment prefix, advertising 1332.951 instead of 1330.944.
                // The complete keyframe grid has 133 real entries from the start.
                expect(durations).toHaveLength(133);
                expect(
                    durations.slice(0, 113).reduce((sum, duration) => sum + duration, 0),
                ).toBeCloseTo(1132.007, 6);
                expect(durations.slice(0, 4)).toEqual([11.136, 9.843, 9.593, 12.304]);
            }
        },
    );

    // GPU transcode tests 2026-10-02: a bogus 2^32 ms runtime built ~716k
    // segments and `Math.max(...segmentDurations)` overflowed the call stack
    // (HTTP 500). The playlist builder must survive any segment count.
    it('caps an implausible runtime at 24 h instead of listing a month of segments', () => {
        const playlist = buildMuxedVodPlaylist({ ...base, runtimeSeconds: 4295262.295 });
        expect(playlist).toContain('#EXT-X-TARGETDURATION:6\n');
        expect(playlist.match(/#EXTINF:/g)?.length).toBe((24 * 3600) / 6);
        expect(playlist.endsWith('#EXT-X-ENDLIST\n')).toBe(true);
    });

    it('builds a keyframe grid with a huge segment count without overflowing the stack', () => {
        // 150k keyframes 0.5 s apart over ~21 h: the copy-grid path computes
        // one duration per segment and the target duration must not spread it.
        const keyframeData = Array.from({ length: 150_000 }, (_v, i) => i * 0.5);
        const playlist = buildMuxedVodPlaylist({
            ...base,
            segmentDuration: 0.5,
            runtimeSeconds: 75_000,
            keyframeData,
        });
        expect(playlist.match(/#EXTINF:/g)?.length).toBeGreaterThan(140_000);
        expect(playlist).toMatch(/#EXT-X-TARGETDURATION:1\n/);
    });

    it('sets the target duration from the longest segment', () => {
        const playlist = buildMuxedVodPlaylist({ ...base, runtimeSeconds: 20 });
        expect(playlist).toContain('#EXT-X-TARGETDURATION:6\n');
        expect(playlist.match(/#EXTINF:/g)?.length).toBe(4);
        expect(playlist).toContain('#EXTINF:2.000000,');
    });

    it('never advertises a target duration below 1 s', () => {
        const playlist = buildMuxedVodPlaylist({ ...base, runtimeSeconds: 0.5 });
        expect(playlist).toContain('#EXT-X-TARGETDURATION:1\n');
    });
});
