// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buildHdrDetails, formatDvProfile, hdrBadgeLabel, type HdrCapsInput } from './hdr-details';

const chrome: HdrCapsInput = {
    dolbyVision: false,
    hdr10: true,
    hdr10Plus: false,
    hlg: true,
    hdrDisplay: true,
};
const safari: HdrCapsInput = { ...chrome, dolbyVision: true };

describe('formatDvProfile', () => {
    it('adds the compatibility id as sub-profile for 8 and 10 only', () => {
        expect(formatDvProfile(8, 1)).toBe('8.1');
        expect(formatDvProfile(8, 4)).toBe('8.4');
        expect(formatDvProfile(10, 1)).toBe('10.1');
        expect(formatDvProfile(7, 6)).toBe('7');
        expect(formatDvProfile(5, 0)).toBe('5');
        expect(formatDvProfile(8, undefined)).toBe('8');
        expect(formatDvProfile(undefined, 1)).toBeNull();
    });
});

describe('hdrBadgeLabel', () => {
    it('shows the real profile and the HDR10 output of a DV re-encode', () => {
        expect(
            hdrBadgeLabel({
                sourceFormat: 'dovi_hdr10',
                outputFormat: 'hdr10',
                isToneMapped: false,
                dvProfile: 8,
                dvBlCompatId: 1,
            }),
        ).toBe('DV P8.1 → HDR10');
    });

    it('does not claim a profile it does not know', () => {
        expect(
            hdrBadgeLabel({ sourceFormat: 'dovi', outputFormat: 'dovi', isToneMapped: false }),
        ).toBe('DV');
    });

    it('shows a tone-map to SDR', () => {
        expect(
            hdrBadgeLabel({ sourceFormat: 'hdr10', outputFormat: 'sdr', isToneMapped: true }),
        ).toBe('HDR10 → SDR');
    });

    it('keeps the legacy direct-play short label', () => {
        expect(
            hdrBadgeLabel({ sourceFormat: 'DV P8', outputFormat: null, isToneMapped: false }),
        ).toBe('DV');
    });
});

describe('buildHdrDetails', () => {
    const p81 = { sourceFormat: 'dovi_hdr10', dvProfile: 8, dvBlCompatId: 1 };

    it('DV P8.1 re-encoded: RPU dropped, HDR10 base layer kept', () => {
        const d = buildHdrDetails(
            { ...p81, outputFormat: 'hdr10', isToneMapped: false },
            { isVideoTranscode: true, targetCodec: 'HEVC', caps: chrome },
        );
        expect(d).toMatchObject({
            sourceLabel: 'Dolby Vision Profile 8.1',
            outputLabel: 'HDR10',
            baseLayer: 'hdr10',
            outcome: 'dv_stripped',
        });
    });

    it('DV copied to a browser without DV: plays the base layer', () => {
        const d = buildHdrDetails(
            { ...p81, outputFormat: 'dovi_hdr10', isToneMapped: false },
            { isVideoTranscode: false, caps: chrome },
        );
        expect(d?.outcome).toBe('dv_base_layer');
    });

    it('DV copied to Safari: passthrough', () => {
        const d = buildHdrDetails(
            { ...p81, outputFormat: 'dovi_hdr10', isToneMapped: false },
            { isVideoTranscode: false, caps: safari },
        );
        expect(d?.outcome).toBe('passthrough');
        expect(d?.outputLabel).toBe('Dolby Vision Profile 8.1');
    });

    it('DV P5 tone-mapped because the browser has no DV and there is no base layer', () => {
        const d = buildHdrDetails(
            {
                sourceFormat: 'dovi',
                dvProfile: 5,
                dvBlCompatId: 0,
                outputFormat: 'sdr',
                isToneMapped: true,
            },
            { isVideoTranscode: true, targetCodec: 'HEVC', caps: chrome },
        );
        expect(d).toMatchObject({
            baseLayer: 'none',
            outcome: 'tonemapped',
            tonemapCause: 'browser_no_dv',
        });
    });

    it('HDR10 to H.264 is tone-mapped because of the codec', () => {
        const d = buildHdrDetails(
            { sourceFormat: 'hdr10', outputFormat: 'sdr', isToneMapped: true },
            { isVideoTranscode: true, targetCodec: 'H264', caps: chrome },
        );
        expect(d?.tonemapCause).toBe('codec_no_hdr');
    });

    it('flags an HDR output on an SDR display', () => {
        const d = buildHdrDetails(
            { sourceFormat: 'hdr10', outputFormat: 'hdr10', isToneMapped: false },
            { isVideoTranscode: false, caps: { ...chrome, hdrDisplay: false } },
        );
        expect(d?.displaySdr).toBe(true);
    });

    it('returns null for SDR sources', () => {
        expect(
            buildHdrDetails(
                { sourceFormat: 'sdr', outputFormat: 'sdr', isToneMapped: false },
                { isVideoTranscode: false, caps: chrome },
            ),
        ).toBeNull();
    });
});
