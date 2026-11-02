// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { pixelBombPng } from '../../../../tests/helpers/pixel-bomb-png';
import {
    AVATAR_MAX_INPUT_PIXELS,
    AvatarTooManyPixelsError,
    isAllowedAvatarImage,
    processAvatarImage,
} from './avatar-image';

describe('processAvatarImage', () => {
    it('refuses an image declaring more than 16 MP, whatever the caller passes', async () => {
        const bomb = pixelBombPng(20_000, 20_000);
        expect(bomb.length).toBeLessThan(200);
        expect(isAllowedAvatarImage(bomb)).toBe(true);
        await expect(processAvatarImage(bomb)).rejects.toBeInstanceOf(AvatarTooManyPixelsError);
        await expect(processAvatarImage(bomb)).rejects.toThrow(/pixel limit/i);
        await expect(processAvatarImage(bomb, { maxInputPixels: 1_000_000_000 })).rejects.toThrow(
            /pixel limit/i,
        );
        // 100 MP is under sharp's own ~268 MP default: only the avatar cap stops it.
        await expect(processAvatarImage(pixelBombPng(10_000, 10_000))).rejects.toThrow(
            /pixel limit/i,
        );
    });

    it('throws the decoder error, not the pixel error, for a corrupt image', async () => {
        const corrupt = Buffer.concat([pixelBombPng(10, 10).subarray(0, 40), Buffer.alloc(40)]);
        const err = await processAvatarImage(corrupt).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(AvatarTooManyPixelsError);
    });

    it('lets a caller lower the limit', async () => {
        const img = await sharp({
            create: { width: 400, height: 400, channels: 3, background: '#336699' },
        })
            .png()
            .toBuffer();
        await expect(processAvatarImage(img, { maxInputPixels: 1_000 })).rejects.toThrow(
            /pixel limit/i,
        );
        const out = await processAvatarImage(img);
        const meta = await sharp(out).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(['webp', 200, 200]);
        expect(AVATAR_MAX_INPUT_PIXELS).toBe(16_000_000);
    });
});
