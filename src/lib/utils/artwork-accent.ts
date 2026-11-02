// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pull a usable accent colour out of cover art.
 *
 * The audiobook player is one book for twenty hours, and the cover is the only
 * asset that differs between books — everything else on that screen is chrome.
 * Tinting the controls from the artwork is what makes the screen feel like the
 * book you are in rather than a generic shell.
 *
 * ## Why the roles are separate
 *
 * A single "dominant colour" cannot serve both a filled button and a text
 * label. Babel's gold at its native lightness is legible as text on a dark
 * surface but fails white-on-fill contrast; a deep navy is the reverse. So the
 * sampled hue is projected into three roles with lightness fixed per role, and
 * only the HUE (and a clamped saturation) survives from the artwork.
 *
 * Everything here degrades to `null`, and every caller falls back to the brand
 * accent. A tainted canvas, a cover that never loaded, and a greyscale jacket
 * all take that path.
 */

/** Lightness for the solid control fill. Chosen so white text clears 4.5:1. */
const FILL_LIGHTNESS = 40;
/** Lightness for text/marks sitting ON the dark player surface. */
const TINT_LIGHTNESS = 72;
/** Saturation is clamped: a fully saturated UI reads as an error state. */
const MAX_SATURATION = 62;
const MIN_SATURATION = 18;

export interface ArtworkAccent {
    /** Solid background for controls. Pair with white text. */
    fill: string;
    /** Text, icons and marks on the dark player surface. */
    tint: string;
    /** Ambient wash behind the artwork. Low alpha by construction. */
    wash: string;
}

interface Hsl {
    h: number;
    s: number;
    l: number;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l * 100 };

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
    return { h: h * 360, s: s * 100, l: l * 100 };
}

/**
 * Pick the accent hue from raw RGBA pixels.
 *
 * Pixels are bucketed by hue (24 buckets of 15°) and each bucket accumulates
 * saturation rather than a count: a jacket that is 90% black with a gold
 * foil title should return the gold, and counting pixels would return the
 * black every time. Near-black, near-white, transparent and near-grey pixels
 * are dropped entirely — they carry no hue worth showing.
 */
export function accentFromPixels(data: Uint8ClampedArray): ArtworkAccent | null {
    const BUCKETS = 24;
    const weight = new Float64Array(BUCKETS);
    const satSum = new Float64Array(BUCKETS);
    const hueSin = new Float64Array(BUCKETS);
    const hueCos = new Float64Array(BUCKETS);

    for (let i = 0; i + 3 < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha < 200) continue;
        const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        if (l < 12 || l > 92 || s < 15) continue;
        const bucket = Math.min(BUCKETS - 1, Math.floor((h / 360) * BUCKETS));
        // Weight by saturation AND by distance from mid-grey lightness, so a
        // small area of vivid foil outweighs a large flat wash.
        const w = (s / 100) * (1 - Math.abs(l - 50) / 50) + 0.05;
        weight[bucket] += w;
        satSum[bucket] += s * w;
        // Hue is circular; averaging 350° and 10° arithmetically gives 180°.
        const rad = (h * Math.PI) / 180;
        hueSin[bucket] += Math.sin(rad) * w;
        hueCos[bucket] += Math.cos(rad) * w;
    }

    let best = -1;
    let bestWeight = 0;
    for (let i = 0; i < BUCKETS; i++) {
        if (weight[i] > bestWeight) {
            bestWeight = weight[i];
            best = i;
        }
    }
    if (best < 0 || bestWeight <= 0) return null;

    let hue = (Math.atan2(hueSin[best], hueCos[best]) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    const saturation = Math.min(
        MAX_SATURATION,
        Math.max(MIN_SATURATION, satSum[best] / weight[best]),
    );

    const h = Math.round(hue);
    const s = Math.round(saturation);
    return {
        fill: `hsl(${h} ${s}% ${FILL_LIGHTNESS}%)`,
        tint: `hsl(${h} ${Math.min(s + 10, 80)}% ${TINT_LIGHTNESS}%)`,
        wash: `hsl(${h} ${s}% 50% / 0.12)`,
    };
}

/**
 * Sample a loaded image element.
 *
 * Downscaled to 24×24 first: the accent is a hue, not a thumbnail, and reading
 * ~576 pixels instead of a few hundred thousand keeps this off the frame
 * budget. Returns `null` on a tainted canvas (a cover served cross-origin
 * without CORS headers) rather than throwing — the caller's fallback is the
 * brand accent, which is a perfectly good outcome.
 */
export function sampleImageAccent(image: HTMLImageElement): ArtworkAccent | null {
    if (!image.complete || image.naturalWidth === 0) return null;
    try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(image, 0, 0, size, size);
        return accentFromPixels(ctx.getImageData(0, 0, size, size).data);
    } catch {
        return null;
    }
}
