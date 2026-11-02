// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds a minimal, parseable MP3 with hand-encoded ID3v2.3 / v2.4 frames, so
 * tests can feed REAL bytes to music-metadata (ffmpeg and other writers never
 * produce the NUL-separated multi-value frames that Mp3tag writes).
 */

import { writeFile } from 'node:fs/promises';

/** ID3 text encodings. */
export const ID3_LATIN1 = 0;
export const ID3_UTF16_BOM = 1;
export const ID3_UTF8 = 3;

/** UTF-16LE with a leading BOM, no terminator. */
export function utf16WithBom(text: string): Buffer {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

/**
 * A text frame body (encoding byte + payload). `values` are joined with the
 * encoding's NUL terminator, which is how multi-value frames are written.
 * UTF-16 values each carry their own BOM (Mp3tag style).
 */
export function textFrameBody(encoding: number, values: string[]): Buffer {
    const enc = Buffer.from([encoding]);
    if (encoding === ID3_UTF16_BOM) {
        const parts: Buffer[] = [];
        values.forEach((v, i) => {
            if (i > 0) parts.push(Buffer.from([0, 0]));
            parts.push(utf16WithBom(v));
        });
        return Buffer.concat([enc, ...parts]);
    }
    const sep = Buffer.from([0]);
    const parts: Buffer[] = [];
    values.forEach((v, i) => {
        if (i > 0) parts.push(sep);
        parts.push(Buffer.from(v, encoding === ID3_LATIN1 ? 'latin1' : 'utf8'));
    });
    return Buffer.concat([enc, ...parts]);
}

function syncsafe(n: number): Buffer {
    return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function frame(version: 3 | 4, id: string, body: Buffer): Buffer {
    const size = Buffer.alloc(4);
    if (version === 4) syncsafe(body.length).copy(size);
    else size.writeUInt32BE(body.length);
    return Buffer.concat([Buffer.from(id, 'latin1'), size, Buffer.from([0, 0]), body]);
}

export interface Id3Frame {
    id: string;
    body: Buffer;
}

/** Writes an MP3 (ID3 tag + ~20 silent MPEG frames) and returns its path. */
export async function writeId3Mp3(
    filePath: string,
    version: 3 | 4,
    frames: Id3Frame[],
): Promise<string> {
    const body = Buffer.concat(frames.map((f) => frame(version, f.id, f.body)));
    const header = Buffer.concat([
        Buffer.from('ID3', 'latin1'),
        Buffer.from([version, 0, 0]),
        syncsafe(body.length),
    ]);
    const audioFrame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
    const audio = Buffer.concat(Array.from({ length: 20 }, () => audioFrame));
    await writeFile(filePath, Buffer.concat([header, body, audio]));
    return filePath;
}

/**
 * The prod shape: ID3v2.3 album artist holding three UTF-16 values separated
 * by NUL, each with its own BOM; TPE1 is the plain joined credit.
 */
export function prodNulAlbumArtistFrames(): Id3Frame[] {
    return [
        { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['Woodpecker']) },
        { id: 'TALB', body: textFrameBody(ID3_LATIN1, ['Woodpecker']) },
        {
            id: 'TPE1',
            body: textFrameBody(ID3_LATIN1, ["L'EXAIS x Perfect Pitch x Rocco"]),
        },
        {
            id: 'TPE2',
            body: textFrameBody(ID3_UTF16_BOM, ["L'EXAIS", 'Perfect Pitch', 'Rocco']),
        },
    ];
}
