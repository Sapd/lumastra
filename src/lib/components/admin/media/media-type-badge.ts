// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared utility for media type badge display in admin UI.
 * Labels delegate to the canonical getMediaTypeDisplay() in media-types.ts.
 */

import { getMediaTypeDisplay } from '$lib/utils/media-types';

export interface MediaTypeBadge {
    label: string;
    class: string;
}

/** Tailwind CSS class string for a given media type badge. */
function badgeClass(mediaType: string): string {
    switch (mediaType) {
        case 'tv':
            return 'bg-blue-900/50 text-blue-300 border-blue-700/50';
        case 'movie':
            return 'bg-purple-900/50 text-purple-300 border-purple-700/50';
        case 'episode':
            return 'bg-green-900/50 text-green-300 border-green-700/50';
        case 'season':
            return 'bg-amber-900/50 text-amber-300 border-amber-700/50';
        case 'artist':
            return 'bg-pink-900/50 text-pink-300 border-pink-700/50';
        case 'album':
            return 'bg-rose-900/50 text-rose-300 border-rose-700/50';
        case 'track':
            return 'bg-fuchsia-900/50 text-fuchsia-300 border-fuchsia-700/50';
        case 'audiobook':
            return 'bg-indigo-900/50 text-indigo-300 border-indigo-700/50';
        default:
            return 'bg-gray-900/50 text-gray-300 border-gray-700/50';
    }
}

/**
 * Returns a label and Tailwind CSS class string for a given media type.
 */
export function getMediaTypeBadge(mediaType: string): MediaTypeBadge {
    return {
        label: getMediaTypeDisplay(mediaType),
        class: badgeClass(mediaType),
    };
}

/**
 * Returns just the display label for a given media type.
 */
export function getMediaTypeLabel(mediaType: string): string {
    return getMediaTypeDisplay(mediaType);
}
