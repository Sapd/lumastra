// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Removes **empty-edit** `edts` boxes from the `trak`s of an ISO-BMFF init
 * segment (`init_*.mp4`). An "empty edit" is an `elst` entry with
 * `media_time = -1` (the ISO/IEC 14496-12 sentinel meaning "leave a gap of
 * `segment_duration` in the presentation timeline before playing any media").
 *
 * Why: on a post-seek output, FFmpeg (with `-ss` / `-copyts` /
 * `-start_at_zero`) writes an empty edit whose `segment_duration` equals the
 * seek target (e.g. 1634 s for a seek to ~27 min). When hls.js feeds such an
 * init to MSE:
 *
 *   - **Chrome** ignores fMP4 edit lists and applies only `timestampOffset`.
 *     Content lands at the correct manifest position. Works.
 *   - **Firefox** honors the edit list AND applies `timestampOffset`, stacking
 *     the seek offset twice. Content lands at 2× the seek target (e.g. 3268 s
 *     for a 1634 s seek target). The player then either loops refetching the
 *     same segments (video trak case — hls.js rewrites the elst based on its
 *     own seek math) or produces a split buffer (audio trak case — video lands
 *     at 1634 s, audio at 3268 s, nothing plays).
 *
 * Stripping empty edits leaves only real media edits behind, so hls.js's
 * `timestampOffset` is the single source of seek truth on both browsers.
 *
 * Edits with `media_time >= 0` are preserved. They encode real content trims:
 * in particular, FFmpeg can emit a positive-`media_time` elst on the AAC
 * audio trak to represent the encoder-delay priming samples, and stripping
 * that would shift the audio timeline by a few ms and cause A/V drift on
 * every browser.
 */
export function stripMp4InitEditLists(buffer: Buffer): Buffer {
    if (buffer.length < 8) return buffer;
    const out: Buffer[] = [];
    let o = 0;
    let changed = false;
    while (o + 8 <= buffer.length) {
        const size = buffer.readUInt32BE(o);
        const type = buffer.toString('latin1', o + 4, o + 8);
        if (size < 8 || o + size > buffer.length) {
            // Malformed — bail out and return original to avoid corruption
            return buffer;
        }
        if (type === 'moov') {
            const result = rewriteMoov(buffer, o + 8, o + size);
            if (result.changed) {
                changed = true;
                const newSize = 8 + result.buffer.length;
                const header = Buffer.alloc(8);
                header.writeUInt32BE(newSize, 0);
                header.write('moov', 4, 'latin1');
                out.push(header, result.buffer);
            } else {
                out.push(buffer.subarray(o, o + size));
            }
        } else {
            out.push(buffer.subarray(o, o + size));
        }
        o += size;
    }
    if (!changed) return buffer;
    if (o < buffer.length) out.push(buffer.subarray(o));
    return Buffer.concat(out);
}

interface RewriteResult {
    buffer: Buffer;
    changed: boolean;
}

/**
 * Walk moov children; rewrite each `trak` by stripping any empty-edit
 * `edts` it contains.
 */
function rewriteMoov(buffer: Buffer, start: number, end: number): RewriteResult {
    const out: Buffer[] = [];
    let o = start;
    let changed = false;
    while (o + 8 <= end) {
        const size = buffer.readUInt32BE(o);
        const type = buffer.toString('latin1', o + 4, o + 8);
        if (size < 8 || o + size > end) {
            out.push(buffer.subarray(o, end));
            break;
        }
        if (type === 'trak') {
            const inner = rewriteTrak(buffer, o + 8, o + size);
            if (inner.changed) {
                changed = true;
                const newSize = 8 + inner.buffer.length;
                const header = Buffer.alloc(8);
                header.writeUInt32BE(newSize, 0);
                header.write('trak', 4, 'latin1');
                out.push(header, inner.buffer);
            } else {
                out.push(buffer.subarray(o, o + size));
            }
        } else {
            out.push(buffer.subarray(o, o + size));
        }
        o += size;
    }
    return { buffer: Buffer.concat(out), changed };
}

/**
 * Walk a trak body. For each `edts` child, inspect its `elst`; if the elst
 * contains any empty-edit entry (`media_time = -1`), drop the whole `edts`
 * box (hls.js does not reconstruct a partial elst; the simplest and safest
 * response is to remove the edit list entirely). If the `edts` has no
 * empty edits, keep it intact.
 */
function rewriteTrak(buffer: Buffer, start: number, end: number): RewriteResult {
    const out: Buffer[] = [];
    let o = start;
    let changed = false;
    while (o + 8 <= end) {
        const size = buffer.readUInt32BE(o);
        const type = buffer.toString('latin1', o + 4, o + 8);
        if (size < 8 || o + size > end) {
            out.push(buffer.subarray(o, end));
            break;
        }
        if (type === 'edts' && edtsHasEmptyEdit(buffer, o + 8, o + size)) {
            changed = true;
            // Drop the whole edts box.
        } else {
            out.push(buffer.subarray(o, o + size));
        }
        o += size;
    }
    return { buffer: Buffer.concat(out), changed };
}

/** Return true if any `elst` entry inside [start, end) has `media_time == -1`. */
function edtsHasEmptyEdit(buffer: Buffer, start: number, end: number): boolean {
    let o = start;
    while (o + 8 <= end) {
        const size = buffer.readUInt32BE(o);
        const type = buffer.toString('latin1', o + 4, o + 8);
        if (size < 8 || o + size > end) return false;
        if (type === 'elst') {
            // elst body: version(1) + flags(3) + entry_count(4) + entries
            // v0 entry: segment_duration(4) + media_time(int32) + media_rate(4)
            // v1 entry: segment_duration(8) + media_time(int64) + media_rate(4)
            if (o + 16 > end) return false;
            const version = buffer[o + 8];
            const entryCount = buffer.readUInt32BE(o + 12);
            const entrySize = version === 1 ? 20 : 12;
            let p = o + 16;
            for (let i = 0; i < entryCount; i++) {
                if (p + entrySize > end) return false;
                const mediaTime =
                    version === 1
                        ? Number(buffer.readBigInt64BE(p + 8))
                        : buffer.readInt32BE(p + 4);
                if (mediaTime === -1) return true;
                p += entrySize;
            }
            return false;
        }
        o += size;
    }
    return false;
}

/**
 * True when `buffer` looks like a **fully written** ISO-BMFF init segment.
 *
 * Readiness for an init file cannot be "the file exists" or even "the file is
 * non-empty": FFmpeg creates `init_*.mp4` and then writes `ftyp`+`moov` into it,
 * so a reader can catch it at 0 bytes or part-written. Either one is served as a
 * valid-looking 200 that hls.js cannot demux, surfacing as `fragParsingError`.
 *
 * The test is deliberately **fail-open**: it returns `false` only on an
 * unambiguous truncation signal — a top-level box whose declared size runs past
 * the end of the buffer, or no `moov` at all (a real fMP4 init always has one).
 * Anything it cannot parse is reported complete, so an init we fail to
 * understand is still served rather than being withheld until the caller's
 * timeout. Refusing a valid init would be a worse failure than the race this
 * guards, so the uncertain case keeps today's behaviour.
 */
export function isCompleteMp4Init(buffer: Buffer): boolean {
    if (buffer.length < 8) return false;
    let o = 0;
    let sawMoov = false;
    while (o + 8 <= buffer.length) {
        let size = buffer.readUInt32BE(o);
        const type = buffer.toString('latin1', o + 4, o + 8);
        let headerSize = 8;
        if (size === 1) {
            // 64-bit largesize follows the type.
            if (o + 16 > buffer.length) return false;
            const large = buffer.readBigUInt64BE(o + 8);
            if (large > BigInt(Number.MAX_SAFE_INTEGER)) return true; // unparseable — fail open
            size = Number(large);
            headerSize = 16;
        } else if (size === 0) {
            // "Extends to end of file" — by definition nothing is missing.
            return sawMoov || type === 'moov';
        }
        if (size < headerSize) return true; // malformed — fail open
        if (o + size > buffer.length) return false; // declared past EOF — truncated
        if (type === 'moov') sawMoov = true;
        o += size;
    }
    return sawMoov;
}
