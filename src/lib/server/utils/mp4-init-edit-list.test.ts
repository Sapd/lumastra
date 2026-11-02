// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isCompleteMp4Init, stripMp4InitEditLists } from './mp4-init-edit-list.js';

function atom(type: string, inner: Buffer = Buffer.alloc(0)): Buffer {
    const size = 8 + inner.length;
    const buf = Buffer.alloc(size);
    buf.writeUInt32BE(size, 0);
    buf.write(type, 4, 'latin1');
    inner.copy(buf, 8);
    return buf;
}

/**
 * hdlr body: version(1)+flags(3) + pre_defined(4) + handler_type(4) + reserved(12) + name(1 null)
 */
function hdlr(handlerType: string): Buffer {
    const body = Buffer.alloc(4 + 4 + 4 + 12 + 1);
    body.write(handlerType, 8, 'latin1');
    return atom('hdlr', body);
}

/**
 * Build a v0 elst box with the given entries. Each entry is
 * [segment_duration: uint32, media_time: int32]. media_rate defaults to 1<<16.
 */
function elst(entries: Array<[number, number]>): Buffer {
    const body = Buffer.alloc(8 + entries.length * 12);
    body.writeUInt8(0, 0); // version 0
    // flags (3 bytes) already zero
    body.writeUInt32BE(entries.length, 4);
    let p = 8;
    for (const [segDuration, mediaTime] of entries) {
        body.writeUInt32BE(segDuration, p);
        body.writeInt32BE(mediaTime, p + 4);
        body.writeUInt32BE(0x00010000, p + 8); // media_rate = 1.0
        p += 12;
    }
    return atom('elst', body);
}

/** Shortcut for an edts containing a single empty-edit entry (media_time = -1). */
function emptyEditEdts(segDuration = 1634066): Buffer {
    return atom('edts', elst([[segDuration, -1]]));
}

function videoTrak(...extras: Buffer[]): Buffer {
    const mdia = atom('mdia', hdlr('vide'));
    return atom('trak', Buffer.concat([atom('tkhd', Buffer.alloc(84)), ...extras, mdia]));
}

function audioTrak(...extras: Buffer[]): Buffer {
    const mdia = atom('mdia', hdlr('soun'));
    return atom('trak', Buffer.concat([atom('tkhd', Buffer.alloc(84)), ...extras, mdia]));
}

