// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

import { parseVobSub, parseIdxPalette, parseIdxSize } from './vobsub-parser.js';
import { toRgba } from './pgs-parser.js';

/** `.idx`-style track private data, as Matroska CodecPrivate carries it. */
const CODEC_PRIVATE = Buffer.from(
    'size: 1920x1080\n' +
        'palette: 000000, f0f0f0, cccccc, 999999, 3333fa, 1111bb, fa3333, bb1111, ' +
        '33fa33, 11bb11, fafa33, bbbb11, fa33fa, bb11bb, 33fafa, 11bbbb\n',
    'utf-8',
);

/**
 * Build one SPU packet.
 *
 * Layout: size(2) controlOffset(2) [top field RLE] [bottom field RLE] [DCSQ...]
 */
function spu(options: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    topField: Buffer;
    bottomField: Buffer;
    /** 4 palette indices, for pixel values 0..3. */
    colours?: [number, number, number, number];
    /** 4 alphas 0-15, for pixel values 0..3. */
    alphas?: [number, number, number, number];
    stopDelayTicks?: number;
}): Buffer {
    const colours = options.colours ?? [0, 1, 2, 3];
    const alphas = options.alphas ?? [0, 15, 15, 15];

    const topOffset = 4;
    const bottomOffset = topOffset + options.topField.length;
    const controlOffset = bottomOffset + options.bottomField.length;

    // Nibbles pack high→low as pixel value 3,2,1,0.
    const packNibbles = (v: [number, number, number, number]): number =>
        ((v[3] & 0xf) << 12) | ((v[2] & 0xf) << 8) | ((v[1] & 0xf) << 4) | (v[0] & 0xf);

    const first = Buffer.alloc(4 + 1 + 3 + 3 + 7 + 5 + 1);
    let at = 0;
    first.writeUInt16BE(0, at); // delay 0
    at += 2;
    const nextAddrAt = at;
    at += 2;
    first[at++] = 0x01; // STA_DSP
    first[at++] = 0x03; // SET_COLOR
    first.writeUInt16BE(packNibbles(colours), at);
    at += 2;
    first[at++] = 0x04; // SET_CONTR
    first.writeUInt16BE(packNibbles(alphas), at);
    at += 2;
    first[at++] = 0x05; // SET_DAREA
    first[at++] = options.x1 >> 4;
    first[at++] = ((options.x1 & 0x0f) << 4) | (options.x2 >> 8);
    first[at++] = options.x2 & 0xff;
    first[at++] = options.y1 >> 4;
    first[at++] = ((options.y1 & 0x0f) << 4) | (options.y2 >> 8);
    first[at++] = options.y2 & 0xff;
    first[at++] = 0x06; // SET_DSPXA
    first.writeUInt16BE(topOffset, at);
    at += 2;
    first.writeUInt16BE(bottomOffset, at);
    at += 2;
    first[at] = 0xff; // CMD_END — last write, cursor not needed after

    const second = Buffer.alloc(4 + 2);
    second.writeUInt16BE(options.stopDelayTicks ?? 120, 0);
    second[4] = 0x02; // STP_DSP
    second[5] = 0xff; // CMD_END

    first.writeUInt16BE(controlOffset + first.length, nextAddrAt);
    second.writeUInt16BE(controlOffset + first.length, 2); // self-pointing = last

    const total = controlOffset + first.length + second.length;
    const header = Buffer.alloc(4);
    header.writeUInt16BE(total, 0);
    header.writeUInt16BE(controlOffset, 2);

    return Buffer.concat([header, options.topField, options.bottomField, first, second]);
}

/**
 * One RLE line: a single run of `count` pixels of `colour`.
 *
 * DVD SPU has NO end-of-line marker — unlike PGS. A line ends when the decoder
 * has emitted `width` pixels, and the stream then advances to the next byte
 * boundary. Emitting a terminator here would be consumed as a full-line
 * background run and desynchronise every following row.
 *
 * The run descriptor is `(count << 2) | colour`, written in the narrowest form
 * the decoder's escape chain accepts: values 0x10-0x3F take two nibbles, which
 * for counts 4-15 is exactly one byte and therefore already aligned.
 */
function rleLine(count: number, colour: number): Buffer {
    const value = (count << 2) | colour;
    if (value < 0x10 || value > 0x3f) {
        throw new Error(`rleLine helper only encodes the 2-nibble form; got ${value}`);
    }
    return Buffer.from([value]);
}

function packet(ptsMs: number, durationMs: number, data: Buffer) {
    return { ptsMs, durationMs, data };
}

