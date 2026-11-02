// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minimal Matroska reader for ONE subtitle track.
 *
 * ## Why this exists
 *
 * VobSub cannot be extracted to a bare stream the way PGS can. `.sup` is a
 * self-contained format carrying its own timestamps, so `-f sup` round-trips
 * everything the decoder needs. VobSub has no such muxer in FFmpeg (only the
 * demuxer), and a raw dump of its packets loses two things the decoder cannot
 * reconstruct:
 *
 *  - **When each cue starts.** An SPU's control sequence encodes only a DURATION
 *    relative to its own presentation time; the absolute position lives in the
 *    container.
 *  - **The palette.** SPU pixels are 2-bit indices into a 4-entry selection out
 *    of a 16-entry global palette that is stored per-track, in `CodecPrivate`.
 *
 * So the extractor wraps VobSub in Matroska (see `extractSubtitleStreamBinary`)
 * and this reader takes it apart again. It is deliberately narrow: it walks only
 * the elements needed for one subtitle track out of a file WE generated, and
 * ignores everything else.
 *
 * ## Format notes
 *
 * EBML is a tree of `(id, size, payload)` triples where both id and size are
 * variable-length integers. The elements that matter here:
 *
 * ```
 *   Segment                18538067
 *     Info                 1549A966
 *       TimestampScale     2AD7B1     ns per tick (default 1000000 = 1ms)
 *     Tracks               1654AE6B
 *       TrackEntry         AE
 *         CodecPrivate     63A2       the VobSub palette, as .idx text
 *     Cluster              1F43B675
 *       Timestamp          E7         cluster base, in ticks
 *       SimpleBlock        A3         no duration
 *       BlockGroup         A0
 *         Block            A1
 *         BlockDuration    9B         in ticks
 * ```
 *
 * A Block payload begins with a variable-length track number, a SIGNED 16-bit
 * timestamp relative to its cluster, and one flags byte, then the frame data.
 */

import { Logger } from './logger.js';

const logger = Logger.for('MkvSubtitleReader');

const ID_EBML_HEADER = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

/** Matroska's default when Info omits TimestampScale: 1 ms per tick. */
const DEFAULT_TIMESTAMP_SCALE_NS = 1_000_000;

/** Refuse absurd element sizes rather than allocating from a corrupt header. */
const MAX_ELEMENT_BYTES = 256 * 1024 * 1024;

/** Real Matroska nests a handful of levels; see `walk`. */
const MAX_NESTING_DEPTH = 32;

/** One second per tick is already absurd; beyond this the value is not real. */
const MAX_TIMESTAMP_SCALE_NS = 1_000_000_000;

export interface MkvSubtitlePacket {
    /** Presentation time in milliseconds, on the container's timeline. */
    ptsMs: number;
    /** Duration in milliseconds; 0 when the container did not state one. */
    durationMs: number;
    data: Buffer;
}

export interface MkvSubtitleTrack {
    /** Track-level private data — the VobSub palette lives here. */
    codecPrivate: Buffer | null;
    packets: MkvSubtitlePacket[];
    warnings: string[];
}

interface Cursor {
    offset: number;
}

/**
 * Read an EBML variable-length integer.
 *
 * The first set bit of the leading byte marks the length; `stripMarker` clears
 * that bit, which is right for sizes and element ids used as values but NOT for
 * ids being matched against constants (those keep their marker).
 */
function readVint(
    data: Buffer,
    cursor: Cursor,
    stripMarker: boolean,
): { value: number; bytes: number } | null {
    if (cursor.offset >= data.length) return null;

    const first = data[cursor.offset];
    if (first === 0) return null; // 8+ byte lengths are not produced here

    let length = 1;
    let mask = 0x80;
    while (length <= 8 && (first & mask) === 0) {
        mask >>= 1;
        length++;
    }
    if (length > 8 || cursor.offset + length > data.length) return null;

    let value = stripMarker ? first & (mask - 1) : first;
    for (let i = 1; i < length; i++) {
        // Beyond 2^53 the arithmetic stops being exact; such an element cannot
        // be real here, and continuing would silently produce a wrong size.
        value = value * 256 + data[cursor.offset + i];
        if (!Number.isSafeInteger(value)) return null;
    }

    cursor.offset += length;
    return { value, bytes: length };
}

