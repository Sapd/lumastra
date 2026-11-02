// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import {
    DARK_LOGO_LUMA,
    LogoLegibilityResolver,
    chooseLegibleLogo,
    measureLogoLuma,
    type LogoCandidate,
} from './logo-legibility.js';

/** A 40×10 PNG: `fill` text-ish block on a transparent canvas. */
async function logoPng(fill: { r: number; g: number; b: number }): Promise<Buffer> {
    const block = await sharp({
        create: { width: 30, height: 6, channels: 4, background: { ...fill, alpha: 1 } },
    })
        .png()
        .toBuffer();
    return sharp({
        create: { width: 40, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
        .composite([{ input: block, left: 5, top: 2 }])
        .png()
        .toBuffer();
}

describe('measureLogoLuma', () => {
    it('ignores transparent pixels and reads dark vs light art', async () => {
        const dark = await measureLogoLuma(await logoPng({ r: 20, g: 25, b: 40 }));
        const light = await measureLogoLuma(await logoPng({ r: 240, g: 240, b: 235 }));
        expect(dark).not.toBeNull();
        expect(dark!).toBeLessThan(DARK_LOGO_LUMA);
        expect(light!).toBeGreaterThan(0.9);
    });

    it('returns null for a fully transparent image', async () => {
        const empty = await sharp({
            create: {
                width: 4,
                height: 4,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            },
        })
            .png()
            .toBuffer();
        expect(await measureLogoLuma(empty)).toBeNull();
    });
});

const LUMA: Record<string, number | null> = {
    '/dark-en.png': 0.1,
    '/dark-en-2.png': 0.15,
    '/white-en.png': 0.95,
    '/white-de.png': 0.97,
    '/light-en-lowvote.png': 0.8,
};
const measure = async (p: string): Promise<number | null> => LUMA[p] ?? null;

const CANDIDATES: LogoCandidate[] = [
    { file_path: '/dark-en.png', iso_639_1: 'en', vote_average: 5.5 },
    { file_path: '/white-de.png', iso_639_1: 'de', vote_average: 9 },
    { file_path: '/dark-en-2.png', iso_639_1: 'en', vote_average: 5.4 },
    { file_path: '/light-en-lowvote.png', iso_639_1: 'en', vote_average: 1 },
    { file_path: '/white-en.png', iso_639_1: 'en', vote_average: 5.2 },
];

describe('chooseLegibleLogo', () => {
    it('keeps a light stored logo without looking at alternatives', async () => {
        expect(await chooseLegibleLogo('/white-en.png', CANDIDATES, measure)).toBe('/white-en.png');
    });

    it('swaps a dark logo for the best-voted LIGHT variant of the same language', async () => {
        // /white-de.png is lighter and better voted but German — never crosses languages.
        expect(await chooseLegibleLogo('/dark-en.png', CANDIDATES, measure)).toBe('/white-en.png');
    });

    it('keeps the dark logo when no light same-language variant exists', async () => {
        const onlyDark = CANDIDATES.filter((c) => c.file_path.startsWith('/dark'));
        expect(await chooseLegibleLogo('/dark-en.png', onlyDark, measure)).toBe('/dark-en.png');
    });

    it('keeps the stored logo when it is not in the candidate list', async () => {
        expect(await chooseLegibleLogo('/dark-en.png', [], measure)).toBe('/dark-en.png');
    });
});

describe('LogoLegibilityResolver', () => {
    it('lists logos only for a dark logo and memoises the decision', async () => {
        const list = vi.fn(async () => CANDIDATES);
        const measurePath = vi.fn(measure);
        const resolver = new LogoLegibilityResolver(list, measurePath);

        expect(await resolver.resolve('550', 'movie', '/white-en.png')).toBe('/white-en.png');
        expect(list).not.toHaveBeenCalled();

        expect(await resolver.resolve('550', 'movie', '/dark-en.png')).toBe('/white-en.png');
        expect(await resolver.resolve('550', 'movie', '/dark-en.png')).toBe('/white-en.png');
        expect(list).toHaveBeenCalledTimes(1);
        expect(list).toHaveBeenCalledWith(550, 'movie');
    });

    it('serves the stored logo when TMDB fails, and retries next time', async () => {
        const list = vi
            .fn<(id: number, kind: 'movie' | 'tv') => Promise<LogoCandidate[]>>()
            .mockRejectedValueOnce(new Error('TMDB 503'))
            .mockResolvedValue(CANDIDATES);
        const resolver = new LogoLegibilityResolver(list, measure);

        expect(await resolver.resolve('1', 'tv', '/dark-en.png')).toBe('/dark-en.png');
        expect(await resolver.resolve('1', 'tv', '/dark-en.png')).toBe('/white-en.png');
    });

    it('passes through non-TMDB-shaped input untouched', async () => {
        const list = vi.fn(async () => CANDIDATES);
        const resolver = new LogoLegibilityResolver(list, measure);
        expect(await resolver.resolve('abc', 'movie', '/dark-en.png')).toBe('/dark-en.png');
        expect(await resolver.resolve('1', 'episode', '/dark-en.png')).toBe('/dark-en.png');
        expect(list).not.toHaveBeenCalled();
    });
});
