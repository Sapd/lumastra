// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

import { readMkvSubtitleTrack } from './mkv-subtitle-reader.js';

// --- EBML writers, enough to build the subset the reader walks ---------------

/** Encode a length as an EBML variable-length integer. */
function vintSize(value: number): Buffer {
    if (value < 0x7f) return Buffer.from([0x80 | value]);
    if (value < 0x3fff) return Buffer.from([0x40 | (value >> 8), value & 0xff]);
    return Buffer.from([0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff]);
}

/** Element ids keep their length marker, so they are written verbatim. */
function idBytes(id: number): Buffer {
    const out: number[] = [];
    let remaining = id;
    while (remaining > 0) {
        out.unshift(remaining & 0xff);
        remaining = Math.floor(remaining / 256);
    }
    return Buffer.from(out);
}

function element(id: number, payload: Buffer): Buffer {
    return Buffer.concat([idBytes(id), vintSize(payload.length), payload]);
}

/** Big-endian unsigned integer, minimal width. */
function uint(value: number): Buffer {
    if (value === 0) return Buffer.from([0]);
    const out: number[] = [];
    let remaining = value;
    while (remaining > 0) {
        out.unshift(remaining & 0xff);
        remaining = Math.floor(remaining / 256);
    }
    return Buffer.from(out);
}

/** A Block payload: track number, signed relative timestamp, flags, frame. */
function block(trackNumber: number, relativeTimestamp: number, frame: Buffer): Buffer {
    const head = Buffer.alloc(4);
    head[0] = 0x80 | trackNumber; // 1-byte vint
    head.writeInt16BE(relativeTimestamp, 1);
    head[3] = 0;
    return Buffer.concat([head, frame]);
}

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

interface BuildOptions {
    codecPrivate?: Buffer;
    timestampScaleNs?: number;
    clusters: Array<{
        timestamp: number;
        blocks: Array<{ relative: number; duration?: number; frame: Buffer }>;
    }>;
}

function buildMkv(options: BuildOptions): Buffer {
    const parts: Buffer[] = [element(ID_EBML_HEADER, Buffer.from([0x42, 0x86, 0x81, 0x01]))];

    const segmentParts: Buffer[] = [];

    if (options.timestampScaleNs !== undefined) {
        segmentParts.push(
            element(ID_INFO, element(ID_TIMESTAMP_SCALE, uint(options.timestampScaleNs))),
        );
    }

    if (options.codecPrivate) {
        segmentParts.push(
            element(
                ID_TRACKS,
                element(ID_TRACK_ENTRY, element(ID_CODEC_PRIVATE, options.codecPrivate)),
            ),
        );
    }

    for (const cluster of options.clusters) {
        const clusterParts: Buffer[] = [element(ID_CLUSTER_TIMESTAMP, uint(cluster.timestamp))];

        for (const b of cluster.blocks) {
            const payload = block(1, b.relative, b.frame);
            if (b.duration === undefined) {
                clusterParts.push(element(ID_SIMPLE_BLOCK, payload));
            } else {
                clusterParts.push(
                    element(
                        ID_BLOCK_GROUP,
                        Buffer.concat([
                            element(ID_BLOCK, payload),
                            element(ID_BLOCK_DURATION, uint(b.duration)),
                        ]),
                    ),
                );
            }
        }

        segmentParts.push(element(ID_CLUSTER, Buffer.concat(clusterParts)));
    }

    parts.push(element(ID_SEGMENT, Buffer.concat(segmentParts)));
    return Buffer.concat(parts);
}

