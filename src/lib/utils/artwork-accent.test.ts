// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { accentFromPixels } from './artwork-accent';

/** Build an RGBA buffer from `[r,g,b,count]` runs. */
function pixels(...runs: Array<[number, number, number, number]>): Uint8ClampedArray {
    const total = runs.reduce((n, run) => n + run[3], 0);
    const data = new Uint8ClampedArray(total * 4);
    let i = 0;
    for (const [r, g, b, count] of runs) {
        for (let n = 0; n < count; n++) {
            data[i++] = r;
            data[i++] = g;
            data[i++] = b;
            data[i++] = 255;
        }
    }
    return data;
}

function hueOf(color: string): number {
    const match = /^hsl\((\d+)/.exec(color);
    if (!match) throw new Error(`not an hsl() colour: ${color}`);
    return Number(match[1]);
}

describe('accentFromPixels', () => {
    /**
     * The case the weighting exists for. A typical jacket is mostly dark with a
     * small area of foil; a plain pixel count returns the dark and every book
     * ends up looking the same.
     */
    it('returns the foil hue from a mostly-black cover', () => {
        // 500 near-black pixels, 76 gold ones.
        const accent = accentFromPixels(pixels([8, 8, 10, 500], [212, 168, 60, 76]));
        expect(accent).not.toBeNull();
        // Gold sits around 45°.
        expect(hueOf(accent!.fill)).toBeGreaterThan(30);
        expect(hueOf(accent!.fill)).toBeLessThan(60);
    });

    it('averages hue circularly so reds near 0/360 do not collapse to cyan', () => {
        const accent = accentFromPixels(pixels([200, 30, 40, 100], [200, 40, 30, 100]));
        expect(accent).not.toBeNull();
        const hue = hueOf(accent!.fill);
        expect(hue < 30 || hue > 330).toBe(true);
    });

    it('returns null for a greyscale cover rather than inventing a hue', () => {
        expect(accentFromPixels(pixels([20, 20, 20, 200], [180, 180, 180, 200]))).toBeNull();
    });

    it('returns null for an empty buffer', () => {
        expect(accentFromPixels(new Uint8ClampedArray(0))).toBeNull();
    });

    it('ignores transparent pixels', () => {
        const data = new Uint8ClampedArray(8);
        // One fully transparent vivid pixel, one opaque vivid pixel.
        data.set([220, 20, 20, 0], 0);
        data.set([20, 20, 220, 255], 4);
        const accent = accentFromPixels(data);
        expect(accent).not.toBeNull();
        // Blue, not red — the transparent pixel must not vote.
        expect(hueOf(accent!.fill)).toBeGreaterThan(200);
        expect(hueOf(accent!.fill)).toBeLessThan(260);
    });

    /**
     * Contrast is the reason the roles exist: `fill` carries white text, `tint`
     * sits on the dark player surface. Both lightnesses are fixed by the module,
     * so no cover can produce an unreadable control.
     */
    it('pins lightness per role regardless of how light the artwork is', () => {
        const dark = accentFromPixels(pixels([40, 10, 60, 100]))!;
        const light = accentFromPixels(pixels([230, 190, 250, 100]))!;
        for (const accent of [dark, light]) {
            expect(accent.fill).toMatch(/ 40%\)$/);
            expect(accent.tint).toMatch(/ 72%\)$/);
            expect(accent.wash).toMatch(/\/ 0\.12\)$/);
        }
    });

    it('clamps saturation so no cover can produce a fluorescent UI', () => {
        const accent = accentFromPixels(pixels([255, 0, 0, 100]))!;
        const saturation = Number(/^hsl\(\d+ (\d+)%/.exec(accent.fill)![1]);
        expect(saturation).toBeLessThanOrEqual(62);
    });
});