describe('parseIdxPalette', () => {
    it('reads sixteen RGB entries', () => {
        const palette = parseIdxPalette(CODEC_PRIVATE);
        expect(palette).not.toBeNull();
        expect(palette).toHaveLength(16 * 3);
        // entry 1 is f0f0f0
        expect(Array.from(palette!.subarray(3, 6))).toEqual([0xf0, 0xf0, 0xf0]);
    });

    it('returns null when the track carries no palette', () => {
        expect(parseIdxPalette(Buffer.from('size: 720x576\n'))).toBeNull();
        expect(parseIdxPalette(null)).toBeNull();
    });

    it('returns null for a short palette rather than a partial one', () => {
        expect(parseIdxPalette(Buffer.from('palette: 000000, ffffff\n'))).toBeNull();
    });
});

describe('parseIdxSize', () => {
    it('reads the canvas', () => {
        expect(parseIdxSize(CODEC_PRIVATE)).toEqual({ width: 1920, height: 1080 });
    });

    it('returns null when absent', () => {
        expect(parseIdxSize(Buffer.from('palette: 000000\n'))).toBeNull();
    });
});

describe('parseVobSub', () => {
    /** 4x2 rect: both rows fully painted with pixel value 1. */
    const simple = (): Buffer =>
        spu({
            x1: 100,
            y1: 900,
            x2: 103,
            y2: 901,
            topField: rleLine(4, 1),
            bottomField: rleLine(4, 1),
        });

    it('takes cue timing from the container', () => {
        const result = parseVobSub([packet(4087, 1365, simple())], CODEC_PRIVATE);

        expect(result.cues).toHaveLength(1);
        expect(result.cues[0].startMs).toBe(4087);
        expect(result.cues[0].endMs).toBe(4087 + 1365);
        expect(result.warnings).toEqual([]);
    });

    it('reads the rect from the display area command', () => {
        const [cue] = parseVobSub([packet(0, 1000, simple())], CODEC_PRIVATE).cues;
        expect(cue.rects[0]).toMatchObject({ x: 100, y: 900, width: 4, height: 2 });
    });

    it('reports the canvas from the track private data', () => {
        const result = parseVobSub([packet(0, 1000, simple())], CODEC_PRIVATE);
        expect(result.canvasWidth).toBe(1920);
        expect(result.canvasHeight).toBe(1080);
    });

    // The two fields are INTERLACED: top holds even rows, bottom holds odd ones.
    // Decoding both into the same rows (or swapping them) leaves alternate rows
    // blank, which still reads as text on screen — just faintly striped.
    it('interleaves the top field into even rows and the bottom into odd', () => {
        const data = spu({
            x1: 0,
            y1: 0,
            x2: 3,
            y2: 3,
            topField: Buffer.concat([rleLine(4, 1), rleLine(4, 1)]),
            bottomField: Buffer.concat([rleLine(4, 2), rleLine(4, 2)]),
        });

        const [cue] = parseVobSub([packet(0, 1000, data)], CODEC_PRIVATE).cues;
        const { indices, width } = cue.rects[0];

        expect(Array.from(indices.subarray(0, width))).toEqual([1, 1, 1, 1]); // row 0 top
        expect(Array.from(indices.subarray(width, width * 2))).toEqual([2, 2, 2, 2]); // row 1 bottom
        expect(Array.from(indices.subarray(width * 2, width * 3))).toEqual([1, 1, 1, 1]); // row 2 top
        expect(Array.from(indices.subarray(width * 3, width * 4))).toEqual([2, 2, 2, 2]); // row 3 bottom
    });

    // No row may be left empty when both fields carry data — the striping check.
    it('leaves no blank rows when both fields are painted', () => {
        const data = spu({
            x1: 0,
            y1: 0,
            x2: 3,
            y2: 5,
            topField: Buffer.concat([rleLine(4, 1), rleLine(4, 1), rleLine(4, 1)]),
            bottomField: Buffer.concat([rleLine(4, 1), rleLine(4, 1), rleLine(4, 1)]),
        });

        const [cue] = parseVobSub([packet(0, 1000, data)], CODEC_PRIVATE).cues;
        const { indices, width, height } = cue.rects[0];

        for (let row = 0; row < height; row++) {
            const painted = Array.from(indices.subarray(row * width, (row + 1) * width)).filter(
                (v) => v !== 0,
            );
            expect(painted).toHaveLength(width);
        }
    });

    // Pixel values index four slots, and each slot indexes the 16-entry global
    // palette. Getting the nibble order backwards silently swaps text and outline.
    it('maps pixel values through the selected palette slots', () => {
        const data = spu({
            x1: 0,
            y1: 0,
            x2: 3,
            y2: 1,
            topField: rleLine(4, 1),
            bottomField: rleLine(4, 1),
            colours: [0, 1, 3, 0], // value 1 -> global entry 1 = f0f0f0
            alphas: [0, 15, 15, 15],
        });

        const [cue] = parseVobSub([packet(0, 1000, data)], CODEC_PRIVATE).cues;
        const rgba = toRgba(cue.rects[0]);

        expect(Array.from(rgba.subarray(0, 4))).toEqual([0xf0, 0xf0, 0xf0, 255]);
    });

    it('renders alpha 0 as fully transparent and 15 as fully opaque', () => {
        const data = spu({
            x1: 0,
            y1: 0,
            x2: 3,
            y2: 1,
            topField: rleLine(4, 0), // value 0 = background
            bottomField: rleLine(4, 1),
            alphas: [0, 15, 15, 15],
        });

        const [cue] = parseVobSub([packet(0, 1000, data)], CODEC_PRIVATE).cues;
        const rgba = toRgba(cue.rects[0]);
        const width = cue.rects[0].width;

        expect(rgba[3]).toBe(0); // row 0, background
        expect(rgba[width * 4 + 3]).toBe(255); // row 1, painted
    });

    // Without a container duration there is nothing to display against, so the
    // SPU's own stop delay is the fallback rather than dropping the cue.
    it('falls back to the control sequence stop delay', () => {
        const data = spu({
            x1: 0,
            y1: 0,
            x2: 3,
            y2: 1,
            topField: rleLine(4, 1),
            bottomField: rleLine(4, 1),
            stopDelayTicks: 120,
        });

        const [cue] = parseVobSub([packet(1000, 0, data)], CODEC_PRIVATE).cues;
        // 120 ticks * 1024 / 90000 = 1.365s
        expect(cue.endMs - cue.startMs).toBe(1365);
    });

    it('falls back to greyscale when the track has no palette', () => {
        const result = parseVobSub([packet(0, 1000, simple())], null);
        expect(result.cues).toHaveLength(1);
        expect(result.warnings.join(' ')).toMatch(/palette/i);
    });

    // SET_DAREA coordinates are 12-bit, so they cannot exceed 4095 and the
    // absolute size ceiling is unreachable through a well-formed command. The
    // reachable failure is an inverted rectangle, which yields a negative extent.
    it('skips a packet whose display area is inverted', () => {
        const data = spu({
            x1: 500,
            y1: 500,
            x2: 100,
            y2: 100,
            topField: rleLine(4, 1),
            bottomField: rleLine(4, 1),
        });

        const result = parseVobSub([packet(0, 1000, data)], CODEC_PRIVATE);
        expect(result.cues).toEqual([]);
        expect(result.warnings.join(' ')).toMatch(/implausible/i);
    });

    it('skips a truncated packet rather than throwing', () => {
        const result = parseVobSub([packet(0, 1000, Buffer.from([0x00, 0x10]))], CODEC_PRIVATE);
        expect(result.cues).toEqual([]);
    });

    it('returns an empty result for no packets', () => {
        const result = parseVobSub([], CODEC_PRIVATE);
        expect(result.cues).toEqual([]);
        expect(result.canvasWidth).toBe(1920);
    });

    // The HD-DVD SPU flavour uses 32-bit sizes and offsets; read as a standard
    // packet its fields decode to nonsense geometry.
    it('rejects the HD-DVD variant rather than mis-parsing it', () => {
        const hd = Buffer.alloc(64);
        hd.writeUInt16BE(0, 0); // zero size marks the HD variant
        hd.writeUInt32BE(64, 2);

        const result = parseVobSub([packet(0, 1000, hd)], CODEC_PRIVATE);
        expect(result.cues).toEqual([]);
        expect(result.warnings.join(' ')).toMatch(/HD-DVD/i);
    });

    // A single-row subpicture leaves the bottom field with zero lines. FFmpeg
    // drops these outright; there is no reason to.
    it('decodes a single-row subpicture from the top field alone', () => {
        const data = spu({
            x1: 0,
            y1: 0,
            x2: 3,
            y2: 0,
            topField: rleLine(4, 1),
            bottomField: Buffer.alloc(0),
        });

        const [cue] = parseVobSub([packet(0, 1000, data)], CODEC_PRIVATE).cues;
        expect(cue.rects[0]).toMatchObject({ width: 4, height: 1 });
        expect(Array.from(cue.rects[0].indices)).toEqual([1, 1, 1, 1]);
    });

    // The 12-bit coordinate cap makes a per-dimension ceiling unreachable, so the
    // real guard is on decoded AREA. Fill-to-end-of-line means ~2 bytes paints a
    // whole row, so a tiny packet can otherwise declare a 4096x4096 bitmap.
    it('refuses a cue declaring more rows than its RLE could encode', () => {
        const data = spu({
            x1: 0,
            y1: 0,
            x2: 4095,
            y2: 4095,
            topField: rleLine(4, 1),
            bottomField: rleLine(4, 1),
        });

        const result = parseVobSub([packet(0, 1000, data)], CODEC_PRIVATE);
        expect(result.cues).toEqual([]);
        expect(result.warnings.join(' ')).toMatch(/pixel budget|could encode/i);
    });

    // Without a `size:` line the canvas is inferred, and it must contain EVERY
    // cue — latching the first one leaves later, wider cues overflowing it.
    it('widens an inferred canvas to contain every cue', () => {
        // Each field must carry at least one byte per row it claims, or the
        // row-count guard (correctly) rejects it as a corrupt header.
        const narrow = spu({
            x1: 0,
            y1: 0,
            x2: 99,
            y2: 49,
            topField: Buffer.alloc(64, 0x11),
            bottomField: Buffer.alloc(64, 0x11),
        });
        const wide = spu({
            x1: 0,
            y1: 0,
            x2: 1919,
            y2: 1079,
            topField: Buffer.alloc(2048, 0x11),
            bottomField: Buffer.alloc(2048, 0x11),
        });

        const paletteOnly = Buffer.from(
            'palette: 000000, f0f0f0, cccccc, 999999, 3333fa, 1111bb, fa3333, bb1111, ' +
                '33fa33, 11bb11, fafa33, bbbb11, fa33fa, bb11bb, 33fafa, 11bbbb\n',
        );

        const result = parseVobSub(
            [packet(0, 1000, narrow), packet(2000, 1000, wide)],
            paletteOnly,
        );

        expect(result.cues).toHaveLength(2);
        expect(result.canvasWidth).toBeGreaterThanOrEqual(1920);
        expect(result.canvasHeight).toBeGreaterThanOrEqual(1080);
    });

    // A track of all-bad packets must not allocate one warning string per packet.
    it('caps the warning list on a wholly corrupt track', () => {
        const bad = packet(0, 1000, Buffer.from([0x00, 0x10]));
        const result = parseVobSub(
            Array.from({ length: 5000 }, () => bad),
            CODEC_PRIVATE,
        );

        expect(result.cues).toEqual([]);
        expect(result.warnings.length).toBeLessThanOrEqual(32);
    });

    // The manifest promises ascending, non-overlapping cues and clients advance a
    // single cursor. PGS gets that from its show/hide pairing; VobSub's end is an
    // independent container duration, so a long one can run past the next start.
    it('trims a cue whose duration overruns the next cue', () => {
        const a = spu({
            x1: 0,
            y1: 0,
            x2: 3,
            y2: 1,
            topField: rleLine(4, 1),
            bottomField: rleLine(4, 1),
        });

        const result = parseVobSub([packet(1000, 5000, a), packet(2000, 1000, a)], CODEC_PRIVATE);

        expect(result.cues).toHaveLength(2);
        expect(result.cues[0].endMs).toBe(2000);
        expect(result.cues[0].endMs).toBeLessThanOrEqual(result.cues[1].startMs);
    });

    it('sorts cues that arrive out of order', () => {
        const a = spu({
            x1: 0,
            y1: 0,
            x2: 3,
            y2: 1,
            topField: rleLine(4, 1),
            bottomField: rleLine(4, 1),
        });

        const result = parseVobSub([packet(5000, 500, a), packet(1000, 500, a)], CODEC_PRIVATE);

        expect(result.cues.map((c) => c.startMs)).toEqual([1000, 5000]);
    });

    // Nothing in the format stops a field offset pointing into the control
    // sequence, which would decode command bytes as pixels.
    it('rejects a packet whose field offset reaches past the pixel data', () => {
        const data = spu({
            x1: 0,
            y1: 0,
            x2: 3,
            y2: 1,
            topField: rleLine(4, 1),
            bottomField: rleLine(4, 1),
        });
        const controlOffset = data.readUInt16BE(2);
        // Rewrite the SET_DSPXA top-field operand to point into the control block.
        data.writeUInt16BE(controlOffset + 2, data.indexOf(0x06, controlOffset) + 1);

        const result = parseVobSub([packet(0, 1000, data)], CODEC_PRIVATE);
        expect(result.cues).toEqual([]);
        expect(result.warnings.join(' ')).toMatch(/outside the pixel data/i);
    });
});
