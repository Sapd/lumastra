// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import * as pgs from '../utils/pgs-parser.js';
import { makeLargePgsFixture } from '../../../../scripts/subtitle-render-fixture.js';
import { renderCues } from './subtitle-render-core.js';

beforeEach(() => {
    vi.restoreAllMocks();
});
const canvas = { w: 1920, h: 1080 };
function rect(): pgs.PgsRect {
    const palette = new Uint8Array(1024);
    palette.set([255, 255, 255, 255], 4);
    return { x: 0, y: 0, width: 4, height: 2, indices: new Uint8Array(8).fill(1), palette };
}
it('converts and hashes a reused bitmap with equal palette snapshots only once', async () => {
    const bitmap = rect();
    const convert = vi.spyOn(pgs, 'toRgba');
    const cues = Array.from({ length: 500 }, (_, i) => ({
        startMs: i * 100,
        endMs: i * 100 + 50,
        rects: [{ ...bitmap, palette: bitmap.palette.slice() }],
    }));
    const result = await renderCues(cues, canvas);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(result.images).toHaveLength(1);
    expect(result.manifest.cues).toHaveLength(500);
});
it('respects palette changes and separately caches transparent references', async () => {
    const bitmap = rect();
    const clear = new Uint8Array(1024);
    const red = bitmap.palette.slice();
    red.set([255, 0, 0, 255], 4);
    const convert = vi.spyOn(pgs, 'toRgba');
    const result = await renderCues(
        [bitmap.palette, red, clear, clear.slice()].map((palette, i) => ({
            startMs: i,
            endMs: i + 1,
            rects: [{ ...bitmap, palette }],
        })),
        canvas,
    );
    expect(convert).toHaveBeenCalledTimes(3);
    expect(result.images).toHaveLength(2);
    expect(result.manifest.cues).toHaveLength(2);
});
it('charges only new bitmap/palette conversions, including palette changes', async () => {
    const bitmap = rect();
    const convert = vi.spyOn(pgs, 'toRgba');
    const cues = Array.from({ length: 1000 }, () => ({ startMs: 0, endMs: 1, rects: [bitmap] }));
    expect((await renderCues(cues, canvas, 8)).manifest.cues).toHaveLength(1000);
    expect(convert).toHaveBeenCalledTimes(1);
    const red = bitmap.palette.slice();
    red.set([255, 0, 0, 255], 4);
    await expect(
        renderCues(
            [{ startMs: 0, endMs: 1, rects: [bitmap, { ...bitmap, palette: red }] }],
            canvas,
            8,
        ),
    ).rejects.toMatchObject({
        counts: {
            renderedPixels: 8,
            uniqueBitmaps: 1,
            requestedPixels: 8,
            references: 2,
            limit: 'pixels',
        },
    });
});
it('renders 3000 synthetic Blu-ray cues with heavy reuse within the unique-pixel budget', async () => {
    const fixture = makeLargePgsFixture();
    expect(fixture.references * fixture.objectWidth * fixture.objectHeight).toBeGreaterThan(
        512 * 1024 * 1024,
    );
    const parsed = pgs.parsePgs(fixture.data);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.cues).toHaveLength(3000);
    const convert = vi.spyOn(pgs, 'toRgba');
    const result = await renderCues(parsed.cues, canvas, fixture.uniqueObjects * 1000 * 150);
    expect(result.manifest.cues).toHaveLength(3000);
    expect(convert).toHaveBeenCalledTimes(fixture.uniqueObjects);
});

it('still bounds cheap composition references independently of memoised pixel work', async () => {
    const bitmap = rect();
    await expect(
        renderCues(
            [{ startMs: 0, endMs: 1, rects: Array.from({ length: 80_001 }, () => bitmap) }],
            canvas,
        ),
    ).rejects.toMatchObject({
        counts: { limit: 'references', references: 80_001, uniqueBitmaps: 1, renderedPixels: 8 },
    });
});
