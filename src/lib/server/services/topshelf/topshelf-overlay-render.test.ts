// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- ensureScrimAsset (FIX 1) hermetic harness -----------------------------
// Mocks are layered over the REAL modules (importOriginal) so only the
// specific calls under test are controlled — everything else (config
// getters, other fs functions) stays real, matching how this file already
// imports the module unmocked for escapeXml/overlayGeometry.
const scrimMkdir = vi.fn();
const scrimToFile = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        promises: {
            ...actual.promises,
            mkdir: (...args: unknown[]) => scrimMkdir(...args),
        },
    };
});

vi.mock('sharp', () => ({
    default: vi.fn(() => ({
        png: () => ({ toFile: (...args: unknown[]) => scrimToFile(...args) }),
    })),
}));

// config.js is intentionally left UNMOCKED here: it's a large getter-based
// object with a wide transitive import graph (task registry, paraglide
// messages, ...) that a partial/full mock trips over. This file already
// imports the module under test unmocked for escapeXml/overlayGeometry, so
// the real config resolves fine — `ensureScrimAsset` only reads
// `TOPSHELF_PREVIEW_CACHE_DIR` off it, and `fs.mkdir`/`sharp` are mocked
// below, so no real disk IO happens regardless of its real value.

import {
    escapeXml,
    overlayGeometry,
    ensureScrimAsset,
    fitTextToWidth,
    findFittingFontSize,
    badgeChipHeight,
    __resetScrimAssetForTests,
} from './topshelf-overlay-render.js';
import { computeOverlayBox } from './topshelf-overlay.js';

describe('badgeChipHeight (the badge must read as a small badge)', () => {
    it('caps the chip at a small fraction of the box at every shipped base width', () => {
        for (const maxWidth of [640, 1280, 1920, 3840]) {
            const box = computeOverlayBox(0.4, maxWidth);
            const chip = badgeChipHeight(box.boxH);
            // A quarter of the box at most...
            expect(chip).toBeLessThanOrEqual(Math.round(box.boxH * 0.25));
            // ...and only a few percent of the frame — the old chip inherited
            // the logo composite's scale factor and reached ~13% of it.
            expect(chip / box.baseHeight).toBeLessThan(0.07);
            expect(chip).toBeGreaterThan(0);
        }
    });

    it('scales with the box rather than being a fixed pixel size', () => {
        const small = badgeChipHeight(computeOverlayBox(0.4, 640).boxH);
        const large = badgeChipHeight(computeOverlayBox(0.4, 1920).boxH);
        expect(large).toBeGreaterThan(small);
    });

    it('never lets the chip crowd out the logo, even for a degenerate box', () => {
        for (const boxH of [1, 4, 10, 20, 40, 94, 187, 400]) {
            expect(badgeChipHeight(boxH)).toBeLessThanOrEqual(Math.max(1, Math.round(boxH * 0.4)));
            expect(badgeChipHeight(boxH)).toBeGreaterThanOrEqual(1);
        }
    });
});

describe('escapeXml', () => {
    it('escapes the five XML entities', () => {
        expect(escapeXml('Tom & Jerry')).toBe('Tom &amp; Jerry');
        expect(escapeXml('<Untitled>')).toBe('&lt;Untitled&gt;');
        expect(escapeXml(`"a" 'b'`)).toBe('&quot;a&quot; &apos;b&apos;');
    });
    it('escapes & before other entities so it is not double-escaped', () => {
        expect(escapeXml('<a & b>')).toBe('&lt;a &amp; b&gt;');
    });
    it('passes unicode/non-latin through unchanged', () => {
        expect(escapeXml('進撃の巨人')).toBe('進撃の巨人');
    });
    it('strips XML-1.0-illegal C0 control chars (FIX 4)', () => {
        expect(escapeXml('a\x0Bb\x1Fc')).toBe('abc');
    });
    it('strips illegal control chars alongside entity escaping', () => {
        expect(escapeXml('a\x0B & \x1F<b>')).toBe('a &amp; &lt;b&gt;');
    });
});

