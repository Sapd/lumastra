// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

import { parsePgs, toRgba } from './pgs-parser.js';

/**
 * Build one PGS segment with its 13-byte header.
 * ptsMs is converted to the format's 90 kHz ticks.
 */
function segment(type: number, ptsMs: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(13);
    header.write('PG', 0, 'ascii');
    header.writeUInt32BE(Math.round((ptsMs / 1000) * 90_000), 2);
    header.writeUInt32BE(0, 6);
    header[10] = type;
    header.writeUInt16BE(payload.length, 11);
    return Buffer.concat([header, payload]);
}

/** PCS turning subtitles ON with a single object at (x, y). */
function pcsOn(objectId: number, x: number, y: number): Buffer {
    const p = Buffer.alloc(19);
    p.writeUInt16BE(1920, 0);
    p.writeUInt16BE(1080, 2);
    p[4] = 0x10; // frame rate
    p.writeUInt16BE(0, 5); // composition number
    p[7] = 0x80; // epoch start
    p[8] = 0; // no palette update
    p[9] = 0; // palette id
    p[10] = 1; // one composition object
    p.writeUInt16BE(objectId, 11);
    p[13] = 0; // window id
    p[14] = 0; // not cropped
    p.writeUInt16BE(x, 15);
    p.writeUInt16BE(y, 17);
    return p;
}

/** PCS turning subtitles OFF (zero composition objects). */
function pcsOff(): Buffer {
    const p = Buffer.alloc(11);
    p.writeUInt16BE(1920, 0);
    p.writeUInt16BE(1080, 2);
    p[10] = 0;
    return p;
}

/** Palette with one opaque white entry at the given index. */
function pds(index: number): Buffer {
    const p = Buffer.alloc(2 + 5);
    p[0] = 0;
    p[1] = 0;
    p[2] = index;
    p[3] = 235; // Y (limited-range white)
    p[4] = 128; // Cr
    p[5] = 128; // Cb
    p[6] = 255; // alpha
    return p;
}

/** Single-fragment ODS carrying raw RLE for a width x height bitmap. */
function ods(objectId: number, width: number, height: number, rle: Buffer): Buffer {
    const head = Buffer.alloc(11);
    head.writeUInt16BE(objectId, 0);
    head[2] = 0; // version
    head[3] = 0x80 | 0x40; // first and last fragment
    head.writeUIntBE(rle.length + 4, 4, 3); // data length
    head.writeUInt16BE(width, 7);
    head.writeUInt16BE(height, 9);
    return Buffer.concat([head, rle]);
}

/**
 * RLE painting `height` rows of `width` pixels each in colour 1.
 *
 * Uses the 14-bit run form so a wide row costs a few bytes — which is also what
 * keeps the source-derived pixel budget meaningful: the budget allows 32 px per
 * source byte, and this encodes at roughly that density.
 */
function bigRle(width: number, height: number): Buffer {
    const rows: Buffer[] = [];
    for (let y = 0; y < height; y++) {
        rows.push(Buffer.from([0x00, 0xc0 | (width >> 8), width & 0xff, 1, 0x00, 0x00]));
    }
    return Buffer.concat(rows);
}

/** One 4x1 row: a run of 4 pixels of colour `index`, then end-of-line. */
function rleRow(index: number, count: number): Buffer {
    return Buffer.from([0x00, 0x80 | count, index, 0x00, 0x00]);
}

