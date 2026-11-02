// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trickplay needs the duration, codec, pixel format and size of the file's
 * video stream. The media-probe stage has already stored all of them, so the
 * generator reads them instead of running ffprobe again. The stored row is used
 * only when every field it needs is present; otherwise the caller probes.
 */

import { describe, it, expect } from 'vitest';
import { videoInfoFromStoredProbe } from './trickplay-stored-video-info.js';

const COMPLETE = {
    probed_at: new Date('2026-10-20T10:00:00Z'),
    duration_seconds: 5400.5,
    width: 1920,
    height: 1080,
    codec: 'hevc',
    pixel_format: 'yuv420p10le',
};

describe('videoInfoFromStoredProbe', () => {
    it('maps a complete stored probe to the trickplay video info', () => {
        expect(videoInfoFromStoredProbe(COMPLETE)).toEqual({
            duration: 5400.5,
            width: 1920,
            height: 1080,
            codec: 'hevc',
            pixFmt: 'yuv420p10le',
        });
    });

    it('returns null when the file has never been probed', () => {
        expect(videoInfoFromStoredProbe({ ...COMPLETE, probed_at: null })).toBeNull();
    });

    it('returns null when the stored duration is missing or not positive', () => {
        expect(videoInfoFromStoredProbe({ ...COMPLETE, duration_seconds: null })).toBeNull();
        expect(videoInfoFromStoredProbe({ ...COMPLETE, duration_seconds: 0 })).toBeNull();
    });

    it('returns null when there is no video stream to take the size from', () => {
        expect(
            videoInfoFromStoredProbe({ ...COMPLETE, width: null, height: null, codec: null }),
        ).toBeNull();
    });

    it('returns null when the pixel format is not stored, because GPU decode is keyed on it', () => {
        expect(videoInfoFromStoredProbe({ ...COMPLETE, pixel_format: null })).toBeNull();
    });
});