describe('readMkvSubtitleTrack', () => {
    it('reads blocks with their cluster-relative timing', () => {
        const mkv = buildMkv({
            clusters: [
                {
                    timestamp: 4000,
                    blocks: [
                        { relative: 87, duration: 1365, frame: Buffer.from([1, 2, 3]) },
                        { relative: 1631, duration: 1115, frame: Buffer.from([4, 5]) },
                    ],
                },
            ],
        });

        const track = readMkvSubtitleTrack(mkv);

        expect(track.warnings).toEqual([]);
        expect(track.packets).toHaveLength(2);
        expect(track.packets[0]).toMatchObject({ ptsMs: 4087, durationMs: 1365 });
        expect(track.packets[1]).toMatchObject({ ptsMs: 5631, durationMs: 1115 });
        expect(Array.from(track.packets[0].data)).toEqual([1, 2, 3]);
    });

    it('carries the track private data through', () => {
        const codecPrivate = Buffer.from('size: 720x576\npalette: 000000\n');
        const mkv = buildMkv({
            codecPrivate,
            clusters: [
                { timestamp: 0, blocks: [{ relative: 0, duration: 10, frame: Buffer.from([9]) }] },
            ],
        });

        expect(readMkvSubtitleTrack(mkv).codecPrivate?.toString()).toBe(codecPrivate.toString());
    });

    // Ticks are not milliseconds by definition — they are scaled by
    // TimestampScale. Ignoring it silently mistimes every cue.
    it('honours a non-default TimestampScale', () => {
        const mkv = buildMkv({
            timestampScaleNs: 100_000, // 0.1 ms per tick
            clusters: [
                {
                    timestamp: 10_000, // 1000 ms
                    blocks: [{ relative: 5_000, duration: 20_000, frame: Buffer.from([1]) }],
                },
            ],
        });

        const [packet] = readMkvSubtitleTrack(mkv).packets;
        expect(packet.ptsMs).toBe(1500);
        expect(packet.durationMs).toBe(2000);
    });

    // Blocks may carry a NEGATIVE offset from their cluster.
    it('handles a negative block timestamp', () => {
        const mkv = buildMkv({
            clusters: [
                {
                    timestamp: 5000,
                    blocks: [{ relative: -200, duration: 500, frame: Buffer.from([1]) }],
                },
            ],
        });

        expect(readMkvSubtitleTrack(mkv).packets[0].ptsMs).toBe(4800);
    });

    it('reads a SimpleBlock, which states no duration', () => {
        const mkv = buildMkv({
            clusters: [{ timestamp: 1000, blocks: [{ relative: 0, frame: Buffer.from([7]) }] }],
        });

        const [packet] = readMkvSubtitleTrack(mkv).packets;
        expect(packet.ptsMs).toBe(1000);
        expect(packet.durationMs).toBe(0);
    });

    it('reads across multiple clusters', () => {
        const mkv = buildMkv({
            clusters: [
                { timestamp: 0, blocks: [{ relative: 10, duration: 5, frame: Buffer.from([1]) }] },
                {
                    timestamp: 30_000,
                    blocks: [{ relative: 20, duration: 5, frame: Buffer.from([2]) }],
                },
            ],
        });

        const track = readMkvSubtitleTrack(mkv);
        expect(track.packets.map((p) => p.ptsMs)).toEqual([10, 30_020]);
    });

    it('reports a non-Matroska buffer rather than throwing', () => {
        const track = readMkvSubtitleTrack(Buffer.from('not matroska at all'));
        expect(track.packets).toEqual([]);
        expect(track.warnings.join(' ')).toMatch(/matroska/i);
    });

    it('returns empty for an empty buffer', () => {
        expect(readMkvSubtitleTrack(Buffer.alloc(0)).packets).toEqual([]);
    });

    // A truncated file should yield whatever parsed cleanly rather than nothing.
    it('keeps packets read before a truncated tail', () => {
        const mkv = buildMkv({
            clusters: [
                { timestamp: 0, blocks: [{ relative: 0, duration: 100, frame: Buffer.from([1]) }] },
            ],
        });

        const track = readMkvSubtitleTrack(mkv.subarray(0, mkv.length - 3));
        expect(track.packets.length).toBeLessThanOrEqual(1);
    });

    // Cluster Timestamp is mandatory. Assuming zero would time every cue in the
    // cluster from the start of the file, bunching subtitles at 00:00.
    it('drops a cluster that states no Timestamp rather than timing it from zero', () => {
        const mkv = buildMkv({
            clusters: [
                { timestamp: 0, blocks: [{ relative: 10, duration: 5, frame: Buffer.from([1]) }] },
            ],
        });
        const at = mkv.indexOf(Buffer.from([0xe7]));
        const stripped = Buffer.concat([mkv.subarray(0, at), mkv.subarray(at + 3)]);

        expect(readMkvSubtitleTrack(stripped).warnings.join(' ')).toMatch(/no Timestamp/i);
    });

    // An unbounded scale multiplies every cue time into nonsense.
    it('falls back to the default for an implausible TimestampScale', () => {
        const mkv = buildMkv({
            timestampScaleNs: 999_999_999_999,
            clusters: [
                {
                    timestamp: 1000,
                    blocks: [{ relative: 0, duration: 10, frame: Buffer.from([1]) }],
                },
            ],
        });

        const track = readMkvSubtitleTrack(mkv);
        expect(track.packets[0].ptsMs).toBe(1000);
        expect(track.warnings.join(' ')).toMatch(/TimestampScale/i);
    });

    // Lacing headers would otherwise be handed to the SPU parser as pixel data.
    it('skips a laced block', () => {
        const mkv = buildMkv({
            clusters: [
                {
                    timestamp: 0,
                    blocks: [{ relative: 0, duration: 10, frame: Buffer.from([1, 2]) }],
                },
            ],
        });
        const at = mkv.indexOf(Buffer.from([0xa1]));
        mkv[at + 2 + 3] |= 0x06;

        expect(readMkvSubtitleTrack(mkv).packets).toEqual([]);
    });
});
