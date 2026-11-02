// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Session helper utilities
 *
 * Extracted for testability. Builds subtitle strings and image URLs for session objects.
 */

import { isEpisode, isMusic } from '$lib/server/utils/media-types';
import { getExternalIdFor } from '$lib/utils/external-ids';
import { signUrl } from '$lib/server/utils/signed-url';

interface SubtitleInput {
    mediaType?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    seriesName?: string;
    chapter?: string;
    title?: string;
}

/**
 * Build a subtitle string for a session based on media type.
 *
 * - episode → S1E3 - Episode Title
 * - music → Artist name (from seriesName)
 * - audiobook → Chapter name
 * - other → undefined
 */
export function buildSubtitle(session: SubtitleInput): string | undefined {
    if (session.mediaType && isEpisode(session.mediaType)) {
        const base = `S${session.seasonNumber ?? 0}E${session.episodeNumber ?? 0}`;
        // For episodes: seriesName = parent series name, title = episode name
        return session.title && session.seriesName ? `${base} - ${session.title}` : base;
    }

    if (session.mediaType && isMusic(session.mediaType)) {
        return session.seriesName ?? undefined;
    }

    if (session.mediaType === 'audiobook') {
        return session.chapter ?? undefined;
    }

    return undefined;
}

interface ImageUrlInput {
    externalIds?: Record<string, string | undefined>;
    jellyfinId?: string;
}

/**
 * Build a signed image URL for a session.
 * Prefers internal UUID over Jellyfin ID. Returns undefined if no image source.
 *
 * Uses the canonical /api/v1/media/{id}/images/poster endpoint with a
 * short-lived HMAC ?sig= credential so Bearer auth is not required in <img> src.
 */
export function buildImageUrl(session: ImageUrlInput): string | undefined {
    const internalId = getExternalIdFor(session.externalIds, 'internal');

    if (internalId) {
        return signUrl(`/api/v1/media/${internalId}/images/poster`, {
            expiresIn: 600,
            purpose: 'image',
        });
    }

    if (session.jellyfinId) {
        return signUrl(
            `/api/v1/media/${encodeURIComponent(`jellyfin:${session.jellyfinId}:movie`)}/images/primary`,
            { expiresIn: 600, purpose: 'image' },
        );
    }

    return undefined;
}
