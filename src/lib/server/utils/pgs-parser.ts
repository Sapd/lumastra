// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PGS (Presentation Graphic Stream) parser — Blu-ray bitmap subtitles.
 *
 * Parses the `.sup` byte stream produced by `ffmpeg -map 0:s:N -copyts -c:s copy`
 * into timed cues with RGBA bitmaps, so the server can render them to PNG and
 * clients need no subtitle decoder of their own. See `subtitle-render.service`.
 *
 * ## Wire format
 *
 * A `.sup` file is a flat sequence of segments, each:
 *
 * ```
 *   'P' 'G'      2 bytes   magic
 *   PTS          4 bytes   90 kHz presentation timestamp
 *   DTS          4 bytes   90 kHz decode timestamp (unused here)
 *   type         1 byte    see SEGMENT_* below
 *   size         2 bytes   payload length
 *   payload      size bytes
 * ```
 *
 * Segments group into *display sets*, conventionally PCS → WDS → PDS → ODS → END.
 * A display set whose PCS carries one or more composition objects turns subtitles
 * ON; a PCS with zero objects turns them OFF. The ON timestamp is the cue start
 * and the following OFF timestamp is its end — the format has no duration field.
 *
 * ## Timestamps
 *
 * PTS values are emitted unchanged, as milliseconds. What timeline they sit on is
 * decided upstream, in `ffmpeg-subtitle-extractor`:
 *
 *  - `-copyts` on the extraction keeps the container's own timestamps, rather
 *    than rebasing to zero (which would shift every cue by the first packet's
 *    PTS — routinely 60s+ into a feature film, after the logos).
 *  - `normalizeSupTimestamps` then subtracts the container's `start_time` when
 *    that exceeds 0.1s, so the cues line up with a transcode that begins at PTS 0.
 *
 * The result is the PLAYER's timeline — the same one `currentTime` runs on — not
 * strictly the source container's. For the common case of a container starting at
 * zero the two are identical; for a TS-sourced remux with a non-zero start they
 * are not, and it is the player timeline that is correct for an overlay.
 */

import { Logger } from './logger.js';

const logger = Logger.for('PgsParser');

const SEGMENT_PDS = 0x14; // Palette Definition
const SEGMENT_ODS = 0x15; // Object Definition (the bitmap)
const SEGMENT_PCS = 0x16; // Presentation Composition (positions + on/off)
const SEGMENT_WDS = 0x17; // Window Definition
const SEGMENT_END = 0x80; // End of display set

/**
 * Enough to diagnose a bad track. Unbounded, a corrupt stream pushes one string
 * per segment — a 50 MB extraction of 13-byte segments is ~3.8M of them. The
 * VobSub parser has carried this bound since review; PGS did not.
 */
const MAX_WARNINGS = 32;

/** Collects non-fatal problems, bounded by the caller. */
type WarnFn = (message: string) => void;

/** Fixed 13-byte segment header: magic(2) PTS(4) DTS(4) type(1) size(2). */
const SEGMENT_HEADER_BYTES = 13;

/** PGS timestamps are 90 kHz ticks. */
const PGS_TIMESCALE_HZ = 90_000;

/**
 * Absolute ceiling on a decoded object, used when the canvas is unknown or
 * itself implausible. 8K-wide covers any real subtitle bitmap by a wide margin.
 */
const MAX_OBJECT_DIMENSION = 8192;

