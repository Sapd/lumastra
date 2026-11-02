// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Re-encode cover art that arrives in a format we don't store.
 *
 * Providers occasionally serve an album cover as a GIF (seen on prod for
 * TheAudioDB covers). Album enrichment stores only JPEG, PNG and WebP, and it
 * used to reject the GIF as `unsupported_content_type`. That failure is
 * deterministic, yet it was recorded as a retryable attempt, so after five
 * tries the album sat at `failed_permanent` and turned the task-health check
 * red. Converting the first frame to PNG keeps the real cover.
 */

import sharp from 'sharp';

/** Content types we decode and re-encode as PNG. Never SVG (scriptable). */
export const CONVERTIBLE_CONTENT_TYPES = new Set(['image/gif', 'image/tiff', 'image/avif']);

/** Refuse decompression bombs: 50 MP is far beyond any real cover. */
const MAX_INPUT_PIXELS = 50_000_000;

export async function convertCoverToPng(
    buffer: Buffer,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: string }> {
    try {
        const png = await sharp(buffer, {
            animated: false,
            limitInputPixels: MAX_INPUT_PIXELS,
        })
            .png()
            .toBuffer();
        return { ok: true, buffer: png };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `undecodable_image: ${reason.slice(0, 120)}` };
    }
}
