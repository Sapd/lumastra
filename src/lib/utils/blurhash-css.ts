// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { decode } from 'blurhash';

const cache = new Map<string, string>();

/**
 * Decode a blurhash to a tiny data URL for use as CSS background.
 * Results are cached in memory to avoid repeated decoding.
 */
export function blurhashToDataUrl(blurhash: string, width = 32, height = 32): string {
    const cacheKey = `${blurhash}:${width}:${height}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        if (typeof document === 'undefined') return '';
        const pixels = decode(blurhash, width, height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';
        const imageData = ctx.createImageData(width, height);
        imageData.data.set(pixels);
        ctx.putImageData(imageData, 0, 0);
        const dataUrl = canvas.toDataURL();
        cache.set(cacheKey, dataUrl);
        return dataUrl;
    } catch {
        /* expected: canvas API may be unavailable (SSR or restricted environment) */
        return '';
    }
}
