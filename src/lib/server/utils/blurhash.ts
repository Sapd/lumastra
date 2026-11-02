// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { encode } from 'blurhash';
import sharp from 'sharp';

/**
 * Compute a BlurHash string from an image buffer.
 * Resizes to tiny dimensions first for speed (~1-2ms).
 */
export async function computeBlurHash(imageBuffer: Buffer): Promise<string | null> {
    try {
        const { data, info } = await sharp(imageBuffer)
            .resize(32, 32, { fit: 'inside' })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        return encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
    } catch {
        /* expected: sharp decode or blurhash encode fails for unsupported/corrupt images */
        return null;
    }
}
