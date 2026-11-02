// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Impure overlay materializers for the Top Shelf render pipeline. Render-time
 * only — never called on the mint hot path. Produces the small transparent
 * PNGs (logo / text) and the shared gradient scrim that ffmpeg overlays.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getImageProxyService } from '$lib/server/services/image-proxy/index.js';
import type { OverlayBox, OverlayPosition } from './topshelf-overlay.js';

const logger = Logger.for('TopShelfOverlayRender');

/**
 * Text PNG geometry. The canvas WIDTH is FIXED (ffmpeg scales the whole PNG to
 * a known absolute width — see `buildTopShelfFfmpegArgs`), so `TEXT_TARGET_W`
 * is the width the ink is allowed to occupy, with `TEXT_PAD` breathing room on
 * BOTH sides so the stroke around the first/last glyph can never be cut by the
 * canvas edge (the old `x="0"` clipped the left stroke).
 *
 * The font size is now SHRINK-TO-FIT rather than fixed: `renderTextPng` binary
 * -searches for the largest size in `[TEXT_FONT_MIN_PX, TEXT_FONT_MAX_PX]` at
 * which the full label's measured ink width fits `TEXT_TARGET_W`, so a short
 * label renders big and a long one shrinks — instead of every label rendering
 * at one size and long ones getting cut. `TEXT_FONT_MIN_PX` is the floor below
 * which text stops being legible from couch distance on a TV; only text that
 * STILL overflows at the floor falls back to ellipsis truncation.
 *
 * Canvas HEIGHT and the text baseline scale with the CHOSEN font size (not a
 * constant) — see `textCanvasGeometry` — so vertical layout stays correct
 * (no clipping, no floating) at every size in the range.
 */
const TEXT_TARGET_W = 1200;
const TEXT_PAD = 12;
const TEXT_FONT_MAX_PX = 96;
const TEXT_FONT_MIN_PX = 48;
const TEXT_CANVAS_W = TEXT_TARGET_W + TEXT_PAD * 2;
const TEXT_STROKE_PX = 4;
/** Max number of measurement rasterizations `renderTextPng` may perform per render (bounded cost). */
const TEXT_FIT_MAX_MEASUREMENTS = 10;

/**
 * Canvas height / baseline Y for a given chosen font size — the same ratios
 * the old fixed-size constants used (`1.45`/`1.08`), just applied to whatever
 * size was actually picked instead of a hardcoded 84px.
 */
function textCanvasGeometry(fontPx: number): { canvasH: number; baselineY: number } {
    return { canvasH: Math.round(fontPx * 1.45), baselineY: Math.round(fontPx * 1.08) };
}

/**
 * Fallback average glyph advance (fraction of font size) used ONLY when text
 * measurement fails. DejaVu Sans Bold — the font the container actually
 * resolves `sans-serif` to — averages ~0.60–0.62 here; the old 0.55 under-
 * estimated it, which is exactly why long labels overflowed the canvas and got
 * cut with no ellipsis.
 */
const AVG_ADVANCE = 0.62;

/**
 * Badge (`S01E02`) chip baked under an episode's inherited series logo.
 *
 * Every dimension is a FRACTION OF THE OVERLAY BOX rather than a fixed px
 * size. The old fixed 52px font lived on a canvas whose width was
 * `max(logoWidth, chipWidth)` and which ffmpeg then scaled by
 * `contentWidth / canvasWidth` — so the chip's on-screen size was a function
 * of the LOGO's aspect ratio: a stacked logo produced a ~360px-wide canvas,
 * a 1.42x upscale, and a badge 91px tall on a 720p frame. Deriving the chip
 * from the box means it is the same small size for every logo shape.
 */
const BADGE_HEIGHT_FRACTION = 0.22;
/**
 * Hard rasterization floor, NOT a design driver. `BADGE_HEIGHT_FRACTION` of the
 * box is already resolution-proportional (~5% of the frame height at any
 * `TOPSHELF_RENDER_MAX_WIDTH`), so this only catches a degenerately small box —
 * set it higher and it silently becomes the rule at a small base width, where
 * it would make the chip a much larger share of the box.
 */
