// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { buildAdaptiveReport } from './adaptive-report.js';
import { SessionAdaptiveReportSchema } from '$lib/schemas/session-adaptive.js';

const LIVE_LADDER = {
    rungs: [
        { id: '1080p8m', height: 1080, maxBitrateBps: 8_000_000, codec: 'h264' as const },
        { id: '720p4m', height: 720, maxBitrateBps: 4_000_000, codec: 'h264' as const },
        { id: '360p1m', height: 360, maxBitrateBps: 1_000_000, codec: 'h264' as const },
    ],
    includesOriginal: false,
};

const base = {
    liveLadder: null,
    decodedResolution: null,
    hlsLevels: null,
    hlsCurrentLevel: null,
    bandwidthEstimate: null,
    switches: 0,
    rebuffers: 0,
};

describe('buildAdaptiveReport', () => {
    it('names the Live TV rung from the decoded height', () => {
        const report = buildAdaptiveReport({
            ...base,
            liveLadder: LIVE_LADDER,
            decodedResolution: '1280x720',
            bandwidthEstimate: 18_400_000.6,
            switches: 2,
            rebuffers: 1,
        });
        expect(report).toEqual({
            variant_id: '720p4m',
            height: 720,
            indicated_bitrate: 4_000_000,
            ladder: [
                { id: '1080p8m', height: 1080, bitrate: 8_000_000 },
                { id: '720p4m', height: 720, bitrate: 4_000_000 },
                { id: '360p1m', height: 360, bitrate: 1_000_000 },
            ],
            measured_bandwidth: 18_400_001,
            switches: 2,
            rebuffers: 1,
        });
        expect(SessionAdaptiveReportSchema.safeParse(report).success).toBe(true);
    });

    it('reports the hls.js ladder for adaptive VOD, highest first', () => {
        const report = buildAdaptiveReport({
            ...base,
            hlsLevels: [
                { height: 480, bitrate: 1_400_000 },
                { height: 1080, bitrate: 5_800_000 },
            ],
            hlsCurrentLevel: 0,
        });
        expect(report).toMatchObject({
            height: 480,
            indicated_bitrate: 1_400_000,
            ladder: [
                { height: 1080, bitrate: 5_800_000 },
                { height: 480, bitrate: 1_400_000 },
            ],
        });
        expect(SessionAdaptiveReportSchema.safeParse(report).success).toBe(true);
    });

    it('sends nothing for single-rendition playback', () => {
        expect(
            buildAdaptiveReport({ ...base, hlsLevels: [{ height: 1080, bitrate: 9_000_000 }] }),
        ).toBeUndefined();
        expect(buildAdaptiveReport(base)).toBeUndefined();
    });

    it('omits the variant while the decoder has no picture yet', () => {
        const report = buildAdaptiveReport({ ...base, liveLadder: LIVE_LADDER });
        expect(report?.variant_id).toBeUndefined();
        expect(report?.ladder).toHaveLength(3);
    });
});

describe('buildAdaptiveReport stays inside the schema', () => {
    it('drops out-of-range values instead of sending them', () => {
        const report = buildAdaptiveReport({
            liveLadder: null,
            decodedResolution: '15360x8640',
            hlsLevels: [
                { height: 8640, bitrate: 2_000_000_000 },
                { height: 1080, bitrate: 6_000_000 },
            ],
            hlsCurrentLevel: 0,
            bandwidthEstimate: Number.POSITIVE_INFINITY,
            switches: 0,
            rebuffers: 0,
        });
        expect(SessionAdaptiveReportSchema.safeParse(report).success).toBe(true);
        expect(report?.height).toBeUndefined();
        expect(report?.measured_bandwidth).toBeUndefined();
    });
});