/** Read an element header: its id (marker retained) and payload length. */
function readElementHeader(
    data: Buffer,
    cursor: Cursor,
): { id: number; size: number; unknownSize: boolean } | null {
    const idStart = cursor.offset;
    const id = readVint(data, cursor, false);
    if (!id) return null;

    // Reconstruct the id from its raw bytes so it matches the constants above.
    let rawId = 0;
    for (let i = idStart; i < cursor.offset; i++) rawId = rawId * 256 + data[i];

    // An all-ones size means "unknown length" — legal for Segment and Cluster,
    // which then run to the next element at their level or to EOF. ffmpeg's
    // matroska muxer emits an 8-byte one for both when the output is not
    // seekable, so this must be detected from the RAW bytes: an 8-byte all-ones
    // value is 2^56-1, which `readVint` rejects as unsafe before ever returning
    // it, and `(1 << 56) - 1` would in any case be wrong — JS shifts are mod 32,
    // so anything from 5 size bytes up computes a garbage mask (1 << 35 === 8).
    const sizeStart = cursor.offset;
    const marker = data[sizeStart];
    if (marker === undefined) return null;

    let sizeBytes = 1;
    let mask = 0x80;
    while (sizeBytes <= 8 && (marker & mask) === 0) {
        mask >>= 1;
        sizeBytes++;
    }
    if (sizeBytes > 8 || sizeStart + sizeBytes > data.length) return null;

    let allOnes = (marker & (mask - 1)) === mask - 1;
    for (let i = 1; i < sizeBytes && allOnes; i++) {
        if (data[sizeStart + i] !== 0xff) allOnes = false;
    }

    if (allOnes) {
        cursor.offset = sizeStart + sizeBytes;
        return { id: rawId, size: 0, unknownSize: true };
    }

    const size = readVint(data, cursor, true);
    if (!size) return null;

    if (size.value > MAX_ELEMENT_BYTES) return null;

    return { id: rawId, size: size.value, unknownSize: false };
}

/** Big-endian unsigned integer of arbitrary width (as EBML stores them). */
function readUInt(data: Buffer, start: number, length: number): number {
    let value = 0;
    for (let i = 0; i < length; i++) value = value * 256 + data[start + i];
    return value;
}

/**
 * Extract the subtitle packets and track private data from a Matroska buffer.
 *
 * Tolerant by design: a malformed element ends the walk and whatever was read up
 * to that point is returned, rather than throwing away a whole track for one bad
 * cluster.
 */
export function readMkvSubtitleTrack(data: Buffer): MkvSubtitleTrack {
    const warnings: string[] = [];
    const packets: MkvSubtitlePacket[] = [];
    let codecPrivate: Buffer | null = null;
    let timestampScaleNs = DEFAULT_TIMESTAMP_SCALE_NS;

    /** Ticks → milliseconds, via the file's TimestampScale. */
    const toMs = (ticks: number): number => Math.round((ticks * timestampScaleNs) / 1_000_000);

    /**
     * Walk one level, descending into containers we care about.
     *
     * `depth` is capped because this recurses on nested containers, and element
     * ids are as short as one byte — a chain of nested TrackEntry elements costs
     * ~4 bytes per level, so ~20 KB of crafted input would otherwise blow the
     * stack. Real files nest a handful of levels deep. This is reachable: the
     * caller sniffs magic bytes on CACHE FILE content, which the service itself
     * documents as corruptible, not only on files we just generated.
     */
    function walk(start: number, end: number, clusterTimestamp: number, depth: number): void {
        if (depth > MAX_NESTING_DEPTH) {
            warnings.push('Element nesting too deep; stopped descending');
            return;
        }

        const cursor: Cursor = { offset: start };

        while (cursor.offset < end) {
            const header = readElementHeader(data, cursor);
            if (!header) {
                warnings.push(`Malformed element at byte ${cursor.offset}`);
                return;
            }

            const payloadStart = cursor.offset;
            const payloadEnd = header.unknownSize ? end : Math.min(payloadStart + header.size, end);

            switch (header.id) {
                case ID_SEGMENT:
                case ID_INFO:
                case ID_TRACKS:
                case ID_TRACK_ENTRY:
                    walk(payloadStart, payloadEnd, clusterTimestamp, depth + 1);
                    break;

                case ID_CLUSTER: {
                    // A cluster's own Timestamp precedes its blocks, so read it
                    // first and hand it down rather than walking twice.
                    const base = findClusterTimestamp(data, payloadStart, payloadEnd);
                    if (base === null) {
                        // Every block in the cluster would silently be timed from
                        // zero, which reads as subtitles bunched at the start.
                        warnings.push('Cluster has no Timestamp; its cues would be mistimed');
                        cursor.offset = payloadEnd;
                        continue;
                    }
                    walk(payloadStart, payloadEnd, base, depth + 1);
                    break;
                }

                case ID_BLOCK_GROUP:
                    readBlockGroup(payloadStart, payloadEnd, clusterTimestamp);
                    break;

                case ID_SIMPLE_BLOCK: {
                    const block = parseBlock(data, payloadStart, payloadEnd);
                    if (block) {
                        packets.push({
                            ptsMs: toMs(clusterTimestamp + block.relativeTimestamp),
                            durationMs: 0,
                            data: block.data,
                        });
                    }
                    break;
                }

                case ID_TIMESTAMP_SCALE: {
                    // Unbounded, this multiplies every cue time. A crafted value
                    // yields timestamps past the safe-integer range, so cue times
                    // become nonsense rather than merely wrong.
                    const scale = readUInt(data, payloadStart, payloadEnd - payloadStart);
                    timestampScaleNs =
                        scale > 0 && scale <= MAX_TIMESTAMP_SCALE_NS
                            ? scale
                            : DEFAULT_TIMESTAMP_SCALE_NS;
                    if (scale > MAX_TIMESTAMP_SCALE_NS) {
                        warnings.push(`Implausible TimestampScale ${scale}; using the default`);
                    }
                    break;
                }

                case ID_CODEC_PRIVATE:
                    codecPrivate = data.subarray(payloadStart, payloadEnd);
                    break;

                default:
                    break;
            }

            if (header.unknownSize) {
                // Only containers carry unknown sizes, and walk() above already
                // consumed the rest of this level.
                return;
            }
            cursor.offset = payloadEnd;
        }
    }

    /** A BlockGroup pairs one Block with its BlockDuration. */
    function readBlockGroup(start: number, end: number, clusterTimestamp: number): void {
        const cursor: Cursor = { offset: start };
        let blockData: Buffer | null = null;
        let relativeTimestamp = 0;
        let durationTicks = 0;

        while (cursor.offset < end) {
            const header = readElementHeader(data, cursor);
            if (!header) return;

            const payloadStart = cursor.offset;
            const payloadEnd = Math.min(payloadStart + header.size, end);

            if (header.id === ID_BLOCK) {
                const block = parseBlock(data, payloadStart, payloadEnd);
                if (block) {
                    blockData = block.data;
                    relativeTimestamp = block.relativeTimestamp;
                }
            } else if (header.id === ID_BLOCK_DURATION) {
                durationTicks = readUInt(data, payloadStart, payloadEnd - payloadStart);
            }

            cursor.offset = payloadEnd;
        }

        if (blockData) {
            packets.push({
                ptsMs: toMs(clusterTimestamp + relativeTimestamp),
                durationMs: toMs(durationTicks),
                data: blockData,
            });
        }
    }

    // Check the magic before walking. Without this, arbitrary bytes whose first
    // byte happens to carry a valid vint marker parse as a plausible element and
    // the reader returns an empty track — indistinguishable from a real file with
    // no subtitles, which is a much harder failure to diagnose.
    if (data.length < 4 || data.readUInt32BE(0) !== ID_EBML_HEADER) {
        return { codecPrivate: null, packets: [], warnings: ['Not a Matroska file'] };
    }

    const cursor: Cursor = { offset: 0 };
    // Skip the EBML header element, then walk the rest of the file.
    const first = readElementHeader(data, cursor);
    if (!first) {
        return { codecPrivate: null, packets: [], warnings: ['Not a Matroska file'] };
    }
    walk(cursor.offset + (first.unknownSize ? 0 : first.size), data.length, 0, 0);

    logger.debug('Read Matroska subtitle track', {
        bytes: data.length,
        packets: packets.length,
        hasCodecPrivate: !!codecPrivate,
        timestampScaleNs,
        warnings: warnings.length,
    });

    return { codecPrivate, packets, warnings };
}

