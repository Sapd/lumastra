// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cheap quality scoring for a candidate thumbnail frame.
 *
 * Pure: raw pixel buffers in, numbers out. No sharp, no I/O — the caller
 * decodes and hands over buffers, so every threshold here is unit-testable.
 *
 * Scope is deliberately narrow: it scores the failure modes actually MEASURED
 * on production frames, not every mode imaginable. Sampling six real TNG S3
 * episodes at the shipped 10% offset produced two near-black starfields and one
 * title card out of six. The near-black frames are what this rejects; the title
 * card is handled structurally by `frame-window.ts`, which puts the credit
 * window out of reach in the first place.
 *
 * NOT implemented, on purpose: the Otsu/edge-band text-card detector from the
 * design spec. Its own worked example scores a real lower-third credit line at
 * ~0.17 — a nudge, not a veto — and it has never been validated against a real
 * frame. Adding an unvalidated 200-line detector to reject a frame the window
 * already excludes is cost without evidence. Revisit if field data shows title
 * cards surviving the window.
 */

/** Rec.709 luma from 8-bit RGB. */
export function luma(r: number, g: number, b: number): number {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export interface LumaStats {
    mean: number;
    stddev: number;
    /** 5th percentile luma — robust floor, unlike min. */
    p05: number;
    /** 95th percentile luma — robust ceiling, unlike max. */
    p95: number;
    /** Shannon entropy over an 8-bin luma histogram, 0..3. */
    entropy: number;
}

/** Luma statistics from a greyscale buffer. */
export function lumaStats(grey: Uint8Array | Buffer): LumaStats {
    const n = grey.length;
    if (n === 0) return { mean: 0, stddev: 0, p05: 0, p95: 0, entropy: 0 };

    const hist = new Uint32Array(256);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        hist[grey[i]]++;
        sum += grey[i];
    }
    const mean = sum / n;

    let varSum = 0;
    for (let i = 0; i < n; i++) {
        const d = grey[i] - mean;
        varSum += d * d;
    }

    // Percentiles, not min/max: a single specular highlight or one dead pixel
    // must not be able to fake contrast in either direction.
    const at = (frac: number): number => {
        const target = frac * n;
        let acc = 0;
        for (let v = 0; v < 256; v++) {
            acc += hist[v];
            if (acc >= target) return v;
        }
        return 255;
    };

    let entropy = 0;
    for (let bin = 0; bin < 8; bin++) {
        let c = 0;
        for (let v = bin * 32; v < (bin + 1) * 32; v++) c += hist[v];
        if (c > 0) {
            const p = c / n;
            entropy -= p * Math.log2(p);
        }
    }

    return { mean, stddev: Math.sqrt(varSum / n), p05: at(0.05), p95: at(0.95), entropy };
}

/**
 * Fraction of pixels with a strong Sobel gradient — a cheap "is there detail
 * here" proxy. A starfield or a fade-to-black scores near zero; a face or a
 * lit set scores high.
 */
export function edgeDensity(grey: Uint8Array | Buffer, width: number, height: number): number {
    if (width < 3 || height < 3) return 0;
    let strong = 0;
    let total = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const gx =
                -grey[i - width - 1] +
                grey[i - width + 1] +
                -2 * grey[i - 1] +
                2 * grey[i + 1] +
                -grey[i + width - 1] +
                grey[i + width + 1];
            const gy =
                -grey[i - width - 1] -
                2 * grey[i - width] -
                grey[i - width + 1] +
                grey[i + width - 1] +
                2 * grey[i + width] +
                grey[i + width + 1];
            if (Math.abs(gx) + Math.abs(gy) >= 90) strong++;
            total++;
        }
    }
    return total === 0 ? 0 : strong / total;
}

/**
 * Hasler–Süsstrunk colourfulness from an interleaved RGB buffer.
 *
 * Deliberately NOT a skin-tone or face heuristic: the spec's proposed Kovac
 * rule is a warm-pixel detector that fires on explosions, sunsets and
 * teal-and-orange grading, and is documented to under-fire on darker skin
 * tones. It would bias a whole library orange for a small weight.
 */
export function colorfulness(rgb: Uint8Array | Buffer): number {
    const px = Math.floor(rgb.length / 3);
    if (px === 0) return 0;

    let sumRG = 0;
    let sumYB = 0;
    let sumRG2 = 0;
    let sumYB2 = 0;
    for (let i = 0; i < px; i++) {
        const r = rgb[i * 3];
        const g = rgb[i * 3 + 1];
        const b = rgb[i * 3 + 2];
        const rg = r - g;
        const yb = 0.5 * (r + g) - b;
        sumRG += rg;
        sumYB += yb;
        sumRG2 += rg * rg;
        sumYB2 += yb * yb;
    }
    const meanRG = sumRG / px;
    const meanYB = sumYB / px;
    const varRG = Math.max(0, sumRG2 / px - meanRG * meanRG);
    const varYB = Math.max(0, sumYB2 / px - meanYB * meanYB);

    return Math.sqrt(varRG + varYB) + 0.3 * Math.sqrt(meanRG * meanRG + meanYB * meanYB);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export interface FrameScore {
    score: number;
    /** True when the frame is unusable (blank, near-black, blown out). */
    rejected: boolean;
    reason?: string;
}

export interface ScoreInput {
    grey: Uint8Array | Buffer;
    width: number;
    height: number;
    rgb: Uint8Array | Buffer;
    /** Relax the darkness floor for genuinely dark-graded content. */
    darkTolerant?: boolean;
}

/**
 * Score a candidate, 0..1. Higher is a better thumbnail.
 *
 * Rejected frames still receive a score so a caller with nothing but rejects
 * can pick the least-bad rather than leaving an episode with no image at all —
 * a blank card is a worse regression than a mediocre frame.
 */
export function scoreFrame(input: ScoreInput): FrameScore {
    const { grey, width, height, rgb, darkTolerant } = input;
    const stats = lumaStats(grey);
    const edges = edgeDensity(grey, width, height);
    const colour = colorfulness(rgb);

    const darkFloor = darkTolerant ? 14 : 18;

    let rejected = false;
    let reason: string | undefined;
    if (stats.p95 < darkFloor) {
        rejected = true;
        reason = 'near-black';
    } else if (stats.p05 > 235) {
        rejected = true;
        reason = 'blown-out';
    } else if (stats.stddev < 8) {
        rejected = true;
        reason = 'flat';
    } else if (stats.entropy < 0.8) {
        rejected = true;
        reason = 'low-entropy';
    }

    const edgeScore = clamp01((edges - 0.02) / 0.1);
    const sigmaScore = clamp01((stats.stddev - 18) / 40);
    const spreadScore = clamp01((stats.p95 - stats.p05) / 180);
    const colourScore = clamp01((colour - 8) / 32);
    const entropyScore = clamp01((stats.entropy - 1.4) / 1.4);

    const base =
        0.3 * edgeScore +
        0.22 * sigmaScore +
        0.2 * spreadScore +
        0.16 * colourScore +
        0.12 * entropyScore;

    // Dark frames are legitimate in prestige TV, so this is a nudge rather than
    // a veto — the hard floor above already removes the truly black ones.
    const darkPenalty = clamp01((60 - stats.mean) / 44);
    const score = clamp01(base - 0.1 * darkPenalty);

    return { score, rejected, reason };
}
