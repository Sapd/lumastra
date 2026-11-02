// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VobSub / DVD subtitle (SPU) parser.
 *
 * Produces the same cue shape as `pgs-parser`, so the renderer and the endpoints
 * that serve rendered bitmap subtitles do not care which of the two produced them.
 *
 * ## Where the pieces come from
 *
 * Unlike PGS, a VobSub cue is assembled from THREE sources:
 *
 *  - the **container** gives each cue's start time and duration (the extractor
 *    wraps the track in Matroska for exactly this reason — see
 *    `mkv-subtitle-reader`);
 *  - the **SPU packet** gives the on-screen rectangle, the bitmap, and which four
 *    palette slots the bitmap's 2-bit pixels select;
 *  - the **track's CodecPrivate** gives the 16-entry global palette those four
 *    slots index into, as `.idx` text.
 *
 * Miss any one of them and the cue is undisplayable, which is why a raw packet
 * dump is not enough for this format.
 *
 * ## SPU packet layout
 *
 * ```
 *   size          2 bytes   total packet length, including these 2
 *   controlOffset 2 bytes   offset (from packet start) of the first DCSQ
 *   ...RLE bitmap data...
 *   DCSQ          control sequences, each:
 *     delay       2 bytes   in 1024/90000 s units, relative to packet PTS
 *     nextAddr    2 bytes   offset of the next DCSQ (self-pointing = last)
 *     commands    variable, terminated by 0xFF
 * ```
 *
 * Colour/contrast state is reset per PACKET here. FFmpeg carries it across
 * packets, so a packet omitting `SET_COLOR` inherits the previous one's; real
 * tracks always carry both commands, and resetting keeps one malformed packet
 * from tinting everything after it.
 *
 * The commands that matter: `0x03 SET_COLOR` (four 4-bit palette indices),
 * `0x04 SET_CONTR` (four 4-bit alphas), `0x05 SET_DAREA` (the rectangle, as four
 * 12-bit coordinates), `0x06 SET_DSPXA` (offsets of the two interlaced fields).
 * `0x01`/`0x02` start and stop display — read for validation, but the container's
 * duration is preferred because it is what the player itself will honour.
 */

import { Logger } from './logger.js';
import type { PgsCue, PgsRect } from './pgs-parser.js';

const logger = Logger.for('VobSubParser');

const CMD_FORCED_START = 0x00;
const CMD_START_DISPLAY = 0x01;
const CMD_STOP_DISPLAY = 0x02;
const CMD_SET_COLOR = 0x03;
const CMD_SET_CONTRAST = 0x04;
const CMD_SET_AREA = 0x05;
const CMD_SET_PIXEL_ADDR = 0x06;
const CMD_CHANGE_COLCON = 0x07;
const CMD_END = 0xff;

/**
 * DCSQ delays are in units of 1024/90000 s — NOT plain 90 kHz ticks. Getting
 * this wrong scales every duration by ~11x.
 */
const DCSQ_TICKS_PER_SECOND = 90_000 / 1024;

/**
 * Bounds on decoded bitmap size.
 *
 * SET_DAREA coordinates are 12-bit, so width and height cannot exceed 4096 and a
 * per-dimension ceiling alone is worthless — 4096x4096 is a *reachable* 16.7 MB
 * per cue. Worse, the fill-to-end-of-line rule means one 2-byte run paints an
 * entire row, so ~8 KB of packet can declare a full 4096x4096 bitmap: a ~2000x
 * amplification, repeated per packet, and `MAX_CUES` in the render service only
 * runs AFTER parsing returns.
 *
 * So bound the decoded area directly, per cue and cumulatively across the track.
 *
 * The cumulative bound has two terms and the ABSOLUTE ceiling is the real one;
 * the per-source-byte term only stops a tiny crafted file claiming all of it, and
 * is set far above any legitimate encoding. A fixed cap is only ever calibrated
 * against the sample it was measured on: the 45-minute track this was built
 * against averages ~37 kpx per cue, but a 3-hour track, or a disc authored with
 * full-frame subpictures (720x576 = 414 kpx per cue), scales past any constant
 * chosen from that one sample. PGS hit exactly that and truncated a 3-hour film
 * silently; the same shape of cap was still sitting here afterwards.
 *
 * Note VobSub's fill-to-end-of-line form makes flat content especially cheap to
 * encode, so density varies more here than for PGS, not less.
 */
