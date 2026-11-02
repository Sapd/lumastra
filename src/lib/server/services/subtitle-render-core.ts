// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'crypto';
import sharp from 'sharp';
import { SubtitleRenderBudgetError } from './subtitle-render-protocol.js';
import { parsePgs, toRgba, type PgsCue } from '../utils/pgs-parser.js';
import { parseVobSub } from '../utils/vobsub-parser.js';
import { readMkvSubtitleTrack } from '../utils/mkv-subtitle-reader.js';
import type {
    RenderedRect,
    RenderedCue,
    RenderedSubtitleManifest,
} from './subtitle-render.service.js';

const BUNDLE_MAGIC = 'LSR1';
const MAX_CUES = 20_000;
// Bound geometry/manifest work as well as pixels (PGS allows many tiny rects).
const MAX_RENDER_REFERENCES = 80_000;
export const MAX_RENDER_PIXELS = 512 * 1024 * 1024;

interface BundleIndexEntry {
    offset: number;
    length: number;
}

export interface BundleManifest extends RenderedSubtitleManifest {
    /** image id → byte range within the image region. */
    index: Record<string, BundleIndexEntry>;
}

function packBundle(manifest: BundleManifest, images: Buffer[]): Buffer {
    const json = Buffer.from(JSON.stringify(manifest), 'utf-8');
    const header = Buffer.alloc(8);
    header.write(BUNDLE_MAGIC, 0, 'ascii');
    header.writeUInt32BE(json.length, 4);
    return Buffer.concat([header, json, ...images]);
}

export async function renderCues(
    cues: PgsCue[],
    canvas: { w: number; h: number },
    maxPixels = MAX_RENDER_PIXELS,
): Promise<{ manifest: BundleManifest; images: Buffer[] }> {
    const index: Record<string, BundleIndexEntry> = {};
    const images: Buffer[] = [];
    const byContent = new Map<string, string>();
    // Insertion order keeps the bundle deterministic even when encodes finish
    // out of order. At most four raw bitmaps are retained by pending encodes.
    const encoded = new Map<string, Buffer | null>();
    const pending = new Set<Promise<void>>();
    let encodeFailure: Error | null = null;
    const checkEncoding = (): void => {
        if (encodeFailure) throw encodeFailure;
    };
    const outCues: RenderedCue[] = [];

    let renderedPixels = 0;
    let uniqueBitmaps = 0;
    let references = 0;
    // Palette snapshots may have different identities despite equal contents.
    // Retain only a small palette key and image id, never RGBA buffers.
    const byBitmap = new WeakMap<Uint8Array, Map<string, string | null>>();

    for (const cue of cues) {
        const rects: RenderedRect[] = [];

        for (const rect of cue.rects) {
            const area = rect.width * rect.height;
            const budgetError = (
                limit: 'pixels' | 'references' | 'dimensions',
            ): SubtitleRenderBudgetError =>
                new SubtitleRenderBudgetError({
                    references,
                    uniqueBitmaps,
                    renderedPixels,
                    requestedPixels: Number.isSafeInteger(area) && area > 0 ? area : 0,
                    maxPixels,
                    maxReferences: MAX_RENDER_REFERENCES,
                    limit,
                });
            if (++references > MAX_RENDER_REFERENCES) throw budgetError('references');
            const paletteKey = `${rect.width}x${rect.height}:${Buffer.from(rect.palette).toString('base64')}`;
            let variants = byBitmap.get(rect.indices);
            if (!variants) {
                variants = new Map<string, string | null>();
                byBitmap.set(rect.indices, variants);
            }
            if (variants.has(paletteKey)) {
                const cachedId = variants.get(paletteKey);
                if (cachedId)
                    rects.push({
                        x: rect.x,
                        y: rect.y,
                        w: rect.width,
                        h: rect.height,
                        image: cachedId,
                    });
                continue;
            }
            // Reused bitmap/palette pairs never repeat conversion or hashing,
            // so only cache misses consume the pixel-work budget.
            if (!Number.isSafeInteger(area) || area <= 0) throw budgetError('dimensions');
            if (area > maxPixels - renderedPixels) throw budgetError('pixels');
            if (pending.size >= 4) await Promise.race(pending);
            checkEncoding();
            renderedPixels += area;
            uniqueBitmaps++;
            const pixels = toRgba(rect);

            // A fully transparent rect draws nothing; PGS emits these for spacing
            // and shipping them would cost bytes and a client composite for no
            // visible result.
            if (!hasVisiblePixels(pixels)) {
                variants.set(paletteKey, null);
                continue;
            }

            // Digest, NOT the pixels themselves. Keying on the raw RGBA would
            // retain every rect's uncompressed bitmap for the whole render —
            // roughly 1 MB per cue, so gigabytes on a feature-length track — and
            // OOM the process.
            //
            // The DIMENSIONS are hashed in alongside the pixels because two rects
            // can share a byte sequence at different shapes (a solid bar 8x4 vs
            // 4x8); sharing an id across them would hand the client a PNG whose
            // real dimensions contradict the manifest's w/h.
            //
            // Hex, and used directly as the public image id — see below.
            const contentKey = createHash('sha1')
                .update(`${rect.width}x${rect.height}:`)
                .update(pixels)
                .digest('hex');
            let id = byContent.get(contentKey);

            if (!id) {
                // Publish the id before starting the async encode, so a distinct
                // definition with equal pixels also shares an in-flight PNG.
                id = contentKey.slice(0, 16);
                byContent.set(contentKey, id);
                encoded.set(id, null);
                const imageId = id;
                const encode = sharp(pixels, {
                    raw: { width: rect.width, height: rect.height, channels: 4 },
                })
                    .png({ compressionLevel: 9, effort: 7 })
                    .toBuffer();
                const task = encode
                    .then(
                        (png) => {
                            encoded.set(imageId, png);
                        },
                        (error: unknown) => {
                            encodeFailure ??=
                                error instanceof Error ? error : new Error(String(error));
                        },
                    )
                    .finally(() => {
                        pending.delete(task);
                    });
                pending.add(task);
            }

            variants.set(paletteKey, id);
            rects.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height, image: id });
        }

        if (rects.length > 0) {
            outCues.push({ startMs: cue.startMs, endMs: cue.endMs, rects });
        }
    }

    await Promise.all(pending);
    checkEncoding();
    let offset = 0;
    for (const [id, png] of encoded) {
        if (!png) throw new Error('Subtitle PNG encoding did not complete');
        index[id] = { offset, length: png.length };
        images.push(png);
        offset += png.length;
    }
    return { manifest: { canvas, cues: outCues, index }, images };
}

