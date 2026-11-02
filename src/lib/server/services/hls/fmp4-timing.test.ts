// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { box, buildFragment, buildInit } from './__fixtures__/fmp4-boxes.js';
import { readFragmentStart, readTrackTimescale } from './fmp4-timing.js';

describe('readTrackTimescale', () => {
    it('reads mdhd v0 and v1', () => {
        expect(readTrackTimescale(buildInit(16000, 0))).toBe(16000);
        expect(readTrackTimescale(buildInit(48000, 1))).toBe(48000);
    });

    it('returns null without a track', () => {
        expect(readTrackTimescale(box('moov', box('mvhd', Buffer.alloc(100))))).toBeNull();
        expect(readTrackTimescale(Buffer.alloc(3))).toBeNull();
    });
});

describe('readFragmentStart', () => {
    it('adds the first sample composition offset to tfdt', () => {
        const frag = buildFragment({ decodeTime: 19245200, firstCto: 1344 });
        const r = readFragmentStart(frag, 16000)!;
        expect(r.decodeSeconds).toBeCloseTo(1202.825, 6);
        expect(r.presentationSeconds).toBeCloseTo(1202.909, 6);
    });

    it('reads a wrapped negative decode time as negative (an encoder priming part)', () => {
        // FFmpeg writes AAC's first packet at −1024 samples as 2^64 − 1024.
        const wrapped = buildFragment({ decodeTime: 0, tfdtVersion: 1 });
        const tfdtAt = wrapped.indexOf('tfdt') + 4;
        wrapped.writeBigUInt64BE((1n << 64n) - 1024n, tfdtAt + 4);
        const r = readFragmentStart(wrapped, 48000)!;
        expect(r.decodeSeconds).toBeCloseTo(-1024 / 48000, 9);
        expect(r.presentationSeconds).toBeLessThan(0);
    });

    it('keeps a large 32-bit decode time positive (only the 64-bit field wraps)', () => {
        const r = readFragmentStart(
            buildFragment({ decodeTime: 0x80000001, tfdtVersion: 0 }),
            90000,
        )!;
        expect(r.decodeSeconds).toBeCloseTo(0x80000001 / 90000, 6);
    });

    it('handles a negative composition offset (trun v1)', () => {
        const r = readFragmentStart(buildFragment({ decodeTime: 16000, firstCto: -800 }), 16000)!;
        expect(r.presentationSeconds).toBeCloseTo(0.95, 6);
    });

    it('uses tfdt alone when samples carry no composition offset', () => {
        const r = readFragmentStart(
            buildFragment({ decodeTime: 57600000, tfdtVersion: 0 }),
            48000,
        )!;
        expect(r.decodeSeconds).toBe(1200);
        expect(r.presentationSeconds).toBe(1200);
    });

    it('returns null for a truncated or box-less buffer', () => {
        const frag = buildFragment({ decodeTime: 100, firstCto: 5 });
        expect(readFragmentStart(frag.subarray(0, 30), 1000)).toBeNull();
        expect(readFragmentStart(Buffer.alloc(0), 1000)).toBeNull();
        expect(readFragmentStart(frag, 0)).toBeNull();
    });
});