/**
 * Caps on decoded bitmap area, per object and across the track.
 *
 * The dimension and expansion-ratio checks below bound each object against its
 * own RLE, but neither caps the TOTAL: a stream of well-formed objects can
 * accumulate without limit, and with no PCS canvas seen yet an 8192x8192 object
 * needs only ~16 KB of RLE to pass.
 *
 * The cumulative cap has two terms, and the ABSOLUTE ceiling is the real bound.
 *
 * The per-source-byte term exists only so a tiny crafted file cannot claim the
 * whole ceiling. It is deliberately far above any legitimate encoding: a real
 * anti-aliased PGS track measures ~2.4 px per source byte, but flat or sparse
 * authoring — long single-colour runs, which the 14-bit run form encodes in a few
 * bytes per row — reaches hundreds. An earlier value of 32 looked like a
 * comfortable 13x margin against the measured density and still truncated
 * flat-run content, which is the same mistake as the fixed cap it replaced:
 * calibrating against one sample and assuming the rest of the world resembles it.
 *
 * These were previously fixed at 4 Mpx / 128 Mpx, copied from the VobSub path to
 * "keep them in step". That was wrong: a DVD cue is ~37 kpx but a 1080p PGS cue
 * is ~57 kpx, so a 3-hour film decodes to ~137 Mpx and TRUNCATED silently — then
 * cached in that state for 90 days. Constants must be calibrated per format.
 */
const MAX_OBJECT_PIXELS = 16 * 1024 * 1024;
const MAX_TRACK_PIXELS_PER_SOURCE_BYTE = 512;
const MAX_TRACK_PIXELS = 512 * 1024 * 1024;

/**
 * Most pixels one RLE byte may legitimately describe. The two-byte long-run form
 * encodes at most 16383 pixels per 3-4 bytes, so ~4096 px/byte is already far
 * past any real bitmap; beyond it the declared size cannot be honest.
 */
const MAX_RLE_EXPANSION_RATIO = 4096;

/** ODS sequence flags: first fragment / last fragment of one object. */
const ODS_FIRST_FRAGMENT = 0x80;
const ODS_LAST_FRAGMENT = 0x40;

/**
 * A single bitmap placed at a position on the video canvas.
 *
 * Kept in its native PALETTED form — `indices` is one byte per pixel into
 * `palette`, which is 256 RGBA quads (1024 bytes). This is not an optimisation
 * detail the caller can ignore: PGS is a paletted format, and preserving that
 * lets the renderer emit a colour-type-3 PNG, which is ~4x smaller than the same
 * image flattened to RGBA and is exactly lossless. Call `toRgba` when raw pixels
 * are genuinely needed.
 */
export interface PgsRect {
    x: number;
    y: number;
    width: number;
    height: number;
    indices: Uint8Array;
    palette: Uint8Array;
}

/** Expand a paletted rect to tightly packed RGBA (`width * height * 4` bytes). */
export function toRgba(rect: PgsRect): Buffer {
    const out = Buffer.allocUnsafe(rect.width * rect.height * 4);
    for (let i = 0; i < rect.indices.length; i++) {
        const entry = rect.indices[i] * 4;
        const at = i * 4;
        out[at] = rect.palette[entry];
        out[at + 1] = rect.palette[entry + 1];
        out[at + 2] = rect.palette[entry + 2];
        out[at + 3] = rect.palette[entry + 3];
    }
    return out;
}

/** One subtitle event: everything on screen between `startMs` and `endMs`. */
export interface PgsCue {
    /** Absolute source-media milliseconds. */
    startMs: number;
    endMs: number;
    rects: PgsRect[];
}

export interface PgsParseResult {
    /** Video canvas the coordinates are relative to, from the PCS. */
    canvasWidth: number;
    canvasHeight: number;
    cues: PgsCue[];
    /** Non-fatal problems; a healthy track reports none. */
    warnings: string[];
}

interface RawSegment {
    ptsMs: number;
    type: number;
    payload: Buffer;
}

/**
 * Split the byte stream into segments.
 *
 * Stops at the first structurally invalid segment rather than throwing: a
 * truncated tail (an extraction killed by the 120s timeout, a partially written
 * cache file) should still yield every cue that did parse.
 */