function hasVisiblePixels(rgba: Buffer): boolean {
    for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] !== 0) return true;
    }
    return false;
}

/** Matroska/EBML magic — the container VobSub is extracted into. */
const EBML_MAGIC = 0x1a45dfa3;

/** PGS `.sup` files are a bare run of segments, each starting with 'PG'. */
function looksLikePgs(data: Buffer): boolean {
    return data.length >= 2 && data[0] === 0x50 && data[1] === 0x47;
}

/**
 * Decode whichever bitmap subtitle format the extractor produced.
 *
 * Dispatch is on the bytes rather than on the track's codec: the resolver
 * already chose the container from the codec, and sniffing means this cannot
 * disagree with it. Returns null for anything neither decoder recognises.
 */
function parseBitmapSubtitle(
    data: Buffer,
): { canvasWidth: number; canvasHeight: number; cues: PgsCue[]; warnings: string[] } | null {
    if (looksLikePgs(data)) return parsePgs(data);

    if (data.length >= 4 && data.readUInt32BE(0) === EBML_MAGIC) {
        // VobSub needs its container: the packet timing and the 16-entry palette
        // both live outside the SPU payloads. See `vobsub-parser`.
        const track = readMkvSubtitleTrack(data);
        const result = parseVobSub(track.packets, track.codecPrivate);
        return { ...result, warnings: [...track.warnings, ...result.warnings] };
    }

    return null;
}

export async function renderBitmapSubtitle(data: Buffer): Promise<Buffer | null> {
    const parsed = parseBitmapSubtitle(data);
    if (!parsed || parsed.cues.length === 0 || parsed.cues.length > MAX_CUES) return null;
    const { manifest, images } = await renderCues(parsed.cues, {
        w: parsed.canvasWidth,
        h: parsed.canvasHeight,
    });
    return manifest.cues.length ? packBundle(manifest, images) : null;
}