const MAX_CUE_PIXELS = 4 * 1024 * 1024;
const MAX_TRACK_PIXELS_PER_SOURCE_BYTE = 512;
const MAX_TRACK_PIXELS = 512 * 1024 * 1024;

/** Enough to diagnose a bad track; a per-packet unbounded list is a leak. */
const MAX_WARNINGS = 32;

/** Collects non-fatal problems, bounded by the caller. */
type WarnFn = (message: string) => void;

export interface VobSubParseResult {
    canvasWidth: number;
    canvasHeight: number;
    cues: PgsCue[];
    warnings: string[];
}

/**
 * Parse the 16-entry global palette out of `.idx`-style track private data.
 *
 * The line looks like `palette: 000000, f0f0f0, cccccc, ...` — sixteen RGB
 * triples in hex. Returns null when absent, so the caller can fall back rather
 * than rendering every cue in the wrong colours.
 */
export function parseIdxPalette(codecPrivate: Buffer | null): Uint8Array | null {
    if (!codecPrivate) return null;

    const text = codecPrivate.toString('utf-8');
    const line = text.split('\n').find((l) => l.trim().toLowerCase().startsWith('palette:'));
    if (!line) return null;

    const entries = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-fA-F]{6}$/.test(s));

    if (entries.length < 16) return null;

    // Stored as RGB triples. (The DVD spec's on-disc palette is YCrCb, but the
    // `.idx` sidecar convention — which is what lands in CodecPrivate — is RGB,
    // and the values bear that out: 000000 black, f0f0f0 near-white.)
    const palette = new Uint8Array(16 * 3);
    for (let i = 0; i < 16; i++) {
        const value = parseInt(entries[i], 16);
        palette[i * 3] = (value >> 16) & 0xff;
        palette[i * 3 + 1] = (value >> 8) & 0xff;
        palette[i * 3 + 2] = value & 0xff;
    }
    return palette;
}

/** Canvas from the `size: 1920x1080` line of the same private data. */
export function parseIdxSize(
    codecPrivate: Buffer | null,
): { width: number; height: number } | null {
    if (!codecPrivate) return null;

    const match = /^size:\s*(\d+)\s*x\s*(\d+)/im.exec(codecPrivate.toString('utf-8'));
    if (!match) return null;

    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    if (!width || !height) return null;

    return { width, height };
}

/** A neutral greyscale fallback, used when the track carries no palette. */
function defaultPalette(): Uint8Array {
    const palette = new Uint8Array(16 * 3);
    for (let i = 0; i < 16; i++) {
        const level = Math.round((i / 15) * 255);
        palette[i * 3] = level;
        palette[i * 3 + 1] = level;
        palette[i * 3 + 2] = level;
    }
    return palette;
}

interface SpuDisplay {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    /** Palette index (into the 16-entry global palette) per 2-bit pixel value. */
    colours: [number, number, number, number];
    /** Alpha 0–15 per 2-bit pixel value. */
    alphas: [number, number, number, number];
    topFieldOffset: number;
    bottomFieldOffset: number;
    /** Start of the control block — the hard end of the pixel region. */
    controlOffset: number;
    stopDelayMs: number | null;
}

/**
 * Walk the control sequences of one SPU packet.
 *
 * Later DCSQs override earlier ones for geometry and colour, which is how a cue
 * that changes mid-display is expressed; the stop delay is taken from whichever
 * DCSQ carries `STP_DSP`.
 */
