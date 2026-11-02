// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `formatFailureCategory` / `formatEncoderName` are what stand between the
 * raw classifier/encoder ids (`invalid-argument`, `h264_qsv`, …) and an
 * operator who has never read the FFmpeg source — the failure mode is a
 * category or encoder id that isn't in the lookup table rendering nothing
 * (or throwing) instead of falling back to something readable.
 */

import { describe, it, expect } from 'vitest';
import { formatFailureCategory, formatEncoderName } from './format';

describe('formatFailureCategory', () => {
    it('gives every classifier category a label and a hint', () => {
        const categories = [
            'output-unavailable',
            'gpu-init',
            'codec-unsupported',
            'missing-input',
            'permission',
            'out-of-memory',
            'invalid-argument',
        ];
        for (const category of categories) {
            const display = formatFailureCategory(category);
            expect(display.label.length).toBeGreaterThan(0);
            expect(display.label).not.toBe(category);
            expect(display.hint).toBeTruthy();
        }
    });

    it('labels "unknown" without a hint', () => {
        const display = formatFailureCategory('unknown');
        expect(display.label.length).toBeGreaterThan(0);
        expect(display.hint).toBeNull();
    });

    it('falls back to a humanized id for a category the map does not know, with no hint', () => {
        const display = formatFailureCategory('gpu-failure');
        expect(display.label).toBe('Gpu failure');
        expect(display.hint).toBeNull();
    });

    it('humanizes an unrecognized underscore-separated id', () => {
        expect(formatFailureCategory('some_weird_id').label).toBe('Some weird id');
    });

    it('falls back to the raw id verbatim when it cannot be humanized', () => {
        expect(formatFailureCategory('').label).toBe('');
    });
});

describe('formatEncoderName', () => {
    it('labels null and the "software" id the same way', () => {
        expect(formatEncoderName(null).label).toBe(formatEncoderName('software').label);
        expect(formatEncoderName(null).label.length).toBeGreaterThan(0);
    });

    it('maps known codec/vendor combinations to a readable label', () => {
        expect(formatEncoderName('h264_qsv').label).toBe('Intel QSV (H.264)');
        expect(formatEncoderName('hevc_nvenc').label).toBe('NVIDIA NVENC (HEVC (H.265))');
        expect(formatEncoderName('av1_vaapi').label).toBe('VAAPI (AV1)');
        expect(formatEncoderName('h264_amf').label).toBe('AMD AMF (H.264)');
        expect(formatEncoderName('hevc_videotoolbox').label).toBe(
            'Apple VideoToolbox (HEVC (H.265))',
        );
    });

    it('falls back to the raw id for an unrecognized vendor or codec', () => {
        expect(formatEncoderName('foo_bar').label).toBe('foo_bar');
        expect(formatEncoderName('h264_unknownvendor').label).toBe('h264_unknownvendor');
    });

    it('falls back to the raw id for an id with no vendor separator', () => {
        expect(formatEncoderName('libx264').label).toBe('libx264');
    });
});