function* iterateSegments(data: Buffer, warn: WarnFn): Generator<RawSegment> {
    let offset = 0;

    while (offset + SEGMENT_HEADER_BYTES <= data.length) {
        if (data[offset] !== 0x50 || data[offset + 1] !== 0x47) {
            warn(`Lost segment sync at byte ${offset}; stopped parsing`);
            return;
        }

        const pts = data.readUInt32BE(offset + 2);
        const type = data[offset + 10];
        const size = data.readUInt16BE(offset + 11);
        const payloadStart = offset + SEGMENT_HEADER_BYTES;

        if (payloadStart + size > data.length) {
            warn(`Truncated ${type.toString(16)} segment at byte ${offset}`);
            return;
        }

        yield {
            // Round to the nearest ms; PGS ticks are 1/90 ms so this is lossless
            // to within half a millisecond, far below subtitle timing precision.
            ptsMs: Math.round((pts / PGS_TIMESCALE_HZ) * 1000),
            type,
            payload: data.subarray(payloadStart, payloadStart + size),
        };

        offset = payloadStart + size;
    }
}

/** One 256-entry palette: index → [r, g, b, a], so 1024 bytes. */
type Palette = Uint8Array;

/** Placeholder for an object whose colours are bound later, at composition. */
const EMPTY_PALETTE = new Uint8Array(0);

/**
 * Decode a Palette Definition Segment into RGBA.
 *
 * PGS stores Y/Cr/Cb + alpha. Entries are sparse and may be updated between
 * display sets, so the caller keeps a persistent palette and applies each PDS
 * on top rather than replacing wholesale.
 *
 * Colour conversion is BT.709 limited-range (16–235 luma), which is what the
 * Blu-ray spec mandates for HD PGS and what libavcodec's decoder produces —
 * verified against `ff_pgssub_decoder` output on a real disc: identical peak luma.
 */
function applyPaletteSegment(payload: Buffer, palette: Palette, warn: WarnFn): void {
    if (payload.length < 2) {
        warn('Palette segment too short');
        return;
    }

    // payload[0] = palette id, payload[1] = version; entries follow as 5-byte tuples.
    for (let i = 2; i + 5 <= payload.length; i += 5) {
        const index = payload[i];
        const y = payload[i + 1];
        const cr = payload[i + 2];
        const cb = payload[i + 3];
        const alpha = payload[i + 4];

        const luma = (y - 16) * 1.164383;
        const cbCentered = cb - 128;
        const crCentered = cr - 128;

        palette[index * 4] = clampByte(luma + 1.792741 * crCentered);
        palette[index * 4 + 1] = clampByte(luma - 0.213249 * cbCentered - 0.532909 * crCentered);
        palette[index * 4 + 2] = clampByte(luma + 2.112402 * cbCentered);
        palette[index * 4 + 3] = alpha;
    }
}

function clampByte(value: number): number {
    if (value <= 0) return 0;
    if (value >= 255) return 255;
    return Math.round(value);
}

/**
 * Decode PGS run-length encoding into palette indices.
 *
 * The encoding is byte-oriented; a zero byte introduces a run whose two top bits
 * select the form:
 *
 * ```
 *   00 00                     → end of line
 *   00 0L LLLLLL              → L pixels of colour 0
 *   00 01 LLLLLL LLLLLLLL     → L pixels of colour 0   (14-bit length)
 *   00 10 LLLLLL CCCCCCCC     → L pixels of colour C
 *   00 11 LLLLLL LLLLLLLL CC  → L pixels of colour C   (14-bit length)
 * ```
 *
 * Any other byte is one pixel of that palette index. Runs are clipped at the row
 * edge and rows past `height` are dropped, so a corrupt length can waste work but
 * cannot write out of bounds or hang.
 */