function parseControl(packet: Buffer, warn: WarnFn): SpuDisplay | null {
    if (packet.length < 4) return null;

    const packetSize = packet.readUInt16BE(0);

    // A zero size marks the HD-DVD variant: 32-bit size and DCSQ offsets, a
    // 256-entry palette, inverted contrast, and a different RLE. Reject it
    // outright — read as a standard SPU those 32-bit fields decode to nonsense
    // geometry, which is worse than declining the track.
    if (packetSize === 0) {
        warn('HD-DVD (8-bit palette) SPU variant is not supported');
        return null;
    }

    const controlOffset = packet.readUInt16BE(2);
    if (controlOffset < 4 || controlOffset >= packet.length) {
        warn(`Control offset ${controlOffset} outside packet of ${packet.length}`);
        return null;
    }

    const display: SpuDisplay = {
        x1: 0,
        y1: 0,
        x2: -1,
        y2: -1,
        colours: [0, 1, 2, 3],
        alphas: [0, 15, 15, 15],
        topFieldOffset: -1,
        bottomFieldOffset: -1,
        controlOffset,
        stopDelayMs: null,
    };

    const limit = Math.min(packetSize, packet.length);
    let sequenceStart = controlOffset;
    let sequences = 0;
    let sawArea = false;
    let sawPixelAddr = false;
    let sawColour = false;
    let sawContrast = false;

    // Bounded: a self-referential or cyclic nextAddr must not spin.
    while (sequences++ < 64 && sequenceStart + 4 <= limit) {
        const delayTicks = packet.readUInt16BE(sequenceStart);
        const nextAddr = packet.readUInt16BE(sequenceStart + 2);
        const delayMs = Math.round((delayTicks / DCSQ_TICKS_PER_SECOND) * 1000);

        let at = sequenceStart + 4;
        let commands = 0;

        while (at < limit && commands++ < 64) {
            const command = packet[at];

            // CMD_END terminates this DCSQ; the cursor is not read again.
            if (command === CMD_END) break;

            switch (command) {
                case CMD_FORCED_START:
                case CMD_START_DISPLAY:
                    at += 1;
                    break;

                case CMD_STOP_DISPLAY:
                    display.stopDelayMs = delayMs;
                    at += 1;
                    break;

                case CMD_SET_COLOR: {
                    if (at + 3 > limit) return finish();
                    sawColour = true;
                    const packed = packet.readUInt16BE(at + 1);
                    // Nibbles run high→low as pixel value 3,2,1,0 — reversed
                    // relative to the pixel values they describe.
                    display.colours = [
                        packed & 0x0f,
                        (packed >> 4) & 0x0f,
                        (packed >> 8) & 0x0f,
                        (packed >> 12) & 0x0f,
                    ];
                    at += 3;
                    break;
                }

                case CMD_SET_CONTRAST: {
                    if (at + 3 > limit) return finish();
                    sawContrast = true;
                    const packed = packet.readUInt16BE(at + 1);
                    display.alphas = [
                        packed & 0x0f,
                        (packed >> 4) & 0x0f,
                        (packed >> 8) & 0x0f,
                        (packed >> 12) & 0x0f,
                    ];
                    at += 3;
                    break;
                }

                case CMD_SET_AREA: {
                    if (at + 7 > limit) return finish();
                    // Four 12-bit coordinates packed into six bytes.
                    const b = packet;
                    display.x1 = (b[at + 1] << 4) | (b[at + 2] >> 4);
                    display.x2 = ((b[at + 2] & 0x0f) << 8) | b[at + 3];
                    display.y1 = (b[at + 4] << 4) | (b[at + 5] >> 4);
                    display.y2 = ((b[at + 5] & 0x0f) << 8) | b[at + 6];
                    sawArea = true;
                    at += 7;
                    break;
                }

                case CMD_SET_PIXEL_ADDR: {
                    if (at + 5 > limit) return finish();
                    const top = packet.readUInt16BE(at + 1);
                    const bottom = packet.readUInt16BE(at + 3);

                    // Both must land inside the PIXEL region — after the 4-byte
                    // header and before the control block. Nothing in the format
                    // enforces that, and an offset pointing into the control
                    // sequence decodes command bytes as pixels: a cue rendered
                    // from noise rather than the bitmap. (This is also the shape
                    // of the xine overlapping-fields advisory, though the decode
                    // itself is bounds-safe here.)
                    // Equality with controlOffset is legal and means an EMPTY
                    // field — a single-row subpicture has no bottom field at all.
                    if (top < 4 || bottom < 4 || top > controlOffset || bottom > controlOffset) {
                        warn(`Field offsets ${top}/${bottom} outside the pixel data`);
                        return null;
                    }

                    display.topFieldOffset = top;
                    display.bottomFieldOffset = bottom;
                    sawPixelAddr = true;
                    at += 5;
                    break;
                }

                case CMD_CHANGE_COLCON: {
                    // Variable-length colour/contrast animation; skipped, but its
                    // length must still be honoured to stay in step.
                    if (at + 3 > limit) return finish();
                    at += 1 + packet.readUInt16BE(at + 1);
                    break;
                }

                default:
                    warn(`Unknown SPU command 0x${command.toString(16)}`);
                    return finish();
            }
        }

        // A DCSQ whose next pointer targets itself (or goes backwards) marks the
        // end of the chain.
        if (nextAddr <= sequenceStart || nextAddr + 4 > limit) break;
        sequenceStart = nextAddr;
    }

    return finish();

    function finish(): SpuDisplay | null {
        if (!sawArea || !sawPixelAddr) {
            warn('SPU packet lacks a display area or pixel address');
            return null;
        }
        // Not fatal — the defaults are a sane white-on-transparent mapping — but
        // the cue is NOT rendered in its authored colours, and silently wrong
        // colours are harder to diagnose than a missing cue.
        if (!sawColour || !sawContrast) {
            warn('SPU packet omits colour/contrast; using defaults');
        }
        return display;
    }
}

