// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import sharp from '$lib/server/services/image-proxy/image-sharp';

/**
 * Validation and processing shared by every stored avatar: the user's upload
 * and the picture synced from the OIDC provider. Both end up as a 200x200 WebP
 * with metadata stripped, so whatever arrived is never served as-is.
 */

/** Size of the stored avatar, in pixels (square). */
export const STORED_AVATAR_PX = 200;

/** Allowed image magic bytes */
const MAGIC_BYTES: Array<{ mime: string; bytes: number[] }> = [
    { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
    { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

/** WebP uses RIFF container — check both RIFF header and WEBP signature at offset 8 */
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_SIG = [0x57, 0x45, 0x42, 0x50]; // "WEBP"

/**
 * True when the bytes start like JPEG, PNG, GIF or WebP. SVG is deliberately
 * not on the list: it is a document that can carry script, not just pixels.
 */
export function isAllowedAvatarImage(buffer: Buffer): boolean {
    if (buffer.length < 12) return false;

    // Check standard magic bytes (JPEG, PNG, GIF)
    const matchesStandard = MAGIC_BYTES.some(({ bytes }) => bytes.every((b, i) => buffer[i] === b));
    if (matchesStandard) return true;

    // Check WebP: RIFF header at offset 0 + WEBP at offset 8
    const isRiff = WEBP_RIFF.every((b, i) => buffer[i] === b);
    const isWebP = WEBP_SIG.every((b, i) => buffer[i + 8] === b);
    return isRiff && isWebP;
}

/**
 * Most input pixels any avatar decode may have: 16 MP is plenty for a 200 px
 * square and bounds the decode (~64 MB RGBA). A small file can still declare
 * huge dimensions, and sharp's own default (~268 MP) lets one upload take
 * gigabytes.
 */
export const AVATAR_MAX_INPUT_PIXELS = 16_000_000;

/** What the upload routes tell the user when an image is over AVATAR_MAX_INPUT_PIXELS. */
export const AVATAR_TOO_MANY_PIXELS_MESSAGE = 'Image too large (max 16 megapixels)';

/** Thrown by processAvatarImage when the image declares more pixels than the limit. */
export class AvatarTooManyPixelsError extends Error {
    constructor(readonly limit: number) {
        super(`Image exceeds the avatar pixel limit (${limit} pixels)`);
        this.name = 'AvatarTooManyPixelsError';
    }
}

/**
 * Re-encode an avatar: auto-rotate from EXIF, then strip it, crop to a
 * 200x200 square, WebP q80. Throws AvatarTooManyPixelsError when the input
 * has more than AVATAR_MAX_INPUT_PIXELS pixels (`maxInputPixels` may lower
 * that bound, never raise it), and sharp's own error when it cannot decode
 * the input.
 */
export async function processAvatarImage(
    raw: Buffer,
    options: { maxInputPixels?: number } = {},
): Promise<Buffer> {
    const limit = Math.min(AVATAR_MAX_INPUT_PIXELS, options.maxInputPixels ?? Infinity);
    try {
        return await sharp(raw, { limitInputPixels: limit })
            .rotate() // Auto-rotate based on EXIF before stripping
            .resize(STORED_AVATAR_PX, STORED_AVATAR_PX, { fit: 'cover' })
            .webp({ quality: 80 })
            .toBuffer();
    } catch (err) {
        // sharp: "Input image exceeds pixel limit"
        if (err instanceof Error && /pixel limit/i.test(err.message)) {
            throw new AvatarTooManyPixelsError(limit);
        }
        throw err;
    }
}