describe('parsePgs', () => {
    const simpleTrack = (): Buffer =>
        Buffer.concat([
            segment(0x16, 1000, pcsOn(0, 100, 900)),
            segment(0x14, 1000, pds(1)),
            segment(0x15, 1000, ods(0, 4, 1, rleRow(1, 4))),
            segment(0x80, 1000, Buffer.alloc(0)),
            segment(0x16, 3000, pcsOff()),
            segment(0x80, 3000, Buffer.alloc(0)),
        ]);

    it('pairs an ON and OFF presentation segment into one cue', () => {
        const result = parsePgs(simpleTrack());

        expect(result.cues).toHaveLength(1);
        expect(result.cues[0].startMs).toBe(1000);
        expect(result.cues[0].endMs).toBe(3000);
        expect(result.warnings).toEqual([]);
    });

    it('reports the canvas from the presentation segment', () => {
        const result = parsePgs(simpleTrack());
        expect(result.canvasWidth).toBe(1920);
        expect(result.canvasHeight).toBe(1080);
    });

    it('places the rect at the composition position with the object size', () => {
        const [cue] = parsePgs(simpleTrack()).cues;
        expect(cue.rects).toHaveLength(1);
        expect(cue.rects[0]).toMatchObject({ x: 100, y: 900, width: 4, height: 1 });
    });

    // The palette is YCrCb; toRgba yields RGBA. Y=235 limited-range is white.
    it('converts palette entries to RGBA on demand', () => {
        const [cue] = parsePgs(simpleTrack()).cues;
        const pixels = toRgba(cue.rects[0]);

        expect(pixels).toHaveLength(4 * 1 * 4);
        expect(pixels[0]).toBeGreaterThan(250);
        expect(pixels[1]).toBeGreaterThan(250);
        expect(pixels[2]).toBeGreaterThan(250);
        expect(pixels[3]).toBe(255);
    });

    // The rect stays paletted so the renderer can emit a colour-type-3 PNG.
    it('keeps the bitmap in paletted form', () => {
        const [cue] = parsePgs(simpleTrack()).cues;
        expect(cue.rects[0].indices).toHaveLength(4 * 1);
        expect(Array.from(cue.rects[0].indices)).toEqual([1, 1, 1, 1]);
        expect(cue.rects[0].palette).toHaveLength(256 * 4);
    });

    // A later display set mutates the running palette; an already-open cue must
    // keep the colours it was composed with rather than seeing the update.
    it('snapshots the palette per cue', () => {
        const data = Buffer.concat([
            segment(0x16, 1000, pcsOn(0, 0, 0)),
            segment(0x14, 1000, pds(1)),
            segment(0x15, 1000, ods(0, 4, 1, rleRow(1, 4))),
            segment(0x16, 3000, pcsOff()),
            // Second cue redefines index 1 as fully transparent black.
            segment(0x16, 4000, pcsOn(0, 0, 0)),
            segment(0x14, 4000, Buffer.from([0, 0, 1, 16, 128, 128, 0])),
            segment(0x15, 4000, ods(0, 4, 1, rleRow(1, 4))),
            segment(0x16, 6000, pcsOff()),
        ]);

        const { cues } = parsePgs(data);
        expect(cues).toHaveLength(2);
        expect(toRgba(cues[0].rects[0])[3]).toBe(255);
        expect(toRgba(cues[1].rects[0])[3]).toBe(0);
    });

    // PGS has no duration field, so a cue with no closing PCS has no end. Emitting
    // it would leave subtitles on screen for the rest of the film.
    it('drops a cue left open at end of stream', () => {
        const data = Buffer.concat([
            segment(0x16, 1000, pcsOn(0, 0, 0)),
            segment(0x14, 1000, pds(1)),
            segment(0x15, 1000, ods(0, 4, 1, rleRow(1, 4))),
            segment(0x80, 1000, Buffer.alloc(0)),
        ]);

        const result = parsePgs(data);
        expect(result.cues).toEqual([]);
        expect(result.warnings.join(' ')).toMatch(/unclosed/i);
    });

    // A second ON without an intervening OFF is legal as a mid-cue update; cues
    // must still not overlap or a client would draw two at once.
    it('closes the previous cue when a new one opens without an OFF', () => {
        const data = Buffer.concat([
            segment(0x16, 1000, pcsOn(0, 0, 0)),
            segment(0x14, 1000, pds(1)),
            segment(0x15, 1000, ods(0, 4, 1, rleRow(1, 4))),
            segment(0x16, 2000, pcsOn(0, 0, 0)),
            segment(0x16, 4000, pcsOff()),
        ]);

        const result = parsePgs(data);
        expect(result.cues).toHaveLength(2);
        expect(result.cues[0]).toMatchObject({ startMs: 1000, endMs: 2000 });
        expect(result.cues[1]).toMatchObject({ startMs: 2000, endMs: 4000 });
        expect(result.cues[0].endMs).toBeLessThanOrEqual(result.cues[1].startMs);
    });

    it('skips a cue whose end is not after its start', () => {
        const data = Buffer.concat([
            segment(0x16, 5000, pcsOn(0, 0, 0)),
            segment(0x14, 5000, pds(1)),
            segment(0x15, 5000, ods(0, 4, 1, rleRow(1, 4))),
            segment(0x16, 5000, pcsOff()),
        ]);

        expect(parsePgs(data).cues).toEqual([]);
    });

    // A truncated tail is expected in the wild (extraction hit its timeout, cache
    // file half-written). Everything before the damage must survive.
    it('keeps cues parsed before a truncated tail', () => {
        const good = simpleTrack();
        const truncated = Buffer.concat([good, segment(0x16, 9000, pcsOn(0, 0, 0)).subarray(0, 8)]);

        const result = parsePgs(truncated);
        expect(result.cues).toHaveLength(1);
    });

    it('stops cleanly when segment sync is lost', () => {
        // At least a full header's worth of garbage, or the loop ends on length
        // before it ever inspects the magic.
        const data = Buffer.concat([simpleTrack(), Buffer.alloc(32, 0xff)]);

        const result = parsePgs(data);
        expect(result.cues).toHaveLength(1);
        expect(result.warnings.join(' ')).toMatch(/sync/i);
    });

    // A sub-header remnant is indistinguishable from padding, so it is ignored
    // rather than reported — a warning there would fire on healthy files.
    it('ignores a trailing fragment shorter than a segment header', () => {
        const data = Buffer.concat([simpleTrack(), Buffer.from([0xff, 0xff, 0x00])]);

        const result = parsePgs(data);
        expect(result.cues).toHaveLength(1);
        expect(result.warnings).toEqual([]);
    });

    it('returns an empty result for empty input rather than throwing', () => {
        const result = parsePgs(Buffer.alloc(0));
        expect(result.cues).toEqual([]);
        expect(result.canvasWidth).toBe(0);
    });

    // Objects can span several ODS segments; only the first carries the dimensions.
    it('assembles an object split across ODS fragments', () => {
        const rle = rleRow(1, 4);
        const firstHead = Buffer.alloc(11);
        firstHead.writeUInt16BE(0, 0);
        firstHead[3] = 0x80; // first, not last
        firstHead.writeUIntBE(rle.length + 4, 4, 3);
        firstHead.writeUInt16BE(4, 7);
        firstHead.writeUInt16BE(1, 9);

        const contHead = Buffer.alloc(4);
        contHead.writeUInt16BE(0, 0);
        contHead[3] = 0x40; // last fragment

        const data = Buffer.concat([
            segment(0x16, 1000, pcsOn(0, 10, 20)),
            segment(0x14, 1000, pds(1)),
            segment(0x15, 1000, Buffer.concat([firstHead, rle.subarray(0, 2)])),
            segment(0x15, 1000, Buffer.concat([contHead, rle.subarray(2)])),
            segment(0x16, 3000, pcsOff()),
        ]);

        const result = parsePgs(data);
        expect(result.cues).toHaveLength(1);
        expect(result.cues[0].rects[0]).toMatchObject({ width: 4, height: 1 });
    });

    // A corrupt run length must not write outside the bitmap or spin.
    it('clips an overlong RLE run to the row width', () => {
        const overlong = Buffer.from([0x00, 0x80 | 0x3f, 1, 0x00, 0x00]); // 63 px into a 4 px row
        const data = Buffer.concat([
            segment(0x16, 1000, pcsOn(0, 0, 0)),
            segment(0x14, 1000, pds(1)),
            segment(0x15, 1000, ods(0, 4, 1, overlong)),
            segment(0x16, 3000, pcsOff()),
        ]);

        const result = parsePgs(data);
        expect(result.cues[0].rects[0].indices).toHaveLength(4 * 1);
        expect(toRgba(result.cues[0].rects[0])).toHaveLength(4 * 1 * 4);
    });

    // Rows advance ONLY on the explicit 0x00 0x00 end-of-line marker. Also
    // wrapping when the cursor reaches the object width advances twice and blanks
    // every other row — which still renders as readable text, just faintly
    // striped, so it survives a casual look. Assert full coverage instead.
    it('does not double-advance rows at the width boundary', () => {
        const twoFullRows = Buffer.concat([rleRow(1, 4), rleRow(1, 4)]);
        const data = Buffer.concat([
            segment(0x16, 1000, pcsOn(0, 0, 0)),
            segment(0x14, 1000, pds(1)),
            segment(0x15, 1000, ods(0, 4, 2, twoFullRows)),
            segment(0x16, 3000, pcsOff()),
        ]);

        const [cue] = parsePgs(data).cues;
        expect(Array.from(cue.rects[0].indices)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);

        // Ink coverage, the striping-resistant form of the same check.
        const rgba = toRgba(cue.rects[0]);
        let opaque = 0;
        for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) opaque++;
        expect(opaque).toBe(8);
    });

    it('rejects an object with implausible dimensions', () => {
        const data = Buffer.concat([
            segment(0x16, 1000, pcsOn(0, 0, 0)),
            segment(0x14, 1000, pds(1)),
            segment(0x15, 1000, ods(0, 40000, 40000, rleRow(1, 4))),
            segment(0x16, 3000, pcsOff()),
        ]);

        const result = parsePgs(data);
        expect(result.cues).toEqual([]);
        expect(result.warnings.join(' ')).toMatch(/implausible/i);
    });

    // Timestamps come straight off the wire because the extractor passes -copyts.
    // A track whose first cue is 69s in must report 69s, not 0.
    it('preserves absolute source timestamps', () => {
        const data = Buffer.concat([
            segment(0x16, 69194, pcsOn(0, 0, 0)),
            segment(0x14, 69194, pds(1)),
            segment(0x15, 69194, ods(0, 4, 1, rleRow(1, 4))),
            segment(0x16, 71154, pcsOff()),
        ]);

        const [cue] = parsePgs(data).cues;
        expect(cue.startMs).toBe(69194);
        expect(cue.endMs).toBe(71154);
    });

    // Regression: the cumulative pixel budget was once a fixed 128 Mpx copied from
    // the VobSub parser, which truncated a legitimate 3-hour film silently. The
    // budget now scales with source size, so a track well past that old constant
    // must still decode in full.
    it('renders a track whose total pixels exceed the old fixed budget', () => {
        // 600 cues of 640x360 = 138 Mpx, past the retired 128 Mpx constant.
        const parts: Buffer[] = [];
        for (let i = 0; i < 600; i++) {
            const start = i * 4000;
            parts.push(
                segment(0x16, start, pcsOn(0, 0, 0)),
                segment(0x14, start, pds(1)),
                segment(0x15, start, ods(0, 640, 360, bigRle(640, 360))),
                segment(0x80, start, Buffer.alloc(0)),
                segment(0x16, start + 2000, pcsOff()),
                segment(0x80, start + 2000, Buffer.alloc(0)),
            );
        }

        const result = parsePgs(Buffer.concat(parts));

        const totalPixels = result.cues.reduce(
            (sum, cue) => sum + cue.rects.reduce((n, r) => n + r.width * r.height, 0),
            0,
        );
        expect(result.cues).toHaveLength(600);
        expect(totalPixels).toBeGreaterThan(128 * 1024 * 1024);
        expect(result.warnings.join(' ')).not.toMatch(/budget/i);
    });

    // A corrupt stream must not allocate one warning string per segment.
    it('caps the warning list on a wholly unknown-segment stream', () => {
        const junk: Buffer[] = [];
        for (let i = 0; i < 5000; i++) junk.push(segment(0x99, i, Buffer.alloc(0)));

        const result = parsePgs(Buffer.concat(junk));
        expect(result.warnings.length).toBeLessThanOrEqual(32);
    });
});