/**
 * Decode one interlaced field of nibble-run-length data into palette indices.
 *
 * The encoding reads 4-bit nibbles and grows the run descriptor until its value
 * is large enough:
 *
 * ```
 *   v = nibble
 *   if v < 0x4  : v = (v << 4) | nibble
 *   if v < 0x10 : v = (v << 4) | nibble
 *   if v < 0x40 : v = (v << 4) | nibble
 *   count = v >> 2 ; colour = v & 3
 *   count == 0  → run to the end of the line
 * ```
 *
 * `rows` selects which lines of the output this field fills: the top field holds
 * EVEN rows and the bottom field ODD ones. Each line ends on a byte boundary, so
 * a dangling nibble is discarded before the next line begins.
 */
function decodeField(
    data: Buffer,
    startByte: number,
    endByte: number,
    width: number,
    height: number,
    firstRow: number,
    out: Uint8Array,
): void {
    let nibbleIndex = startByte * 2;
    // Hard stop at the control block, not at the end of the packet. Nothing in
    // the format prevents a field offset from running into the control sequence,
    // and decoding command bytes as pixels renders a cue out of noise.
    const endNibble = Math.min(endByte, data.length) * 2;

    const nextNibble = (): number => {
        if (nibbleIndex >= endNibble) return 0;
        const byte = data[nibbleIndex >> 1];
        const value = nibbleIndex & 1 ? byte & 0x0f : byte >> 4;
        nibbleIndex++;
        return value;
    };

    for (let row = firstRow; row < height; row += 2) {
        let x = 0;

        while (x < width) {
            if (nibbleIndex >= endNibble) return;

            // The escapes NEST — each wider form is only consulted when the
            // previous one was taken. Writing these as three sequential `if`s
            // instead makes a first nibble of, say, 0x5 (already a complete
            // 1-nibble run) fall into the `< 0x10` test and swallow a second
            // nibble, which desynchronises the whole field. It renders as
            // horizontal streaks rather than text.
            let value = nextNibble();
            if (value < 0x4) {
                value = (value << 4) | nextNibble();
                if (value < 0x10) {
                    value = (value << 4) | nextNibble();
                    if (value < 0x40) {
                        value = (value << 4) | nextNibble();
                    }
                }
            }

            const colour = value & 0x03;
            let count = value >> 2;

            // A descriptor below 4 (i.e. a zero length) means "fill to the end of
            // the line with this colour". Note this is `value < 4`, not just an
            // all-zero code: the original LiViD notes listed only 0x0000, and
            // real discs carry 0x0003.
            if (count === 0) count = width - x;

            // Runs must not cross a line boundary. Clamping rather than erroring
            // matches the lenient implementations; treating it as fatal would
            // drop whole subtitles on files other players show fine.
            const end = Math.min(x + count, width);
            out.fill(colour, row * width + x, row * width + end);
            x = end;
        }

        // Lines are byte-aligned; drop a half-consumed byte before the next one.
        if (nibbleIndex & 1) nibbleIndex++;
    }
}