const BADGE_MIN_HEIGHT_PX = 18;
/** The chip may never eat more than this share of the box's height. */
const BADGE_MAX_HEIGHT_FRACTION = 0.4;
/** Gap between the logo's bottom edge and the badge chip, as a fraction of the box height. */
const BADGE_GAP_FRACTION = 0.06;
/** Cap height / font size for the digits-and-caps badge label (no descenders). */
const BADGE_CAP_RATIO = 0.76;
/** Vertical padding inside the chip, as a fraction of the chip height. */
const BADGE_PAD_Y_RATIO = 0.18;
/** Horizontal padding inside the chip, as a fraction of the font size. */
const BADGE_PAD_X_RATIO = 0.38;
/** Corner radius, as a fraction of the chip height. */
const BADGE_RADIUS_RATIO = 0.16;
const BADGE_STROKE_PX = 2;
const BADGE_MIN_FONT_PX = 10;

/** Shared gradient scrim filename, kept at the store root (see ensureScrimAsset). */
const SCRIM_FILENAME = 'scrim-gradient.png';
/** Scrim gradient height in px; rendered narrow (4px wide) and stretched by ffmpeg. */
const SCRIM_HEIGHT = 256;
const SCRIM_WIDTH = 4;
/** Max alpha at the dark end of the gradient (~0.78 opacity). */
const SCRIM_MAX_ALPHA = 200;

/**
 * XML-escape a string for safe embedding inside an SVG `<text>` node.
 *
 * Re-exported from the shared implementation so this module's public surface is
 * unchanged (topshelf-render.service.ts and the tests import it from here).
 * The logic itself lives in utils/xml-escape.ts because the OpenSubsonic
 * serializer needs exactly the same handling, and keeping two copies is how the
 * control-character stripping ended up in one and not the other.
 */
import { escapeXml } from '$lib/server/utils/xml-escape.js';

export { escapeXml };

/** The `<text>` element shared by measurement and final render — identical markup
 * on both passes, so what we measure is exactly what we draw (stroke included). */
function textElement(
    safe: string,
    opts: { x: number; y: number; fontPx: number; strokePx: number; extraAttrs?: string },
): string {
    return `<text x="${opts.x}" y="${opts.y}" font-size="${opts.fontPx}" fill="#ffffff"
        stroke="#000000" stroke-width="${opts.strokePx}" paint-order="stroke"${opts.extraAttrs ?? ''}>${safe}</text>`;
}

/**
 * Measure the real rendered INK width of `text` in px, by rasterizing it on an
 * oversized transparent canvas and trimming the transparent margin away.
 *
 * This is the whole point of the clipping fix: character-budget heuristics
 * (the old `AVG_ADVANCE = 0.55`) are wrong by 10–25% for the font that is
 * actually installed, and wrong by ~40% for CJK — so a "fits" verdict was
 * routinely a silent overflow. Measuring is font- and script-agnostic.
 * Returns `null` when measurement is not possible (blank text, sharp failure),
 * so the caller can fall back to the estimator.
 */
