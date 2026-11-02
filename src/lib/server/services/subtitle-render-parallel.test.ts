// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ encode: vi.fn() }));
vi.mock('sharp', () => ({ default: () => ({ png: () => ({ toBuffer: () => h.encode() }) }) }));
import { renderCues } from './subtitle-render-core.js';

it('encodes up to four distinct PNGs concurrently and shares in-flight duplicate content', async () => {
    let active = 0;
    let peak = 0;
    h.encode.mockImplementation(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return Buffer.from('encoded PNG');
    });
    const rects = Array.from({ length: 12 }, (_, i) => {
        const palette = new Uint8Array(1024);
        palette.set([i % 10, 255, 255, 255], 4);
        return { x: i, y: 0, width: 2, height: 2, indices: new Uint8Array(4).fill(1), palette };
    });
    const result = await renderCues([{ startMs: 0, endMs: 1, rects }], { w: 1920, h: 1080 });
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(h.encode).toHaveBeenCalledTimes(10);
    expect(result.images).toHaveLength(10);
    expect(result.manifest.cues[0].rects[0].image).toBe(result.manifest.cues[0].rects[10].image);
});
