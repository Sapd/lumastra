// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { CanonicalFieldId, RadioMetadataSource, RadioNowPlaying } from '$lib/schemas/radio';

export type { CanonicalFieldId, RadioMetadataSource, RadioNowPlaying };

/**
 * Flat parsed record keyed by canonical field IDs. The service projects
 * this into the nested RadioNowPlaying.track/show/dj/upNext tree.
 */
export type FlatFields = Partial<Record<CanonicalFieldId, string | number>>;

/**
 * Output of the detector: a proposed JSONPath per field plus confidence.
 */
export interface DetectedMapping {
    jsonPaths: Partial<Record<CanonicalFieldId, string>>;
    confidence: Partial<Record<CanonicalFieldId, number>>;
    allLeafPaths: string[];
}

/**
 * Internal cache record — same as RadioNowPlaying but also keeps raw
 * upstream image URLs (never exposed to clients) and last-error telemetry
 * for the admin chip tooltip.
 */
export interface RadioNowPlayingCacheRecord extends RadioNowPlaying {
    _imageUrls?: {
        dj?: string;
        show?: string;
        upNext?: string;
    };
    _lastError?: {
        at: string;
        message: string;
    };
}