describe('stripMp4InitEditLists', () => {
    it('removes an empty-edit edts from a video trak', () => {
        const edts = emptyEditEdts();
        const trak = videoTrak(edts);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const ftyp = atom('ftyp', Buffer.alloc(24));
        const input = Buffer.concat([ftyp, moov]);

        const output = stripMp4InitEditLists(input);

        expect(output.length).toBe(input.length - edts.length);
        expect(output.indexOf(Buffer.from('edts', 'latin1'))).toBe(-1);
        expect(output.indexOf(Buffer.from('mdia', 'latin1'))).toBeGreaterThan(0);
        expect(output.indexOf(Buffer.from('tkhd', 'latin1'))).toBeGreaterThan(0);
    });

    it('removes an empty-edit edts from an audio trak (real preprod bug)', () => {
        // FFmpeg seek output was writing a 1634s baked-in empty edit on the
        // audio trak, causing Firefox to stack segment_duration on top of
        // timestampOffset and land audio at 2× the seek target.
        const edts = emptyEditEdts(1634066);
        const trak = audioTrak(edts);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const output = stripMp4InitEditLists(input);

        expect(output.length).toBe(input.length - edts.length);
        expect(output.indexOf(Buffer.from('edts', 'latin1'))).toBe(-1);
    });

    it('preserves an edts with media_time = 0 (noop edit)', () => {
        const edts = atom('edts', elst([[1000, 0]]));
        const trak = videoTrak(edts);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const output = stripMp4InitEditLists(input);
        expect(output.equals(input)).toBe(true);
    });

    it('preserves an edts with positive media_time (AAC encoder delay)', () => {
        // Real AAC priming: elst entry trims 1024 samples of encoder delay.
        const edts = atom('edts', elst([[1024, 1024]]));
        const trak = audioTrak(edts);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const output = stripMp4InitEditLists(input);
        expect(output.equals(input)).toBe(true);
    });

    it('strips the empty-edit while preserving an AAC-priming edt on another trak', () => {
        const videoEdts = emptyEditEdts();
        const audioEdts = atom('edts', elst([[1024, 1024]]));
        const vTrak = videoTrak(videoEdts);
        const aTrak = audioTrak(audioEdts);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), vTrak, aTrak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const output = stripMp4InitEditLists(input);

        expect(output.length).toBe(input.length - videoEdts.length);
        const firstEdts = output.indexOf(Buffer.from('edts', 'latin1'));
        expect(firstEdts).toBeGreaterThan(0);
        expect(output.indexOf(Buffer.from('edts', 'latin1'), firstEdts + 1)).toBe(-1);
    });

    it('strips empty edits from multiple traks and updates container sizes', () => {
        const edts1 = emptyEditEdts();
        const edts2 = emptyEditEdts();
        const trak1 = videoTrak(edts1);
        const trak2 = audioTrak(edts2);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak1, trak2]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const output = stripMp4InitEditLists(input);

        expect(output.length).toBe(input.length - edts1.length - edts2.length);
        const moovSize = output.readUInt32BE(output.indexOf(Buffer.from('moov', 'latin1')) - 4);
        expect(moovSize).toBe(moov.length - edts1.length - edts2.length);
    });

    it('strips a multi-entry elst when any entry is an empty edit', () => {
        // FFmpeg sometimes writes [empty edit, real edit]. Dropping the whole
        // edts is the safest response (hls.js won't reconstruct a partial elst).
        const edts = atom(
            'edts',
            elst([
                [1634066, -1],
                [100_000_000, 0],
            ]),
        );
        const trak = videoTrak(edts);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const output = stripMp4InitEditLists(input);
        expect(output.length).toBe(input.length - edts.length);
        expect(output.indexOf(Buffer.from('edts', 'latin1'))).toBe(-1);
    });

    it('returns the input unchanged when no edts is present', () => {
        const trak = videoTrak();
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const output = stripMp4InitEditLists(input);
        expect(output.equals(input)).toBe(true);
    });

    it('is idempotent', () => {
        const edts = emptyEditEdts();
        const trak = videoTrak(edts);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const once = stripMp4InitEditLists(input);
        const twice = stripMp4InitEditLists(once);
        expect(twice.equals(once)).toBe(true);
    });

    it('returns the input unchanged for a malformed box (defensive)', () => {
        const bad = Buffer.alloc(16);
        bad.writeUInt32BE(9999, 0);
        bad.write('moov', 4, 'latin1');
        const output = stripMp4InitEditLists(bad);
        expect(output.equals(bad)).toBe(true);
    });

    it('returns input unchanged for a box with size=1 (largesize / extended size)', () => {
        const inner = atom('mvhd', Buffer.alloc(100));
        const totalSize = BigInt(8 + 8 + inner.length);
        const buf = Buffer.alloc(Number(totalSize));
        buf.writeUInt32BE(1, 0);
        buf.write('moov', 4, 'latin1');
        buf.writeBigUInt64BE(totalSize, 8);
        inner.copy(buf, 16);
        const output = stripMp4InitEditLists(buf);
        expect(output.equals(buf)).toBe(true);
    });

    it('returns input unchanged for a box with size=0 (extends-to-EOF sentinel)', () => {
        const buf = Buffer.alloc(20);
        buf.writeUInt32BE(0, 0);
        buf.write('moov', 4, 'latin1');
        const output = stripMp4InitEditLists(buf);
        expect(output.equals(buf)).toBe(true);
    });

    it('handles nested trak-inside-trak without crashing', () => {
        const innerEdts = emptyEditEdts();
        const innerTrak = videoTrak(innerEdts);
        const outerTrakContent = Buffer.concat([atom('tkhd', Buffer.alloc(84)), innerTrak]);
        const outerTrak = atom('trak', outerTrakContent);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), outerTrak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        expect(() => stripMp4InitEditLists(input)).not.toThrow();
        const output = stripMp4InitEditLists(input);
        let o = 0;
        while (o + 8 <= output.length) {
            const sz = output.readUInt32BE(o);
            expect(sz).toBeGreaterThanOrEqual(8);
            expect(o + sz).toBeLessThanOrEqual(output.length);
            o += sz;
        }
    });

    it('returns input unchanged for a moov containing only mvhd (no trak)', () => {
        const moov = atom('moov', atom('mvhd', Buffer.alloc(100)));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);
        const output = stripMp4InitEditLists(input);
        expect(output.equals(input)).toBe(true);
    });

    it('processes multiple top-level moov boxes independently', () => {
        const edts = emptyEditEdts();
        const trak = videoTrak(edts);
        const moov1 = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const moov2 = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = Buffer.concat([moov1, moov2]);

        const output = stripMp4InitEditLists(input);

        expect(output.indexOf(Buffer.from('edts', 'latin1'))).toBe(-1);
        let moovCount = 0;
        let o = 0;
        while (o + 8 <= output.length) {
            const sz = output.readUInt32BE(o);
            const type = output.toString('latin1', o + 4, o + 8);
            if (type === 'moov') moovCount++;
            o += sz;
        }
        expect(moovCount).toBe(2);
    });

    it('does not strip edts from a trak that sits outside a moov', () => {
        const edts = emptyEditEdts();
        const trak = videoTrak(edts);
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), trak]);

        const output = stripMp4InitEditLists(input);
        expect(output.equals(input)).toBe(true);
    });

    it('preserves an empty edts (no elst child at all)', () => {
        // Without an elst we cannot tell if it's an empty edit → leave it alone.
        const emptyEdts = atom('edts');
        const trak = videoTrak(emptyEdts);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const output = stripMp4InitEditLists(input);
        expect(output.equals(input)).toBe(true);
    });

    it('handles a large init segment without errors', () => {
        const edts = emptyEditEdts();
        const padding = atom('free', Buffer.alloc(1024 * 1024 - 300));
        const trak = videoTrak(edts, padding);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const output = stripMp4InitEditLists(input);
        expect(output.length).toBe(input.length - edts.length);
        expect(output.indexOf(Buffer.from('edts', 'latin1'))).toBe(-1);
    });

    it('strips an edts whose last byte is exactly the last byte of the buffer', () => {
        const edts = emptyEditEdts();
        const trak = videoTrak(edts);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = moov;

        const output = stripMp4InitEditLists(input);
        expect(output.length).toBe(input.length - edts.length);
        expect(output.indexOf(Buffer.from('edts', 'latin1'))).toBe(-1);
    });

    it('preserves free/skip boxes that follow an edts inside trak', () => {
        const edts = emptyEditEdts();
        const freeBox = atom('free', Buffer.alloc(32));
        const trak = videoTrak(edts, freeBox);
        const moov = atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(100)), trak]));
        const input = Buffer.concat([atom('ftyp', Buffer.alloc(24)), moov]);

        const output = stripMp4InitEditLists(input);

        expect(output.length).toBe(input.length - edts.length);
        expect(output.indexOf(Buffer.from('edts', 'latin1'))).toBe(-1);
        expect(output.indexOf(Buffer.from('free', 'latin1'))).toBeGreaterThan(0);
        expect(output.indexOf(Buffer.from('mdia', 'latin1'))).toBeGreaterThan(0);
    });
});

