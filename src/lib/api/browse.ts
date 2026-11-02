// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browse API domain module
 *
 * Typed functions for browsing media libraries, keywords, A-Z browse,
 * and library listing.
 */

import { z } from 'zod';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview';
import { apiGet } from './client.js';
import type { ApiRequestOptions } from './types.js';
import {
    BrowseResponseSchema as InternalBrowseResponseSchema,
    BrowseKeywordsResponseSchema,
    LibrariesResponseSchema,
    AzBrowseResponseSchema,
} from '$lib/schemas/api-browse-responses';

const BrowseResponseSchema = InternalBrowseResponseSchema.extend({
    recentlyAdded: z.array(MediaPreviewSchema).optional(),
    genres: z.array(z.object({ genre: z.string(), items: z.array(MediaPreviewSchema) })).optional(),
});

// =========================================================================
// Browse Content
// =========================================================================

export function getBrowse(type?: string, options?: ApiRequestOptions) {
    return apiGet('/api/browse', BrowseResponseSchema, {
        ...options,
        params: { ...options?.params, type },
    });
}

export function getRecentlyAdded(params?: {
    type?: string;
    libraryGroupId?: string;
    new?: 'everything' | 'seasons' | 'titles';
    q?: string;
}) {
    return apiGet('/api/browse/recent', BrowseResponseSchema, {
        params: {
            type: params?.type,
            libraryGroupId: params?.libraryGroupId,
            new: params?.new,
            q: params?.q,
        },
    });
}

export function getBrowseKeywords(options?: { limit?: number; offset?: number; type?: string }) {
    return apiGet('/api/browse/keywords', BrowseKeywordsResponseSchema, {
        params: {
            limit: options?.limit,
            offset: options?.offset,
            type: options?.type,
        },
    });
}

// =========================================================================
// Libraries
// =========================================================================

export function getLibraries() {
    return apiGet('/api/browse/libraries', LibrariesResponseSchema);
}

// =========================================================================
// A-Z Browse
// =========================================================================

export function getAzBrowse(options?: {
    q?: string;
    signal?: AbortSignal;
    letter?: string;
    libraryGroupId?: string;
    type?: string;
    offset?: number;
    limit?: number;
    audio?: string[];
    subs?: string[];
    includeUnknown?: boolean;
    sort?: string;
    res?: string[];
    hdr?: string[];
    codec?: string[];
    qualityIncludeUnknown?: boolean;
    /** Exact genre name (case-sensitive on the server) — sent through verbatim. */
    genre?: string;
    /** Tag/keyword (normalized server-side) — sent through verbatim. */
    tag?: string;
}) {
    return apiGet('/api/browse/az', AzBrowseResponseSchema, {
        signal: options?.signal,
        params: {
            q: options?.q?.trim() || undefined,
            letter: options?.letter,
            libraryGroupId: options?.libraryGroupId,
            type: options?.type,
            offset: options?.offset,
            limit: options?.limit,
            audio: options?.audio?.length ? options.audio.join(',') : undefined,
            subs: options?.subs?.length ? options.subs.join(',') : undefined,
            includeUnknown: options?.includeUnknown ? 'true' : undefined,
            sort: options?.sort,
            res: options?.res?.length ? options.res.join(',') : undefined,
            hdr: options?.hdr?.length ? options.hdr.join(',') : undefined,
            codec: options?.codec?.length ? options.codec.join(',') : undefined,
            qUnknown: options?.qualityIncludeUnknown ? 'true' : undefined,
            genre: options?.genre || undefined,
            tag: options?.tag || undefined,
        },
    });
}
