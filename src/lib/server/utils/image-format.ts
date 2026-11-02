// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Format Selection Utility
 *
 * Centralized logic for selecting image output format and content type.
 * Eliminates duplication across TMDB, Jellyfin, and other image providers.
 *
 * Key behaviors:
 * - WebP conversion is preferred when enabled (except for logos to preserve transparency)
 * - Logos always use PNG to preserve transparency
 * - Respects explicit format requests from clients
 */

import { config } from '$lib/server/config';
import type { ImageFormat, ImageType } from '../services/image-proxy/types';

export interface FormatSelection {
    format: ImageFormat;
    contentType: string;
}

/**
 * Select appropriate image format and content type
 *
 * @param imageType - Type of image (poster, backdrop, logo, still)
 * @param requestedFormat - Explicitly requested format (overrides defaults)
 * @returns Object with format and contentType
 *
 * @example
 * // WebP enabled, no explicit request -> webp
 * selectImageFormat('poster') // { format: 'webp', contentType: 'image/webp' }
 *
 * // Logo preserves transparency
 * selectImageFormat('logo') // { format: 'png', contentType: 'image/png' }
 *
 * // Explicit format request
 * selectImageFormat('poster', 'jpg') // { format: 'jpg', contentType: 'image/jpeg' }
 */
export function selectImageFormat(
    imageType: ImageType,
    requestedFormat?: ImageFormat,
): FormatSelection {
    // Logos require transparency preservation - always PNG. AVIF supports
    // alpha but we keep logos in PNG for predictable rendering across the
    // long tail of clients (and logos are small enough that the format-size
    // savings don't matter).
    if (imageType === 'logo') {
        return { format: 'png', contentType: 'image/png' };
    }

    if (requestedFormat) {
        return {
            format: requestedFormat,
            contentType: contentTypeForFormat(requestedFormat),
        };
    }

    if (config.IMAGE_WEBP_ENABLED) {
        return { format: 'webp', contentType: 'image/webp' };
    }

    return { format: 'jpg', contentType: 'image/jpeg' };
}

function contentTypeForFormat(format: ImageFormat): string {
    switch (format) {
        case 'webp':
            return 'image/webp';
        case 'avif':
            return 'image/avif';
        case 'png':
            return 'image/png';
        case 'jpg':
            return 'image/jpeg';
    }
}