describe('ensureScrimAsset', () => {
    beforeEach(() => {
        __resetScrimAssetForTests();
        scrimMkdir.mockReset().mockResolvedValue(undefined);
        scrimToFile.mockReset().mockResolvedValue(undefined);
    });

    it('clears the memoized promise on rejection so a transient failure does not permanently break scrimmed renders (FIX 1)', async () => {
        scrimToFile.mockRejectedValueOnce(new Error('sharp boom'));

        await expect(ensureScrimAsset()).rejects.toThrow('sharp boom');

        // A second call must retry from scratch (not replay the cached
        // rejection) and this time succeed.
        const path = await ensureScrimAsset();
        expect(path).toContain('scrim-gradient.png');
        expect(scrimToFile).toHaveBeenCalledTimes(2);
    });

    it('memoizes a successful result across calls (only generates once)', async () => {
        const first = await ensureScrimAsset();
        const second = await ensureScrimAsset();
        expect(first).toBe(second);
        expect(scrimToFile).toHaveBeenCalledTimes(1);
    });
});

describe('fitTextToWidth (text clipping fix)', () => {
    /**
     * Stand-in for the real (rasterize + trim) measurer. `perChar` deliberately
     * exceeds the OLD 0.55-of-font-size assumption — a wide font like DejaVu
     * Sans Bold is exactly what made long labels overflow the canvas and get
     * cut with no ellipsis.
     */
    const measurer =
        (perChar: number) =>
        (s: string): Promise<number> =>
            Promise.resolve(s.length * perChar);

    it('leaves text that already fits untouched and reports it as not truncated', async () => {
        const r = await fitTextToWidth('Cloud Runner', 1200, measurer(30));
        expect(r.text).toBe('Cloud Runner');
        expect(r.truncated).toBe(false);
        expect(r.width).toBeLessThanOrEqual(1200);
    });

    it('ellipsizes an overlong label until it MEASURES inside the target', async () => {
        const long = 'S01E02 · A Very Long Episode Title That Must Ellipsize';
        const r = await fitTextToWidth(long, 600, measurer(30));
        expect(r.truncated).toBe(true);
        expect(r.text.endsWith('…')).toBe(true);
        expect(r.text.length).toBeLessThan(long.length);
        expect(r.width).toBeLessThanOrEqual(600);
    });

    it('fits wide scripts by character count, not by a latin advance guess', async () => {
        // Full-width glyphs: ~1 em each, nearly double the latin assumption.
        const r = await fitTextToWidth('進撃の巨人進撃の巨人進撃の巨人', 300, measurer(84));
        expect(r.truncated).toBe(true);
        expect(r.width).toBeLessThanOrEqual(300);
    });

    it('converges (and never spins) when even one character overflows', async () => {
        const r = await fitTextToWidth('WWWWWWWW', 10, measurer(100));
        expect(r.text.endsWith('…')).toBe(true);
        expect(r.text.length).toBeLessThanOrEqual(2);
    });
});

