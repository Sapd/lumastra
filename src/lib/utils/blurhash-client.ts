// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { decode } from 'blurhash';

/**
 * Decode a blurhash into a small data: URI for use as a CSS background.
 * Client-only (uses canvas). Returns null on any failure / non-DOM env.
 */
export function blurhashToCssBackground(hash: string | undefined, w = 32, h = 18): string | null {
    if (!hash || typeof document === 'undefined') return null;
    try {
        const pixels = decode(hash, w, h);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const imageData = ctx.createImageData(w, h);
        imageData.data.set(pixels);
        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL();
    } catch {
        return null;
    }
}