function decodeRle(data: Buffer, width: number, height: number): Uint8Array {
    const indices = new Uint8Array(width * height);
    let read = 0;
    let x = 0;
    let y = 0;

    while (read < data.length && y < height) {
        const byte = data[read++];

        if (byte !== 0) {
            if (x < width) indices[y * width + x] = byte;
            x++;
            continue;
        }

        if (read >= data.length) break;
        const control = data[read++];

        if (control === 0) {
            y++;
            x = 0;
            continue;
        }

        const form = control >> 6;
        let runLength: number;
        let colour = 0;

        if (form === 0) {
            runLength = control & 0x3f;
        } else if (form === 1) {
            if (read >= data.length) break;
            runLength = ((control & 0x3f) << 8) | data[read++];
        } else if (form === 2) {
            if (read >= data.length) break;
            runLength = control & 0x3f;
            colour = data[read++];
        } else {
            if (read + 1 >= data.length) break;
            runLength = ((control & 0x3f) << 8) | data[read++];
            colour = data[read++];
        }

        const rowBase = y * width;
        const runEnd = Math.min(x + runLength, width);
        for (let px = x; px < runEnd; px++) indices[rowBase + px] = colour;
        x += runLength;
    }

    return indices;
}

/** An object being assembled; PGS allows one bitmap to span several ODS segments. */
interface PendingObject {
    width: number;
    height: number;
    fragments: Buffer[];
}

/** A composition entry from the PCS: which object goes where. */
interface CompositionObject {
    objectId: number;
    x: number;
    y: number;
}

function parseCompositionObjects(payload: Buffer, warn: WarnFn): CompositionObject[] {
    const objects: CompositionObject[] = [];
    const count = payload[10];
    let offset = 11;

    for (let i = 0; i < count; i++) {
        // objectId(2) windowId(1) flags(1) x(2) y(2) [crop x,y,w,h — 8 more]
        if (offset + 8 > payload.length) {
            warn('Composition object list truncated');
            break;
        }

        const cropped = (payload[offset + 3] & 0x80) !== 0;
        if (cropped) {
            // The crop rectangle is read past but never applied, so the full
            // object draws at (x, y) rather than the authored sub-rectangle.
            // Rare (scrolling credits and similar); warn so it is diagnosable
            // instead of looking like a positioning bug.
            warn(`Composition object ${payload.readUInt16BE(offset)} is cropped; crop ignored`);
        }
        objects.push({
            objectId: payload.readUInt16BE(offset),
            x: payload.readUInt16BE(offset + 4),
            y: payload.readUInt16BE(offset + 6),
        });

        offset += cropped ? 16 : 8;
    }

    return objects;
}

/**
 * Parse a `.sup` byte stream into timed RGBA cues.
 *
 * Never throws on malformed input — problems are collected into `warnings` and
 * whatever parsed cleanly is returned, so one bad display set in a two-hour track
 * costs that cue rather than the whole subtitle.
 */