describe('findFittingFontSize (shrink-to-fit)', () => {
    /** Stand-in for `measureTextInkWidth(text, fontPx, ...)`: linear in both text length and font size. */
    const measurerFor =
        (text: string, perCharPerPx: number) =>
        (fontPx: number): Promise<number> =>
            Promise.resolve(text.length * fontPx * perCharPerPx);

    it('a short string still fits — and renders — at the max size', async () => {
        const short = 'S01E02 · Pilot';
        const r = await findFittingFontSize(1200, 48, 96, measurerFor(short, 0.62));
        expect(r.fits).toBe(true);
        expect(r.fontPx).toBe(96);
    });

    it('a long string that overflows at max but fits somewhere in range shrinks below the max', async () => {
        const medium = 'S01E02 · Maps and Legends';
        const r = await findFittingFontSize(1200, 48, 96, measurerFor(medium, 0.62));
        expect(r.fits).toBe(true);
        expect(r.fontPx).toBeLessThan(96);
        expect(r.fontPx).toBeGreaterThanOrEqual(48);
        // The chosen size must actually measure inside the target.
        expect(await measurerFor(medium, 0.62)(r.fontPx)).toBeLessThanOrEqual(1200);
    });

    it('a longer string yields a strictly SMALLER chosen font size than a shorter one', async () => {
        const short = 'S01E02 · Pilot';
        const medium = 'S01E02 · Maps and Legends';
        const rShort = await findFittingFontSize(1200, 48, 96, measurerFor(short, 0.62));
        const rMedium = await findFittingFontSize(1200, 48, 96, measurerFor(medium, 0.62));
        expect(rMedium.fontPx).toBeLessThan(rShort.fontPx);
    });

    it('reports fits:false (caller must ellipsize) when even the floor size overflows', async () => {
        const veryLong =
            'S01E02 · An Extremely Long Episode Title That Goes On And On Forever And Ever';
        const r = await findFittingFontSize(1200, 48, 96, measurerFor(veryLong, 0.62));
        expect(r.fits).toBe(false);
        expect(r.fontPx).toBe(48);
    });

    it('bounds the number of measurement calls (no regression in render cost)', async () => {
        let calls = 0;
        const measure = async (fontPx: number): Promise<number> => {
            calls += 1;
            return 'S01E02 · Maps and Legends'.length * fontPx * 0.62;
        };
        await findFittingFontSize(1200, 48, 96, measure);
        expect(calls).toBeLessThanOrEqual(10);
    });

    it('composes with fitTextToWidth so ellipsis is only used as the last resort at the floor size', async () => {
        const veryLong =
            'S01E02 · An Extremely Long Episode Title That Goes On And On Forever And Ever';
        const perChar = 0.62;
        const fit = await findFittingFontSize(1200, 48, 96, measurerFor(veryLong, perChar));
        expect(fit.fits).toBe(false);

        const ellipsized = await fitTextToWidth(veryLong, 1200, (candidate) =>
            measurerFor(candidate, perChar)(fit.fontPx),
        );
        expect(ellipsized.truncated).toBe(true);
        expect(ellipsized.text.endsWith('…')).toBe(true);
        expect(ellipsized.width).toBeLessThanOrEqual(1200);

        // A string that DOES fit at the floor never needs ellipsis at all.
        const medium = 'S01E02 · Maps and Legends';
        const fitMedium = await findFittingFontSize(1200, 48, 96, measurerFor(medium, perChar));
        expect(fitMedium.fits).toBe(true);
    });
});

describe('overlayGeometry', () => {
    it('top-left anchors at the padded top-left with a top scrim', () => {
        const g = overlayGeometry('tl', 0.04);
        expect(g.xExpr).toContain('main_w*0.04');
        expect(g.yExpr).toContain('main_h*0.04');
        expect(g.scrimFlip).toBe(true); // top scrim = gradient flipped
    });
    it('top-right anchors from the right edge with a top scrim', () => {
        const g = overlayGeometry('tr', 0.04);
        expect(g.xExpr).toContain('main_w-overlay_w-main_w*0.04');
        expect(g.yExpr).toContain('main_h*0.04');
        expect(g.scrimFlip).toBe(true);
    });
    it('bottom-left anchors from the bottom edge with a bottom scrim', () => {
        const g = overlayGeometry('bl', 0.04);
        expect(g.xExpr).toContain('main_w*0.04');
        expect(g.yExpr).toContain('main_h-overlay_h-main_h*0.04');
        expect(g.scrimFlip).toBe(false);
    });
    it('bottom-right anchors from the far edges with a bottom scrim', () => {
        const g = overlayGeometry('br', 0.04);
        expect(g.xExpr).toContain('main_w-overlay_w-main_w*0.04');
        expect(g.yExpr).toContain('main_h-overlay_h-main_h*0.04');
        expect(g.scrimFlip).toBe(false);
    });
});
