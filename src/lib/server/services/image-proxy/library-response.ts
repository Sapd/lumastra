// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import sharp from '$lib/server/services/image-proxy/image-sharp';
import { z } from 'zod';
import type { BackdropResult } from '../library-backdrop.service';
import { imageResponse } from './response';

export const LibraryImageQuery = z.object({
    v: z.string().optional().describe('Opaque artwork revision; ignored for resolution.'),
    size: z
        .enum(['thumb', 'card', 'hd', 'full'])
        .optional()
        .describe('Width: thumb=256, card=512, hd=1280, full=generated original (default).'),
});

/** Resized mosaics by ETag (hash + size): a revalidation or repeated fetch must not re-encode. */
const resizedCache = new Map<string, Buffer>();
const RESIZED_CACHE_MAX = 64;

/** Resize the generated mosaic, retaining its aspect ratio and original format. */
export async function libraryImageResponse(
    result: BackdropResult,
    request: Request,
): Promise<Response> {
    const size = new URL(request.url).searchParams.get('size') ?? 'full';
    const width = ({ thumb: 256, card: 512, hd: 1280 } as Record<string, number>)[size];
    const etag = `"${result.contentHash}-${size}"`;
    const options = { scope: 'private', bounded: width !== undefined } as const;
    const base = { contentType: result.contentType, cacheControl: 'private, max-age=86400', etag };

    // Answer a matching conditional request before any encoding work.
    const ifNoneMatch = request.headers.get('if-none-match');
    if (
        ifNoneMatch &&
        ifNoneMatch.split(',').some((tag) => tag.trim() === etag || tag.trim() === '*')
    ) {
        return imageResponse({ ...base, buffer: Buffer.alloc(0) }, request, options);
    }

    let buffer = result.buffer;
    if (width) {
        const cached = resizedCache.get(etag);
        if (cached) {
            buffer = cached;
        } else {
            try {
                buffer = await sharp(result.buffer)
                    .resize({ width, withoutEnlargement: true })
                    .toBuffer();
                if (resizedCache.size >= RESIZED_CACHE_MAX) {
                    resizedCache.delete(resizedCache.keys().next().value as string);
                }
                resizedCache.set(etag, buffer);
            } catch {
                // Undecodable mosaic: serve it as generated rather than failing the request.
                buffer = result.buffer;
            }
        }
    }
    return imageResponse({ ...base, buffer }, request, options);
}
