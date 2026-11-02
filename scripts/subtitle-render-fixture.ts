// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Reproducible Blu-ray-sized paletted text, with definitions reused across display sets. */
export interface LargePgsFixture {
    data: Buffer;
    cues: number;
    displaySets: number;
    uniqueObjects: number;
    references: number;
    objectWidth: number;
    objectHeight: number;
}

function segment(type: number, ptsMs: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(13);
    header.write('PG');
    header.writeUInt32BE(ptsMs * 90, 2);
    header[10] = type;
    header.writeUInt16BE(payload.length, 11);
    return Buffer.concat([header, payload]);
}

function textBitmap(identity: number, width: number, height: number): Uint8Array {
    const pixels = new Uint8Array(width * height);
    // Two rows of scaled 5x7 glyphs, with dark outlines and transparent spacing.
    const strokes: Array<{ x: number; y: number }> = [];
    let seed = identity + 1;
    for (let line = 0; line < 2; line++) {
        for (let glyph = 0; glyph < 50; glyph++) {
            for (let row = 0; row < 7; row++) {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                for (let col = 0; col < 5; col++) {
                    if ((seed >>> (col + 16)) & 1) {
                        strokes.push({ x: 40 + glyph * 18 + col * 2, y: 28 + line * 58 + row * 3 });
                    }
                }
            }
        }
    }
    for (const { x, y } of strokes) {
        for (let dy = -1; dy < 4; dy++)
            pixels.fill(2, (y + dy) * width + x - 1, (y + dy) * width + x + 3);
    }
    for (const { x, y } of strokes) {
        for (let dy = 0; dy < 3; dy++)
            pixels.fill(1, (y + dy) * width + x, (y + dy) * width + x + 2);
    }
    return pixels;
}

function definition(id: number, width: number, height: number, ptsMs: number): Buffer[] {
    const pixels = textBitmap(id, width, height);
    const bytes: number[] = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width;) {
            const colour = pixels[y * width + x];
            let end = x + 1;
            while (end < width && pixels[y * width + end] === colour) end++;
            const length = end - x;
            if (colour && length <= 2) {
                for (let i = 0; i < length; i++) bytes.push(colour);
            } else if (length < 64) {
                bytes.push(0, (colour ? 0x80 : 0) | length);
                if (colour) bytes.push(colour);
            } else {
                bytes.push(0, (colour ? 0xc0 : 0x40) | (length >> 8), length & 255);
                if (colour) bytes.push(colour);
            }
            x = end;
        }
        bytes.push(0, 0);
    }
    const rle = Buffer.from(bytes);
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < rle.length) {
        const first = offset === 0;
        const header = Buffer.alloc(first ? 11 : 4);
        header.writeUInt16BE(id);
        const length = Math.min(65535 - header.length, rle.length - offset);
        header[3] = (first ? 0x80 : 0) | (offset + length === rle.length ? 0x40 : 0);
        if (first) {
            header.writeUIntBE(rle.length + 4, 4, 3);
            header.writeUInt16BE(width, 7);
            header.writeUInt16BE(height, 9);
        }
        parts.push(
            segment(0x15, ptsMs, Buffer.concat([header, rle.subarray(offset, offset + length)])),
        );
        offset += length;
    }
    return parts;
}

export function makeLargePgsFixture(uniqueObjects = 128, cues = 3000): LargePgsFixture {
    const objectWidth = 1000;
    const objectHeight = 150;
    const parts: Buffer[] = [];
    const defined = new Set<number>();
    let references = 0;
    for (let cue = 0; cue <= cues; cue++) {
        const ids =
            cue === cues
                ? []
                : cue % 2 === 0
                  ? [cue % uniqueObjects]
                  : [cue % uniqueObjects, (cue + 1) % uniqueObjects];
        const pcs = Buffer.alloc(11 + ids.length * 8);
        pcs.writeUInt16BE(1920);
        pcs.writeUInt16BE(1080, 2);
        pcs.writeUInt16BE(cue, 5);
        pcs[10] = ids.length;
        ids.forEach((id, index) => {
            pcs.writeUInt16BE(id, 11 + index * 8);
            pcs.writeUInt16BE(460, 15 + index * 8);
            pcs.writeUInt16BE(870 - index * 170, 17 + index * 8);
        });
        const ptsMs = cue * 3000;
        parts.push(segment(0x16, ptsMs, pcs));
        if (cue === 0)
            parts.push(
                segment(0x14, 0, Buffer.from([0, 0, 1, 235, 128, 128, 255, 2, 16, 128, 128, 255])),
            );
        for (const id of ids) {
            references++;
            if (!defined.has(id)) {
                parts.push(...definition(id, objectWidth, objectHeight, ptsMs));
                defined.add(id);
            }
        }
        parts.push(segment(0x80, ptsMs, Buffer.alloc(0)));
    }
    return {
        data: Buffer.concat(parts),
        cues,
        displaySets: cues + 1,
        uniqueObjects: defined.size,
        references,
        objectWidth,
        objectHeight,
    };
}