export function parsePgs(data: Buffer): PgsParseResult {
    const allWarnings: string[] = [];
    const warn: WarnFn = (message) => {
        if (allWarnings.length < MAX_WARNINGS) allWarnings.push(message);
    };
    const cues: PgsCue[] = [];

    // Palette and object stores persist across display sets: an "acquisition
    // point" set may reference a palette or object defined earlier in the epoch.
    const budget = {
        decodedPixels: 0,
        maxPixels: Math.min(data.length * MAX_TRACK_PIXELS_PER_SOURCE_BYTE, MAX_TRACK_PIXELS),
    };
    const palette: Palette = new Uint8Array(256 * 4);
    const objects = new Map<number, PgsRect>();
    const pending = new Map<number, PendingObject>();

    let canvasWidth = 0;
    let canvasHeight = 0;
    let openCue: {
        startMs: number;
        composition: CompositionObject[];
        /** Bound at END of the opening display set; see SEGMENT_END below. */
        palette: Palette | null;
    } | null = null;

    for (const segment of iterateSegments(data, warn)) {
        switch (segment.type) {
            case SEGMENT_PDS:
                applyPaletteSegment(segment.payload, palette, warn);
                break;

            case SEGMENT_ODS:
                parseObjectSegment(
                    segment.payload,
                    pending,
                    objects,
                    canvasWidth,
                    canvasHeight,
                    budget,
                    warn,
                );
                break;

            case SEGMENT_PCS: {
                if (segment.payload.length < 11) {
                    warn('Presentation segment too short');
                    break;
                }

                if (canvasWidth === 0) {
                    // Latch from the first PCS that declares a real canvas. A
                    // zero here would reach the client as canvas {w:0,h:0}, and
                    // any overlay scaling by displayedWidth / canvas.w divides by
                    // zero and loses every subtitle.
                    const declaredWidth = segment.payload.readUInt16BE(0);
                    const declaredHeight = segment.payload.readUInt16BE(2);
                    if (declaredWidth > 0 && declaredHeight > 0) {
                        canvasWidth = declaredWidth;
                        canvasHeight = declaredHeight;
                    }
                }

                const composition = parseCompositionObjects(segment.payload, warn);

                if (composition.length > 0) {
                    // A new ON without an intervening OFF (rare, but legal for a
                    // mid-cue update): close the previous cue here so cues never
                    // overlap, which would make a client show two at once.
                    if (openCue) {
                        finishCue(openCue, segment.ptsMs, objects, cues, palette);
                    }
                    // Palette is bound at END, not here: within a display set the
                    // PCS arrives BEFORE its PDS, so snapshotting now would capture
                    // the previous set's colours (or, on the first cue, none at all).
                    openCue = { startMs: segment.ptsMs, composition, palette: null };
                } else if (openCue) {
                    finishCue(openCue, segment.ptsMs, objects, cues, palette);
                    openCue = null;
                }
                break;
            }

            case SEGMENT_END:
                // Display set complete: its PDS and ODS have been applied, so the
                // running palette now holds this cue's colours. Snapshot before a
                // later set mutates it in place.
                if (openCue && !openCue.palette) openCue.palette = palette.slice();
                break;

            case SEGMENT_WDS:
                break;

            default:
                warn(`Unknown segment type 0x${segment.type.toString(16)}`);
        }
    }

    if (openCue) {
        // Track ends while subtitles are still up — no closing PCS. Drop it
        // rather than inventing a duration; a dangling cue would otherwise
        // display until the end of the film.
        warn('Track ended with an unclosed cue; dropped');
    }

    // The manifest promises ascending, non-overlapping cues and clients binary-
    // search them. PGS gets non-overlap structurally from its show/hide pairing,
    // but ascending order rests on monotonic PTS, which a corrupt or wrapping
    // stream does not provide. A no-op on healthy tracks.
    cues.sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < cues.length; i++) {
        if (cues[i - 1].endMs > cues[i].startMs) cues[i - 1].endMs = cues[i].startMs;
    }
    const ordered = cues.filter((cue) => cue.endMs > cue.startMs);

    logger.debug('Parsed PGS stream', {
        bytes: data.length,
        cues: ordered.length,
        canvas: `${canvasWidth}x${canvasHeight}`,
        warnings: allWarnings.length,
    });

    return { canvasWidth, canvasHeight, cues: ordered, warnings: allWarnings };
}

/**
 * Assemble an ODS fragment; on the last fragment, decode it to RGBA and store it
 * under its object id for later composition.
 */
