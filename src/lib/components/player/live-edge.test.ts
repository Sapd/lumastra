// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { catchUpOnVisibility, liveEdgeDistance, livePosition } from './live-edge.js';

const seekable: TimeRanges = { length: 2, start: (i) => i * 100, end: (i) => i * 100 + 30 };

describe('live edge', () => {
    it('measures delay against the HLS sync position and clamps negative delay', () => {
        const position = livePosition({ seekable }, { liveSyncPosition: 124 });
        expect(position).toBe(124);
        expect(liveEdgeDistance(position, 110)).toBe(14);
        expect(liveEdgeDistance(position, 126)).toBe(0);
    });

    it('reports an unknown delay when the live window is unavailable', () => {
        const position = livePosition({ seekable: { ...seekable, length: 0 } });
        expect(liveEdgeDistance(position, 0)).toBeNull();
        expect(liveEdgeDistance(Infinity, 10)).toBeNull();
    });

    it('uses the last seekable range on Safari and leaves room to buffer', () => {
        const video = { currentTime: 108, seekable, paused: false, readyState: 2 };
        expect(catchUpOnVisibility(true, video)).toBe(false);
        expect(video.currentTime).toBe(108);
        expect(catchUpOnVisibility(false, video)).toBe(true);
        expect(video.currentTime).toBe(127);
    });

    it('does not rewind or seek during a pause', () => {
        const video = { currentTime: 126, seekable, paused: false, readyState: 2 };
        expect(catchUpOnVisibility(false, video, { liveSyncPosition: 124 })).toBe(false);
        expect(catchUpOnVisibility(false, { ...video, paused: true })).toBe(false);
        expect(video.currentTime).toBe(126);
    });
});