/**
 * Parse a Matroska-wrapped VobSub track into timed RGBA cues.
 *
 * `packets` come from `readMkvSubtitleTrack`; `codecPrivate` is that reader's
 * track private data, carrying the palette and canvas size.
 */
export function parseVobSub(
    packets: Array<{ ptsMs: number; durationMs: number; data: Buffer }>,
    codecPrivate: Buffer | null,
): VobSubParseResult {
    // Bounded: a track whose every packet fails would otherwise allocate one
    // string per packet, defeating the point of a cheap reject path.
    const allWarnings: string[] = [];
    const warn: WarnFn = (message) => {
        if (allWarnings.length < MAX_WARNINGS) allWarnings.push(message);
    };
    const cues: PgsCue[] = [];

    const globalPalette = parseIdxPalette(codecPrivate);
    if (!globalPalette) {
        warn('No palette in track private data; falling back to greyscale');
    }
    const palette16 = globalPalette ?? defaultPalette();

    let decodedPixels = 0;
    // Sized against the bytes actually supplied, so a long or densely-authored
    // track scales with its own source rather than against a sampled constant.
    const sourceBytes = packets.reduce((total, packet) => total + packet.data.length, 0);
    const maxTrackPixels = Math.min(
        sourceBytes * MAX_TRACK_PIXELS_PER_SOURCE_BYTE,
        MAX_TRACK_PIXELS,
    );

    const declaredSize = parseIdxSize(codecPrivate);
    let canvasWidth = declaredSize?.width ?? 0;
    let canvasHeight = declaredSize?.height ?? 0;

    for (const packet of packets) {
        const display = parseControl(packet.data, warn);
        if (!display) continue;

        const width = display.x2 - display.x1 + 1;
        const height = display.y2 - display.y1 + 1;

        if (width <= 0 || height <= 0) {
            warn(`Implausible display area ${width}x${height}`);
            continue;
        }

        const pixels = width * height;
        if (pixels > MAX_CUE_PIXELS) {
            warn(`Display area ${width}x${height} exceeds the per-cue pixel budget`);
            continue;
        }

        // Every line costs at least one byte to encode, so a height beyond the
        // bytes actually present is a corrupt header rather than dense coding.
        const rleBytesAvailable = Math.max(
            0,
            packet.data.length - Math.min(display.topFieldOffset, display.bottomFieldOffset),
        );
        if (height > rleBytesAvailable) {
            warn(
                `Display area ${width}x${height} declares more rows than the ${rleBytesAvailable} bytes of RLE could encode`,
            );
            continue;
        }

        decodedPixels += pixels;
        if (decodedPixels > maxTrackPixels) {
            warn('Track exceeds the total decoded-pixel budget; stopping');
            break;
        }

        // Every pixel defaults to value 0, which for a normal subtitle is the
        // fully transparent background — so a short or truncated field leaves
        // transparent gaps rather than garbage.
        const indices = new Uint8Array(width * height);
        if (display.topFieldOffset >= 0) {
            decodeField(
                packet.data,
                display.topFieldOffset,
                display.controlOffset,
                width,
                height,
                0,
                indices,
            );
        }
        if (display.bottomFieldOffset >= 0) {
            decodeField(
                packet.data,
                display.bottomFieldOffset,
                display.controlOffset,
                width,
                height,
                1,
                indices,
            );
        }

        // Expand the 4 selected colours into the 256-entry RGBA table the shared
        // renderer expects, so PGS and VobSub cues are interchangeable downstream.
        const rgbaPalette = new Uint8Array(256 * 4);
        for (let value = 0; value < 4; value++) {
            const globalIndex = display.colours[value] & 0x0f;
            const alpha = display.alphas[value] & 0x0f;
            rgbaPalette[value * 4] = palette16[globalIndex * 3];
            rgbaPalette[value * 4 + 1] = palette16[globalIndex * 3 + 1];
            rgbaPalette[value * 4 + 2] = palette16[globalIndex * 3 + 2];
            // 0–15 → 0–255; 15 must map to fully opaque.
            rgbaPalette[value * 4 + 3] = alpha * 17;
        }

        // Prefer the container's duration: it is what the player honours, and
        // `end_display_time` is routinely absent on these tracks. Fall back to
        // the SPU's own stop delay when the container states none.
        const durationMs =
            packet.durationMs > 0
                ? packet.durationMs
                : (display.stopDelayMs ?? 0) > 0
                  ? (display.stopDelayMs as number)
                  : 0;

        if (durationMs <= 0) {
            warn('Cue has no duration from container or control sequence');
            continue;
        }

        const rect: PgsRect = {
            x: display.x1,
            y: display.y1,
            width,
            height,
            indices,
            palette: rgbaPalette,
        };

        if (!declaredSize) {
            // No `size:` line — infer a canvas containing EVERY cue. Guarding on
            // `canvasWidth === 0` instead would latch the first cue's extent and
            // then never widen, so a short opening line would declare a canvas
            // that every later, wider cue overflows. Clients scale rects by
            // canvas→video, so that renders all subtitles oversized.
            canvasWidth = Math.max(canvasWidth, display.x2 + 1);
            canvasHeight = Math.max(canvasHeight, display.y2 + 1);
        }

        cues.push({
            startMs: packet.ptsMs,
            endMs: packet.ptsMs + durationMs,
            rects: [rect],
        });
    }

    // The manifest contract — and the client cursor that consumes it — require
    // ascending, non-overlapping cues. PGS gets that structurally from its
    // show/hide pairing. VobSub does NOT: each cue's end is its own start plus an
    // independent container duration, so a long duration can run past the next
    // cue's start, and nothing guarantees packets arrive in order.
    cues.sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < cues.length; i++) {
        if (cues[i - 1].endMs > cues[i].startMs) cues[i - 1].endMs = cues[i].startMs;
    }
    const trimmed = cues.filter((cue) => cue.endMs > cue.startMs);
    if (trimmed.length !== cues.length) {
        warn(`Dropped ${cues.length - trimmed.length} cue(s) left with no duration after trimming`);
    }

    logger.debug('Parsed VobSub track', {
        packets: packets.length,
        cues: trimmed.length,
        canvas: `${canvasWidth}x${canvasHeight}`,
        hasPalette: !!globalPalette,
        warnings: allWarnings.length,
    });

    return { canvasWidth, canvasHeight, cues: trimmed, warnings: allWarnings };
}