function parseObjectSegment(
    payload: Buffer,
    pending: Map<number, PendingObject>,
    objects: Map<number, PgsRect>,
    canvasWidth: number,
    canvasHeight: number,
    budget: { decodedPixels: number; maxPixels: number },
    warn: WarnFn,
): void {
    if (payload.length < 4) {
        warn('Object segment too short');
        return;
    }

    const objectId = payload.readUInt16BE(0);
    const sequenceFlags = payload[3];
    const isFirst = (sequenceFlags & ODS_FIRST_FRAGMENT) !== 0;
    const isLast = (sequenceFlags & ODS_LAST_FRAGMENT) !== 0;

    if (isFirst) {
        // First fragment carries dataLength(3) width(2) height(2) before the RLE.
        if (payload.length < 11) {
            warn('First object fragment too short for its header');
            return;
        }
        pending.set(objectId, {
            width: payload.readUInt16BE(7),
            height: payload.readUInt16BE(9),
            fragments: [payload.subarray(11)],
        });
    } else {
        const existing = pending.get(objectId);
        if (!existing) {
            warn(`Continuation fragment for unknown object ${objectId}`);
            return;
        }
        existing.fragments.push(payload.subarray(4));
    }

    if (!isLast) return;

    const assembled = pending.get(objectId);
    pending.delete(objectId);
    if (!assembled) return;

    const { width, height } = assembled;
    const rle = Buffer.concat(assembled.fragments);

    // `width`/`height` come straight off the wire and drive a `width * height`
    // allocation, so they are the one place this parser can be made to allocate
    // arbitrarily from a handful of input bytes. A declared 8192x8192 costs 67 MB
    // from a 24-byte segment, and object ids are 16-bit, so a small crafted or
    // bit-rotted file could pin gigabytes. Bound them three ways:
    //
    //  - against the PCS canvas, which a PGS object cannot legally exceed;
    //  - against an absolute ceiling, for a stream whose canvas is bogus too;
    //  - against the RLE actually received. The encoding emits at minimum one
    //    control pair per row plus a terminator, so a real bitmap can only
    //    compress so far; a declared area wildly beyond what the payload could
    //    describe is a corrupt header, not a very efficient image.
    const canvasLimitW = canvasWidth > 0 ? canvasWidth : MAX_OBJECT_DIMENSION;
    const canvasLimitH = canvasHeight > 0 ? canvasHeight : MAX_OBJECT_DIMENSION;

    if (
        width <= 0 ||
        height <= 0 ||
        width > Math.min(canvasLimitW, MAX_OBJECT_DIMENSION) ||
        height > Math.min(canvasLimitH, MAX_OBJECT_DIMENSION)
    ) {
        warn(`Object ${objectId} has implausible size ${width}x${height}`);
        return;
    }

    if (width * height > rle.length * MAX_RLE_EXPANSION_RATIO) {
        warn(
            `Object ${objectId} declares ${width}x${height} but carries only ${rle.length} RLE bytes`,
        );
        return;
    }

    if (width * height > MAX_OBJECT_PIXELS) {
        warn(`Object ${objectId} area ${width}x${height} exceeds the per-object budget`);
        return;
    }

    if (budget.decodedPixels + width * height > budget.maxPixels) {
        warn('Track exceeds the total decoded-pixel budget; object dropped');
        return;
    }
    budget.decodedPixels += width * height;

    const indices = decodeRle(rle, width, height);

    // Palette deliberately NOT bound here. A display set may update the palette
    // after defining its object (and an acquisition point may reuse an object
    // defined under an earlier palette), so the colours are resolved when the cue
    // is composed, not when the bitmap is decoded.
    objects.set(objectId, {
        x: 0,
        y: 0,
        width,
        height,
        indices,
        palette: EMPTY_PALETTE,
    });
}

/** Resolve an open cue's composition against the object store and record it. */
function finishCue(
    open: { startMs: number; composition: CompositionObject[]; palette: Palette | null },
    endMs: number,
    objects: Map<number, PgsRect>,
    cues: PgsCue[],
    /** Fallback for a stream whose display sets omit the END segment. */
    livePalette: Palette,
): void {
    // A zero- or negative-length cue can't be displayed; skip rather than emit
    // something a player would either flash or reject.
    if (endMs <= open.startMs) return;

    const rects: PgsRect[] = [];
    for (const entry of open.composition) {
        const object = objects.get(entry.objectId);
        if (!object) continue;
        rects.push({
            x: entry.x,
            y: entry.y,
            width: object.width,
            height: object.height,
            indices: object.indices,
            palette: open.palette ?? livePalette.slice(),
        });
    }

    if (rects.length === 0) return;

    cues.push({ startMs: open.startMs, endMs, rects });
}
