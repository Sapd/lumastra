// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Just enough ISO-BMFF parsing to time an fMP4 fragment: the track timescale
 * from an init segment, and the decode and presentation time of a fragment's
 * first sample (tfdt + the first trun sample's composition offset).
 *
 * The GOP-mode assembler identifies FFmpeg's per-keyframe files by this time
 * rather than by filename, so one merged cut can never shift a timeline.
 */

interface BoxRef {
    type: string;
    /** Offset of the payload (after the header). */
    start: number;
    /** Offset one past the end of the box. */
    end: number;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'moof', 'traf']);

function* boxes(buf: Buffer, from: number, to: number): Generator<BoxRef> {
    let off = from;
    while (off + 8 <= to) {
        let size = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        let header = 8;
        if (size === 1) {
            if (off + 16 > to) return;
            size = Number(buf.readBigUInt64BE(off + 8));
            header = 16;
        } else if (size === 0) {
            size = to - off;
        }
        if (size < header || off + size > to) return;
        yield { type, start: off + header, end: off + size };
        off += size;
    }
}

/** Depth-first search for the first box of `type` along container boxes. */
function find(buf: Buffer, type: string, from = 0, to = buf.length): BoxRef | null {
    for (const b of boxes(buf, from, to)) {
        if (b.type === type) return b;
        if (CONTAINERS.has(b.type)) {
            const inner = find(buf, type, b.start, b.end);
            if (inner) return inner;
        }
    }
    return null;
}

/** Timescale of the first track's media header, or null. */
export function readTrackTimescale(init: Buffer): number | null {
    const mdhd = find(init, 'mdhd');
    if (!mdhd) return null;
    const version = init[mdhd.start];
    const at = mdhd.start + (version === 1 ? 4 + 16 : 4 + 8);
    if (at + 4 > mdhd.end) return null;
    const timescale = init.readUInt32BE(at);
    return timescale > 0 ? timescale : null;
}

/**
 * Decode and presentation time (seconds) of the fragment's first sample, from
 * the first traf. Null when the structure is missing or truncated.
 */
export function readFragmentStart(
    seg: Buffer,
    timescale: number,
): { decodeSeconds: number; presentationSeconds: number } | null {
    if (!(timescale > 0)) return null;
    const traf = find(seg, 'traf');
    if (!traf) return null;
    const tfdt = find(seg, 'tfdt', traf.start, traf.end);
    if (!tfdt || tfdt.start + 8 > tfdt.end) return null;
    const tfdtVersion = seg[tfdt.start];
    let decode: number;
    if (tfdtVersion === 1) {
        if (tfdt.start + 12 > tfdt.end) return null;
        // baseMediaDecodeTime is unsigned by the spec, but FFmpeg writes a
        // negative first decode time (an encoder's priming samples under
        // -avoid_negative_ts disabled) as its two's complement: 2^64 − 1024 for
        // AAC. Read it signed, so such a fragment sorts to the START of the
        // timeline instead of twelve million years past its end (prod 2026-11-02).
        // Only the 64-bit field: FFmpeg always writes version 1, and a 32-bit
        // value past 2^31 is a legitimate large decode time (a 90 kHz track
        // beyond ~6.6 h), not a wrapped negative.
        decode = Number(seg.readBigInt64BE(tfdt.start + 4));
    } else {
        decode = seg.readUInt32BE(tfdt.start + 4);
    }

    let cto = 0;
    const trun = find(seg, 'trun', traf.start, traf.end);
    if (trun && trun.start + 8 <= trun.end) {
        const version = seg[trun.start];
        const flags = seg.readUIntBE(trun.start + 1, 3);
        const sampleCount = seg.readUInt32BE(trun.start + 4);
        let at = trun.start + 8;
        if (flags & 0x1) at += 4; // data_offset
        if (flags & 0x4) at += 4; // first_sample_flags
        if (sampleCount > 0 && flags & 0x800) {
            if (flags & 0x100) at += 4; // sample_duration
            if (flags & 0x200) at += 4; // sample_size
            if (flags & 0x400) at += 4; // sample_flags
            if (at + 4 > trun.end) return null;
            cto = version === 1 ? seg.readInt32BE(at) : seg.readUInt32BE(at);
        }
    }
    return { decodeSeconds: decode / timescale, presentationSeconds: (decode + cto) / timescale };
}