describe('isCompleteMp4Init', () => {
    const ftyp = atom('ftyp', Buffer.alloc(20, 1));
    const moov = atom('moov', Buffer.alloc(64, 2));
    const full = Buffer.concat([ftyp, moov]);

    it('accepts a complete ftyp + moov init', () => {
        expect(isCompleteMp4Init(full)).toBe(true);
    });

    it('rejects an empty buffer', () => {
        expect(isCompleteMp4Init(Buffer.alloc(0))).toBe(false);
    });

    it('rejects a prefix that stops inside the moov', () => {
        // The moov header declares 72 bytes but only part of them are present —
        // the unambiguous signature of a half-written init.
        expect(isCompleteMp4Init(full.subarray(0, full.length - 10))).toBe(false);
    });

    it('rejects a file that has ftyp but no moov yet', () => {
        expect(isCompleteMp4Init(ftyp)).toBe(false);
    });

    it('rejects a prefix that stops inside a box header', () => {
        expect(isCompleteMp4Init(Buffer.concat([ftyp, moov.subarray(0, 4)]))).toBe(false);
    });

    // Fail-open: withholding a valid init until timeout would be worse than the
    // race being guarded, so anything unparseable is reported ready.
    it('accepts an unparseable buffer rather than withholding it', () => {
        const bogus = Buffer.alloc(16);
        bogus.writeUInt32BE(2, 0); // size < header — malformed
        bogus.write('junk', 4, 'latin1');
        expect(isCompleteMp4Init(bogus)).toBe(true);
    });

    it('handles a 64-bit largesize box', () => {
        const body = Buffer.alloc(32, 3);
        const large = Buffer.alloc(16 + body.length);
        large.writeUInt32BE(1, 0);
        large.write('moov', 4, 'latin1');
        large.writeBigUInt64BE(BigInt(16 + body.length), 8);
        body.copy(large, 16);
        expect(isCompleteMp4Init(Buffer.concat([ftyp, large]))).toBe(true);
        expect(isCompleteMp4Init(Buffer.concat([ftyp, large.subarray(0, 20)]))).toBe(false);
    });

    it('treats a size-0 moov as extending to EOF', () => {
        const toEof = Buffer.alloc(24);
        toEof.writeUInt32BE(0, 0);
        toEof.write('moov', 4, 'latin1');
        expect(isCompleteMp4Init(Buffer.concat([ftyp, toEof]))).toBe(true);
    });
});