/**
 * Scan a cluster's direct children for its Timestamp element.
 * Returns null when absent, so the caller can reject rather than assume zero.
 */
function findClusterTimestamp(data: Buffer, start: number, end: number): number | null {
    const cursor: Cursor = { offset: start };

    while (cursor.offset < end) {
        const header = readElementHeader(data, cursor);
        if (!header) return 0;

        const payloadStart = cursor.offset;
        const payloadEnd = Math.min(payloadStart + header.size, end);

        if (header.id === ID_CLUSTER_TIMESTAMP) {
            return readUInt(data, payloadStart, payloadEnd - payloadStart);
        }
        // Blocks follow the timestamp; once we reach one there is nothing left
        // to find at this level.
        if (header.id === ID_SIMPLE_BLOCK || header.id === ID_BLOCK_GROUP) return null;

        cursor.offset = payloadEnd;
    }
    return null;
}

/**
 * Parse a Block / SimpleBlock payload: track number, relative timestamp, flags,
 * then the frame. Lacing is not handled — subtitle blocks are never laced.
 */
function parseBlock(
    data: Buffer,
    start: number,
    end: number,
): { relativeTimestamp: number; data: Buffer } | null {
    const cursor: Cursor = { offset: start };
    const track = readVint(data, cursor, true);
    if (!track) return null;

    // 2-byte SIGNED relative timestamp, then 1 flags byte.
    if (cursor.offset + 3 > end) return null;
    const relativeTimestamp = data.readInt16BE(cursor.offset);

    // Bits 1-2 of the flags select lacing. Subtitle blocks are never laced, and
    // this reader does not split them — decoding a laced block would hand the
    // lacing headers to the SPU parser as if they were pixel data.
    if ((data[cursor.offset + 2] & 0x06) !== 0) return null;

    const frameStart = cursor.offset + 3;
    if (frameStart >= end) return null;

    return { relativeTimestamp, data: data.subarray(frameStart, end) };
}