async function measureTextInkWidth(
    text: string,
    fontPx: number,
    strokePx: number,
): Promise<number | null> {
    if (text.trim().length === 0) return null;
    // Generous canvas: 1.4em per char covers full-width CJK (1.0em) with room
    // for the stroke, so measurement itself can never be the thing that clips.
    const canvasW = Math.ceil(text.length * fontPx * 1.4) + fontPx * 2;
    const canvasH = Math.ceil(fontPx * 2.2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
  <style>text { font-family: sans-serif; font-weight: 700; }</style>
  ${textElement(escapeXml(text), { x: fontPx, y: Math.round(fontPx * 1.4), fontPx, strokePx })}
</svg>`;
    try {
        const { info } = await sharp(Buffer.from(svg))
            .trim({ threshold: 1 })
            .toBuffer({ resolveWithObject: true });
        return info.width;
    } catch (err: unknown) {
        logger.warn('Top Shelf overlay text measurement failed; falling back to estimate', {
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/** Coarse fallback width estimate — only used when measurement is unavailable. */
function estimateTextWidth(text: string, fontPx: number): number {
    return text.length * fontPx * AVG_ADVANCE;
}

/**
 * Truncate `text` (appending `…`) until its measured width fits `targetW`.
 *
 * `measure` returns the real ink width; the loop converges by scaling the
 * character count by the measured overshoot ratio, then falls back to
 * one-character steps. Both loops are hard-bounded so a pathological font can
 * never spin here. Exported for unit testing with an injected measurer.
 */
export async function fitTextToWidth(
    text: string,
    targetW: number,
    measure: (candidate: string) => Promise<number>,
): Promise<{ text: string; width: number; truncated: boolean }> {
    const full = await measure(text);
    if (full <= targetW) return { text, width: full, truncated: false };

    let chars = text.length;
    let candidate = text;
    let width = full;
    // Proportional back-off: each pass aims at `targetW` using the measured
    // overshoot, and always drops at least one character so it terminates.
    for (let i = 0; i < 6 && width > targetW && chars > 1; i++) {
        const scaled = Math.floor(chars * (targetW / width)) - 1;
        chars = Math.max(1, Math.min(chars - 1, scaled));
        candidate = `${text.slice(0, chars).trimEnd()}…`;
        width = await measure(candidate);
    }
    // Linear finish for the last few px (bounded).
    for (let i = 0; i < 12 && width > targetW && chars > 1; i++) {
        chars -= 1;
        candidate = `${text.slice(0, chars).trimEnd()}…`;
        width = await measure(candidate);
    }
    return { text: candidate, width, truncated: true };
}

export interface FontSizeFit {
    /** Largest size in `[minPx, maxPx]` (integer px) at which `text` measured within `targetW`. */
    fontPx: number;
    /** The measured width of the FULL (untruncated) text at `fontPx`. */
    width: number;
    /** False only when even `minPx` overflows `targetW` — caller must then ellipsize. */
    fits: boolean;
}

/**
 * Binary-search the largest integer font size in `[minPx, maxPx]` at which the
 * FULL (untruncated) text's measured ink width fits `targetW` — the
 * shrink-to-fit counterpart to `fitTextToWidth`'s ellipsis fallback.
 *
 * Bounded to `TEXT_FIT_MAX_MEASUREMENTS` rasterizations: one probe at `maxPx`
 * (the common case — most labels fit at the max size and this returns after a
 * single measurement), one at `minPx` only when `maxPx` overflows, then a
 * binary search over the remaining range. `log2(maxPx-minPx)` is ~6 for the
 * real 48–96 range, so real calls stay well under the cap; it exists purely so
 * a pathological range can never spin. Exported for unit testing with an
 * injected measurer.
 */
export async function findFittingFontSize(
    targetW: number,
    minPx: number,
    maxPx: number,
    measure: (fontPx: number) => Promise<number>,
): Promise<FontSizeFit> {
    let measurements = 0;
    const bounded = async (fontPx: number): Promise<number> => {
        measurements += 1;
        if (measurements > TEXT_FIT_MAX_MEASUREMENTS) return Number.POSITIVE_INFINITY;
        return measure(fontPx);
    };

    const atMax = await bounded(maxPx);
    if (atMax <= targetW) return { fontPx: maxPx, width: atMax, fits: true };

    const atMin = await bounded(minPx);
    if (atMin > targetW) return { fontPx: minPx, width: atMin, fits: false };

    // Largest fontPx in (minPx, maxPx) that still fits — invariant: lo always
    // fits, hi+1 never does, so `lo` converges to that boundary.
    let lo = minPx;
    let loWidth = atMin;
    let hi = maxPx;
    while (lo < hi - 1) {
        const mid = Math.floor((lo + hi) / 2);
        const w = await bounded(mid);
        if (w <= targetW) {
            lo = mid;
            loWidth = w;
        } else {
            hi = mid;
        }
    }
    return { fontPx: lo, width: loWidth, fits: true };
}

/**
 * Transparent `boxW x boxH` canvas with `layers` composited into it.
 *
 * THE structural guarantee behind both overlay geometry bugs: the canvas is
 * EXACTLY the box, every layer is placed at a non-negative offset, and every
 * layer was resized `fit: 'inside'` its sub-area first — so nothing can be
 * positioned outside the box, and ffmpeg receives a PNG it never has to
 * rescale. Callers must not pass a layer larger than the box; the clamp below
 * is a belt-and-suspenders guard, since `sharp` REJECTS an oversized composite
 * input outright (which would fail the whole render).
 */
/**
 * Where inside the box the content block hugs, for a given corner: content in a
 * RIGHT-anchored box must hug the box's right edge, otherwise a logo narrower
 * than the box floats away from the frame corner by however much its aspect
 * ratio happens to leave over. Purely an offset choice — every result is still
 * inside the box, which is what the geometry guarantee rests on.
 */
function boxAnchor(pos: OverlayPosition): { right: boolean; bottom: boolean } {
    return { right: pos === 'tr' || pos === 'br', bottom: pos === 'bl' || pos === 'br' };
}

async function writeBoxedCanvas(
    box: OverlayBox,
    layers: OverlayOptions[],
    outPath: string,
): Promise<void> {
    const clamped = layers.map((layer) => ({
        ...layer,
        left: Math.max(0, layer.left ?? 0),
        top: Math.max(0, layer.top ?? 0),
    }));
    await sharp({
        create: {
            width: box.boxW,
            height: box.boxH,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite(clamped)
        .png()
        .toFile(outPath);
}

/**
 * Render `text` to a transparent PNG at `outPath`, SHRINKING THE FONT SIZE to
 * fit rather than truncating: `findFittingFontSize` binary-searches the
 * largest size in `[TEXT_FONT_MIN_PX, TEXT_FONT_MAX_PX]` at which the full
 * label's measured ink width fits `TEXT_TARGET_W`. A short label renders at
 * `TEXT_FONT_MAX_PX`; a long one shrinks proportionally. Only a label that
 * STILL overflows at `TEXT_FONT_MIN_PX` falls back to ellipsis truncation
 * (rendered AT the floor size, via the same `fitTextToWidth` used before this
 * change) — ellipsis is now the rare last resort, not the common path.
 *
 * Canvas height and baseline scale with the CHOSEN size (`textCanvasGeometry`)
 * so vertical layout never clips or floats regardless of which size wins.
 *
 * A truncated label is additionally pinned to the target width with
 * `textLength`/`lengthAdjust` so a measurement drift of a few px still cannot
 * bleed past the canvas. Non-truncated labels are never stretched (no
 * `textLength`). Escaping happens LAST — escaping an already-truncated string
 * can never reintroduce an entity that busts the fit.
 *
 * The high-resolution ink raster is then fitted (`fit: 'inside'`, preserving
 * aspect) into `box` and written on a canvas of EXACTLY `box.boxW x box.boxH`,
 * anchored top-left — the same fixed box the logo path uses, so ffmpeg overlays
 * a final PNG and never rescales it. The effective on-screen text size is
 * unchanged: ffmpeg used to apply exactly this `boxW / TEXT_CANVAS_W` factor
 * itself.
 */
export async function renderTextPng(
    text: string,
    outPath: string,
    box: OverlayBox,
    pos: OverlayPosition = 'tl',
): Promise<void> {
    const measureAt = async (fontPx: number, candidate: string): Promise<number> =>
        (await measureTextInkWidth(candidate, fontPx, TEXT_STROKE_PX)) ??
        estimateTextWidth(candidate, fontPx);

    const fit = await findFittingFontSize(
        TEXT_TARGET_W,
        TEXT_FONT_MIN_PX,
        TEXT_FONT_MAX_PX,
        (fontPx) => measureAt(fontPx, text),
    );

    let renderText = text;
    let truncated = false;
    if (!fit.fits) {
        // Even the floor size overflows — ellipsize at the floor.
        const fitted = await fitTextToWidth(text, TEXT_TARGET_W, (candidate) =>
            measureAt(fit.fontPx, candidate),
        );
        renderText = fitted.text;
        truncated = fitted.truncated;
    }

    const safe = escapeXml(renderText);
    const { canvasH, baselineY } = textCanvasGeometry(fit.fontPx);
    // `textLength` is applied ONLY to a truncated label: it force-fits the
    // glyphs into exactly the target box (slight condensing at worst), which
    // is what guarantees "never clips" even if the measurement is a hair off.
    const element = textElement(safe, {
        x: TEXT_PAD,
        y: baselineY,
        fontPx: fit.fontPx,
        strokePx: TEXT_STROKE_PX,
        extraAttrs: truncated
            ? ` textLength="${TEXT_TARGET_W}" lengthAdjust="spacingAndGlyphs"`
            : undefined,
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TEXT_CANVAS_W}" height="${canvasH}">
  <style>text { font-family: sans-serif; font-weight: 700; }</style>
  ${element}
</svg>`;
    const { data: ink, info } = await sharp(Buffer.from(svg))
        .resize({ width: box.boxW, height: box.boxH, fit: 'inside' })
        .png()
        .toBuffer({ resolveWithObject: true });
    const anchor = boxAnchor(pos);
    await writeBoxedCanvas(
        box,
        [
            {
                input: ink,
                left: anchor.right ? box.boxW - info.width : 0,
                top: anchor.bottom ? box.boxH - info.height : 0,
            },
        ],
        outPath,
    );
}

/**
 * Chip height for a given box: a small fraction of the box, with a legibility
 * floor and a hard ceiling so the badge can never crowd out the logo.
 * Exported for the unit tests that pin the "badge stays small" contract.
 */
export function badgeChipHeight(boxH: number): number {
    const ceiling = Math.max(1, Math.round(boxH * BADGE_MAX_HEIGHT_FRACTION));
    return Math.min(
        ceiling,
        Math.max(BADGE_MIN_HEIGHT_PX, Math.round(BADGE_HEIGHT_FRACTION * boxH)),
    );
}

/** Gap between the logo's bottom edge and the badge chip, for a given box. */
function badgeGap(boxH: number): number {
    return Math.max(2, Math.round(BADGE_GAP_FRACTION * boxH));
}

/**
 * Render the small `S01E02` chip: white bold text on a rounded, semi-opaque
 * black plate, at an EXACT `heightPx` and never wider than `maxWidthPx`.
 *
 * Both bounds come from the overlay box, so the chip reads as a small badge
 * regardless of the logo it sits under (it used to inherit the logo composite's
 * scale factor and could end up ~2.4x its intended size). The label is
 * shrink-to-fit on width — one proportional re-measure, then `textLength` pins
 * the glyphs inside the plate so a few px of measurement drift still cannot
 * bleed past it.
 */
async function renderBadgeBuffer(
    badge: string,
    heightPx: number,
    maxWidthPx: number,
): Promise<{ buffer: Buffer; width: number; height: number }> {
    const padY = Math.round(heightPx * BADGE_PAD_Y_RATIO);
    const capBox = Math.max(1, heightPx - padY * 2);
    const measure = async (fontPx: number): Promise<number> =>
        (await measureTextInkWidth(badge, fontPx, BADGE_STROKE_PX)) ??
        estimateTextWidth(badge, fontPx);

    let fontPx = Math.max(BADGE_MIN_FONT_PX, Math.round(capBox / BADGE_CAP_RATIO));
    let padX = Math.max(2, Math.round(fontPx * BADGE_PAD_X_RATIO));
    let inkW = await measure(fontPx);
    let width = Math.ceil(inkW) + padX * 2;
    if (width > maxWidthPx) {
        // Proportional shrink, then hard-clamp: the plate is NEVER wider than
        // the box, which is what keeps the chip inside the canvas.
        fontPx = Math.max(BADGE_MIN_FONT_PX, Math.floor(fontPx * (maxWidthPx / width)));
        padX = Math.max(2, Math.round(fontPx * BADGE_PAD_X_RATIO));
        inkW = await measure(fontPx);
        width = Math.min(maxWidthPx, Math.ceil(inkW) + padX * 2);
    }

    const innerW = Math.max(1, width - padX * 2);
    const capH = Math.round(fontPx * BADGE_CAP_RATIO);
    // Badges are `S`/`E` + digits — no descenders, so centring on cap height is
    // both tight and optically correct.
    const baselineY = Math.round((heightPx + capH) / 2);
    const radius = Math.round(heightPx * BADGE_RADIUS_RATIO);
    const safe = escapeXml(badge);
    const pin = inkW > innerW ? ` textLength="${innerW}" lengthAdjust="spacingAndGlyphs"` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${heightPx}">
  <style>text { font-family: sans-serif; font-weight: 700; }</style>
  <rect x="0" y="0" width="${width}" height="${heightPx}" rx="${radius}" ry="${radius}"
        fill="#000000" fill-opacity="0.7"/>
  <text x="${padX}" y="${baselineY}" font-size="${fontPx}"
        fill="#ffffff" stroke="#000000" stroke-width="${BADGE_STROKE_PX}" paint-order="stroke"${pin}>${safe}</text>
</svg>`;
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    return { buffer, width, height: heightPx };
}

/**
 * Compose ONE content PNG — logo, optionally with an `S01E02` badge under it —
 * into a canvas of EXACTLY `box.boxW x box.boxH`. Keeping this a single PNG is
 * deliberate: the ffmpeg graph stays "scrim + exactly one content overlay",
 * and because the PNG is already the final size the graph does no rescaling.
 *
 * Layout, all inside the canvas:
 *  - logo → `fit: 'inside'` the sub-area `boxW x (boxH - chip - gap)`, anchored
 *    TOP-LEFT. `fit: 'inside'` preserves aspect and bounds BOTH axes, so a
 *    stacked/near-square logo can no longer blow up vertically (it is the
 *    height bound that was missing).
 *  - badge → exact small chip height, aligned to the same edge as the logo,
 *    directly under it, clamped so its bottom edge never passes `boxH`.
 *
 * `pos` only chooses WHICH edges of the box the block hugs (so a right-anchored
 * corner does not leave the burn floating in the middle of the frame); the
 * block is inside the box either way.
 *
 * Exported so the overlay integration test can composite a synthesized logo
 * without standing up the image-proxy service.
 */
export async function composeLogoWithBadge(
    logoBytes: Buffer,
    badge: string | null | undefined,
    outPath: string,
    box: OverlayBox,
    pos: OverlayPosition = 'tl',
): Promise<void> {
    const chipH = badge ? badgeChipHeight(box.boxH) : 0;
    const gap = badge ? badgeGap(box.boxH) : 0;
    const logoAreaH = Math.max(1, box.boxH - chipH - gap);

    const { data: logoData, info: logoInfo } = await sharp(logoBytes)
        .resize({ width: box.boxW, height: logoAreaH, fit: 'inside' })
        .png()
        .toBuffer({ resolveWithObject: true });

    const chip = badge ? await renderBadgeBuffer(badge, chipH, box.boxW) : null;
    const anchor = boxAnchor(pos);
    const blockH = logoInfo.height + (chip ? gap + chip.height : 0);
    const blockTop = anchor.bottom ? Math.max(0, box.boxH - blockH) : 0;
    const leftOf = (w: number): number => (anchor.right ? Math.max(0, box.boxW - w) : 0);

    const layers: OverlayOptions[] = [
        { input: logoData, left: leftOf(logoInfo.width), top: blockTop },
    ];
    if (chip) {
        layers.push({
            input: chip.buffer,
            left: leftOf(chip.width),
            // Sits under the logo's ACTUAL height, but never past the box.
            top: Math.max(0, Math.min(blockTop + logoInfo.height + gap, box.boxH - chip.height)),
        });
    }
    await writeBoxedCanvas(box, layers, outPath);
}

/**
 * Fetch the media's logo via the centralized ImageProxyService and write the
 * boxed content PNG to `outPath`. Returns `false` (never throws) when the proxy
 * has no logo bytes for this item, so the caller can fall back to text.
 *
 * For an EPISODE the proxy resolves the inherited SERIES logo (its metadata
 * lookup walks the same parent chain as `getImageMetadata`), and `badge` — the
 * resolver's `S01E02` label — is baked under it, producing ONE composited
 * content PNG. A badge that fails to compose degrades to the bare logo (still
 * boxed) rather than failing the whole render.
 *
 * EVERY path goes through `composeLogoWithBadge`, including the bare-logo one.
 * The old code wrote the RAW proxy bytes when there was no badge, handing
 * ffmpeg an arbitrarily-shaped PNG that it then sized by width alone — the
 * bare-logo half of the oversize bug. A logo we cannot box at all now returns
 * `false` (→ the caller's negative-cache → the mint ladder falls to text)
 * instead of being burned unbounded.
 */
export async function materializeLogoPng(
    mediaId: string,
    outPath: string,
    badge: string | null | undefined,
    box: OverlayBox,
    pos: OverlayPosition = 'tl',
): Promise<boolean> {
    const service = getImageProxyService();
    const result = await service
        .getImageByCatalogId(mediaId, 'logo', { format: 'png' })
        .catch((err: unknown) => {
            logger.warn('Top Shelf logo fetch failed', { mediaId, error: String(err) });
            return null;
        });
    if (!result || result.buffer.length === 0) return false;

    if (badge) {
        try {
            await composeLogoWithBadge(result.buffer, badge, outPath, box, pos);
            return true;
        } catch (err: unknown) {
            logger.warn('Top Shelf logo+badge composition failed; boxing the bare logo', {
                mediaId,
                badge,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    try {
        await composeLogoWithBadge(result.buffer, null, outPath, box, pos);
        return true;
    } catch (err: unknown) {
        logger.warn('Top Shelf logo could not be composited into the overlay box', {
            mediaId,
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}

let scrimPathPromise: Promise<string> | null = null;

/**
 * Lazily generate the shared vertical-gradient scrim PNG exactly once and
 * return its path. Lives at the artifact store's ROOT (not inside any
 * per-item directory) so the store's per-item GC sweep — which only visits
 * directory entries under the root — never touches it.
 */
export function ensureScrimAsset(): Promise<string> {
    if (!scrimPathPromise) {
        scrimPathPromise = (async (): Promise<string> => {
            const dir = config.TOPSHELF_PREVIEW_CACHE_DIR;
            await fs.mkdir(dir, { recursive: true });
            const path = join(dir, SCRIM_FILENAME);
            // Narrow transparent-at-top → black-at-bottom vertical gradient;
            // ffmpeg stretches it to cover the overlay's scrim band.
            const raw = Buffer.alloc(SCRIM_WIDTH * SCRIM_HEIGHT * 4);
            for (let y = 0; y < SCRIM_HEIGHT; y++) {
                const alpha = Math.round((y / (SCRIM_HEIGHT - 1)) * SCRIM_MAX_ALPHA);
                for (let x = 0; x < SCRIM_WIDTH; x++) {
                    const i = (y * SCRIM_WIDTH + x) * 4;
                    raw[i] = 0;
                    raw[i + 1] = 0;
                    raw[i + 2] = 0;
                    raw[i + 3] = alpha;
                }
            }
            await sharp(raw, { raw: { width: SCRIM_WIDTH, height: SCRIM_HEIGHT, channels: 4 } })
                .png()
                .toFile(path);
            return path;
        })().catch((err: unknown) => {
            // Never memoize a rejection: a transient scrim-gen failure (e.g.
            // one bad `sharp` call, a momentary ENOSPC) would otherwise
            // permanently break every scrimmed render process-wide, since
            // this promise is cached forever. Clear the memo so the NEXT
            // call retries from scratch, then rethrow so this call's caller
            // still observes the failure.
            scrimPathPromise = null;
            throw err;
        });
    }
    return scrimPathPromise;
}

/** Reset the memoized scrim promise — exclusively for tests. */
export function __resetScrimAssetForTests(): void {
    scrimPathPromise = null;
}

export interface OverlayGeometry {
    xExpr: string;
    yExpr: string;
    /** Y of the scrim overlay (band anchored to the same edge as the content). */
    scrimYExpr: string;
    /** True when the gradient PNG must be vertically flipped (top anchors). */
    scrimFlip: boolean;
}

/**
 * ffmpeg overlay x/y expressions (in terms of `main_w`/`main_h`/`overlay_w`/
 * `overlay_h`) for the given corner, plus the scrim's Y and flip direction.
 * Top corners get a top-anchored scrim (gradient flipped so it's dark-near-
 * edge); bottom corners get a bottom-anchored scrim (gradient as generated).
 */
export function overlayGeometry(pos: OverlayPosition, padding: number): OverlayGeometry {
    const padX = `main_w*${padding}`;
    const padY = `main_h*${padding}`;
    const isTop = pos === 'tl' || pos === 'tr';
    const isLeft = pos === 'tl' || pos === 'bl';
    const xExpr = isLeft ? padX : `main_w-overlay_w-${padX}`;
    const yExpr = isTop ? padY : `main_h-overlay_h-${padY}`;
    const scrimYExpr = isTop ? '0' : 'main_h-overlay_h';
    return { xExpr, yExpr, scrimYExpr, scrimFlip: isTop };
}
