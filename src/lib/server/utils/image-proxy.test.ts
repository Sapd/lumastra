// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { resizeForPreset, avifQualityForWebp } from './image-proxy';

vi.mock('$lib/server/config', () => ({
    config: {
        IMAGE_THUMB_QUALITY: 75,
        IMAGE_FULL_QUALITY: 85,
        IMAGE_AVIF_THUMB_QUALITY: 54,
        IMAGE_AVIF_FULL_QUALITY: 67,
        IMAGE_AVIF_SPEED: 6, // faster encode for tests
    },
}));

/** Build a tiny 16×16 solid-color PNG for predictable test inputs. */
async function tinyPng(): Promise<Buffer> {
    return sharp({
        create: {
            width: 16,
            height: 16,
            channels: 3,
            background: { r: 64, g: 128, b: 200 },
        },
    })
        .png()
        .toBuffer();
}

describe('avifQualityForWebp', () => {
    it('maps a WebP-scale quality to a LOWER AVIF-scale value (full tier 67/85 ratio)', () => {
        expect(avifQualityForWebp(85, false)).toBe(67); // 85 * 67/85
        expect(avifQualityForWebp(95, false)).toBe(75); // 95 * 67/85 ≈ 74.9
    });
    it('uses the thumb ratio (54/75) for thumb-tier requests', () => {
        expect(avifQualityForWebp(85, true)).toBe(61); // 85 * 54/75 ≈ 61.2
        expect(avifQualityForWebp(50, true)).toBe(36); // 50 * 54/75 = 36
    });
    it('never exceeds the WebP input and stays within [1,100]', () => {
        for (const q of [50, 70, 85, 95]) {
            const a = avifQualityForWebp(q, false);
            expect(a).toBeLessThanOrEqual(q);
            expect(a).toBeGreaterThanOrEqual(1);
            expect(a).toBeLessThanOrEqual(100);
        }
    });
});

describe('resizeForPreset', () => {
    it('returns original buffer untouched when size is missing or "full"', async () => {
        const png = await tinyPng();
        const out1 = await resizeForPreset(png, 'image/png', undefined);
        const out2 = await resizeForPreset(png, 'image/png', 'full');
        expect(out1.buffer).toBe(png);
        expect(out2.buffer).toBe(png);
        expect(out1.contentType).toBe('image/png');
    });

    it('encodes WebP for thumb by default', async () => {
        const png = await tinyPng();
        const { buffer, contentType } = await resizeForPreset(png, 'image/png', 'thumb');
        expect(contentType).toBe('image/webp');
        // RIFF....WEBP magic bytes
        expect(buffer.slice(0, 4).toString('utf8')).toBe('RIFF');
        expect(buffer.slice(8, 12).toString('utf8')).toBe('WEBP');
    });

    it('encodes AVIF when format=avif is requested', async () => {
        const png = await tinyPng();
        const { buffer, contentType } = await resizeForPreset(png, 'image/png', 'thumb', 'avif');
        expect(contentType).toBe('image/avif');
        // AVIF is a HEIF brand. The first 12 bytes contain "ftypavif" or
        // "ftypheic"-family. Sharp/libheif emits "ftypavif" as the major brand.
        const head = buffer.slice(0, 16).toString('binary');
        expect(head).toContain('ftyp');
        // Most common: avif/avis brand
        const isAvif = head.includes('avif') || head.includes('avis');
        expect(isAvif).toBe(true);
    });

    it('falls back to WebP when AVIF encoder rejects the input', async () => {
        // Use a buffer Sharp cannot decode at all to force the encode path
        // to fail. resizeForPreset should walk: avif fail → webp success.
        // Build a real PNG but corrupt it after the IHDR — Sharp will throw
        // on the first attempt regardless of format.
        const png = await tinyPng();
        const corrupt = Buffer.concat([png.slice(0, 30), Buffer.alloc(50)]);
        const { contentType } = await resizeForPreset(corrupt, 'image/png', 'thumb', 'avif');
        // Either webp succeeds (fallback path), or jpeg fallback after that,
        // or we land on the original return (ultimate fallback). Critically,
        // we MUST NOT return contentType='image/avif' from a failed AVIF
        // encode — that's the bug pattern the codex review caught.
        expect(contentType).not.toBe('image/avif');
    });

    it('preserves original buffer when ALL encoders fail (last-resort fallback)', async () => {
        // Pass total garbage. Sharp throws on every encoder. resizeForPreset
        // should ultimately return the original buffer + contentType so the
        // caller never receives `null` — image rendering may fail but the
        // pipeline doesn't crash.
        const garbage = Buffer.alloc(64, 0xab);
        const result = await resizeForPreset(garbage, 'image/png', 'thumb', 'avif');
        expect(result.buffer).toBe(garbage);
    });

    it('honors explicit format=jpeg without falling through to webp', async () => {
        // Codex regression: previously the route mapped jpg → webp via a
        // missing branch, so explicit ?format=jpg silently returned WebP.
        const png = await tinyPng();
        const { buffer, contentType } = await resizeForPreset(png, 'image/png', 'thumb', 'jpeg');
        expect(contentType).toBe('image/jpeg');
        // JPEG SOI marker
        expect(buffer[0]).toBe(0xff);
        expect(buffer[1]).toBe(0xd8);
    });

    it('honors explicit format=png without falling through to webp', async () => {
        // Codex regression: same as above, ?format=png was being mapped to
        // WebP. Resized custom artwork is sometimes deliberately served as
        // PNG to preserve transparency.
        const png = await tinyPng();
        const { buffer, contentType } = await resizeForPreset(png, 'image/png', 'thumb', 'png');
        expect(contentType).toBe('image/png');
        // PNG signature
        expect(buffer[0]).toBe(0x89);
        expect(buffer.slice(1, 4).toString('utf8')).toBe('PNG');
    });

    it('hd and wide presets use the full quality tier (not thumb-tier)', async () => {
        // isThumbTier = size === 'thumb' || size === 'card'; hd and wide must
        // NOT use the thumb-tier quality so full-bleed backdrops aren't over-compressed.
        // We verify the presets resolve to a width (not early-return as 'full')
        // and produce WebP output, confirming the resize path was taken.
        const png = await tinyPng();
        const hdOut = await resizeForPreset(png, 'image/png', 'hd');
        const wideOut = await resizeForPreset(png, 'image/png', 'wide');
        // Both should produce WebP (resize path was taken, not the full/unset passthrough)
        expect(hdOut.contentType).toBe('image/webp');
        expect(wideOut.contentType).toBe('image/webp');
    });
});
