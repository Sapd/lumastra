// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Raw Vorbis comment reader for FLAC files.
 *
 * music-metadata returns already-decoded strings, so when a tag contains
 * non-UTF-8 bytes (Vorbis spec violation — common in old Windows rippers
 * that wrote raw CP-1252 bytes), the original bytes are lost to U+FFFD
 * substitution before we ever see them.
 *
 * This reader walks the FLAC METADATA_BLOCK chain, locates the
 * VORBIS_COMMENT block, and returns each tag's raw byte buffer so the
 * caller can re-decode with a fallback codepage.
 */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { withFsGuard } from '$lib/server/utils/safe-fs.js';

/**
 * UPPERCASE tag name → list of raw value byte buffers, one per Vorbis comment
 * instance. Multi-valued tags (e.g. multiple ARTIST entries) preserve each
 * instance in source order so callers can recover them individually rather
 * than collapsing to a single value.
 */
export type RawVorbisComments = Map<string, Buffer[]>;

const FLAC_SIGNATURE = Buffer.from('fLaC', 'ascii');
const BLOCK_TYPE_VORBIS_COMMENT = 4;
// Cap the comment block we'll process. Real-world Vorbis comment blocks are
// well under 1 MB even with embedded artwork (which lives in a separate
// PICTURE block, type 6). Anything larger is almost certainly corrupt or
// hostile, and we don't want to allocate hundreds of MB on its say-so.
const MAX_COMMENT_BLOCK_BYTES = 16 * 1024 * 1024;

/**
 * Read the raw Vorbis comment block from a FLAC file.
 * Returns a Map of UPPERCASE tag name → array of raw value byte buffers,
 * one per Vorbis comment instance, in source order. Multi-valued tags
 * (multiple ARTIST entries) get one buffer per instance.
 * Returns null when the file isn't FLAC, has no comment block, or is malformed.
 */
export async function readFlacVorbisCommentsRaw(
    filePath: string,
): Promise<RawVorbisComments | null> {
    // Route the whole open→read→close sequence through the global fs guard so
    // these raw NFS reads are COUNTED against the fs concurrency cap and bounded
    // by a timeout. Previously they bypassed safe-fs entirely: a hung read on a
    // dead mount pinned a libuv threadpool thread uncounted AND held the scan's
    // BullMQ slot until the 120m hard cap (F1/F3). On timeout or any error the
    // caller contract is unchanged — return null (empty raw comments).
    try {
        return await withFsGuard(
            () => readFlacVorbisCommentsRawInner(filePath),
            'vorbisRead',
            filePath,
        );
    } catch {
        return null;
    }
}

async function readFlacVorbisCommentsRawInner(filePath: string): Promise<RawVorbisComments | null> {
    let fd: FileHandle | undefined;
    try {
        fd = await open(filePath, 'r');

        const sig = Buffer.alloc(4);
        const sigRead = await fd.read(sig, 0, 4, 0);
        if (sigRead.bytesRead !== 4 || !sig.equals(FLAC_SIGNATURE)) {
            return null;
        }

        let offset = 4;
        const header = Buffer.alloc(4);
        // Bound the walk so a corrupt file with a self-referencing chain
        // can't loop forever. Real FLAC files have well under 100 metadata
        // blocks even in pathological cases.
        for (let i = 0; i < 1024; i++) {
            const headRead = await fd.read(header, 0, 4, offset);
            if (headRead.bytesRead !== 4) return null;
            offset += 4;

            const isLast = (header[0] & 0x80) !== 0;
            const blockType = header[0] & 0x7f;
            const blockSize = (header[1] << 16) | (header[2] << 8) | header[3];

            if (blockType === BLOCK_TYPE_VORBIS_COMMENT) {
                if (blockSize === 0 || blockSize > MAX_COMMENT_BLOCK_BYTES) {
                    return null;
                }
                const data = Buffer.alloc(blockSize);
                const dataRead = await fd.read(data, 0, blockSize, offset);
                if (dataRead.bytesRead !== blockSize) return null;
                return parseVorbisCommentBlock(data);
            }

            offset += blockSize;
            if (isLast) return null;
        }
        return null;
    } catch {
        return null;
    } finally {
        await fd?.close().catch(() => {});
    }
}

/**
 * Parse a Vorbis comment block body (without the FLAC metadata block header).
 * Layout: vendor_length(LE u32) vendor_string user_count(LE u32)
 *         { entry_length(LE u32) entry_bytes ("KEY=VALUE") }*
 */
function parseVorbisCommentBlock(data: Buffer): RawVorbisComments {
    const result: RawVorbisComments = new Map();
    let o = 0;

    if (o + 4 > data.length) return result;
    const vendorLen = data.readUInt32LE(o);
    o += 4;
    if (o + vendorLen > data.length) return result;
    o += vendorLen;

    if (o + 4 > data.length) return result;
    const userCount = data.readUInt32LE(o);
    o += 4;

    for (let i = 0; i < userCount; i++) {
        if (o + 4 > data.length) break;
        const len = data.readUInt32LE(o);
        o += 4;
        if (o + len > data.length) break;

        const raw = data.subarray(o, o + len);
        o += len;

        const eq = raw.indexOf(0x3d); // '='
        if (eq <= 0) continue;
        // Field names are required to be ASCII per Vorbis spec; safe to
        // upcase as bytes before string conversion.
        const key = raw.subarray(0, eq).toString('ascii').toUpperCase();
        const value = raw.subarray(eq + 1);

        // subarray is a view; copy so the underlying block buffer can be GC'd
        // once parsing returns. Append to preserve every instance — required
        // for sound mojibake recovery on multi-valued ARTIST/ALBUMARTIST tags.
        const copied = Buffer.from(value);
        const existing = result.get(key);
        if (existing) {
            existing.push(copied);
        } else {
            result.set(key, [copied]);
        }
    }

    return result;
}
